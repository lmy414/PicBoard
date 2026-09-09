use crate::error::AppError;
use std::path::{Component, Path, PathBuf};

/// Resolve the business data root directory.
///
/// Precedence:
/// 1. Explicit override passed by the host (isolation / existing custom entry).
/// 2. `QUICK_IMAGE_BOARD_DATA_ROOT` environment variable.
/// 3. Legacy Electron-compatible default: `%APPDATA%/quick-image-board/quick-image-board`
///    (Electron `app.getPath("userData")` = `%APPDATA%/<productName>`; storage joined it
///    with `quick-image-board`). We keep the same two-level layout for compatibility.
///
/// The Rust host must never silently fall back to a different default while running a
/// data mutation; callers that require isolation resolve an explicit root first.
pub fn resolve_root(explicit: Option<PathBuf>) -> Result<PathBuf, AppError> {
    let root = if let Some(path) = explicit {
        path
    } else if let Ok(value) = std::env::var("QUICK_IMAGE_BOARD_DATA_ROOT") {
        if value.trim().is_empty() {
            return Err(AppError::message(
                "QUICK_IMAGE_BOARD_DATA_ROOT 为空，无法确定数据目录",
            ));
        }
        PathBuf::from(value)
    } else {
        let base =
            dirs::data_dir().ok_or_else(|| AppError::message("无法解析 Windows 用户数据目录"))?;
        // Electron: app.getPath("userData") = %APPDATA%/quick-image-board; storage = userData/quick-image-board
        base.join("quick-image-board").join("quick-image-board")
    };
    if root.as_os_str().is_empty() || !root.is_absolute() {
        return Err(AppError::message("数据目录必须是绝对路径"));
    }
    Ok(root)
}

/// Resolve a storage-relative path under `root` while rejecting traversal.
/// Accepts legacy `/` and `\` separators; rejects absolute, drive/UNC and `..` escapes.
pub fn safe_join(root: &Path, relative: &str) -> Result<PathBuf, AppError> {
    // State files may have been written on another platform, so normalize
    // both separator spellings before asking `Path` to inspect components.
    // This also makes the traversal check work when Linux tests read a legacy
    // Windows state file.
    let normalized = relative.replace('\\', "/");
    let candidate = Path::new(&normalized);
    let has_drive_prefix = normalized.len() >= 2
        && normalized.as_bytes()[1] == b':'
        && normalized.as_bytes()[0].is_ascii_alphabetic();
    if candidate.is_absolute() || normalized.starts_with('/') || has_drive_prefix {
        return Err(AppError::message("图片路径不能是绝对路径"));
    }
    if candidate.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err(AppError::message("图片路径越界"));
    }
    Ok(root.join(candidate))
}

/// Sanitize a user/category-provided segment for use in a relative filesystem path.
/// Mirrors Electron `safeSegment`: illegal characters and control chars become `_`,
/// then trimmed; an empty result falls back to `其他`.
pub fn sanitize_segment(value: &str) -> String {
    let mut output = value
        .chars()
        .map(|ch| {
            if "<>:\"/\\|?*".contains(ch) || ch.is_control() {
                '_'
            } else {
                ch
            }
        })
        .collect::<String>();
    output = output.trim().to_owned();
    if output.is_empty() {
        "其他".to_owned()
    } else {
        output
    }
}
