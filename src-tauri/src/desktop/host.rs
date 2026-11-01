//! Desktop lifecycle host: owns the close behavior decision (float / tray /
//! quit), keeps React informed about window expansion, and exposes
//! `get/setDesktopSettings` + `pickDirectory` to the renderer.
//!
//! Close semantics (single entry point for both the renderer's × button and
//! the OS/system close path):
//! - float: collapse to the floating ball (same as "收起").
//! - tray: hide the window; process and tray stay alive.
//! - quit: quit the whole application.
//!
//! Window close requests funnel through the CloseRequested handler which may
//! `prevent_close`; the renderer is notified via `window:expanded-changed` so
//! UI state and the real window never disagree.

use crate::desktop::prefs::{
    load as load_prefs, save as save_prefs, CloseBehavior, DesktopPreferences, GridSize,
    HistoryRetentionDays,
};
use crate::desktop::{setup_tray, AutoStartManager};
use crate::error::AppError;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State, WebviewWindow, WindowEvent};

/// Debug/dev builds never register auto-start and report the toggle as
/// unavailable. Detection mirrors `tauri::is_dev()` plus the explicit debug
/// assertions (dev runs through `npm run dev:rust` are debug builds).
pub fn is_dev_build() -> bool {
    tauri::is_dev() || cfg!(debug_assertions)
}

pub struct DesktopState {
    pub prefs: Mutex<DesktopPreferences>,
    pub auto_start: AutoStartManager,
    pub data_root: PathBuf,
    /// Live clipboard-capture switch shared with the monitor thread, so
    /// pausing takes effect without restarting the listener. `true` = recording.
    capture: Arc<AtomicBool>,
}

impl DesktopState {
    pub fn current(&self) -> DesktopPreferences {
        self.prefs
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone()
    }

    /// `true` while clipboard capture is recording (mirrors `captureEnabled`).
    pub fn capture_enabled_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.capture)
    }
}

/// Setup hook: register the desktop host state and the tray icon.
pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let data_root = crate::resolve_data_root()?;
    let dev = is_dev_build();
    let auto_start = if dev {
        AutoStartManager::new_dev()
    } else {
        let exe = std::env::current_exe().unwrap_or_default();
        AutoStartManager::new_release(&exe)
    };
    let mut prefs = load_prefs(&data_root);
    // Auto-start state on disk is only a local cache of the last user choice;
    // the real current value always comes from the registry in release builds.
    prefs.auto_start = if dev { false } else { auto_start.is_enabled() };
    let _ = save_prefs(&data_root, &prefs);

    app.manage(DesktopState {
        prefs: Mutex::new(prefs.clone()),
        auto_start,
        data_root,
        capture: Arc::new(AtomicBool::new(prefs.capture_enabled)),
    });

    // Tray is always created: with closeBehavior tray/float it is the way the
    // window can be restored; even under "quit" a tray exit stays available.
    setup_tray(app.handle())?;
    Ok(())
}

/// Which settings a patch actually changed (drives side effects like an
/// immediate retention cleanup).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SettingsChange {
    pub retention_changed: bool,
}

/// Update settings from a renderer command; failures propagate to the caller
/// so the UI never shows a fabricated success.
pub fn update_settings(
    state: &State<'_, DesktopState>,
    close_behavior: Option<CloseBehavior>,
    auto_start: Option<bool>,
    capture_enabled: Option<bool>,
    history_retention_days: Option<HistoryRetentionDays>,
    snap_to_grid: Option<bool>,
    grid_size: Option<GridSize>,
) -> Result<(DesktopPreferences, SettingsChange), AppError> {
    let mut prefs = state.current();
    let previous_retention = prefs.history_retention_days;
    if let Some(value) = close_behavior {
        prefs.close_behavior = value;
    }
    if let Some(enabled) = auto_start {
        state.auto_start.set_enabled(enabled)?;
        prefs.auto_start = enabled;
    }
    if let Some(enabled) = capture_enabled {
        prefs.capture_enabled = enabled;
    }
    if let Some(days) = history_retention_days {
        prefs.history_retention_days = days;
    }
    if let Some(snap) = snap_to_grid {
        prefs.snap_to_grid = snap;
    }
    if let Some(size) = grid_size {
        prefs.grid_size = size;
    }
    save_prefs(&state.data_root, &prefs)?;
    state
        .capture
        .store(prefs.capture_enabled, Ordering::Release);
    *state
        .prefs
        .lock()
        .unwrap_or_else(|poison| poison.into_inner()) = prefs.clone();
    let change = SettingsChange {
        retention_changed: prefs.history_retention_days != previous_retention,
    };
    Ok((prefs, change))
}

/// Remember the user-chosen bounds of the expanded window. Called (debounced)
/// from the window controller whenever the user resizes or moves the expanded
/// window; failures are logged, never surfaced to the renderer.
pub fn remember_window_bounds(
    app: &AppHandle,
    bounds: &crate::window_geometry::Rect,
    monitor: Option<String>,
) {
    let Some(state) = app.try_state::<DesktopState>() else {
        return;
    };
    let saved = crate::desktop::SavedWindowBounds {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        monitor,
    };
    let mut prefs = state.current();
    if prefs.window_bounds.as_ref() == Some(&saved) {
        return;
    }
    prefs.window_bounds = Some(saved);
    if let Err(error) = save_prefs(&state.data_root, &prefs) {
        eprintln!("[desktop] failed to save window bounds: {error}");
        return;
    }
    *state
        .prefs
        .lock()
        .unwrap_or_else(|poison| poison.into_inner()) = prefs;
}

/// Install the close-request interception on the main window. Both the
/// renderer × button (`closeWindow`) and any system close path end here.
///
/// All three behaviors prevent the raw close because a live tray icon keeps
/// the process running; quitting must therefore exit the app explicitly.
///
/// Only `prevent_close()` (a flag) runs inside the callback: hiding or exiting
/// re-entrantly from the event dispatch is what froze the UI thread, so the
/// action itself is deferred to a worker.
pub fn install_close_behavior(window: &WebviewWindow) -> Result<(), AppError> {
    let app = window.app_handle().clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            let Some(state) = app.try_state::<DesktopState>() else {
                return;
            };
            let behavior = state.current().close_behavior;
            api.prevent_close();
            let app = app.clone();
            crate::platform::spawn_worker("picboard-close-action", move || {
                if let Err(error) = apply_close_action(&app, behavior) {
                    eprintln!("[desktop] close action failed: {error}");
                }
            });
        }
    });
    Ok(())
}

/// Perform the close action after a prevented close: hide into the tray or
/// fully quit (exit kills the tray too).
pub fn apply_close_action(app: &AppHandle, behavior: CloseBehavior) -> Result<(), AppError> {
    match behavior {
        CloseBehavior::Quit => {
            app.exit(0);
            Ok(())
        }
        CloseBehavior::Tray => {
            let window = app
                .get_webview_window("main")
                .ok_or_else(|| AppError::message("主窗口不存在"))?;
            if let Some(readiness) = app.try_state::<crate::startup_readiness::StartupReadiness>() {
                readiness.mark_user_hidden("main");
            }
            // Hiding keeps the process, the tray icon and the background
            // clipboard capture alive.
            window.hide()?;
            Ok(())
        }
    }
}
