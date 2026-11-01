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

/// Last user-chosen bounds of the expanded window, in logical pixels, together
/// with the monitor name they were captured on. Restoring clamps them into the
/// current work area, so the monitor name is informational.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SavedWindowBounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    #[serde(default)]
    pub monitor: Option<String>,
}

/// Window close behavior contract (mirrors `shared/image-board.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CloseBehavior {
    /// Close hides the main window; process, tray and background capture stay.
    #[default]
    Tray,
    /// Close quits the whole application.
    Quit,
}

impl Serialize for CloseBehavior {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(match self {
            CloseBehavior::Tray => "tray",
            CloseBehavior::Quit => "quit",
        })
    }
}

impl<'de> Deserialize<'de> for CloseBehavior {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        // "float" (the removed collapse-to-ball behavior) and anything unknown
        // migrate to the tray default.
        Ok(match value.as_str() {
            "quit" => CloseBehavior::Quit,
            _ => CloseBehavior::Tray,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPreferences {
    pub close_behavior: CloseBehavior,
    #[serde(default)]
    pub auto_start: bool,
    /// Clipboard capture switch. Pausing keeps the monitor thread alive but
    /// makes it ignore every clipboard update.
    #[serde(default = "default_capture_enabled")]
    pub capture_enabled: bool,
    /// History retention. Only the values in [`RETENTION_CHOICES`] are valid.
    #[serde(default)]
    pub history_retention_days: HistoryRetentionDays,
    /// Snap node/card placement to the layout grid (off by default: free mode).
    #[serde(default = "default_snap_to_grid")]
    pub snap_to_grid: bool,
    /// Grid spacing used when `snap_to_grid` is on.
    #[serde(default)]
    pub grid_size: GridSize,
    /// Remembered expanded-window bounds; `None` until the user resizes or
    /// moves the expanded window for the first time.
    #[serde(default)]
    pub window_bounds: Option<SavedWindowBounds>,
}

fn default_snap_to_grid() -> bool {
    false
}

fn default_capture_enabled() -> bool {
    true
}

impl Default for DesktopPreferences {
    fn default() -> Self {
        Self {
            close_behavior: CloseBehavior::Tray,
            auto_start: false,
            capture_enabled: true,
            history_retention_days: HistoryRetentionDays::default(),
            snap_to_grid: false,
            grid_size: GridSize::default(),
            window_bounds: None,
        }
    }
}

/// Allowed `historyRetentionDays` values. `0` means "never delete".
pub const RETENTION_CHOICES: [u32; 5] = [0, 7, 30, 90, 365];

/// Allowed layout grid sizes, serialized as a plain number.
pub const GRID_CHOICES: [u32; 3] = [16, 24, 32];

/// Layout grid spacing, serialized as a plain number.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct GridSize(u32);

impl GridSize {
    pub fn new(size: u32) -> Result<Self, AppError> {
        if GRID_CHOICES.contains(&size) {
            Ok(Self(size))
        } else {
            Err(AppError::message("网格间距无效"))
        }
    }

    pub fn size(self) -> u32 {
        self.0
    }

    fn sanitized(size: u32) -> Self {
        if GRID_CHOICES.contains(&size) {
            Self(size)
        } else {
            Self::default()
        }
    }
}

impl Default for GridSize {
    fn default() -> Self {
        Self(24)
    }
}

/// History retention in days, serialized as a plain number.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct HistoryRetentionDays(u32);

impl HistoryRetentionDays {
    pub fn new(days: u32) -> Result<Self, AppError> {
        if RETENTION_CHOICES.contains(&days) {
            Ok(Self(days))
        } else {
            Err(AppError::message("历史保留时间无效"))
        }
    }

    pub fn days(self) -> u32 {
        self.0
    }

    fn sanitized(days: u32) -> Self {
        if RETENTION_CHOICES.contains(&days) {
            Self(days)
        } else {
            Self::default()
        }
    }
}

impl Default for HistoryRetentionDays {
    fn default() -> Self {
        Self(30)
    }
}

const FILE_NAME: &str = "desktop-settings.json";

fn file_path(root: &Path) -> PathBuf {
    root.join(FILE_NAME)
}

pub fn load(root: &Path) -> DesktopPreferences {
    match std::fs::read_to_string(file_path(root)) {
        Ok(content) => match serde_json::from_str::<DesktopPreferences>(&content) {
            Ok(mut preferences) => {
                // A hand-edited or downgraded file may carry a value the UI
                // cannot express; fall back to the default instead of
                // silently deleting history with an out-of-contract number.
                preferences.history_retention_days =
                    HistoryRetentionDays::sanitized(preferences.history_retention_days.days());
                preferences.grid_size = GridSize::sanitized(preferences.grid_size.size());
                preferences
            }
            Err(error) => {
                eprintln!("[desktop] ignoring invalid {}: {error}", FILE_NAME);
                DesktopPreferences::default()
            }
        },
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
            capture_enabled: false,
            history_retention_days: HistoryRetentionDays::new(90).unwrap(),
            snap_to_grid: true,
            grid_size: GridSize::new(32).unwrap(),
            window_bounds: Some(SavedWindowBounds {
                x: 10,
                y: 20,
                width: 900,
                height: 640,
                monitor: Some("DISPLAY".into()),
            }),
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
        assert_eq!(json["captureEnabled"], false);
        assert_eq!(json["historyRetentionDays"], 90);
        assert_eq!(json["snapToGrid"], true);
        assert_eq!(json["gridSize"], 32);
        assert_eq!(json["windowBounds"]["x"], 10);
        assert_eq!(json["windowBounds"]["width"], 900);
        assert_eq!(json["windowBounds"]["monitor"], "DISPLAY");

        // Reload keeps the remembered bounds verbatim.
        let reloaded = load(&root);
        assert_eq!(reloaded.window_bounds, preferences.window_bounds);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn legacy_file_without_new_keys_loads_with_contract_defaults() {
        let root =
            std::env::temp_dir().join(format!("quick-image-board-prefs-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            file_path(&root),
            r#"{"closeBehavior":"quit","autoStart":true}"#,
        )
        .unwrap();

        let preferences = load(&root);

        assert_eq!(preferences.close_behavior, CloseBehavior::Quit);
        assert!(preferences.auto_start);
        // Capture must default to on so a fresh install records immediately.
        assert!(preferences.capture_enabled);
        assert_eq!(preferences.history_retention_days.days(), 30);
        // Layout defaults: free mode (no snapping) on a 24 px grid.
        assert!(!preferences.snap_to_grid);
        assert_eq!(preferences.grid_size.size(), 24);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn out_of_contract_grid_size_falls_back_to_default() {
        let root =
            std::env::temp_dir().join(format!("quick-image-board-prefs-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(file_path(&root), r#"{"gridSize":30}"#).unwrap();

        assert_eq!(load(&root).grid_size.size(), 24);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn grid_sizes_accept_only_16_24_and_32() {
        for size in GRID_CHOICES {
            assert_eq!(GridSize::new(size).unwrap().size(), size);
        }
        for size in [0, 1, 8, 15, 17, 23, 25, 31, 33, 64, 100] {
            assert_eq!(GridSize::new(size).unwrap_err().0, "网格间距无效");
        }
        assert_eq!(GridSize::default().size(), 24);
    }

    #[test]
    fn out_of_contract_retention_value_falls_back_to_default() {
        let root =
            std::env::temp_dir().join(format!("quick-image-board-prefs-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            file_path(&root),
            r#"{"closeBehavior":"float","historyRetentionDays":5}"#,
        )
        .unwrap();

        assert_eq!(load(&root).history_retention_days.days(), 30);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn retention_days_reject_values_the_ui_cannot_express() {
        for days in RETENTION_CHOICES {
            assert_eq!(HistoryRetentionDays::new(days).unwrap().days(), days);
        }
        for days in [1, 6, 29, 31, 89, 91, 364, 366, 10_000] {
            let error = HistoryRetentionDays::new(days).unwrap_err();
            assert_eq!(error.0, "历史保留时间无效");
        }
        assert_eq!(HistoryRetentionDays::default().days(), 30);
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
