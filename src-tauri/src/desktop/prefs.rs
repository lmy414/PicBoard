//! Small persistent preference file for desktop-lifecycle settings.
//!
//! Kept separate from `state.json` on purpose: close behavior / auto-start are
//! host preferences, not image-library business state, and must never be
//! serialized through the storage transactions. The file lives under the same
//! data root so isolated development roots keep their own preference and can
//! never affect a real user's choice.

use crate::error::AppError;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;

/// Window close behavior contract (mirrors `shared/image-board.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum CloseBehavior {
    /// Close collapses the expanded window back to the floating 88x88 ball.
    #[default]
    Float,
    /// Close hides the main window but keeps process + tray running.
    Tray,
    /// Close quits the whole application.
    Quit,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPreferences {
    pub close_behavior: CloseBehavior,
    #[serde(default)]
    pub auto_start: bool,
}

impl Default for DesktopPreferences {
    fn default() -> Self {
        Self {
            close_behavior: CloseBehavior::Float,
            auto_start: false,
        }
    }
}

const FILE_NAME: &str = "desktop-settings.json";

fn file_path(root: &Path) -> PathBuf {
    root.join(FILE_NAME)
}

pub fn load(root: &Path) -> DesktopPreferences {
    match std::fs::read_to_string(file_path(root)) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_else(|error| {
            eprintln!("[desktop] ignoring invalid {}: {error}", FILE_NAME);
            DesktopPreferences::default()
        }),
        Err(_) => DesktopPreferences::default(),
    }
}

pub fn save(root: &Path, preferences: &DesktopPreferences) -> Result<(), AppError> {
    let path = file_path(root);
    let content = serde_json::to_string_pretty(preferences)
        .map_err(|error| AppError::message(format!("无法序列化桌面偏好：{error}")))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Write a complete temporary file, then replace the destination. Windows
    // rename does not replace an existing file, so use ReplaceFileW there.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, content)?;
    replace_file(&tmp, &path)?;
    Ok(())
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), AppError> {
    use windows_sys::Win32::Storage::FileSystem::{ReplaceFileW, REPLACEFILE_WRITE_THROUGH};
    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let ok = unsafe {
        ReplaceFileW(
            destination.as_ptr(),
            source.as_ptr(),
            std::ptr::null(),
            REPLACEFILE_WRITE_THROUGH,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if ok == 0 {
        let error = std::io::Error::last_os_error();
        // The first save has no destination yet; MoveFileExW provides the same
        // atomic replace semantics for that initial creation.
        if error.kind() == std::io::ErrorKind::NotFound {
            use windows_sys::Win32::Storage::FileSystem::{
                MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
            };
            let moved = unsafe {
                MoveFileExW(
                    source.as_ptr(),
                    destination.as_ptr(),
                    MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
                )
            };
            if moved != 0 {
                return Ok(());
            }
        }
        return Err(AppError::message(format!("无法安全替换桌面偏好：{error}")));
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), AppError> {
    std::fs::rename(source, destination)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn second_save_removes_temporary_file_and_writes_expected_json() {
        let root =
            std::env::temp_dir().join(format!("quick-image-board-prefs-{}", uuid::Uuid::new_v4()));
        let preferences = DesktopPreferences {
            close_behavior: CloseBehavior::Tray,
            auto_start: true,
        };

        save(&root, &preferences).unwrap();
        save(&root, &preferences).unwrap();

        let path = file_path(&root);
        let tmp = path.with_extension("json.tmp");
        assert!(!tmp.exists());
        let json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(json["closeBehavior"], "tray");
        assert_eq!(json["autoStart"], true);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn replace_missing_source_preserves_existing_destination() {
        let root =
            std::env::temp_dir().join(format!("quick-image-board-prefs-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("missing.tmp");
        let destination = root.join("destination.json");
        std::fs::write(&destination, "old destination").unwrap();

        assert!(replace_file(&source, &destination).is_err());
        assert_eq!(
            std::fs::read_to_string(&destination).unwrap(),
            "old destination"
        );
        let _ = std::fs::remove_dir_all(root);
    }
}
