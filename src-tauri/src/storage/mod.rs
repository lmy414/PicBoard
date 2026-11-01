//! Persistent business state (schema v2) with transactional writes.
//!
//! * `state.json` is replaced atomically; the previous good file is kept as
//!   `state.json.bak`, and a damaged primary is preserved as
//!   `state.json.corrupt-<ms>` before the backup is restored.
//! * The first v2 write after a v1 load copies the untouched v1 file to
//!   `state.v1-backup.json` (never overwriting an existing backup).
//! * Deleting image contents touches the system recycle bin, so a small delete
//!   journal makes a crash between "recycled" and "state written" recoverable.
//!
//! Everything else lives in submodules: [`model`] (persisted shape + repairs),
//! [`migration`] (v1 → v2), [`files`] (layout/atomic IO), [`ingest`] (hash and
//! de-duplication), [`sizing`] (node geometry) and [`ops`] (operations).

mod assets;
mod files;
mod ingest;
mod layout;
mod migration;
mod model;
mod ops;
mod sizing;
#[cfg(test)]
mod tests;

pub use model::ResolvedImage;
pub(crate) use files::{encode_jpeg, encode_png, is_uuid_shaped, write_atomic_bytes};

use crate::dto::{AppState, ContentRecord, STATE_VERSION};
use crate::error::AppError;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub(crate) use model::default_state;

const JOURNAL_VERSION: u32 = 1;
const JOURNAL_FILE: &str = ".image-board-journal.json";
/// Recovery only needs the entry ids, so a journal left behind by a v1 crash
/// (`delete_classified_images`) is reconciled with the same rule as a v2 one.
const JOURNAL_OPERATIONS: [&str; 2] = ["delete_contents", "delete_classified_images"];

/// File operations that remove an image are deliberately abstracted.
/// Production uses the Windows shell recycle bin; tests inject a fake so they
/// never modify the user's real recycle bin.
pub trait RecycleBin: Send + Sync {
    fn recycle(&self, path: &Path) -> Result<(), AppError>;
}

struct PlatformRecycleBin;

impl RecycleBin for PlatformRecycleBin {
    #[cfg(windows)]
    fn recycle(&self, path: &Path) -> Result<(), AppError> {
        recycle_windows(path)
    }

    #[cfg(not(windows))]
    fn recycle(&self, _path: &Path) -> Result<(), AppError> {
        Err(AppError::message("系统回收站仅支持 Windows"))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct DeleteJournal {
    version: u32,
    operation: String,
    phase: String,
    entries: Vec<DeleteJournalEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct DeleteJournalEntry {
    id: String,
    source: String,
    status: String,
}

pub struct ImageBoardStorage {
    pub root: PathBuf,
    state: Option<AppState>,
    /// Grid/snap configuration used by every placement and move.
    layout: layout::LayoutSettings,
    /// True after recovering from a corrupt primary file. While set, the next
    /// successful write must not copy the (bad) primary over the good backup.
    preserve_backup: bool,
    /// The next successful write must first keep an untouched copy of the v1
    /// `state.json` as `state.v1-backup.json`.
    pending_v1_backup: bool,
    recycle_bin: Box<dyn RecycleBin>,
}

impl ImageBoardStorage {
    pub fn new(root: PathBuf) -> Self {
        Self::with_recycle_bin(root, Box::new(PlatformRecycleBin))
    }

    pub fn with_recycle_bin(root: PathBuf, recycle_bin: Box<dyn RecycleBin>) -> Self {
        Self {
            root,
            state: None,
            layout: layout::LayoutSettings::default(),
            preserve_backup: false,
            pending_v1_backup: false,
            recycle_bin,
        }
    }

    /// Apply the desktop layout settings (snap toggle + grid size). Does not
    /// re-layout existing canvases.
    pub fn set_layout_settings(&mut self, snap_to_grid: bool, grid_size: u32) {
        self.layout = layout::LayoutSettings {
            snap_to_grid,
            grid_size: grid_size.max(1),
        };
    }

    fn grid_options(&self) -> layout::GridOptions {
        self.layout.options()
    }

    pub fn load_state(&mut self) -> Result<AppState, AppError> {
        self.ensure_loaded()?;
        self.snapshot()
    }

    /// Absolute location and metadata of an image content, resolved under the
    /// storage lock so the protocol handler can do file IO after releasing it.
    pub fn resolve_image(&mut self, content_id: &str) -> Result<ResolvedImage, AppError> {
        self.ensure_loaded()?;
        let content = self.content(content_id)?.clone();
        if content.kind != crate::dto::ContentKind::Image {
            return Err(AppError::message("该内容不是图片"));
        }
        let image = content
            .image
            .as_ref()
            .ok_or_else(|| AppError::message("图片信息缺失"))?;
        let (path, basename) = files::controlled_image_path(&self.root, content_id, image)?;
        // Belt and braces: a legacy relative path must also resolve inside the
        // data root once the filesystem has followed any link.
        let root = fs::canonicalize(&self.root)?;
        let canonical = fs::canonicalize(&path).map_err(|_| {
            AppError::message(format!("图片文件不存在：{}", path.display()))
        })?;
        if !canonical.starts_with(&root) {
            return Err(AppError::message("图片路径越界"));
        }
        // The bytes decide the type: a content whose display name carries a
        // different extension still serves the right Content-Type.
        let format = files::sniff_image_format(&canonical);
        let file_name = basename.to_string_lossy();
        Ok(ResolvedImage {
            mime: format
                .and_then(files::mime_for_format)
                .unwrap_or_else(|| files::mime_for(&file_name))
                .to_owned(),
            gif: matches!(format, Some(image::ImageFormat::Gif)) || files::is_gif(&file_name),
            width: image.width,
            height: image.height,
            cache_dir: files::thumbs_dir(&self.root),
            path: canonical,
        })
    }

    /// Absolute location of a rich-text asset. Mirrors [`Self::resolve_image`]
    /// so the protocol can serve and thumbnail assets through the same path.
    pub fn resolve_asset(
        &mut self,
        content_id: &str,
        asset_id: &str,
    ) -> Result<ResolvedImage, AppError> {
        self.ensure_loaded()?;
        self.content(content_id)?;
        if !files::is_uuid_shaped(content_id) || !files::is_uuid_shaped(asset_id) {
            return Err(AppError::message("图片资源路径无效"));
        }
        let path = assets::find_asset(&self.root, content_id, asset_id)
            .ok_or_else(|| AppError::message("找不到指定图片资源"))?;
        let root = fs::canonicalize(&self.root)?;
        let canonical = fs::canonicalize(&path)?;
        if !canonical.starts_with(&root) {
            return Err(AppError::message("图片路径越界"));
        }
        let format = files::sniff_image_format(&canonical);
        Ok(ResolvedImage {
            mime: format
                .and_then(files::mime_for_format)
                .unwrap_or_else(|| files::mime_for(&path.to_string_lossy()))
                .to_owned(),
            gif: matches!(format, Some(image::ImageFormat::Gif)),
            // The thumbnail path reads the intrinsic size from the file.
            width: 0,
            height: 0,
            cache_dir: files::thumbs_dir(&self.root),
            path: canonical,
        })
    }

    fn ensure_loaded(&mut self) -> Result<(), AppError> {
        self.ensure_directories()?;
        self.load_internal()
    }

    fn ensure_directories(&self) -> Result<(), AppError> {
        fs::create_dir_all(&self.root)?;
        fs::create_dir_all(self.root.join(files::CONTENT_DIR))?;
        fs::create_dir_all(files::thumbs_dir(&self.root))?;
        Ok(())
    }

    fn load_internal(&mut self) -> Result<(), AppError> {
        if self.state.is_none() {
            let state_file = self.root.join("state.json");
            match fs::read_to_string(&state_file) {
                Ok(content) => {
                    let primary = match serde_json::from_str::<Value>(&content) {
                        Ok(value) => {
                            let legacy = value.get("version").and_then(Value::as_u64)
                                != Some(STATE_VERSION as u64);
                            match model::normalize_state(&self.root, self.layout.options(), value) {
                                Ok(state) => {
                                    self.state = Some(state);
                                    if legacy {
                                        // Upgrade immediately: the first v2
                                        // write is also the only place the
                                        // untouched v1 file is backed up.
                                        self.pending_v1_backup = true;
                                        self.write_state()?;
                                    }
                                    Ok(())
                                }
                                Err(error) => Err(error),
                            }
                        }
                        Err(error) => Err(AppError::message(format!(
                            "state.json JSON 解析失败：{error}"
                        ))),
                    };
                    if let Err(primary_error) = primary {
                        let corrupt = self.root.join(format!(
                            "state.json.corrupt-{}",
                            Utc::now().timestamp_millis()
                        ));
                        files::preserve_corrupt_copy(&state_file, &corrupt)?;
                        let backup = self.root.join("state.json.bak");
                        let backup_content = fs::read_to_string(&backup).map_err(|_| {
                            AppError::message(format!(
                                "本地状态损坏，原文件已保留（{}）。",
                                corrupt.display()
                            ))
                        })?;
                        let mut restored = model::normalize_state(
                            &self.root,
                            self.layout.options(),
                            serde_json::from_str::<Value>(&backup_content)?,
                        )?;
                        restored.storage_notice = Some(format!(
                            "state.json 损坏，已使用备份恢复；损坏原文件已保留。{}",
                            primary_error.0
                        ));
                        self.state = Some(restored);
                        // The preserved copy is already the corrupt primary;
                        // never turn it into the v1 upgrade backup.
                        self.pending_v1_backup = false;
                        self.preserve_backup = true;
                        self.write_state()?;
                        self.preserve_backup = false;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    self.state = Some(default_state());
                    self.write_state()?;
                }
                Err(error) => return Err(error.into()),
            }
        }
        self.recover_journal()
    }

    fn write_state(&mut self) -> Result<(), AppError> {
        self.ensure_directories()?;
        // Every successful state write bumps the persisted revision so the
        // renderers can drop stale broadcasts.
        let next_revision = self.state_ref().revision.wrapping_add(1);
        self.state_mut().revision = next_revision;
        let mut persisted = self.state_ref().clone();
        persisted.storage_notice = None;
        let content = serde_json::to_vec_pretty(&persisted)?;
        let state_file = self.root.join("state.json");
        let temporary = self.root.join(format!("state.json.tmp-{}", Uuid::new_v4()));
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(&content)?;
        file.sync_all()?;
        drop(file);

        // Before the first v2 write, keep the v1 file exactly as it was.
        if self.pending_v1_backup {
            let v1_backup = self.root.join("state.v1-backup.json");
            if !v1_backup.exists() {
                match fs::copy(&state_file, &v1_backup) {
                    Ok(_) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => {
                        let _ = fs::remove_file(&temporary);
                        return Err(error.into());
                    }
                }
            }
        }

        let backup_file = self.root.join("state.json.bak");
        if !self.preserve_backup {
            if let Err(error) = fs::copy(&state_file, &backup_file) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    let _ = fs::remove_file(&temporary);
                    return Err(error.into());
                }
            }
        }
        let result =
            files::replace_state_file(&temporary, &state_file, &backup_file, self.preserve_backup);
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result?;
        self.pending_v1_backup = false;
        Ok(())
    }

    fn journal_path(&self) -> PathBuf {
        self.root.join(JOURNAL_FILE)
    }

    fn write_journal(&self, journal: &DeleteJournal) -> Result<(), AppError> {
        if journal.version != JOURNAL_VERSION
            || !JOURNAL_OPERATIONS.contains(&journal.operation.as_str())
        {
            return Err(AppError::message("本地操作日志版本无效"));
        }
        files::write_atomic_json(&self.journal_path(), journal)
    }

    fn clear_journal(&self) -> Result<(), AppError> {
        files::remove_file_if_exists(&self.journal_path())
    }

    fn recover_journal(&mut self) -> Result<(), AppError> {
        let path = self.journal_path();
        let content = match fs::read_to_string(&path) {
            Ok(content) => content,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        };
        let journal: DeleteJournal = serde_json::from_str(&content)
            .map_err(|error| AppError::message(format!("本地操作日志损坏：{error}")))?;
        if journal.version != JOURNAL_VERSION
            || !JOURNAL_OPERATIONS.contains(&journal.operation.as_str())
        {
            return Err(AppError::message("本地操作日志版本不受支持"));
        }
        if journal.phase == "committed" {
            return self.clear_journal();
        }
        let mut remove_ids = Vec::new();
        for entry in &journal.entries {
            // A prepared entry whose source is gone may have crashed between
            // the shell operation and the durable `recycled` marker. It is
            // treated as already gone, never as something we can roll back.
            if entry.status == "recycled"
                || (entry.status == "prepared" && !Path::new(&entry.source).exists())
            {
                remove_ids.push(entry.id.clone());
            }
        }
        if !remove_ids.is_empty() {
            self.remove_content_records(&remove_ids);
            self.write_state()?;
        }
        self.clear_journal()
    }

    /// Drop content records plus every placement and edge that referenced them.
    fn remove_content_records(&mut self, content_ids: &[String]) {
        if content_ids.is_empty() {
            return;
        }
        let removed: HashSet<&str> = content_ids.iter().map(String::as_str).collect();
        let mut node_ids: HashSet<String> = HashSet::new();
        for canvas in self.state_mut().canvases.iter_mut() {
            canvas.nodes.retain(|node| {
                if removed.contains(node.content_id.as_str()) {
                    node_ids.insert(node.id.clone());
                    false
                } else {
                    true
                }
            });
        }
        self.state_mut().edges.retain(|edge| {
            !node_ids.contains(&edge.from_node) && !node_ids.contains(&edge.to_node)
        });
        for content_id in content_ids {
            self.state_mut().contents.remove(content_id);
        }
    }

    /// Remove the given placements and every edge touching them. Returns the
    /// content ids that lost a placement.
    fn remove_node_records(&mut self, node_ids: &HashSet<String>) -> Vec<String> {
        let mut affected = Vec::new();
        for canvas in self.state_mut().canvases.iter_mut() {
            canvas.nodes.retain(|node| {
                if node_ids.contains(&node.id) {
                    affected.push(node.content_id.clone());
                    false
                } else {
                    true
                }
            });
        }
        self.state_mut().edges.retain(|edge| {
            !node_ids.contains(&edge.from_node) && !node_ids.contains(&edge.to_node)
        });
        affected
    }

    fn bump_contents(&mut self, content_ids: &[String]) {
        let stamp = model::now();
        let mut seen = HashSet::new();
        for content_id in content_ids {
            if !seen.insert(content_id.as_str()) {
                continue;
            }
            if let Some(record) = self.state_mut().contents.get_mut(content_id) {
                record.last_used_at = stamp.clone();
            }
        }
    }

    fn content(&self, content_id: &str) -> Result<&ContentRecord, AppError> {
        self.state_ref()
            .contents
            .get(content_id)
            .ok_or_else(|| AppError::message("找不到指定内容"))
    }

    fn node_location(&self, node_id: &str) -> Result<(usize, usize), AppError> {
        for (canvas_index, canvas) in self.state_ref().canvases.iter().enumerate() {
            if let Some(node_index) = canvas.nodes.iter().position(|node| node.id == node_id) {
                return Ok((canvas_index, node_index));
            }
        }
        Err(AppError::message("找不到指定节点"))
    }

    fn snapshot(&self) -> Result<AppState, AppError> {
        self.state
            .clone()
            .ok_or_else(|| AppError::message("本地状态尚未加载"))
    }

    fn state_ref(&self) -> &AppState {
        self.state.as_ref().expect("state loaded")
    }

    fn state_mut(&mut self) -> &mut AppState {
        self.state.as_mut().expect("state loaded")
    }

    fn canvas_index(&self, id: &str) -> Result<usize, AppError> {
        self.state_ref()
            .canvases
            .iter()
            .position(|canvas| canvas.id == id)
            .ok_or_else(|| AppError::message("找不到指定画布"))
    }
}

#[cfg(windows)]
fn shell_parsing_path(path: &Path) -> Result<Vec<u16>, AppError> {
    use std::os::windows::ffi::OsStrExt;
    if !path.is_absolute() {
        return Err(AppError::message("Shell 文件路径必须是绝对路径"));
    }
    let wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    if wide.contains(&0) {
        return Err(AppError::message("Shell 文件路径包含空字符"));
    }
    // Shell parsing rejects forward slashes even though Win32 file I/O accepts them.
    Ok(wide
        .into_iter()
        .map(|unit| if unit == b'/' as u16 { 0x5c } else { unit })
        .chain(std::iter::once(0))
        .collect())
}

#[cfg(windows)]
fn recycle_windows(path: &Path) -> Result<(), AppError> {
    use std::thread;
    use windows::core::PCWSTR;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{
        FileOperation, IFileOperation, SHCreateItemFromParsingName, FOFX_RECYCLEONDELETE,
        FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT,
    };

    let path = path.to_path_buf();
    thread::Builder::new()
        .name("picboard-recycle-sta".into())
        .spawn(move || {
            let init = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
            if init.is_err() {
                return Err(AppError::message(format!(
                    "初始化回收站 STA COM 失败：{init:?}"
                )));
            }
            let result = (|| {
                let wide = shell_parsing_path(&path)?;
                let item = unsafe {
                    SHCreateItemFromParsingName::<_, _, windows::Win32::UI::Shell::IShellItem>(
                        PCWSTR(wide.as_ptr()),
                        None,
                    )
                }
                .map_err(|error| AppError::message(format!("创建 Shell 文件项失败：{error}")))?;
                let operation: IFileOperation =
                    unsafe { CoCreateInstance(&FileOperation, None, CLSCTX_ALL) }.map_err(
                        |error| AppError::message(format!("创建系统文件操作失败：{error}")),
                    )?;
                unsafe {
                    operation
                        .SetOperationFlags(
                            FOF_ALLOWUNDO
                                | FOF_NOCONFIRMATION
                                | FOF_NOERRORUI
                                | FOF_SILENT
                                | FOFX_RECYCLEONDELETE,
                        )
                        .map_err(|error| {
                            AppError::message(format!("设置回收站操作标志失败：{error}"))
                        })?;
                    operation
                        .DeleteItem(
                            &item,
                            None::<&windows::Win32::UI::Shell::IFileOperationProgressSink>,
                        )
                        .map_err(|error| {
                            AppError::message(format!("加入回收站操作失败：{error}"))
                        })?;
                    operation.PerformOperations().map_err(|error| {
                        AppError::message(format!("执行回收站操作失败：{error}"))
                    })?;
                    let aborted = operation.GetAnyOperationsAborted().map_err(|error| {
                        AppError::message(format!("检查回收站操作状态失败：{error}"))
                    })?;
                    if aborted.as_bool() {
                        return Err(AppError::message("系统回收站操作被中止"));
                    }
                }
                Ok(())
            })();
            unsafe { CoUninitialize() };
            result
        })
        .map_err(|error| AppError::message(format!("启动回收站线程失败：{error}")))?
        .join()
        .map_err(|_| AppError::message("回收站线程异常退出"))?
}
