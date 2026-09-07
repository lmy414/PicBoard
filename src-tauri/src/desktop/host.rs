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

use crate::desktop::prefs::{load as load_prefs, save as save_prefs, CloseBehavior, DesktopPreferences};
use crate::desktop::{AutoStartManager, setup_tray};
use crate::error::AppError;
use std::path::PathBuf;
use std::sync::Mutex;
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
}

impl DesktopState {
    pub fn current(&self) -> DesktopPreferences {
        self.prefs.lock().unwrap_or_else(|poison| poison.into_inner()).clone()
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
        prefs: Mutex::new(prefs),
        auto_start,
        data_root,
    });

    // Tray is always created: with closeBehavior tray/float it is the way the
    // window can be restored; even under "quit" a tray exit stays available.
    setup_tray(app.handle())?;
    Ok(())
}

/// Update settings from a renderer command; failures propagate to the caller
/// so the UI never shows a fabricated success.
pub fn update_settings(
    state: &State<'_, DesktopState>,
    close_behavior: Option<CloseBehavior>,
    auto_start: Option<bool>,
) -> Result<DesktopPreferences, AppError> {
    let mut prefs = state.current();
    if let Some(value) = close_behavior {
        prefs.close_behavior = value;
    }
    if let Some(enabled) = auto_start {
        state.auto_start.set_enabled(enabled)?;
        prefs.auto_start = enabled;
    }
    save_prefs(&state.data_root, &prefs)?;
    *state.prefs.lock().unwrap_or_else(|poison| poison.into_inner()) = prefs.clone();
    Ok(prefs)
}

/// Install the close-request interception on the main window. Both the
/// renderer × button (`closeWindow`) and any system close path end here.
///
/// All three behaviors prevent the raw close because a live tray icon keeps
/// the process running; quitting must therefore exit the app explicitly.
pub fn install_close_behavior(window: &WebviewWindow) -> Result<(), AppError> {
    let app = window.app_handle().clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            let Some(state) = app.try_state::<DesktopState>() else {
                return;
            };
            let behavior = state.current().close_behavior;
            api.prevent_close();
            let _ = apply_close_action(&app, behavior);
        }
    });
    Ok(())
}

/// Perform the close action after a prevented close: collapse to ball, hide,
/// or fully quit (exit kills the tray too).
pub fn apply_close_action(app: &AppHandle, behavior: CloseBehavior) -> Result<(), AppError> {
    match behavior {
        CloseBehavior::Quit => {
            app.exit(0);
            Ok(())
        }
        CloseBehavior::Float => {
            crate::window_controller::set_window_expanded_state(app, false)?;
            if let Some(window) = app.get_webview_window("main") {
                window.show()?;
            }
            Ok(())
        }
        CloseBehavior::Tray => {
            let window = app
                .get_webview_window("main")
                .ok_or_else(|| AppError::message("主窗口不存在"))?;
            app.state::<crate::window_controller::WindowController>().cancel_drag();
            app.state::<crate::window_controller::WindowController>().stop_cursor_tracking();
            crate::window_controller::set_window_expanded_state(app, false)?;
            window.hide()?;
            Ok(())
        }
    }
}
