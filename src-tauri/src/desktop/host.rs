//! Desktop preferences and native window close requests.

use crate::desktop::prefs::{
    load as load_prefs, save as save_prefs, CloseBehavior, DesktopPreferences, GridSize,
    HistoryRetentionDays, TrayCloseBehavior,
};
use crate::desktop::{setup_tray, AutoStartManager};
use crate::error::AppError;
use crate::window_controller::WindowController;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow, WindowEvent};

/// Debug/dev builds never register auto-start and report the toggle as
/// unavailable. Detection mirrors `tauri::is_dev()` plus the explicit debug
/// assertions (dev runs through `npm run dev:rust` are debug builds).
pub fn is_dev_build() -> bool {
    tauri::is_dev() || cfg!(debug_assertions)
}

pub struct DesktopState {
    prefs: Mutex<DesktopPreferences>,
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

    fn edit(
        &self,
        edit: impl FnOnce(&mut DesktopPreferences) -> Result<(), AppError>,
    ) -> Result<DesktopPreferences, AppError> {
        let mut current = self
            .prefs
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let mut next = current.clone();
        edit(&mut next)?;
        if next != *current {
            save_prefs(&self.data_root, &next)?;
            self.capture.store(next.capture_enabled, Ordering::Release);
            *current = next.clone();
        }
        Ok(next)
    }

    /// Persist the titlebar pin choice; failures are logged, never surfaced.
    pub fn set_window_pinned(&self, pinned: bool) {
        if let Err(error) = self.edit(|prefs| {
            prefs.main_window_pinned = pinned;
            Ok(())
        }) {
            eprintln!("[desktop] failed to save pinned preference: {error}");
        }
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

    setup_tray(app.handle())?;
    Ok(())
}

/// Which settings a patch actually changed (drives side effects like an
/// immediate retention cleanup).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SettingsChange {
    pub retention_changed: bool,
}

#[derive(Default)]
pub struct SettingsPatch {
    pub close_behavior: Option<CloseBehavior>,
    pub tray_close_behavior: Option<TrayCloseBehavior>,
    pub auto_start: Option<bool>,
    pub capture_enabled: Option<bool>,
    pub history_retention_days: Option<HistoryRetentionDays>,
    pub snap_to_grid: Option<bool>,
    pub grid_size: Option<GridSize>,
}

/// Update settings from a renderer command; failures propagate to the caller
/// so the UI never shows a fabricated success.
pub fn update_settings(
    app: &AppHandle,
    state: &DesktopState,
    patch: SettingsPatch,
) -> Result<(DesktopPreferences, SettingsChange), AppError> {
    let mut change = SettingsChange::default();
    let mut capture_changed = false;
    let prefs = state.edit(|prefs| {
        if let Some(value) = patch.close_behavior {
            prefs.close_behavior = value;
        }
        if let Some(value) = patch.tray_close_behavior {
            prefs.tray_close_behavior = value;
        }
        if let Some(enabled) = patch.auto_start {
            state.auto_start.set_enabled(enabled)?;
            prefs.auto_start = enabled;
        }
        if let Some(enabled) = patch.capture_enabled {
            capture_changed = prefs.capture_enabled != enabled;
            prefs.capture_enabled = enabled;
        }
        if let Some(days) = patch.history_retention_days {
            change.retention_changed = prefs.history_retention_days != days;
            prefs.history_retention_days = days;
        }
        if let Some(snap) = patch.snap_to_grid {
            prefs.snap_to_grid = snap;
        }
        if let Some(size) = patch.grid_size {
            prefs.grid_size = size;
        }
        Ok(())
    })?;
    if capture_changed {
        publish_capture_state(app, state);
    }
    Ok((prefs, change))
}

pub(super) fn toggle_capture(app: &AppHandle) -> Result<(), AppError> {
    let state = app.state::<DesktopState>();
    state.edit(|prefs| {
        prefs.capture_enabled = !prefs.capture_enabled;
        Ok(())
    })?;
    publish_capture_state(app, &state);
    Ok(())
}

fn publish_capture_state(app: &AppHandle, state: &DesktopState) {
    let enabled = state.capture.load(Ordering::Acquire);
    super::tray::update_capture_menu(app, enabled);
    let _ = app.emit("desktop:capture-changed", enabled);
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
    if let Err(error) = state.edit(move |prefs| {
        prefs.window_bounds = Some(saved);
        Ok(())
    }) {
        eprintln!("[desktop] failed to save window bounds: {error}");
    }
}

/// Keep both webviews alive until an explicit process exit. Window operations
/// are deferred out of the native close callback.
pub fn install_close_behavior(window: &WebviewWindow) {
    let app = window.app_handle().clone();
    let is_tray = window.label() == "tray";
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let app = app.clone();
            crate::platform::spawn_worker("picboard-close-action", move || {
                if let Err(error) = apply_close_action(&app, is_tray) {
                    eprintln!("[desktop] close action failed: {error}");
                }
            });
        }
    });
}

fn apply_close_action(app: &AppHandle, is_tray: bool) -> Result<(), AppError> {
    let prefs = app.state::<DesktopState>().current();
    let controller = app.state::<WindowController>();
    if is_tray {
        match prefs.tray_close_behavior {
            TrayCloseBehavior::Tray => controller.hide_tray_panel(),
            TrayCloseBehavior::Quit => {
                app.exit(0);
                Ok(())
            }
        }
    } else {
        match prefs.close_behavior {
            CloseBehavior::Tray => controller.close_main_to_tray(false),
            CloseBehavior::Panel => controller.close_main_to_tray(true),
            CloseBehavior::Quit => {
                app.exit(0);
                Ok(())
            }
        }
    }
}
