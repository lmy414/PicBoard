//! Narrow directory picker (main window only). Delegates to the Tauri dialog
//! plugin which shows the native Windows folder dialog; the web layer gets no
//! general filesystem/shell access.

use crate::error::AppError;
use tauri::WebviewWindow;
use tauri_plugin_dialog::DialogExt;

/// Show a native "select folder" dialog owned by the main window. Cancel
/// returns `None` and never changes any value on the caller side.
pub async fn pick_directory(
    window: &WebviewWindow,
    initial_path: Option<String>,
) -> Result<Option<String>, AppError> {
    let mut builder = window.dialog().file().set_title("选择目录偏好");
    if let Some(path) = initial_path {
        let path = std::path::PathBuf::from(path);
        if path.is_dir() {
            builder = builder.set_directory(path);
        }
    }
    // `pick_folder` runs its dialog off the main thread and delivers the result
    // through a callback; bridge the callback into this future.
    let (tx, rx) = std::sync::mpsc::channel::<Option<String>>();
    builder.pick_folder(move |file_path| {
        let _ = tx.send(file_path.and_then(|path| path.as_path().map(|p| p.to_string_lossy().into_owned())));
    });
    let picked = rx.recv().map_err(|_| AppError::message("目录选择器未返回结果"))?;
    Ok(picked)
}
