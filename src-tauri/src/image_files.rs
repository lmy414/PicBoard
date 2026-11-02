//! Local image opening/export. No original is overwritten by library edits.
use crate::dto::{ImageOpenResult, ImportImagePayload};
use crate::error::AppError;
use crate::SharedStorage;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

pub const EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "bmp", "gif"];
const MAX_BYTES: usize = 128 * 1024 * 1024;
#[derive(Default)]
pub struct PendingImage {
    pub content_id: Mutex<Option<String>>,
    pub paths: Mutex<Vec<PathBuf>>,
}

pub fn validate_image(bytes: &[u8]) -> Result<(), AppError> {
    if bytes.is_empty() || bytes.len() > MAX_BYTES { return Err(AppError::message("图片文件大小须在 128 MB 以内")); }
    let reader = image::ImageReader::new(std::io::Cursor::new(bytes)).with_guessed_format()?;
    let (width, height) = reader.into_dimensions().map_err(|_| AppError::message("无法识别图片，支持 PNG、JPEG、WebP、BMP 和 GIF"))?;
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 40_000_000 {
        return Err(AppError::message("图片尺寸超过上限（4000 万像素）"));
    }
    Ok(())
}

pub fn open_path(app: &tauri::AppHandle, path: &Path) -> Result<ImageOpenResult, AppError> {
    let metadata = std::fs::metadata(path)?;
    if !metadata.is_file() || metadata.len() > MAX_BYTES as u64 { return Err(AppError::message("图片文件不可用或超过 128 MB")); }
    let bytes = std::fs::read(path)?;
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let storage = app.state::<SharedStorage>();
    let result = storage.lock().unwrap_or_else(|p| p.into_inner()).save_image_copy(&name, &bytes)?;
    let _ = app.emit(crate::STATE_CHANGED_EVENT, &result.state);
    Ok(result)
}

/// Options consume their values; a data-root ending in .png is never opened.
pub fn paths_from_args(args: &[String], cwd: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let mut skip = false;
    for arg in args.iter().skip(1) {
        if skip { skip = false; continue; }
        if arg == "--data-root" || arg == "--preferences-export" { skip = true; continue; }
        if arg.starts_with('-') { continue; }
        let path = PathBuf::from(arg);
        if !path.extension().and_then(|v| v.to_str()).is_some_and(|v| EXTENSIONS.contains(&v.to_ascii_lowercase().as_str())) { continue; }
        paths.push(if path.is_absolute() { path } else { cwd.join(path) });
    }
    paths
}

pub fn receive_args(app: &tauri::AppHandle, args: Vec<String>, cwd: String) {
    if let Some(pending) = app.try_state::<PendingImage>() {
        pending.paths.lock().unwrap_or_else(|p| p.into_inner()).extend(paths_from_args(&args, Path::new(&cwd)));
    }
    // During first startup, setup_app drains the queue after storage is ready.
    if app.try_state::<SharedStorage>().is_none() { return; }
    let app = app.clone();
    crate::platform::spawn_worker("picboard-open-image", move || {
        let paths = std::mem::take(&mut *app.state::<PendingImage>().paths.lock().unwrap_or_else(|p| p.into_inner()));
        for path in paths {
            match open_path(&app, &path) {
                Ok(result) => {
                    if let Some(pending) = app.try_state::<PendingImage>() { *pending.content_id.lock().unwrap_or_else(|p| p.into_inner()) = Some(result.content_id.clone()); }
                    let _ = app.emit("image:opened", &result);
                }
                Err(error) => { eprintln!("[image-open] {error}"); let _ = app.emit("image:open-error", error.to_string()); }
            }
        }
        if let Some(controller) = app.try_state::<crate::window_controller::WindowController>() { let _ = controller.show_main_window(&app, None); }
    });
}

#[tauri::command]
pub async fn open_image_file(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<Option<ImageOpenResult>, AppError> {
    let (tx, rx) = std::sync::mpsc::channel();
    window.dialog().file().set_title("打开图片").add_filter("图片", EXTENSIONS).pick_file(move |file| { let _ = tx.send(file.and_then(|file| file.as_path().map(Path::to_path_buf))); });
    let picked = rx.recv().map_err(|_| AppError::message("文件选择器未返回结果"))?;
    picked.map(|path| open_path(&app, &path)).transpose()
}

#[tauri::command]
pub fn take_pending_image(app: tauri::AppHandle) -> Result<Option<ImageOpenResult>, AppError> {
    let id = app.state::<PendingImage>().content_id.lock().unwrap_or_else(|p| p.into_inner()).take();
    id.map(|content_id| { let state = app.state::<SharedStorage>().lock().unwrap_or_else(|p| p.into_inner()).load_state()?; Ok(ImageOpenResult { state, content_id }) }).transpose()
}

#[derive(serde::Serialize)]
pub struct ImageBytes { data: Vec<u8>, mime: String }
#[tauri::command]
pub async fn read_image(app: tauri::AppHandle, content_id: String) -> Result<ImageBytes, AppError> {
    let image = app.state::<SharedStorage>().lock().unwrap_or_else(|p| p.into_inner()).resolve_image(&content_id)?;
    let data = std::fs::read(image.path)?;
    validate_image(&data)?;
    Ok(ImageBytes { data, mime: image.mime })
}

#[tauri::command]
pub async fn save_image_copy(app: tauri::AppHandle, image: ImportImagePayload) -> Result<ImageOpenResult, AppError> {
    let result = app.state::<SharedStorage>().lock().unwrap_or_else(|p| p.into_inner()).save_image_copy(&image.name, &image.data)?;
    let _ = app.emit(crate::STATE_CHANGED_EVENT, &result.state);
    Ok(result)
}

#[tauri::command]
pub async fn export_image(window: tauri::WebviewWindow, image: ImportImagePayload) -> Result<Option<String>, AppError> {
    validate_image(&image.data)?;
    let format = image::guess_format(&image.data).map_err(|_| AppError::message("导出格式无效"))?;
    let extension = match format { image::ImageFormat::Png => "png", image::ImageFormat::Jpeg => "jpg", image::ImageFormat::WebP => "webp", _ => return Err(AppError::message("仅支持导出 PNG、JPEG 和 WebP")) };
    let (tx, rx) = std::sync::mpsc::channel();
    window.dialog().file().set_title("另存图片").set_file_name(&image.name).add_filter(extension.to_uppercase(), &[extension]).save_file(move |file| { let _ = tx.send(file.and_then(|file| file.as_path().map(Path::to_path_buf))); });
    let path = rx.recv().map_err(|_| AppError::message("保存对话框未返回结果"))?;
    let Some(path) = path else { return Ok(None); };
    let selected_extension = path.extension().and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase();
    if selected_extension != extension && !(extension == "jpg" && selected_extension == "jpeg") {
        return Err(AppError::message(format!("文件扩展名须为 .{extension}，请重新选择保存位置")));
    }
    std::fs::write(&path, image.data)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn launch_arguments_skip_options_and_accept_unicode_paths() {
        let args = ["app.exe", "--data-root", "data.png", "--open", "中文 空格.JPG", "unrelated.txt"].map(String::from);
        assert_eq!(paths_from_args(&args, Path::new("C:/pictures")), vec![Path::new("C:/pictures").join("中文 空格.JPG")]);
    }
    #[test] fn rejects_invalid_image_data() { assert!(validate_image(b"not an image").is_err()); }
}
