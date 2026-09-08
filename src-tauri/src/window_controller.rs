//! Main-window host controller.
//!
//! Mirrors Electron's `electron/main/index.ts` window behavior:
//! - collapsed window 88x88 at primary work area top-right (right-112, top+20);
//! - expansion/collapse follows `shared/window-geometry.ts` semantics;
//! - ball drag polls every ~8 ms, constrained to the matching monitor's work
//!   area; release flushes the final position;
//! - cursor tracking emits `window:cursor-position` every ~50 ms and pauses
//!   while a custom drag is running.
//!
//! Coordinate policy: Win32 cursor and Tauri outer position/size are physical.
//! This module converts to logical (CSS) pixels at the boundary using the
//! window's scale factor so the payload matches the Electron contract
//! (`x - windowX` equals the window-local CSS offset). Geometry math stays in
//! logical units; only position/size/monitor lookups convert back.

use crate::error::AppError;
use crate::platform;
use crate::window_geometry::{self, Rect, WindowGeometryState};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

const COLLAPSED_SIZE: f64 = 88.0;
const DRAG_POLL_MS: u64 = 8;
const CURSOR_POLL_MS: u64 = 50;
const MAX_EMPTY_CURSOR_LOOPS: u32 = 60;

struct Inner {
    handle: AppHandle,
    geometry: Mutex<WindowGeometryState>,
    cursor_active: AtomicBool,
    drag_active: AtomicBool,
    shutdown_requested: AtomicBool,
    drag_start: Mutex<Option<DragAnchor>>,
    drag_operation: Mutex<()>,
    cursor_thread: Mutex<Option<std::thread::JoinHandle<()>>>,
    drag_thread: Mutex<Option<std::thread::JoinHandle<()>>>,
}

#[derive(Clone, Copy)]
struct DragAnchor {
    cursor_x: f64,
    cursor_y: f64,
    window_x: f64,
    window_y: f64,
    width: f64,
    height: f64,
}

#[derive(Clone)]
pub struct WindowController {
    inner: Arc<Inner>,
}

fn main_window(app: &AppHandle) -> Result<WebviewWindow, AppError> {
    app.get_webview_window("main")
        .ok_or_else(|| AppError::message("主窗口不存在"))
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
fn work_area_at(win: &WebviewWindow, physical_x: f64, physical_y: f64) -> Result<Rect, AppError> {
    let monitor = win
        .monitor_from_point(physical_x, physical_y)?
        .or_else(|| win.current_monitor().ok().flatten())
        .ok_or_else(|| AppError::message("无法获取显示器工作区"))?;
    let wa = monitor.work_area();
    let scale = monitor.scale_factor();
    Ok(Rect {
        x: (wa.position.x as f64 / scale).round() as i32,
        y: (wa.position.y as f64 / scale).round() as i32,
        width: (wa.size.width as f64 / scale).round() as i32,
        height: (wa.size.height as f64 / scale).round() as i32,
    })
}

fn set_logical_bounds(win: &WebviewWindow, bounds: Rect) -> Result<(), AppError> {
    let scale = win.scale_factor()?;
    eprintln!(
        "[window] set_logical_bounds -> {:?} (scale {scale})",
        bounds
    );
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

/// Compute the next logical position for the active drag.
fn drag_target(inner: &Inner, scale: f64) -> Result<Option<Rect>, AppError> {
    let anchor = match *inner
        .drag_start
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
    {
        Some(anchor) => anchor,
        None => return Ok(None),
    };
    let cursor = platform::cursor_position()?;
    let cursor_x = cursor.0 as f64 / scale;
    let cursor_y = cursor.1 as f64 / scale;
    let candidate = Rect {
        x: (anchor.window_x + cursor_x - anchor.cursor_x).round() as i32,
        y: (anchor.window_y + cursor_y - anchor.cursor_y).round() as i32,
        width: anchor.width.round() as i32,
        height: anchor.height.round() as i32,
    };
    let win = main_window(&inner.handle)?;
    let cx = (candidate.x + candidate.width / 2) as f64 * scale;
    let cy = (candidate.y + candidate.height / 2) as f64 * scale;
    let work_area = work_area_at(&win, cx, cy)?;
    Ok(Some(window_geometry::fit_window_to_work_area(
        candidate, work_area, false,
    )))
}

impl WindowController {
    pub fn new(handle: AppHandle) -> Self {
        Self {
            inner: Arc::new(Inner {
                handle,
                geometry: Mutex::new(window_geometry::create_window_geometry_state()),
                cursor_active: AtomicBool::new(false),
                drag_active: AtomicBool::new(false),
                shutdown_requested: AtomicBool::new(false),
                drag_start: Mutex::new(None),
                drag_operation: Mutex::new(()),
                cursor_thread: Mutex::new(None),
                drag_thread: Mutex::new(None),
            }),
        }
    }

    /// Place the collapsed window at the primary work area right-112 / top+20.
    pub fn place_initial(&self) -> Result<(), AppError> {
        let win = main_window(&self.inner.handle)?;
        let primary = win
            .primary_monitor()?
            .ok_or_else(|| AppError::message("无法获取主显示器"))?;
        let wa = primary.work_area();
        let scale = primary.scale_factor();
        let work = Rect {
            x: (wa.position.x as f64 / scale).round() as i32,
            y: (wa.position.y as f64 / scale).round() as i32,
            width: (wa.size.width as f64 / scale).round() as i32,
            height: (wa.size.height as f64 / scale).round() as i32,
        };
        let bounds = Rect {
            x: work.x + work.width - 112,
            y: work.y + 20,
            width: COLLAPSED_SIZE.round() as i32,
            height: COLLAPSED_SIZE.round() as i32,
        };
        set_logical_bounds(&win, bounds)
    }

    /// Expand or collapse the window (renderer-initiated). The renderer has
    /// already switched its own React state, so the host only resizes and does
    /// not echo `window:expanded-changed` back (avoids event recursion).
    pub fn set_expanded(&self, expanded: bool) -> Result<(), AppError> {
        apply_expansion(&self.inner.handle, expanded, false)
    }

    pub fn is_expanded(&self) -> bool {
        self.inner
            .geometry
            .lock()
            .map(|state| state.expanded)
            .unwrap_or(false)
    }

    /// Begin the custom drag. Idempotent and serialized against end/cancel.
    pub fn start_window_drag(&self) -> Result<(), AppError> {
        let _operation = self
            .inner
            .drag_operation
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if self.inner.shutdown_requested.load(Ordering::Acquire) {
            return Err(AppError::message("窗口正在销毁"));
        }
        let mut thread_slot = self
            .inner
            .drag_thread
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if self.inner.drag_active.load(Ordering::Acquire) {
            return Ok(());
        }
        let previous = thread_slot.take();
        drop(thread_slot);
        if let Some(previous) = previous {
            let _ = previous.join();
        }
        let win = main_window(&self.inner.handle)?;
        let cursor = platform::cursor_position()?;
        let scale = win.scale_factor()?;
        let rect = logical_rect(&win)?;
        *self
            .inner
            .drag_start
            .lock()
            .unwrap_or_else(|poison| poison.into_inner()) = Some(DragAnchor {
            cursor_x: cursor.0 as f64 / scale,
            cursor_y: cursor.1 as f64 / scale,
            window_x: rect.x as f64,
            window_y: rect.y as f64,
            width: rect.width as f64,
            height: rect.height as f64,
        });
        self.inner.drag_active.store(true, Ordering::Release);
        let inner = Arc::clone(&self.inner);
        let thread = std::thread::spawn(move || {
            let mut released_since = 0u32;
            while inner.drag_active.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(DRAG_POLL_MS));
                if !inner.drag_active.load(Ordering::SeqCst) {
                    break;
                }
                // Host-side fallback: if the physical left button is up for a
                // few consecutive polls, the renderer missed the release (e.g.
                // pointer capture loss). End the drag instead of leaving a
                // ghost loop that keeps re-applying the boundary position.
                if platform::left_button_released() {
                    released_since += 1;
                    // ~120ms of released button is enough to declare the drag over.
                    if released_since >= 15 {
                        eprintln!("[window] drag auto-ended (left button released)");
                        inner.drag_active.store(false, Ordering::Release);
                        inner
                            .drag_start
                            .lock()
                            .unwrap_or_else(|poison| poison.into_inner())
                            .take();
                        spawn_cursor_thread(&inner);
                        break;
                    }
                } else {
                    released_since = 0;
                }
                let result = (|| -> Result<(), AppError> {
                    let win = main_window(&inner.handle)?;
                    let scale = win.scale_factor()?;
                    if let Some(bounds) = drag_target(&inner, scale)? {
                        set_logical_bounds(&win, bounds)?;
                    }
                    Ok(())
                })();
                if let Err(error) = result {
                    eprintln!("[window] drag poll failed: {error}");
                    inner.drag_active.store(false, Ordering::Release);
                    break;
                }
            }
        });
        *self
            .inner
            .drag_thread
            .lock()
            .unwrap_or_else(|poison| poison.into_inner()) = Some(thread);
        Ok(())
    }

    /// End the custom drag with a final position flush. Idempotent.
    pub fn end_window_drag(&self) {
        let _operation = self
            .inner
            .drag_operation
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let was_active = self.inner.drag_active.swap(false, Ordering::AcqRel);
        if let Some(thread) = self
            .inner
            .drag_thread
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .take()
        {
            let _ = thread.join();
        }
        if !was_active {
            self.inner
                .drag_start
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .take();
            return;
        }
        let flushed = (|| -> Result<(), AppError> {
            let win = main_window(&self.inner.handle)?;
            let scale = win.scale_factor()?;
            if let Some(bounds) = drag_target(&self.inner, scale)? {
                set_logical_bounds(&win, bounds)?;
            }
            Ok(())
        })();
        if let Err(error) = flushed {
            eprintln!("[window] drag release flush failed: {error}");
        }
        self.inner
            .drag_start
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .take();
        self.start_cursor_tracking();
    }

    /// Start the 50ms cursor publisher. Idempotent.
    pub fn start_cursor_tracking(&self) {
        if self.inner.shutdown_requested.load(Ordering::Acquire) {
            return;
        }
        spawn_cursor_thread(&self.inner);
    }

    /// Stop the cursor publisher and wait for its thread.
    pub fn stop_cursor_tracking(&self) {
        self.inner.cursor_active.store(false, Ordering::Release);
        if let Some(thread) = self
            .inner
            .cursor_thread
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .take()
        {
            let _ = thread.join();
        }
    }

    /// Stop the drag loop without a final flush. Teardown only signals the
    /// worker; it never joins from a UI callback or close path.
    pub fn cancel_drag(&self) {
        let _operation = self
            .inner
            .drag_operation
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        self.inner.drag_active.store(false, Ordering::Release);
        self.inner
            .drag_start
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .take();
    }

    /// Signal all background loops to stop and asynchronously reclaim their
    /// handles. This is safe from window destruction callbacks.
    pub fn request_teardown(&self) {
        self.inner.shutdown_requested.store(true, Ordering::Release);
        self.inner.cursor_active.store(false, Ordering::Release);
        self.inner.drag_active.store(false, Ordering::Release);
        self.inner
            .drag_start
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .take();
        let inner = Arc::clone(&self.inner);
        std::thread::spawn(move || {
            if let Some(thread) = inner
                .drag_thread
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .take()
            {
                let _ = thread.join();
            }
            if let Some(thread) = inner
                .cursor_thread
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .take()
            {
                let _ = thread.join();
            }
        });
    }

    pub fn close(&self) -> Result<(), AppError> {
        let win = main_window(&self.inner.handle)?;
        win.close()?;
        Ok(())
    }
}

/// Shared expansion primitive used by renderer commands, tray actions and the
/// float close path: resize the native window and optionally emit
/// `window:expanded-changed` so React can follow. Host/tray/close paths emit
/// the event; the renderer command does not (React already flipped its own
/// state and would otherwise enter an event loop).
pub fn set_window_expanded_state(app: &tauri::AppHandle, expanded: bool) -> Result<(), AppError> {
    apply_expansion(app, expanded, true)
}

fn apply_expansion(
    app: &tauri::AppHandle,
    expanded: bool,
    notify_renderer: bool,
) -> Result<(), AppError> {
    use tauri::Emitter;
    let controller = app
        .try_state::<WindowController>()
        .ok_or_else(|| AppError::message("窗口控制器未初始化"))?;
    eprintln!("[window] apply_expansion({expanded}, notify={notify_renderer})");
    let win = main_window(app)?;
    let mut state = controller
        .inner
        .geometry
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    // Resize only when the real geometry differs; the renderer notification is
    // still sent below even when they already match (e.g. tray re-open after a
    // hide left the geometry expanded but React was told collapsed).
    if state.expanded != expanded {
        let current = logical_rect(&win)?;
        let scale = win.scale_factor()?;
        let (anchor_x, anchor_y) = if !expanded && state.collapsed_bounds.is_some() {
            let bounds = state.collapsed_bounds.unwrap_or(current);
            (
                (bounds.x + bounds.width / 2) as f64 * scale,
                (bounds.y + bounds.height / 2) as f64 * scale,
            )
        } else {
            (
                (current.x + current.width / 2) as f64 * scale,
                (current.y + current.height / 2) as f64 * scale,
            )
        };
        let work_area = work_area_at(&win, anchor_x, anchor_y)?;
        let (bounds, changed) =
            window_geometry::transition_window_expansion(current, work_area, expanded, &mut state);
        if changed {
            set_logical_bounds(&win, bounds)?;
        }
    }
    drop(state);
    if notify_renderer {
        app.emit("window:expanded-changed", expanded)?;
    }
    Ok(())
}

/// Start the 50ms cursor-position publisher thread if it is not already
/// running. Idempotent; safe to call from any thread (including the drag loop
/// after an auto-end).
fn spawn_cursor_thread(inner: &Arc<Inner>) {
    if inner.shutdown_requested.load(Ordering::Acquire)
        || inner.cursor_active.swap(true, Ordering::AcqRel)
    {
        return;
    }
    let thread_inner = Arc::clone(inner);
    let thread = std::thread::spawn(move || {
        let mut empty_loops = 0u32;
        while thread_inner.cursor_active.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(CURSOR_POLL_MS));
            if !thread_inner.cursor_active.load(Ordering::SeqCst)
                || thread_inner.drag_active.load(Ordering::SeqCst)
            {
                continue;
            }
            let Ok(window) = main_window(&thread_inner.handle) else {
                continue;
            };
            let Ok(cursor) = platform::cursor_position() else {
                empty_loops += 1;
                if empty_loops >= MAX_EMPTY_CURSOR_LOOPS {
                    break;
                }
                continue;
            };
            empty_loops = 0;
            let Ok(scale) = window.scale_factor() else {
                continue;
            };
            let Ok(pos) = window.outer_position() else {
                continue;
            };
            let payload = serde_json::json!({
                "x": (cursor.0 as f64 / scale).round(),
                "y": (cursor.1 as f64 / scale).round(),
                "windowX": (pos.x as f64 / scale).round(),
                "windowY": (pos.y as f64 / scale).round(),
            });
            let _ = window.emit("window:cursor-position", payload);
        }
        thread_inner.cursor_active.store(false, Ordering::Release);
    });
    *inner
        .cursor_thread
        .lock()
        .unwrap_or_else(|poison| poison.into_inner()) = Some(thread);
}
