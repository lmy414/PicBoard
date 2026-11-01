//! Tauri command layer. Every `ImageBoardApi` method maps to one command with
//! the same parameters/return shape (camelCase DTO). Storage commands take a
//! short-lived lock on the shared storage so all read-modify-write transactions
//! serialize; clipboard commands read/write the system clipboard *outside* that
//! lock; window commands delegate to the `WindowController`.
//!
//! `Uint8Array` arguments arrive as `Vec<u8>` thanks to Tauri's IPC serializer.

use crate::clipboard::{self, CopyContent};
use crate::dto::{
    AppState, CanvasFrame, CanvasPoint, CanvasViewport, ContentAsset, ContentBody, CopyResult,
    DesktopSettingsDto, ImportImagePayload, ImportViewport, MainNavigation, NodeMove, PasteResult,
    PluginListing,
};
use crate::error::AppError;
use crate::preferences::{PreferenceStore, BALL_SETTINGS_KEY, PATH_SETTINGS_KEY};
use crate::storage::ImageBoardStorage;
use crate::window_controller::WindowController;
use crate::SharedStorage;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, State};

fn with_storage<T>(
    storage: &State<'_, SharedStorage>,
    operation: impl FnOnce(&mut ImageBoardStorage) -> Result<T, AppError>,
) -> Result<T, AppError> {
    let mut guard = storage.lock().unwrap_or_else(|poison| poison.into_inner());
    operation(&mut guard)
}

/// Broadcast a new snapshot to every window (main + tray panel). Renderers
/// drop snapshots whose revision is older than the one they hold.
fn broadcast(app: &AppHandle, state: &AppState) {
    let _ = app.emit(crate::STATE_CHANGED_EVENT, state);
}

#[tauri::command]
pub fn load_state(storage: State<'_, SharedStorage>) -> Result<AppState, AppError> {
    with_storage(&storage, |store| store.load_state())
}

#[tauri::command]
pub fn paste_clipboard(
    app: AppHandle,
    storage: State<'_, SharedStorage>,
    canvas_id: String,
    viewport: Option<ImportViewport>,
) -> Result<PasteResult, AppError> {
    let capture = clipboard::read_capture()?;
    let result = with_storage(&storage, |store| {
        let (state, placed) = store.paste_clipboard(&canvas_id, viewport, capture)?;
        Ok(PasteResult { state, placed })
    })?;
    broadcast(&app, &result.state);
    Ok(result)
}

#[tauri::command]
pub fn place_content(
    app: AppHandle,
    storage: State<'_, SharedStorage>,
    content_id: String,
    canvas_id: String,
    center: CanvasPoint,
) -> Result<AppState, AppError> {
    let state = with_storage(&storage, |store| {
        store.place_content(&content_id, &canvas_id, center)
    })?;
    broadcast(&app, &state);
    Ok(state)
}

#[tauri::command]
pub fn set_active_canvas(
    app: AppHandle,
    storage: State<'_, SharedStorage>,
    canvas_id: String,
) -> Result<AppState, AppError> {
    let state = with_storage(&storage, |store| store.set_active_canvas(&canvas_id))?;
    broadcast(&app, &state);
    Ok(state)
}

#[tauri::command]
pub fn set_canvas_viewport(
    app: AppHandle,
    storage: State<'_, SharedStorage>,
    canvas_id: String,
    viewport: CanvasViewport,
) -> Result<AppState, AppError> {
    let state = with_storage(&storage, |store| {
        store.set_canvas_viewport(&canvas_id, viewport)
    })?;
    broadcast(&app, &state);
    Ok(state)
}

#[tauri::command]
pub fn create_canvas(
    app: AppHandle,
    storage: State<'_, SharedStorage>,
    parent_id: Option<String>,
    frame: Option<CanvasFrame>,
) -> Result<AppState, AppError> {
    let state = with_storage(&storage, |store| store.create_canvas(parent_id, frame))?;
    broadcast(&app, &state);
    Ok(state)
}

#[tauri::command]
pub fn move_canvas(
    app: AppHandle,
    storage: State<'_, SharedStorage>,
    canvas_id: String,
    parent_id: Option<String>,
    index: Option<usize>,
) -> Result<AppState, AppError> {
    let state = with_storage(&storage, |store| {
        store.move_canvas(&canvas_id, parent_id, index)
    })?;
    broadcast(&app, &state);
    Ok(state)
}

#[tauri::command]
pub fn set_canvas_frame(
    app: AppHandle,
    storage: State<'_, SharedStorage>,
    canvas_id: String,
    frame: CanvasFrame,
) -> Result<AppState, AppError> {
    let state = with_storage(&storage, |store| store.set_canvas_frame(&canvas_id, frame))?;
    broadcast(&app, &state);
    Ok(state)
}

#[tauri::command]
pub fn group_nodes_into_canvas(
    app: AppHandle,
    storage: State<'_, SharedStorage>,
    node_ids: Vec<String>,
) -> Result<AppState, AppError> {
    let state = with_storage(&storage, |store| store.group_nodes_into_canvas(&node_ids))?;
    broadcast(&app, &state);
    Ok(state)
}

#[tauri::command]
pub fn ungroup_canvas(
    app: AppHandle,
    storage: State<'_, SharedStorage>,
    canvas_id: String,
) -> Result<AppState, AppError> {
    let state = with_storage(&storage, |store| store.ungroup_canvas(&canvas_id))?;
    broadcast(&app, &state);
    Ok(state)
}

#[tauri::command]
pub fn move_nodes_to_canvas(
    app: AppHandle,
    storage: State<'_, SharedStorage>,
    node_ids: Vec<String>,
    target_canvas_id: String,
    origin: CanvasPoint,
) -> Result<AppState, AppError> {
    let state = with_storage(&storage, |store| {
        store.move_nodes_to_canvas(&node_ids, &target_canvas_id, origin)
    })?;
    broadcast(&app, &state);
    Ok(state)
}

#[tauri::command]
pub fn rename_canvas(
    app: AppHandle,
    storage: State<'_, SharedStorage>,
    canvas_id: String,
    name: String,
) -> Result<AppState, AppError> {
    let state = with_storage(&storage, |store| store.rename_canvas(&canvas_id, &name))?;
    broadcast(&app, &state);
    Ok(state)
}

#[tauri::command]
pub fn delete_canvas(
    app: AppHandle,
    storage: State<'_, SharedStorage>,
    canvas_id: String,
) -> Result<AppState, AppError> {
    let state = with_storage(&storage, |store| store.delete_canvas(&canvas_id))?;
    broadcast(&app, &state);
    Ok(state)
}

#[tauri::command]
pub fn move_nodes(
    app: AppHandle,
    storage: State<'_, SharedStorage>,
    moves: Vec<NodeMove>,
) -> Result<AppState, AppError> {
    let state = with_storage(&storage, |store| store.move_nodes(&moves))?;
    broadcast(&app, &state);
    Ok(state)
}

#[tauri::command]
pub fn remove_nodes(
    app: AppHandle,
    storage: State<'_, SharedStorage>,
    node_ids: Vec<String>,
) -> Result<AppState, AppError> {
    let state = with_storage(&storage, |store| store.remove_nodes(&node_ids))?;
    broadcast(&app, &state);
    Ok(state)
}

#[tauri::command]
pub fn create_edge(
    app: AppHandle,
    storage: State<'_, SharedStorage>,
    from_node_id: String,
    to_node_id: String,
) -> Result<AppState, AppError> {
    let state = with_storage(&storage, |store| {
        store.create_edge(&from_node_id, &to_node_id)
    })?;
    broadcast(&app, &state);
    Ok(state)
}

#[tauri::command]
pub fn delete_edges(
    app: AppHandle,
    storage: State<'_, SharedStorage>,
    edge_ids: Vec<String>,
) -> Result<AppState, AppError> {
    let state = with_storage(&storage, |store| store.delete_edges(&edge_ids))?;
    broadcast(&app, &state);
    Ok(state)
}

#[tauri::command]
pub fn get_content_body(
    storage: State<'_, SharedStorage>,
    content_id: String,
) -> Result<ContentBody, AppError> {
    with_storage(&storage, |store| store.get_content_body(&content_id))
}

#[tauri::command]
pub fn update_text_content(
    app: AppHandle,
    storage: State<'_, SharedStorage>,
    content_id: String,
    body: ContentBody,
) -> Result<AppState, AppError> {
    let state = with_storage(&storage, |store| {
        store.update_text_content(&content_id, body)
    })?;
    broadcast(&app, &state);
    Ok(state)
}

#[tauri::command]
pub fn update_link_content(
    app: AppHandle,
    storage: State<'_, SharedStorage>,
    content_id: String,
    url: String,
) -> Result<AppState, AppError> {
    let state = with_storage(&storage, |store| {
        store.update_link_content(&content_id, &url)
    })?;
    broadcast(&app, &state);
    Ok(state)
}

#[tauri::command]
pub fn rename_image(
    app: AppHandle,
    storage: State<'_, SharedStorage>,
    content_id: String,
    name: String,
) -> Result<AppState, AppError> {
    let state = with_storage(&storage, |store| store.rename_image(&content_id, &name))?;
    broadcast(&app, &state);
    Ok(state)
}

#[tauri::command]
pub fn add_content_asset(
    storage: State<'_, SharedStorage>,
    content_id: String,
    image: ImportImagePayload,
) -> Result<ContentAsset, AppError> {
    with_storage(&storage, |store| store.add_content_asset(&content_id, image))
}

#[tauri::command]
pub fn delete_contents(
    app: AppHandle,
    storage: State<'_, SharedStorage>,
    content_ids: Vec<String>,
) -> Result<AppState, AppError> {
    let state = with_storage(&storage, |store| store.delete_contents(&content_ids))?;
    broadcast(&app, &state);
    Ok(state)
}

/// Resolve the clipboard payloads under the lock, publish them without it, then
/// bump the recency clock in a second short lock.
#[tauri::command]
pub fn copy_contents(
    app: AppHandle,
    storage: State<'_, SharedStorage>,
    content_ids: Vec<String>,
) -> Result<CopyResult, AppError> {
    let items = with_storage(&storage, |store| store.copy_payloads(&content_ids))?;
    if items.is_empty() {
        return Ok(CopyResult { copied: 0 });
    }
    let sources: Vec<CopyContent<'_>> = items
        .iter()
        .map(|item| CopyContent {
            id: &item.id,
            kind: item.kind,
            text: &item.text,
            html: item.html.as_deref(),
            image_path: item.image_path.as_deref(),
        })
        .collect();
    clipboard::write_contents(&clipboard::compose_write(&sources))?;
    let ids: Vec<String> = items.into_iter().map(|item| item.id).collect();
    let state = with_storage(&storage, |store| store.touch_contents(&ids))?;
    broadcast(&app, &state);
    Ok(CopyResult { copied: ids.len() })
}

#[tauri::command]
pub fn create_category(
    app: AppHandle,
    storage: State<'_, SharedStorage>,
    name: String,
) -> Result<AppState, AppError> {
    let state = with_storage(&storage, |store| store.create_category(&name))?;
    broadcast(&app, &state);
    Ok(state)
}

#[tauri::command]
pub fn classify_contents(
    app: AppHandle,
    storage: State<'_, SharedStorage>,
    content_ids: Vec<String>,
    category_id: Option<String>,
) -> Result<AppState, AppError> {
    let state = with_storage(&storage, |store| {
        store.classify_contents(&content_ids, category_id.as_deref())
    })?;
    broadcast(&app, &state);
    Ok(state)
}

#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), AppError> {
    let url = clipboard::validate_url(&url)?;
    open_in_shell(&url)
}

#[cfg(windows)]
fn open_in_shell(url: &str) -> Result<(), AppError> {
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let wide = |value: &str| -> Vec<u16> {
        std::ffi::OsStr::new(value)
            .encode_wide()
            .chain(once(0))
            .collect()
    };
    let operation = wide("open");
    let target = wide(url);
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            target.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    // ShellExecuteW returns a value > 32 on success.
    if result as isize <= 32 {
        return Err(AppError::message("无法打开系统浏览器"));
    }
    Ok(())
}

#[cfg(not(windows))]
fn open_in_shell(_url: &str) -> Result<(), AppError> {
    Err(AppError::message("当前平台不支持打开外部链接"))
}

#[tauri::command]
pub fn list_plugins(storage: State<'_, SharedStorage>) -> Result<PluginListing, AppError> {
    crate::plugins::list(storage.inner())
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
pub fn close_window(window: State<'_, WindowController>) -> Result<(), AppError> {
    window.close()
}

/// Show/unminimize/focus the main window, hide the tray panel and optionally
/// navigate the renderer.
#[tauri::command]
pub fn show_main_window(
    app: AppHandle,
    window: State<'_, WindowController>,
    navigate: Option<MainNavigation>,
) -> Result<(), AppError> {
    window.show_main_window(&app, navigate)
}

/// Hide the tray flyout panel.
#[tauri::command]
pub fn hide_tray_panel(window: State<'_, WindowController>) -> Result<(), AppError> {
    window.hide_tray_panel()
}

/// Minimize the main window.
#[tauri::command]
pub fn minimize_window(window: State<'_, WindowController>) -> Result<(), AppError> {
    window.minimize_main_window()
}

/// Quit the whole application (tray menu and settings both use this).
#[tauri::command]
pub fn quit_app(app: AppHandle) -> Result<(), AppError> {
    app.exit(0);
    Ok(())
}

/// Read current desktop settings (close behavior + real auto-start state).
#[tauri::command]
pub fn get_desktop_settings(
    desktop: State<'_, crate::desktop::DesktopState>,
) -> Result<DesktopSettingsDto, AppError> {
    Ok(settings_dto(&desktop))
}

fn settings_dto(desktop: &State<'_, crate::desktop::DesktopState>) -> DesktopSettingsDto {
    let prefs = desktop.current();
    DesktopSettingsDto {
        close_behavior: prefs.close_behavior,
        auto_start: prefs.auto_start,
        auto_start_available: desktop.auto_start.availability().available,
        capture_enabled: prefs.capture_enabled,
        history_retention_days: prefs.history_retention_days,
        snap_to_grid: prefs.snap_to_grid,
        grid_size: prefs.grid_size,
    }
}

/// Update desktop settings. In debug builds auto-start writes are rejected
/// before touching the registry; failures surface as errors. A retention change
/// runs a cleanup immediately (on a worker thread, since the sweep touches the
/// disk).
#[tauri::command]
pub fn set_desktop_settings(
    app: AppHandle,
    desktop: State<'_, crate::desktop::DesktopState>,
    storage: State<'_, SharedStorage>,
    patch: Option<Value>,
) -> Result<DesktopSettingsDto, AppError> {
    use crate::desktop::{CloseBehavior, GridSize, HistoryRetentionDays};
    let patch = patch.unwrap_or_else(|| json!({}));
    let mut close_behavior: Option<CloseBehavior> = None;
    let mut auto_start: Option<bool> = None;
    let mut capture_enabled: Option<bool> = None;
    let mut history_retention_days: Option<HistoryRetentionDays> = None;
    let mut snap_to_grid: Option<bool> = None;
    let mut grid_size: Option<GridSize> = None;
    if let Some(value) = patch.get("closeBehavior") {
        let behavior = value
            .as_str()
            .ok_or_else(|| AppError::message("closeBehavior 必须是字符串"))?;
        close_behavior = Some(match behavior {
            "tray" => CloseBehavior::Tray,
            "quit" => CloseBehavior::Quit,
            _ => {
                return Err(AppError::message(format!(
                    "未知的 closeBehavior：{behavior}"
                )))
            }
        });
    }
    if let Some(value) = patch.get("autoStart") {
        auto_start = Some(
            value
                .as_bool()
                .ok_or_else(|| AppError::message("autoStart 必须是布尔值"))?,
        );
    }
    if let Some(value) = patch.get("captureEnabled") {
        capture_enabled = Some(
            value
                .as_bool()
                .ok_or_else(|| AppError::message("captureEnabled 必须是布尔值"))?,
        );
    }
    if let Some(value) = patch.get("historyRetentionDays") {
        let days = value
            .as_u64()
            .and_then(|days| u32::try_from(days).ok())
            .ok_or_else(|| AppError::message("历史保留时间无效"))?;
        history_retention_days = Some(HistoryRetentionDays::new(days)?);
    }
    if let Some(value) = patch.get("snapToGrid") {
        snap_to_grid = Some(
            value
                .as_bool()
                .ok_or_else(|| AppError::message("snapToGrid 必须是布尔值"))?,
        );
    }
    if let Some(value) = patch.get("gridSize") {
        let size = value
            .as_u64()
            .and_then(|size| u32::try_from(size).ok())
            .ok_or_else(|| AppError::message("网格间距无效"))?;
        grid_size = Some(GridSize::new(size)?);
    }
    let (prefs, change) = crate::desktop::update_settings(
        &desktop,
        close_behavior,
        auto_start,
        capture_enabled,
        history_retention_days,
        snap_to_grid,
        grid_size,
    )?;
    // The layout engine reads these on every placement/move.
    with_storage(&storage, |store| {
        store.set_layout_settings(prefs.snap_to_grid, prefs.grid_size.size());
        Ok(())
    })?;
    if change.retention_changed {
        let app = app.clone();
        let storage = storage.inner().clone();
        std::thread::spawn(move || {
            if let Err(error) = crate::retention::run_cleanup(&app, &storage) {
                eprintln!("[retention] cleanup after settings change failed: {error}");
            }
        });
    }
    Ok(settings_dto(&desktop))
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
pub fn toggle_maximized(window: State<'_, WindowController>) -> Result<bool, AppError> {
    window.toggle_maximized()
}

#[tauri::command]
pub fn is_maximized(window: State<'_, WindowController>) -> bool {
    window.is_maximized()
}

#[tauri::command]
pub fn start_titlebar_drag(window: State<'_, WindowController>) -> Result<(), AppError> {
    window.start_titlebar_drag()
}
