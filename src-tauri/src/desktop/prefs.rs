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
    // Write-then-rename so a crash mid-write never leaves a half-written file.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, content)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}
