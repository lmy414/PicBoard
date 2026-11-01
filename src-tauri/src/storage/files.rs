//! Filesystem layout and low-level file helpers.
//!
//! ```text
//! <root>/state.json                     v2 business state
//! <root>/state.json.bak                 previous good state
//! <root>/state.v1-backup.json           untouched copy of the v1 file
//! <root>/content/<id>/text.txt          text plain text
//! <root>/content/<id>/content.html      rich-text HTML
//! <root>/content/<id>/<file>            image bytes
//! <root>/cache/thumbs/<id>.png|jpg      protocol thumbnail cache
//! <root>/pending/…, classified/…        legacy v1 files (never moved)
//! <root>/plugins/<folder>/…             plugin folders
//! ```

use crate::error::AppError;
use crate::paths::safe_join;
use image::{ExtendedColorType, ImageEncoder};
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub(crate) const CONTENT_DIR: &str = "content";
pub(crate) const CACHE_DIR: &str = "cache";
pub(crate) const TEXT_FILE: &str = "text.txt";
pub(crate) const HTML_FILE: &str = "content.html";

/// Physical basename used when a requested display name is unusable:
/// `<id>.<ext>`, with the extension taken from the bytes when recognizable.
pub(crate) fn fallback_file_name(id: &str, bytes: &[u8]) -> String {
    format!("{id}{}", image_extension(sniff_image_format_bytes(bytes)))
}

fn image_extension(format: Option<image::ImageFormat>) -> &'static str {
    match format {
        Some(image::ImageFormat::Jpeg) => ".jpg",
        Some(image::ImageFormat::Png) => ".png",
        Some(image::ImageFormat::Gif) => ".gif",
        Some(image::ImageFormat::WebP) => ".webp",
        Some(image::ImageFormat::Bmp) => ".bmp",
        _ => ".png",
    }
}

fn sniff_image_format_bytes(bytes: &[u8]) -> Option<image::ImageFormat> {
    image::guess_format(bytes).ok()
}

/// Detect an image container from the file's own bytes. 64 bytes cover every
/// supported header, so Content-Type never depends on the file extension.
pub(crate) fn sniff_image_format(path: &Path) -> Option<image::ImageFormat> {
    use std::io::Read;
    let mut head = [0u8; 64];
    let mut file = fs::File::open(path).ok()?;
    let read = file.read(&mut head).ok()?;
    image::guess_format(&head[..read]).ok()
}

pub(crate) fn mime_for_format(format: image::ImageFormat) -> Option<&'static str> {
    Some(match format {
        image::ImageFormat::Jpeg => "image/jpeg",
        image::ImageFormat::Png => "image/png",
        image::ImageFormat::Gif => "image/gif",
        image::ImageFormat::WebP => "image/webp",
        image::ImageFormat::Bmp => "image/bmp",
        _ => return None,
    })
}

/// File extension (with dot) for a supported image MIME type.
pub(crate) fn extension_for_mime(mime: &str) -> &'static str {
    match mime {
        "image/jpeg" => ".jpg",
        "image/gif" => ".gif",
        "image/webp" => ".webp",
        "image/bmp" => ".bmp",
        _ => ".png",
    }
}

/// Canonical hyphenated UUID shape (8-4-4-4-12 hex). Content ids, asset ids and
/// the `<contentId>/<assetId>` cover/reference form all use it.
pub(crate) fn is_uuid_shaped(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    bytes.iter().enumerate().all(|(index, byte)| match index {
        8 | 13 | 18 | 23 => *byte == b'-',
        _ => byte.is_ascii_hexdigit(),
    })
}

/// Parse an `<contentId>/<assetId>` reference.
pub(crate) fn parse_asset_reference(value: &str) -> Option<(String, String)> {
    let (content_id, asset_id) = value.trim().split_once('/')?;
    if !is_uuid_shaped(content_id) || !is_uuid_shaped(asset_id) {
        return None;
    }
    Some((content_id.to_owned(), asset_id.to_owned()))
}

pub(crate) fn content_dir(root: &Path, id: &str) -> PathBuf {
    root.join(CONTENT_DIR).join(id)
}

pub(crate) fn content_text_path(root: &Path, id: &str) -> PathBuf {
    content_dir(root, id).join(TEXT_FILE)
}

pub(crate) fn content_html_path(root: &Path, id: &str) -> PathBuf {
    content_dir(root, id).join(HTML_FILE)
}

pub(crate) fn thumbs_dir(root: &Path) -> PathBuf {
    root.join(CACHE_DIR).join("thumbs")
}

pub(crate) fn mime_for(file_name: &str) -> &'static str {
    match Path::new(file_name)
        .extension()
        .and_then(OsStr::to_str)
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        _ => "application/octet-stream",
    }
}

pub(crate) fn is_gif(file_name: &str) -> bool {
    Path::new(file_name)
        .extension()
        .and_then(OsStr::to_str)
        .map(|extension| extension.eq_ignore_ascii_case("gif"))
        .unwrap_or(false)
}

/// Intrinsic pixel size from an encoded image; `(0, 0)` when it cannot be read
/// (content is still stored, the renderer just sizes it as "unknown").
pub(crate) fn image_intrinsic_size(bytes: &[u8]) -> (u32, u32) {
    image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .ok()
        .and_then(|reader| reader.into_dimensions().ok())
        .unwrap_or((0, 0))
}

pub(crate) fn image_intrinsic_size_path(path: &Path) -> (u32, u32) {
    image::ImageReader::open(path)
        .ok()
        .and_then(|reader| reader.with_guessed_format().ok())
        .and_then(|reader| reader.into_dimensions().ok())
        .unwrap_or((0, 0))
}

/// Encode RGBA pixels as PNG.
pub(crate) fn encode_png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, AppError> {
    let mut output = Vec::new();
    image::codecs::png::PngEncoder::new(&mut output)
        .write_image(rgba, width, height, ExtendedColorType::Rgba8)
        .map_err(|error| AppError::message(format!("图片编码 PNG 失败：{error}")))?;
    Ok(output)
}

/// Encode RGB pixels as JPEG at the thumbnail quality.
pub(crate) fn encode_jpeg(rgb: &[u8], width: u32, height: u32) -> Result<Vec<u8>, AppError> {
    let mut output = Vec::new();
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, 85);
    encoder
        .write_image(rgb, width, height, ExtendedColorType::Rgb8)
        .map_err(|error| AppError::message(format!("图片编码 JPEG 失败：{error}")))?;
    Ok(output)
}

/// Write `bytes` so readers only ever observe the old file or the new one.
pub(crate) fn write_atomic_bytes(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = path.with_file_name(format!(
        ".{}.tmp-{}",
        path.file_name()
            .and_then(OsStr::to_str)
            .unwrap_or("content"),
        Uuid::new_v4()
    ));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    let result = replace_existing_atomic(&temporary, path);
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub(crate) fn write_atomic_json<T: serde::Serialize>(
    path: &Path,
    value: &T,
) -> Result<(), AppError> {
    let content = serde_json::to_vec_pretty(value)?;
    write_atomic_bytes(path, &content)
}

pub(crate) fn remove_file_if_exists(path: &Path) -> Result<(), AppError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

/// Best-effort removal of a now-unused content/thumbnail folder.
pub(crate) fn remove_dir_if_empty(path: &Path) {
    if let Ok(mut entries) = fs::read_dir(path) {
        if entries.next().is_none() {
            let _ = fs::remove_dir(path);
        }
    }
}

pub(crate) fn remove_thumbnails(cache_dir: &Path, id: &str) {
    for extension in ["png", "jpg"] {
        let _ = fs::remove_file(cache_dir.join(format!("{id}.{extension}")));
    }
}

#[cfg(not(windows))]
pub(crate) fn rename_file_no_replace(source: &Path, destination: &Path) -> Result<(), AppError> {
    fs::rename(source, destination).map_err(Into::into)
}

#[cfg(windows)]
pub(crate) fn rename_file_no_replace(source: &Path, destination: &Path) -> Result<(), AppError> {
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};
    let source_wide = source
        .as_os_str()
        .encode_wide()
        .chain(once(0))
        .collect::<Vec<_>>();
    let destination_wide = destination
        .as_os_str()
        .encode_wide()
        .chain(once(0))
        .collect::<Vec<_>>();
    unsafe {
        MoveFileExW(
            PCWSTR(source_wide.as_ptr()),
            PCWSTR(destination_wide.as_ptr()),
            MOVEFILE_WRITE_THROUGH,
        )
        .map_err(|error| AppError::message(format!("重命名图片失败：{error}")))
    }
}

/// Rename that also handles case-only changes on case-insensitive Windows.
pub(crate) fn rename_file_case_safe(source: &Path, destination: &Path) -> Result<(), AppError> {
    if source.file_name() != destination.file_name()
        && same_filename(
            source
                .file_name()
                .ok_or_else(|| AppError::message("图片路径无效"))?,
            destination
                .file_name()
                .ok_or_else(|| AppError::message("图片路径无效"))?,
        )
    {
        let parent = source
            .parent()
            .ok_or_else(|| AppError::message("图片路径无效"))?;
        let temporary = loop {
            let candidate = parent.join(format!(".picboard-rename-{}.tmp", Uuid::new_v4()));
            if !candidate.exists() {
                break candidate;
            }
        };
        rename_file_no_replace(source, &temporary)?;
        if let Err(error) = rename_file_no_replace(&temporary, destination) {
            let _ = rename_file_no_replace(&temporary, source);
            return Err(error);
        }
        Ok(())
    } else {
        rename_file_no_replace(source, destination)
    }
}

#[cfg(not(windows))]
pub(crate) fn replace_existing_atomic(
    temporary: &Path,
    destination: &Path,
) -> Result<(), AppError> {
    // POSIX rename replaces the destination atomically. Keep this path as a
    // single rename so a crash cannot expose a missing journal/state file.
    fs::rename(temporary, destination).map_err(Into::into)
}

#[cfg(windows)]
pub(crate) fn replace_existing_atomic(
    temporary: &Path,
    destination: &Path,
) -> Result<(), AppError> {
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        MoveFileExW, ReplaceFileW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        REPLACEFILE_WRITE_THROUGH,
    };
    let temporary_wide = temporary
        .as_os_str()
        .encode_wide()
        .chain(once(0))
        .collect::<Vec<_>>();
    let destination_wide = destination
        .as_os_str()
        .encode_wide()
        .chain(once(0))
        .collect::<Vec<_>>();
    unsafe {
        if destination.exists() {
            ReplaceFileW(
                PCWSTR(destination_wide.as_ptr()),
                PCWSTR(temporary_wide.as_ptr()),
                PCWSTR(std::ptr::null()),
                REPLACEFILE_WRITE_THROUGH,
                None,
                None,
            )
            .map_err(|error| AppError::message(format!("原子替换文件失败：{error}")))
        } else {
            MoveFileExW(
                PCWSTR(temporary_wide.as_ptr()),
                PCWSTR(destination_wide.as_ptr()),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
            .map_err(|error| AppError::message(format!("移动临时文件失败：{error}")))
        }
    }
}

pub(crate) fn preserve_corrupt_copy(source: &Path, destination: &Path) -> Result<(), AppError> {
    fs::copy(source, destination).map(|_| ()).map_err(|error| {
        AppError::message(format!(
            "无法保留损坏的 state.json（{}），已保留原文件：{error}",
            source.display()
        ))
    })
}

pub(crate) fn replace_state_file(
    temporary: &Path,
    destination: &Path,
    backup: &Path,
    preserve_backup: bool,
) -> Result<(), AppError> {
    #[cfg(not(windows))]
    {
        let _ = backup;
        let _ = preserve_backup;
        replace_existing_atomic(temporary, destination)
    }
    #[cfg(windows)]
    {
        use std::iter::once;
        use std::os::windows::ffi::OsStrExt;
        use windows::core::PCWSTR;
        use windows::Win32::Storage::FileSystem::{
            MoveFileExW, ReplaceFileW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
            REPLACEFILE_WRITE_THROUGH,
        };
        let temporary_wide = temporary
            .as_os_str()
            .encode_wide()
            .chain(once(0))
            .collect::<Vec<_>>();
        let destination_wide = destination
            .as_os_str()
            .encode_wide()
            .chain(once(0))
            .collect::<Vec<_>>();
        let backup_wide = backup
            .as_os_str()
            .encode_wide()
            .chain(once(0))
            .collect::<Vec<_>>();
        unsafe {
            if destination.exists() {
                let backup_ptr = if preserve_backup {
                    PCWSTR(std::ptr::null())
                } else {
                    PCWSTR(backup_wide.as_ptr())
                };
                ReplaceFileW(
                    PCWSTR(destination_wide.as_ptr()),
                    PCWSTR(temporary_wide.as_ptr()),
                    backup_ptr,
                    REPLACEFILE_WRITE_THROUGH,
                    None,
                    None,
                )
                .map_err(|error| AppError::message(format!("原子替换状态失败：{error}")))
            } else {
                MoveFileExW(
                    PCWSTR(temporary_wide.as_ptr()),
                    PCWSTR(destination_wide.as_ptr()),
                    MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
                )
                .map_err(|error| AppError::message(format!("移动状态临时文件失败：{error}")))
            }
        }
    }
}

/// Ensure a display name is usable as a Windows file name component.
pub(crate) fn validate_image_name(name: &OsStr) -> Result<(), AppError> {
    if name.is_empty() {
        return Err(AppError::message("图片名称不能为空"));
    }
    let lossy = name.to_string_lossy();
    if lossy == "." || lossy == ".." {
        return Err(AppError::message("图片名称不能是 . 或 .."));
    }
    if lossy.ends_with(['.', ' ']) {
        return Err(AppError::message("图片名称不能以点或空格结尾"));
    }
    if lossy
        .chars()
        .any(|ch| ch.is_control() || "<>:\"/\\|?*".contains(ch))
    {
        return Err(AppError::message("图片名称包含 Windows 非法字符"));
    }
    let stem = Path::new(name)
        .file_stem()
        .and_then(OsStr::to_str)
        .unwrap_or_default();
    let device = stem
        .trim_end_matches(['.', ' '])
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    let device_number = |prefix: &str| {
        device.strip_prefix(prefix).is_some_and(|suffix| {
            matches!(
                suffix,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    };
    if matches!(device.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || device_number("COM")
        || device_number("LPT")
    {
        return Err(AppError::message("图片名称不能使用 Windows 保留设备名"));
    }
    if filename_unit_len(name) > 255 {
        return Err(AppError::message("图片名称过长"));
    }
    Ok(())
}

fn filename_unit_len(value: &OsStr) -> usize {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        value.encode_wide().count()
    }
    #[cfg(not(windows))]
    {
        value.to_string_lossy().encode_utf16().count()
    }
}

pub(crate) fn casefold_os(value: &OsStr) -> String {
    value.to_string_lossy().to_lowercase()
}

pub(crate) fn same_filename(left: &OsStr, right: &OsStr) -> bool {
    casefold_os(left) == casefold_os(right)
}

pub(crate) fn path_eq(left: &Path, right: &Path) -> bool {
    #[cfg(windows)]
    {
        let normalize = |path: &Path| casefold_os(path.as_os_str()).replace('/', "\\");
        normalize(left) == normalize(right)
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

pub(crate) fn ensure_no_name_collision(
    parent: &Path,
    target: &OsStr,
    source: &Path,
) -> Result<(), AppError> {
    let entries = fs::read_dir(parent)?;
    for entry in entries {
        let entry = entry?;
        if same_filename(entry.file_name().as_os_str(), target) && !path_eq(&entry.path(), source) {
            return Err(AppError::message("图片目标文件名已存在"));
        }
    }
    Ok(())
}

/// Normalize a requested rename against the current extension.
pub(crate) fn normalized_image_name(
    old_basename: &OsStr,
    requested: &str,
) -> Result<String, AppError> {
    validate_image_name(OsStr::new(requested))?;
    let old = old_basename
        .to_str()
        .ok_or_else(|| AppError::message("原图片文件名不是有效 Unicode"))?;
    let old_extension = Path::new(old).extension().and_then(OsStr::to_str);
    let requested_path = Path::new(requested);
    let requested_extension = requested_path.extension().and_then(OsStr::to_str);
    let result = match (old_extension, requested_extension) {
        (Some(old_ext), None) => format!("{requested}.{old_ext}"),
        (Some(old_ext), Some(new_ext)) if new_ext.eq_ignore_ascii_case(old_ext) => {
            let stem = requested_path
                .file_stem()
                .and_then(OsStr::to_str)
                .ok_or_else(|| AppError::message("图片名称无效"))?;
            format!("{stem}.{old_ext}")
        }
        (Some(_), Some(_)) => return Err(AppError::message("图片扩展名必须与原文件一致")),
        (None, None) => requested.to_owned(),
        (None, Some(_)) => return Err(AppError::message("原图片没有扩展名，不能添加其他扩展名")),
    };
    validate_image_name(OsStr::new(&result))?;
    Ok(result)
}

pub(crate) fn validate_category_segment(category_id: &str) -> Result<(), AppError> {
    if category_id.is_empty()
        || category_id == "."
        || category_id == ".."
        || category_id.contains('/')
        || category_id.contains('\\')
        || category_id
            .chars()
            .any(|ch| ch.is_control() || "<>:\"|?*".contains(ch))
    {
        return Err(AppError::message("分类标识无效"));
    }
    Ok(())
}

/// Legacy v1 layout for an image record without a persisted relative path.
pub(crate) fn relative_for_status_values(
    status: &str,
    category_id: Option<&str>,
    file_name: &str,
) -> Result<String, AppError> {
    validate_image_name(OsStr::new(file_name))?;
    match status {
        "classified" => {
            let category_id =
                category_id.ok_or_else(|| AppError::message("本地状态缺少图片分类"))?;
            validate_category_segment(category_id)?;
            Ok(PathBuf::from("classified")
                .join(category_id)
                .join(file_name)
                .to_string_lossy()
                .into_owned())
        }
        _ => Ok(PathBuf::from("pending")
            .join(file_name)
            .to_string_lossy()
            .into_owned()),
    }
}

/// Accept only the three locations the host ever writes image bytes to:
/// `content/<content id>/<file>`, legacy `pending/<file>` and legacy
/// `classified/<category>/<file>`.
pub(crate) fn expected_image_parent(
    root: &Path,
    content_id: &str,
    relative_path: &str,
) -> Result<PathBuf, AppError> {
    let normalized = relative_path.replace('\\', "/");
    let parts: Vec<&str> = normalized.split('/').filter(|part| !part.is_empty()).collect();
    let (file_name, directory) = match parts.split_last() {
        Some((file_name, directory)) if !directory.is_empty() => (*file_name, directory.join("/")),
        _ => return Err(AppError::message("图片路径缺少文件名")),
    };
    if file_name.is_empty() {
        return Err(AppError::message("图片路径缺少文件名"));
    }
    if directory == format!("{CONTENT_DIR}/{content_id}") {
        return Ok(root.join(CONTENT_DIR).join(content_id));
    }
    if directory == "pending" {
        return Ok(root.join("pending"));
    }
    if let Some(category) = directory.strip_prefix("classified/") {
        if !category.is_empty() && !category.contains('/') {
            validate_category_segment(category)?;
            return Ok(root.join("classified").join(category));
        }
    }
    Err(AppError::message("图片路径不在受控目录内"))
}

/// Resolve the absolute source path of an image content, refusing anything
/// outside the host-controlled layout.
pub(crate) fn controlled_image_path(
    root: &Path,
    content_id: &str,
    image: &crate::dto::ImageInfo,
) -> Result<(PathBuf, OsString), AppError> {
    let source = safe_join(root, &image.relative_path)?;
    let normalized = image.relative_path.replace('\\', "/");
    let persisted_basename = normalized
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| AppError::message("图片路径缺少文件名"))?;
    if persisted_basename
        != source
            .file_name()
            .and_then(OsStr::to_str)
            .unwrap_or_default()
    {
        return Err(AppError::message("图片路径文件名无效"));
    }
    let expected_parent = expected_image_parent(root, content_id, &image.relative_path)?;
    let actual_parent = source
        .parent()
        .ok_or_else(|| AppError::message("图片路径无效"))?;
    if !path_eq(actual_parent, &expected_parent) {
        return Err(AppError::message("图片路径不在受控目录内"));
    }
    let metadata = fs::symlink_metadata(&source)
        .map_err(|_| AppError::message(format!("图片文件不存在：{}", source.display())))?;
    if !metadata.file_type().is_file() {
        return Err(AppError::message("图片源必须是普通文件"));
    }
    let basename = source
        .file_name()
        .ok_or_else(|| AppError::message("图片路径缺少文件名"))?
        .to_os_string();
    Ok((source, basename))
}
