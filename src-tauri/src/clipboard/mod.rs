//! Cross-platform clipboard façade.
//!
//! Windows implementation is native (see [`windows`]): it reads image data from
//! the system clipboard without the Electron runtime, decodes it and re-encodes
//! to PNG for uniform storage import. It also writes file lists (CF_HDROP) and
//! single-image Bitmap data for the copy action.
//!
//! Non-Windows targets currently have no implementation and return a clear error
//! instead of pretending success (the project targets Windows).

use crate::error::AppError;

#[cfg(windows)]
mod windows;

/// Read an image from the clipboard and return PNG bytes.
/// Returns `Ok(None)` when the clipboard is empty or holds no image.
#[cfg(windows)]
pub fn read_image_png() -> Result<Option<Vec<u8>>, AppError> {
    windows::read_image_png()
}

/// Read an image from the clipboard and return PNG bytes.
#[cfg(not(windows))]
pub fn read_image_png() -> Result<Option<Vec<u8>>, AppError> {
    Err(AppError::message("当前平台不支持系统剪贴板读取"))
}

/// Publish the given absolute file paths to the clipboard.
/// A single path also publishes a Bitmap decoded from that image.
#[cfg(windows)]
pub fn write_image_files(paths: &[std::path::PathBuf]) -> Result<(), AppError> {
    windows::write_image_files(paths)
}

/// Publish the given absolute file paths to the clipboard.
#[cfg(not(windows))]
pub fn write_image_files(_paths: &[std::path::PathBuf]) -> Result<(), AppError> {
    Err(AppError::message("当前平台不支持系统剪贴板写入"))
}
