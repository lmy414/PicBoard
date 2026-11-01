//! Window management: the main desktop window (frameless, resizable, bounds
//! remembered) and the tray flyout panel.
//!
//! The main window is a normal desktop window — not topmost, in the taskbar,
//! freely resizable with a minimum size. The tray panel is a small
//! always-on-top flyout anchored to the tray icon, toggled by the tray's left
//! click and hidden on focus loss.

use crate::error::AppError;
use crate::platform;
use crate::window_geometry::{self, Rect};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

const BOUNDS_SAVE_DEBOUNCE: Duration = Duration::from_millis(500);

/// Event that carries a navigation instruction to the main window.
pub(crate) const MAIN_NAVIGATE_EVENT: &str = "main:navigate";

struct Inner {
    handle: AppHandle,
    /// Fake-maximize bookkeeping. It lives behind its own type so the lock-free
    /// read path used by window-event callbacks can never accidentally take
    /// the restore mutex.
    maximize: MaximizeState,
    shutdown_requested: AtomicBool,
    bounds_saver: BoundsSaver,
}

/// Fake-maximize state of the main window: the pre-maximize bounds plus a
/// lock-free "is maximized" flag.
///
/// `Rect`s are copied in and out of the mutex, so no lock outlives a method
/// call and none is ever held while a window API runs. That matters because
/// tao dispatches `Resized`/`Moved` re-entrantly from inside
/// `SetWindowPos`/`SetWindowSize`: those events land in
/// `note_window_geometry_changed`, which reads only the atomic flag.
#[derive(Default)]
struct MaximizeState {
    restore: Mutex<Option<Rect>>,
    maximized: AtomicBool,
}

impl MaximizeState {
    /// Lock-free: safe from a window-event callback.
    fn is_maximized(&self) -> bool {
        self.maximized.load(Ordering::Acquire)
    }

    /// Whether a geometry change may be remembered. Reachable from the
    /// window-event callback, so it must never block.
    fn should_schedule_save(&self) -> bool {
        !self.is_maximized()
    }

    /// Record the pre-maximize bounds and flip the flag *before* the caller
    /// applies the maximized bounds: the re-entrant `Resized`/`Moved` events
    /// then skip the bounds saver instead of queueing the maximized frame.
    fn begin_maximize(&self, current: Rect) {
        *self.lock_restore() = Some(current);
        self.maximized.store(true, Ordering::Release);
    }

    /// Take the restore bounds (clearing the slot) without touching the flag:
    /// the caller applies them while the window still counts as maximized.
    fn take_restore(&self) -> Option<Rect> {
        self.lock_restore().take()
    }

    /// Put the restore bounds back after a failed restore.
    fn put_restore(&self, bounds: Rect) {
        *self.lock_restore() = Some(bounds);
    }

    /// The restore completed: the window is a normal window again.
    fn mark_restored(&self) {
        self.maximized.store(false, Ordering::Release);
    }

    /// Roll a failed maximize back to the pre-toggle state.
    fn cancel_maximize(&self) {
        *self.lock_restore() = None;
        self.maximized.store(false, Ordering::Release);
    }

    fn lock_restore(&self) -> std::sync::MutexGuard<'_, Option<Rect>> {
        self.restore
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }
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
    let Some(controller) = handle.try_state::<WindowController>() else {
        return Ok(());
    };
    // Reads the fake-maximize flag plus the window's own natively maximized
    // state, without holding any lock across the query.
    if !crate::window_geometry::should_persist_bounds(controller.is_maximized()) {
        return Ok(());
    }
    // The window may already be gone (teardown races the debounce): nothing to
    // remember then.
    let Ok(win) = main_window(handle) else {
        return Ok(());
    };
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

fn work_area_at(win: &WebviewWindow, physical_x: f64, physical_y: f64) -> Result<Rect, AppError> {
    let monitor = win
        .monitor_from_point(physical_x, physical_y)?
        .or_else(|| win.current_monitor().ok().flatten())
        .ok_or_else(|| AppError::message("无法获取显示器工作区"))?;
    Ok(monitor_work_area_logical(&monitor))
}

fn set_logical_bounds(win: &WebviewWindow, bounds: Rect) -> Result<(), AppError> {
    let scale = win.scale_factor()?;
    win.set_position(PhysicalPosition::new(
        (bounds.x as f64 * scale).round() as i32,
        (bounds.y as f64 * scale).round() as i32,
    ))?;
    win.set_size(PhysicalSize::new(
        (bounds.width as f64 * scale).round() as u32,
        (bounds.height as f64 * scale).round() as u32,
    ))?;
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
                maximize: MaximizeState::default(),
                shutdown_requested: AtomicBool::new(false),
                bounds_saver,
            }),
        }
    }

    /// Apply the remembered (or first-use) bounds and the desktop-window flags
    /// to the hidden main window. Runs once during setup, before the reveal.
    pub fn restore_main_bounds(&self) -> Result<(), AppError> {
        let win = main_window(&self.inner.handle)?;
        let monitor = win
            .current_monitor()
            .ok()
            .flatten()
            .or_else(|| win.primary_monitor().ok().flatten())
            .ok_or_else(|| AppError::message("无法获取显示器"))?;
        let work_area = monitor_work_area_logical(&monitor);
        let saved = saved_window_bounds(&self.inner.handle);
        let bounds = window_geometry::fit_main_window(saved, work_area);
        set_logical_bounds(&win, bounds)?;
        set_main_window_flags(&win)
    }

    /// A window resize/move was observed. The user's bounds are remembered
    /// (debounced); maximized frames are never persisted.
    pub fn note_window_geometry_changed(&self) {
        // Lock-free on purpose: tao dispatches window events re-entrantly from
        // inside SetWindowPos/SetWindowSize, which a command on the UI thread
        // may still be executing. No locks, no window APIs here.
        if !self.inner.maximize.should_schedule_save()
            || self.inner.shutdown_requested.load(Ordering::Acquire)
        {
            return;
        }
        self.inner.bounds_saver.request();
    }

    /// Whether the main window is maximized: either the fake maximize applied
    /// by this controller or a native maximize (Win+Up / aero snap) that only
    /// the window itself knows about. No lock is held while the window is
    /// queried, and window-event callbacks never call this (they read the
    /// atomic flag through `should_schedule_save`).
    pub fn is_maximized(&self) -> bool {
        if self.inner.maximize.is_maximized() {
            return true;
        }
        main_window(&self.inner.handle)
            .map(|win| win.is_maximized().unwrap_or(false))
            .unwrap_or(false)
    }

    pub fn toggle_maximized(&self) -> Result<bool, AppError> {
        let win = main_window(&self.inner.handle)?;
        // The restore bounds are copied out and the flag flipped BEFORE the
        // window APIs: Resized/Moved fire synchronously inside
        // set_position/set_size and re-enter the event handler, so no lock may
        // be held here (see note_window_geometry_changed).
        if let Some(bounds) = self.inner.maximize.take_restore() {
            if let Err(error) = set_logical_bounds(&win, bounds) {
                // The window may still be maximized: keep the toggle intact.
                self.inner.maximize.put_restore(bounds);
                return Err(error);
            }
            self.inner.maximize.mark_restored();
            return Ok(false);
        }
        let current = logical_rect(&win)?;
        let scale = win.scale_factor()?;
        let work = work_area_at(
            &win,
            (current.x + current.width / 2) as f64 * scale,
            (current.y + current.height / 2) as f64 * scale,
        )?;
        self.inner.maximize.begin_maximize(current);
        if let Err(error) = set_logical_bounds(&win, work) {
            self.inner.maximize.cancel_maximize();
            return Err(error);
        }
        Ok(true)
    }

    /// Restore a maximized window to its saved bounds before a titlebar drag,
    /// keeping the grab point under the cursor.
    pub fn start_titlebar_drag(&self) -> Result<(), AppError> {
        let win = main_window(&self.inner.handle)?;
        if let Some(saved) = self.inner.maximize.take_restore() {
            // Window APIs run with NO lock held (see note_window_geometry_changed).
            let restored = (|| {
                let current = logical_rect(&win)?;
                let scale = win.scale_factor()?;
                let cursor = platform::cursor_position()?;
                let x = cursor.0 as f64 / scale;
                let y = cursor.1 as f64 / scale;
                let ratio =
                    ((x - current.x as f64) / current.width.max(1) as f64).clamp(0.0, 1.0);
                let bounds = Rect {
                    x: (x - saved.width as f64 * ratio).round() as i32,
                    y: (y - (y - current.y as f64).clamp(0.0, 40.0)).round() as i32,
                    ..saved
                };
                set_logical_bounds(&win, bounds)
            })();
            match restored {
                Ok(()) => self.inner.maximize.mark_restored(),
                Err(error) => {
                    // Still maximized: the next drag retries the restore.
                    self.inner.maximize.put_restore(saved);
                    return Err(error);
                }
            }
        }
        self.inner
            .handle
            .emit("window:maximized-changed", false)?;
        win.start_dragging()?;
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

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: i32, y: i32, width: i32, height: i32) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn maximize_round_trip_keeps_the_restore_bounds() {
        let state = MaximizeState::default();
        let original = rect(40, 60, 1000, 700);
        assert!(state.should_schedule_save());
        state.begin_maximize(original);
        assert!(state.is_maximized());
        // While maximized, the re-entrant geometry events are ignored.
        assert!(!state.should_schedule_save());
        // The restore rect is returned once and the slot is emptied *before*
        // the caller touches the window.
        assert_eq!(state.take_restore(), Some(original));
        assert_eq!(state.take_restore(), None);
        state.mark_restored();
        assert!(!state.is_maximized());
        assert!(state.should_schedule_save());
    }

    #[test]
    fn a_failed_maximize_leaves_no_restore_bounds() {
        let state = MaximizeState::default();
        state.begin_maximize(rect(10, 20, 800, 600));
        state.cancel_maximize();
        assert!(!state.is_maximized());
        assert_eq!(state.take_restore(), None);
    }

    #[test]
    fn a_failed_restore_keeps_the_restore_bounds() {
        let state = MaximizeState::default();
        state.begin_maximize(rect(10, 20, 800, 600));
        let saved = state.take_restore().expect("restore bounds");
        state.put_restore(saved);
        // Still maximized, and the next toggle/drag retries the restore.
        assert!(state.is_maximized());
        assert_eq!(state.take_restore(), Some(saved));
    }

    /// tao re-enters the window-event handler while a window API is running.
    /// The handler path (`note_window_geometry_changed`) must never wait on the
    /// restore mutex, which the legacy implementation held across
    /// `set_position`/`set_size` — the self-deadlock that froze the UI thread.
    #[test]
    fn the_geometry_handler_ignores_the_restore_lock() {
        let state = Arc::new(MaximizeState::default());
        state.begin_maximize(rect(0, 0, 1280, 800));
        // A toggle is mid-flight on the UI thread: the restore slot is locked.
        let guard = state.lock_restore();
        let (sender, receiver) = mpsc::channel();
        let probe = {
            let state = Arc::clone(&state);
            std::thread::spawn(move || {
                let _ = sender.send((state.should_schedule_save(), state.is_maximized()));
            })
        };
        let observed = receiver
            .recv_timeout(Duration::from_secs(2))
            .expect("the geometry handler blocked on the restore lock");
        drop(guard);
        probe.join().expect("probe thread");
        assert_eq!(observed, (false, true));
    }

    /// Full toggle shape with the window API re-entering the handler on the
    /// same thread, as tao does: it must finish, must not queue the maximized
    /// frame for saving, and must queue the restored geometry afterwards.
    #[test]
    fn a_toggle_with_reentrant_geometry_events_completes() {
        let (sender, receiver) = mpsc::channel();
        let finished = std::thread::spawn(move || {
            let state = MaximizeState::default();
            let mut saves = Vec::new();
            // The "window": every applied bounds dispatches Resized/Moved
            // synchronously into the geometry handler.
            let mut apply = |state: &MaximizeState| saves.push(state.should_schedule_save());

            let original = rect(100, 100, 1000, 700);
            state.begin_maximize(original);
            apply(&state);
            let restore = state.take_restore().expect("restore bounds");
            apply(&state);
            state.mark_restored();
            apply(&state);
            let _ = sender.send(saves);
            restore
        });
        let saves = receiver
            .recv_timeout(Duration::from_secs(2))
            .expect("the toggle deadlocked on its own re-entrant events");
        let restore = finished.join().expect("toggle thread");
        assert_eq!(restore, rect(100, 100, 1000, 700));
        // Maximized: skipped; still maximized while restoring: skipped; after
        // the restore: remembered.
        assert_eq!(saves, vec![false, false, true]);
    }
}
