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

/// Content-layer animation cues for hide/re-show (the renderer fades its own
/// shell before the host hides the window).
pub(crate) const WINDOW_HIDE_ANIM_EVENT: &str = "window:hide-anim";
pub(crate) const WINDOW_SHOW_ANIM_EVENT: &str = "window:shown-anim";

struct Inner {
    handle: AppHandle,
    shutdown_requested: AtomicBool,
    bounds_saver: BoundsSaver,
    visibility: Mutex<WindowVisibility>,
    tray_visible: AtomicBool,
}

#[derive(Default)]
struct WindowVisibility {
    main_revision: usize,
    tray_positioned: bool,
}

enum TrayAfterMainHide {
    Keep,
    Hide,
    Show,
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
                visibility: Mutex::new(WindowVisibility::default()),
                tray_visible: AtomicBool::new(false),
            }),
        }
    }

    /// Apply the remembered (or first-use) bounds and the desktop-window flags
    /// to the hidden main window. Runs once during setup, before the reveal.
    pub fn restore_main_bounds(&self) -> Result<(), AppError> {
        let win = main_window(&self.inner.handle)?;
        let pinned = self
            .inner
            .handle
            .try_state::<crate::desktop::DesktopState>()
            .map(|desktop| desktop.current().main_window_pinned)
            .unwrap_or(false);
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
        set_logical_bounds(&win, bounds, monitor.scale_factor())?;
        // The pin choice survives restarts; the flag setter above resets it.
        win.set_always_on_top(pinned)?;
        Ok(())
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
        let mut visibility = self.visibility();
        visibility.main_revision = visibility.main_revision.wrapping_add(1);
        self.hide_tray_window()?;
        let win = main_window(&self.inner.handle)?;
        if win.is_minimized().unwrap_or(false) {
            win.unminimize()?;
        }
        win.show()?;
        win.set_focus()?;
        let _ = app.emit_to("main", WINDOW_SHOW_ANIM_EVENT, ());
        if let Some(readiness) = app.try_state::<crate::startup_readiness::StartupReadiness>() {
            readiness.mark_user_shown("main");
        }
        if let Some(navigate) = navigate {
            app.emit_to("main", MAIN_NAVIGATE_EVENT, navigate)?;
        }
        Ok(())
    }

    pub fn hide_tray_panel(&self) -> Result<(), AppError> {
        let _visibility = self.visibility();
        self.hide_tray_window()
    }

    fn visibility(&self) -> std::sync::MutexGuard<'_, WindowVisibility> {
        self.inner
            .visibility
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    fn hide_tray_window(&self) -> Result<(), AppError> {
        tray_panel(&self.inner.handle)?.hide()?;
        self.inner.tray_visible.store(false, Ordering::Release);
        Ok(())
    }

    pub fn tray_is_shown(&self) -> bool {
        self.inner.tray_visible.load(Ordering::Acquire)
    }

    pub fn dismiss_unfocused_tray(&self) -> Result<(), AppError> {
        let _visibility = self.visibility();
        if self.tray_is_shown() && !tray_panel(&self.inner.handle)?.is_focused()? {
            self.hide_tray_window()?;
        }
        Ok(())
    }

    pub fn minimize_main_window(&self) -> Result<(), AppError> {
        main_window(&self.inner.handle)?.minimize()?;
        Ok(())
    }

    /// Titlebar pin toggle: keep the window above all others. Persisted.
    pub fn toggle_pinned(&self) -> Result<bool, AppError> {
        let win = main_window(&self.inner.handle)?;
        let pinned = !win.is_always_on_top()?;
        win.set_always_on_top(pinned)?;
        if let Some(desktop) = self.inner.handle.try_state::<crate::desktop::DesktopState>() {
            desktop.set_window_pinned(pinned);
        }
        Ok(pinned)
    }

    pub fn is_pinned(&self) -> bool {
        self.inner
            .handle
            .try_state::<crate::desktop::DesktopState>()
            .map(|desktop| desktop.current().main_window_pinned)
            .unwrap_or(false)
    }

    /// Global-hotkey entry: summon the hidden window, dismiss the visible one.
    pub fn toggle_main_visibility(&self) -> Result<(), AppError> {
        let win = main_window(&self.inner.handle)?;
        if win.is_visible().unwrap_or(false) {
            self.hide_to_tray()
        } else {
            self.show_main_window(&self.inner.handle, None)
        }
    }

    /// Snap the window to a zone of the current monitor's work area, given as
    /// fractions (0..1). Restores a maximized window first so the new bounds
    /// stick, and persists the result like any user-driven resize.
    pub fn snap_to_zone(&self, zone: crate::dto::SnapZone) -> Result<(), AppError> {
        let zone = zone.validated()?;
        let win = main_window(&self.inner.handle)?;
        let monitor = win
            .current_monitor()?
            .ok_or_else(|| AppError::message("无法获取显示器"))?;
        let scale = monitor.scale_factor();
        let work_area = monitor_work_area_logical(&monitor);
        let width = ((work_area.width as f64 * (zone.x1 - zone.x0)).round() as i32)
            .max(window_geometry::MAIN_MIN_WIDTH);
        let height = ((work_area.height as f64 * (zone.y1 - zone.y0)).round() as i32)
            .max(window_geometry::MAIN_MIN_HEIGHT);
        let bounds = Rect {
            x: (work_area.x as f64 + work_area.width as f64 * zone.x0).round() as i32,
            y: (work_area.y as f64 + work_area.height as f64 * zone.y0).round() as i32,
            width,
            height,
        };
        if win.is_maximized()? {
            win.unmaximize()?;
        }
        set_logical_bounds(&win, bounds, scale)?;
        self.inner.bounds_saver.request();
        Ok(())
    }

    fn hide_to_tray(&self) -> Result<(), AppError> {
        self.hide_main(TrayAfterMainHide::Keep)
    }

    pub fn close_main_to_tray(&self, return_to_panel: bool) -> Result<(), AppError> {
        self.hide_main(if return_to_panel {
            TrayAfterMainHide::Show
        } else {
            TrayAfterMainHide::Hide
        })
    }

    fn hide_main(&self, after: TrayAfterMainHide) -> Result<(), AppError> {
        let mut visibility = self.visibility();
        if matches!(after, TrayAfterMainHide::Hide) {
            self.hide_tray_window()?;
        }
        visibility.main_revision = visibility.main_revision.wrapping_add(1);
        let revision = visibility.main_revision;
        let app = self.inner.handle.clone();
        let win = main_window(&self.inner.handle)?;
        if let Some(readiness) = app.try_state::<crate::startup_readiness::StartupReadiness>() {
            readiness.mark_user_hidden("main");
        }
        let _ = app.emit_to("main", WINDOW_HIDE_ANIM_EVENT, ());
        let controller = self.clone();
        crate::platform::spawn_worker("picboard-hide-anim", move || {
            std::thread::sleep(Duration::from_millis(200));
            let mut visibility = controller.visibility();
            if visibility.main_revision != revision {
                return;
            }
            if let Err(error) = win.hide() {
                eprintln!("[window] main hide failed: {error}");
                return;
            }
            if matches!(after, TrayAfterMainHide::Show) {
                if let Err(error) = controller.return_to_tray_panel(&win, &mut visibility) {
                    eprintln!("[window] tray reveal failed: {error}");
                }
            }
        });
        Ok(())
    }

    pub fn set_tray_panel_at(&self, show: bool, icon: Rect) -> Result<(), AppError> {
        let mut visibility = self.visibility();
        if !show {
            return self.hide_tray_window();
        }
        let panel = tray_panel(&self.inner.handle)?;
        let center_x = f64::from(icon.x) + f64::from(icon.width) / 2.0;
        let center_y = f64::from(icon.y) + f64::from(icon.height) / 2.0;
        let monitor = self
            .inner
            .handle
            .monitor_from_point(center_x, center_y)?
            .ok_or_else(|| AppError::message("无法获取托盘所在显示器"))?;
        let scale = monitor.scale_factor();
        let work_area = monitor_work_area_logical(&monitor);
        let tray_icon = Rect {
            x: (f64::from(icon.x) / scale).round() as i32,
            y: (f64::from(icon.y) / scale).round() as i32,
            width: (f64::from(icon.width) / scale).round() as i32,
            height: (f64::from(icon.height) / scale).round() as i32,
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
        self.show_tray_window(&panel, &mut visibility)
    }

    fn return_to_tray_panel(
        &self,
        main: &WebviewWindow,
        visibility: &mut WindowVisibility,
    ) -> Result<(), AppError> {
        let panel = tray_panel(&self.inner.handle)?;
        let saved = if visibility.tray_positioned {
            let position = panel.outer_position()?;
            let size = panel.outer_size()?;
            self.inner
                .handle
                .monitor_from_point(
                    f64::from(position.x) + f64::from(size.width) / 2.0,
                    f64::from(position.y) + f64::from(size.height) / 2.0,
                )?
                .map(|monitor| (position, monitor))
        } else {
            None
        };
        let (position, monitor) = match saved {
            Some((position, monitor)) => (Some(position), monitor),
            None => {
                let monitor = main
                    .current_monitor()?
                    .or(main.primary_monitor()?)
                    .ok_or_else(|| AppError::message("无法获取显示器"))?;
                (None, monitor)
            }
        };
        let scale = monitor.scale_factor();
        let saved_position = position.map(|position| {
            (
                (f64::from(position.x) / scale).round() as i32,
                (f64::from(position.y) / scale).round() as i32,
            )
        });
        let bounds = window_geometry::fit_tray_panel(saved_position, monitor_work_area_logical(&monitor));
        if saved_position != Some((bounds.x, bounds.y)) {
            panel.set_position(PhysicalPosition::new(
                (f64::from(bounds.x) * scale).round() as i32,
                (f64::from(bounds.y) * scale).round() as i32,
            ))?;
        }
        self.show_tray_window(&panel, visibility)
    }

    fn show_tray_window(
        &self,
        panel: &WebviewWindow,
        visibility: &mut WindowVisibility,
    ) -> Result<(), AppError> {
        panel.show()?;
        visibility.tray_positioned = true;
        self.inner.tray_visible.store(true, Ordering::Release);
        panel.set_focus()?;
        Ok(())
    }
}
