//! Origin-compatible preference migration for the two renderer localStorage
//! keys (`quick-image-board.ball-settings` / `quick-image-board.path-settings`).
//!
//! The Electron app stored preferences in Chromium localStorage under the
//! `file://` (or Vite dev) origin. WebView2 uses a different origin/profile, so
//! those values are not inherited automatically. This module lets the Rust host
//! accept an explicit, validated JSON export produced by the Electron entry
//! (`npm run export:prefs`), fill missing keys, and never overwrite values that
//! are already present and valid.

use crate::error::AppError;
use serde_json::{Map, Value};
use std::path::Path;

pub const BALL_SETTINGS_KEY: &str = "quick-image-board.ball-settings";
pub const PATH_SETTINGS_KEY: &str = "quick-image-board.path-settings";

/// In-memory validated migration preferences installed by the host at startup.
#[derive(Default)]
pub struct PreferenceStore {
    pub values: std::sync::Mutex<Map<String, Value>>,
}

impl PreferenceStore {
    pub fn install(&self, values: Map<String, Value>) {
        *self
            .values
            .lock()
            .unwrap_or_else(|poison| poison.into_inner()) = values;
    }

    pub fn snapshot(&self) -> Map<String, Value> {
        self.values
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone()
    }
}

/// Load an Electron preference export file into a map keyed by the two keys.
///
/// Expected shape: `{ "quick-image-board.ball-settings": { ... }, "quick-image-board.path-settings": { ... } }`.
/// Missing or non-object values for a key are ignored (the renderer falls back
/// to defaults); corrupt JSON or an unreadable file is a hard error so a broken
/// migration file is never silently treated as a first run.
pub fn load_preference_export(path: &Path) -> Result<Map<String, Value>, AppError> {
    let content = std::fs::read_to_string(path)
        .map_err(|error| AppError::message(format!("无法读取偏好导出文件：{error}")))?;
    let value: Value = serde_json::from_str(&content)
        .map_err(|error| AppError::message(format!("偏好导出文件不是有效 JSON：{error}")))?;
    let object = value
        .as_object()
        .ok_or_else(|| AppError::message("偏好导出文件顶层必须是对象"))?;
    let mut result = Map::new();
    for key in [BALL_SETTINGS_KEY, PATH_SETTINGS_KEY] {
        match object.get(key) {
            Some(Value::Object(_)) => {
                result.insert(key.to_string(), object[key].clone());
            }
            Some(_) => {
                return Err(AppError::message(format!(
                    "偏好导出文件中的 {key} 必须是对象"
                )))
            }
            None => {}
        }
    }
    if result.is_empty() {
        return Err(AppError::message(
            "偏好导出文件不包含任何可迁移的设置键",
        ));
    }
    Ok(result)
}

/// Validate a ball-settings export (mirrors `normalizeBallSettings` rules
/// closely enough to reject malformed payloads while accepting legacy values).
fn valid_ball_settings(value: &Value) -> bool {
    let Some(object) = value.as_object() else { return false };
    if let Some(color) = object.get("colorId").and_then(Value::as_str) {
        if color.is_empty() {
            return false;
        }
    }
    if let Some(shape) = object.get("shapeId").and_then(Value::as_str) {
        if shape.is_empty() {
            return false;
        }
    }
    true
}

fn valid_path_settings(value: &Value) -> bool {
    let Some(object) = value.as_object() else { return false };
    for key in ["filePath", "classifiedPath", "temporaryPath"] {
        if let Some(item) = object.get(key) {
            if !item.is_string() {
                return false;
            }
        }
    }
    true
}

/// Validate and normalize an export map into the final preference map used by
/// the bootstrap. Values that fail validation are dropped so the renderer falls
/// back to its normal defaults.
pub fn normalize_export(
    export: Map<String, Value>,
) -> Map<String, Value> {
    let mut result = Map::new();
    for (key, value) in export {
        let valid = match key.as_str() {
            BALL_SETTINGS_KEY => valid_ball_settings(&value),
            PATH_SETTINGS_KEY => valid_path_settings(&value),
            _ => false,
        };
        if valid {
            result.insert(key, value);
        }
    }
    result
}
