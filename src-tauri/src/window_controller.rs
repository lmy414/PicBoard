//! Window management: the main desktop window (frameless, resizable, bounds
//! remembered) and the tray flyout panel.
//!
//! The main window is a normal desktop window — not topmost, in the taskbar,
//! freely resizable with a minimum size. The tray panel is a small
//! always-on-top flyout anchored to the tray icon, toggled by the tray's left
//! click and hidden on focus loss.

use crate::error::AppError;
use crate::window_geometry::{self, Rect};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, WebviewWindow};

const BOUNDS_SAVE_DEBOUNCE: Duration = Duration::from_millis(500);

/// Event that carries a navigation instruction to the main window.
pub(crate) const MAIN_NAVIGATE_EVENT: &str = "main:navigate";

struct Inner {
    handle: AppHandle,
    shutdown_requested: AtomicBool,
    bounds_saver: BoundsSaver,
}

/// Handle shared with the commands and setup.
#[derive(Clone)]
pub struct WindowController {
    inner: Arc<Inner>,
}

fn main_window(app: &AppHandle) -> Result<WebviewWindow, AppError> {
    app.get_webview_window("main")
        .ok_or_else(|| AppError::message("主窗口不存在"))
}

fn tray_panel(app: &AppHandle) -> Result<WebviewWindow, AppError> {
    app.get_webview_window("tray")
        .ok_or_else(|| AppError::message("托盘面板不存在"))
}

fn reap_thread(thread: std::thread::JoinHandle<()>) {
    crate::platform::spawn_worker("picboard-window-reaper", move || {
        let _ = thread.join();
    });
}

/// Debounced persistence of the user's main-window bounds. Resizes and moves
/// arrive at high frequency; the worker waits for quiet before touching the
/// preferences file. Signalled teardown only, never joined from a UI callback.
struct BoundsSaver {
    sender: mpsc::Sender<()>,
    stop: Arc<AtomicBool>,
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl BoundsSaver {
    fn start(handle: AppHandle) -> Self {
        let (sender, receiver) = mpsc::channel::<()>();
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let thread = std::thread::Builder::new()
            .name("picboard-window-bounds".into())
            .spawn(move || bounds_saver_loop(&handle, &receiver, &thread_stop));
        let thread = match thread {
            Ok(thread) => Some(thread),
            Err(error) => {
                eprintln!("[window] failed to start the bounds saver: {error}");
                None
            }
        };
        Self {
            sender,
            stop,
            thread: Mutex::new(thread),
        }
    }

    fn request(&self) {
        let _ = self.sender.send(());
    }

    /// Signal the worker and reap its thread off the calling thread.
    fn stop(&self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self
            .thread
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .take()
        {
            reap_thread(thread);
        }
    }
}

fn bounds_saver_loop(handle: &AppHandle, receiver: &mpsc::Receiver<()>, stop: &AtomicBool) {
    loop {
        match receiver.recv_timeout(Duration::from_millis(200)) {
            Ok(()) => {}
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }
        if stop.load(Ordering::Acquire) {
            return;
        }
        // Debounce: keep waiting while changes keep arriving.
        loop {
            if stop.load(Ordering::Acquire) {
                return;
            }
            match receiver.recv_timeout(BOUNDS_SAVE_DEBOUNCE) {
                Ok(()) => continue,
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
        if let Err(error) = save_user_bounds(handle) {
            eprintln!("[window] failed to save window bounds: {error}");
        }
    }
}

/// Persist the current main-window bounds. Maximized frames are never
/// remembered: restoring from the maximize is the user's chosen geometry.
///
/// Runs on the bounds-saver worker thread, so the window queries below are
/// safe: nothing here holds a lock across them.
fn save_user_bounds(handle: &AppHandle) -> Result<(), AppError> {
    if handle.try_state::<WindowController>().is_none() {
        return Ok(());
    }
    // The window may already be gone (teardown races the debounce): nothing to
    // remember then.
    let Ok(win) = main_window(handle) else {
        return Ok(());
    };
    // A minimize can arrive while a move/resize is being debounced. Its
    // off-screen Windows frame must never replace the normal restore bounds.
    if !window_geometry::should_persist_bounds(win.is_maximized()?, win.is_minimized()?) {
        return Ok(());
    }
    let rect = logical_rect(&win)?;
    let monitor = win
        .current_monitor()
        .ok()
        .flatten()
        .and_then(|monitor| monitor.name().cloned());
    crate::desktop::remember_window_bounds(handle, &rect, monitor);
    Ok(())
}

fn logical_rect(win: &WebviewWindow) -> Result<Rect, AppError> {
    let scale = win.scale_factor()?;
    let pos = win.outer_position()?;
    let size = win.outer_size()?;
    Ok(Rect {
        x: (pos.x as f64 / scale).round() as i32,
        y: (pos.y as f64 / scale).round() as i32,
        width: (size.width as f64 / scale).round() as i32,
        height: (size.height as f64 / scale).round() as i32,
    })
}

/// Logical work area of the monitor under `(physical_x, physical_y)`.
fn monitor_work_area_logical(monitor: &tauri::Monitor) -> Rect {
    let scale = monitor.scale_factor();
    let wa = monitor.work_area();
    Rect {
        x: (wa.position.x as f64 / scale).round() as i32,
        y: (wa.position.y as f64 / scale).round() as i32,
        width: (wa.size.width as f64 / scale).round() as i32,
        height: (wa.size.height as f64 / scale).round() as i32,
    }
}

fn set_logical_bounds(win: &WebviewWindow, bounds: Rect, scale: f64) -> Result<(), AppError> {
    // Global logical positions in the preferences use the saved monitor's DPI.
    // Use that monitor's factor, not the hidden window's initial primary DPI.
    win.set_position(PhysicalPosition::new(
        (bounds.x as f64 * scale).round() as i32,
        (bounds.y as f64 * scale).round() as i32,
    ))?;
    win.set_size(LogicalSize::new(bounds.width as f64, bounds.height as f64))?;
    Ok(())
}

/// The user's previously chosen main-window bounds, if any.
fn saved_window_bounds(app: &AppHandle) -> Option<Rect> {
    let desktop = app.try_state::<crate::desktop::DesktopState>()?;
    let saved = desktop.current().window_bounds?;
    Some(Rect {
        x: saved.x,
        y: saved.y,
        width: saved.width,
        height: saved.height,
    })
}

/// Main-window mode flags: resizable with a sane minimum, not topmost. Tauri's
/// runtime attaches native edge/corner resize borders to undecorated windows
/// when resizable is enabled.
fn set_main_window_flags(win: &WebviewWindow) -> Result<(), AppError> {
    win.set_min_size(Some(LogicalSize::new(
        window_geometry::MAIN_MIN_WIDTH as f64,
        window_geometry::MAIN_MIN_HEIGHT as f64,
    )))?;
    win.set_resizable(true)?;
    win.set_always_on_top(false)?;
    Ok(())
}

impl WindowController {
    pub fn new(handle: AppHandle) -> Self {
        let bounds_saver = BoundsSaver::start(handle.clone());
        Self {
            inner: Arc::new(Inner {
                handle,
                shutdown_requested: AtomicBool::new(false),
                bounds_saver,
            }),
        }
    }

    /// Apply the remembered (or first-use) bounds and the desktop-window flags
    /// to the hidden main window. Runs once during setup, before the reveal.
    pub fn restore_main_bounds(&self) -> Result<(), AppError> {
        let win = main_window(&self.inner.handle)?;
        let saved_monitor = self
            .inner
            .handle
            .try_state::<crate::desktop::DesktopState>()
            .and_then(|desktop| desktop.current().window_bounds)
            .and_then(|bounds| bounds.monitor);
        let monitor = saved_monitor
            .and_then(|name| {
                win.available_monitors()
                    .ok()?
                    .into_iter()
                    .find(|monitor| monitor.name() == Some(&name))
            })
            .or_else(|| win.current_monitor().ok().flatten())
            .or_else(|| win.primary_monitor().ok().flatten())
            .ok_or_else(|| AppError::message("无法获取显示器"))?;
        let work_area = monitor_work_area_logical(&monitor);
        let saved = saved_window_bounds(&self.inner.handle);
        let bounds = window_geometry::fit_main_window(saved, work_area);
        set_main_window_flags(&win)?;
        set_logical_bounds(&win, bounds, monitor.scale_factor())
    }

    /// Called re-entrantly by tao from native move/size APIs. Only signal the
    /// worker here: no window query and no lock may run on this callback path.
    pub fn note_window_geometry_changed(&self) {
        if !self.inner.shutdown_requested.load(Ordering::Acquire) {
            self.inner.bounds_saver.request();
        }
    }

    /// Native state is the single source of truth for titlebar buttons,
    /// double-click, Win+Up/Down and Aero snap/drag-to-restore alike.
    pub fn is_maximized(&self) -> bool {
        main_window(&self.inner.handle)
            .map(|win| win.is_maximized().unwrap_or(false))
            .unwrap_or(false)
    }

    pub fn toggle_maximized(&self) -> Result<bool, AppError> {
        let win = main_window(&self.inner.handle)?;
        let maximized = !win.is_maximized()?;
        if maximized {
            win.maximize()?;
        } else {
            win.unmaximize()?;
        }
        // Restoring must schedule a save even if all move/resize events were
        // emitted during the native transition. The worker filters max/min.
        self.inner.bounds_saver.request();
        win.emit("window:maximized-changed", maximized)?;
        Ok(maximized)
    }

    /// The native HTCAPTION loop owns drag-to-restore, the cursor grab point,
    /// mixed-DPI monitor transitions and Aero snap. Moving a work-area-sized
    /// normal window by hand cannot provide those Windows semantics.
    pub fn start_titlebar_drag(&self) -> Result<(), AppError> {
        let win = main_window(&self.inner.handle)?;
        win.start_dragging()?;
        Ok(())
    }

    /// Start the OS sizing loop, keeping content pointer handlers out of the
    /// gesture. This always targets main; tray sizing/anchoring is untouched.
    pub fn start_resize_dragging(&self, direction: &str) -> Result<(), AppError> {
        let win = main_window(&self.inner.handle)?;
        // Infer the SDK's native ResizeDirection here (not re-exported by
        // tauri). Its Deserialize implementation validates all eight names.
        let direction = serde_json::from_value(serde_json::Value::String(direction.to_owned()))
            .map_err(|_| AppError::message("无效的窗口缩放方向"))?;
        if win.is_maximized()? || win.is_minimized()? {
            return Ok(());
        }
        win.as_ref().window().start_resize_dragging(direction)?;
        Ok(())
    }

    /// Stop background work. Signal-only; handles are reclaimed on a separate
    /// thread so this stays safe from window destruction callbacks.
    pub fn request_teardown(&self) {
        self.inner.shutdown_requested.store(true, Ordering::Release);
        self.inner.bounds_saver.stop();
    }

    pub fn close(&self) -> Result<(), AppError> {
        let win = main_window(&self.inner.handle)?;
        win.close()?;
        Ok(())
    }

    /// Show/unminimize/focus the main window, hide the tray panel and
    /// optionally navigate the renderer.
    pub fn show_main_window(
        &self,
        app: &AppHandle,
        navigate: Option<crate::dto::MainNavigation>,
    ) -> Result<(), AppError> {
        self.hide_tray_panel()?;
        let win = main_window(&self.inner.handle)?;
        if win.is_minimized().unwrap_or(false) {
            win.unminimize()?;
        }
        win.show()?;
        win.set_focus()?;
        if let Some(readiness) = app.try_state::<crate::startup_readiness::StartupReadiness>() {
            readiness.mark_user_shown("main");
        }
        if let Some(navigate) = navigate {
            app.emit_to("main", MAIN_NAVIGATE_EVENT, navigate)?;
        }
        Ok(())
    }

    pub fn hide_tray_panel(&self) -> Result<(), AppError> {
        tray_panel(&self.inner.handle)?.hide()?;
        Ok(())
    }

    pub fn minimize_main_window(&self) -> Result<(), AppError> {
        main_window(&self.inner.handle)?.minimize()?;
        Ok(())
    }

    /// Left click on the tray icon: show the panel anchored to the clicked
    /// icon (the icon's rect in physical pixels), or hide it when it is
    /// already visible. Deferred to a worker thread by the tray handler.
    pub fn toggle_tray_panel_at(
        &self,
        icon_x: f64,
        icon_y: f64,
        icon_width: f64,
        icon_height: f64,
    ) {
        if let Err(error) = self.toggle_tray_panel_inner(icon_x, icon_y, icon_width, icon_height) {
            eprintln!("[tray] panel toggle failed: {error}");
        }
    }

    fn toggle_tray_panel_inner(
        &self,
        icon_x: f64,
        icon_y: f64,
        icon_width: f64,
        icon_height: f64,
    ) -> Result<(), AppError> {
        let panel = tray_panel(&self.inner.handle)?;
        if panel.is_visible().unwrap_or(false) {
            panel.hide()?;
            return Ok(());
        }
        let center_x = icon_x + icon_width / 2.0;
        let center_y = icon_y + icon_height / 2.0;
        let monitor = self
            .inner
            .handle
            .monitor_from_point(center_x, center_y)?
            .ok_or_else(|| AppError::message("无法获取托盘所在显示器"))?;
        let scale = monitor.scale_factor();
        let work_area = monitor_work_area_logical(&monitor);
        let tray_icon = Rect {
            x: (icon_x / scale).round() as i32,
            y: (icon_y / scale).round() as i32,
            width: (icon_width / scale).round() as i32,
            height: (icon_height / scale).round() as i32,
        };
        let anchored = window_geometry::anchor_tray_panel(
            tray_icon,
            work_area,
            window_geometry::TRAY_PANEL_WIDTH,
            window_geometry::TRAY_PANEL_HEIGHT,
        );
        panel.set_position(PhysicalPosition::new(
            (anchored.x as f64 * scale).round() as i32,
            (anchored.y as f64 * scale).round() as i32,
        ))?;
        panel.show()?;
        panel.set_focus()?;
        Ok(())
    }
}
