//! Tauri command layer. Every `ImageBoardApi` method maps to one command with
//! the same parameters/return shape (camelCase DTO). Storage commands take a
//! short-lived lock on the shared storage so all read-modify-write transactions
//! serialize; window commands delegate to the `WindowController`.
//!
//! `Uint8Array` arguments arrive as `Vec<u8>` thanks to Tauri's IPC serializer;
//! `dataUrl` values never leave the snapshot (they are stripped before persist).

use crate::dto::{AppState, CanvasViewport, CopyResult, DesktopSettingsDto, ImportImagePayload, ImportViewport, PasteResult};
use crate::error::AppError;
use crate::preferences::{PreferenceStore, BALL_SETTINGS_KEY, PATH_SETTINGS_KEY};
use crate::storage::ImageBoardStorage;
use crate::window_controller::WindowController;
use serde_json::{json, Map, Value};
use std::sync::{Arc, Mutex};
use tauri::State;

pub type SharedStorage = Arc<Mutex<ImageBoardStorage>>;

fn with_storage<T>(
    storage: &State<'_, SharedStorage>,
    operation: impl FnOnce(&mut ImageBoardStorage) -> Result<T, AppError>,
) -> Result<T, AppError> {
    let mut guard = storage
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    operation(&mut guard)
}

#[tauri::command]
pub fn load_state(storage: State<'_, SharedStorage>) -> Result<AppState, AppError> {
    with_storage(&storage, |store| store.load_state())
}

#[tauri::command]
pub fn import_images(
    storage: State<'_, SharedStorage>,
    canvas_id: String,
    images: Vec<ImportImagePayload>,
    viewport: Option<ImportViewport>,
) -> Result<AppState, AppError> {
    with_storage(&storage, |store| store.import_images(&canvas_id, images, viewport))
}

#[tauri::command]
pub fn paste_image(
    storage: State<'_, SharedStorage>,
    canvas_id: String,
) -> Result<PasteResult, AppError> {
    with_storage(&storage, |store| {
        let (state, imported) = store.paste_image(&canvas_id)?;
        Ok(PasteResult { state, imported })
    })
}

#[tauri::command]
pub fn set_active_canvas(
    storage: State<'_, SharedStorage>,
    canvas_id: String,
) -> Result<AppState, AppError> {
    with_storage(&storage, |store| store.set_active_canvas(&canvas_id))
}

#[tauri::command]
pub fn set_canvas_viewport(
    storage: State<'_, SharedStorage>,
    canvas_id: String,
    viewport: CanvasViewport,
) -> Result<AppState, AppError> {
    with_storage(&storage, |store| store.set_canvas_viewport(&canvas_id, viewport))
}

#[tauri::command]
pub fn create_canvas(storage: State<'_, SharedStorage>) -> Result<AppState, AppError> {
    with_storage(&storage, |store| store.create_canvas())
}

#[tauri::command]
pub fn rename_canvas(
    storage: State<'_, SharedStorage>,
    canvas_id: String,
    name: String,
) -> Result<AppState, AppError> {
    with_storage(&storage, |store| store.rename_canvas(&canvas_id, &name))
}

#[tauri::command]
pub fn delete_canvas(
    storage: State<'_, SharedStorage>,
    canvas_id: String,
) -> Result<AppState, AppError> {
    with_storage(&storage, |store| store.delete_canvas(&canvas_id))
}

#[tauri::command]
pub fn create_category(
    storage: State<'_, SharedStorage>,
    name: String,
) -> Result<AppState, AppError> {
    with_storage(&storage, |store| store.create_category(&name))
}

#[tauri::command]
pub fn classify_images(
    storage: State<'_, SharedStorage>,
    image_ids: Vec<String>,
    category_id: String,
) -> Result<AppState, AppError> {
    with_storage(&storage, |store| store.classify_images(&image_ids, &category_id))
}

#[tauri::command]
pub fn remove_image_from_canvas(
    storage: State<'_, SharedStorage>,
    image_id: String,
) -> Result<AppState, AppError> {
    with_storage(&storage, |store| store.remove_image_from_canvas(&image_id))
}

#[tauri::command]
pub fn move_image(
    storage: State<'_, SharedStorage>,
    image_id: String,
    x: f64,
    y: f64,
) -> Result<AppState, AppError> {
    with_storage(&storage, |store| store.move_image(&image_id, x, y))
}

/// Copy image files to the Windows clipboard. Resolves and validates paths
/// while holding the storage lock, then releases it before touching the
/// clipboard so a slow/busy clipboard never blocks other storage work.
#[tauri::command]
pub fn copy_image_files(
    storage: State<'_, SharedStorage>,
    image_ids: Vec<String>,
) -> Result<CopyResult, AppError> {
    let paths = {
        let mut guard = storage
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        guard.image_paths(&image_ids)?
    };
    crate::clipboard::write_image_files(&paths)?;
    Ok(CopyResult { copied: paths.len() })
}

/// Returns validated migration preferences (if any) as a JSON object with the
/// two known keys; the renderer seeds its localStorage from this before React
/// initializes defaults.
#[tauri::command]
pub fn bootstrap_preferences(store: State<'_, PreferenceStore>) -> Result<Value, AppError> {
    let snapshot = store.snapshot();
    let mut object = Map::new();
    for key in [BALL_SETTINGS_KEY, PATH_SETTINGS_KEY] {
        if let Some(value) = snapshot.get(key) {
            let short = if key == BALL_SETTINGS_KEY {
                "ballSettings"
            } else {
                "pathSettings"
            };
            object.insert(short.to_string(), value.clone());
        }
    }
    Ok(json!(object))
}

#[tauri::command]
pub fn set_expanded(
    window: State<'_, WindowController>,
    expanded: bool,
) -> Result<(), AppError> {
    window.set_expanded(expanded)
}

#[tauri::command]
pub fn close_window(window: State<'_, WindowController>) -> Result<(), AppError> {
    window.close()
}

/// Read current desktop settings (close behavior + real auto-start state).
#[tauri::command]
pub fn get_desktop_settings(
    desktop: State<'_, crate::desktop::DesktopState>,
) -> Result<DesktopSettingsDto, AppError> {
    let prefs = desktop.current();
    Ok(DesktopSettingsDto {
        close_behavior: prefs.close_behavior,
        auto_start: prefs.auto_start,
        auto_start_available: desktop.auto_start.availability().available,
    })
}

/// Update desktop settings. In debug builds auto-start writes are rejected
/// before touching the registry; failures surface as errors.
#[tauri::command]
pub fn set_desktop_settings(
    desktop: State<'_, crate::desktop::DesktopState>,
    patch: Option<serde_json::Value>,
) -> Result<DesktopSettingsDto, AppError> {
    use crate::desktop::CloseBehavior;
    let patch = patch.unwrap_or_else(|| json!({}));
    let mut close_behavior: Option<CloseBehavior> = None;
    let mut auto_start: Option<bool> = None;
    if let Some(value) = patch.get("closeBehavior") {
        let behavior = value.as_str().ok_or_else(|| AppError::message("closeBehavior 必须是字符串"))?;
        close_behavior = Some(match behavior {
            "float" => CloseBehavior::Float,
            "tray" => CloseBehavior::Tray,
            "quit" => CloseBehavior::Quit,
            _ => return Err(AppError::message(format!("未知的 closeBehavior：{behavior}"))),
        });
    }
    if let Some(value) = patch.get("autoStart") {
        auto_start = Some(value.as_bool().ok_or_else(|| AppError::message("autoStart 必须是布尔值"))?);
    }
    if close_behavior.is_none() && auto_start.is_none() {
        // No-op: still return the current state.
    }
    let prefs = crate::desktop::update_settings(&desktop, close_behavior, auto_start)?;
    Ok(DesktopSettingsDto {
        close_behavior: prefs.close_behavior,
        auto_start: prefs.auto_start,
        auto_start_available: desktop.auto_start.availability().available,
    })
}

/// Narrow native directory picker (main window only). Cancel returns null.
#[tauri::command]
pub async fn pick_directory(
    window: tauri::WebviewWindow,
    initial_path: Option<String>,
) -> Result<Option<String>, AppError> {
    crate::desktop::pick_directory(&window, initial_path).await
}

#[tauri::command]
pub fn start_window_drag(window: State<'_, WindowController>) -> Result<(), AppError> {
    window.start_window_drag()
}

#[tauri::command]
pub fn end_window_drag(window: State<'_, WindowController>) -> Result<(), AppError> {
    window.end_window_drag();
    Ok(())
}
