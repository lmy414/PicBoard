use crate::{
    dto::{
        AppState, CanvasRecord, CanvasViewport, CategoryRecord, ImageRecord, ImportImagePayload,
        ImportViewport,
    },
    error::AppError,
    paths::safe_join,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashSet},
    ffi::{OsStr, OsString},
    fs,
    io::Write,
    path::{Path, PathBuf},
};
use uuid::Uuid;

const DEFAULT_VIEWPORT: CanvasViewport = CanvasViewport {
    x: -900.0,
    y: -500.0,
    zoom: 1.0,
};
const MIN_ZOOM: f64 = 0.5;
const MAX_ZOOM: f64 = 1.5;
const JOURNAL_VERSION: u32 = 1;
const JOURNAL_FILE: &str = ".image-board-journal.json";

/// File operations which remove an image from the library are deliberately
/// abstracted. Production uses the Windows shell recycle bin; tests inject a
/// fake so they never modify the user's real recycle bin.
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
struct DeleteJournal {
    version: u32,
    operation: String,
    phase: String,
    entries: Vec<DeleteJournalEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DeleteJournalEntry {
    id: String,
    source: String,
    status: String,
}

pub struct ImageBoardStorage {
    pub root: PathBuf,
    state: Option<AppState>,
    previews_loaded: bool,
    /// True after recovering from a corrupt primary file. While set, the next
    /// successful write must not copy the (bad) primary over the good backup.
    preserve_backup: bool,
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
            previews_loaded: false,
            preserve_backup: false,
            recycle_bin,
        }
    }

    pub fn load_state(&mut self) -> Result<AppState, AppError> {
        self.ensure_directories()?;
        self.load_internal()?;
        self.hydrate_state()?;
        self.snapshot()
    }

    pub fn import_images(
        &mut self,
        canvas_id: &str,
        payloads: Vec<ImportImagePayload>,
        viewport: Option<ImportViewport>,
    ) -> Result<AppState, AppError> {
        self.ensure_loaded()?;
        let before = self.snapshot()?;
        let canvas_index = self.canvas_index(canvas_id)?;
        let view = viewport
            .as_ref()
            .map(normalize_import_viewport)
            .unwrap_or_else(|| self.state_ref().canvases[canvas_index].viewport.clone());
        self.state_mut().canvases[canvas_index].viewport = view.clone();
        let width = viewport
            .as_ref()
            .map(|item| finite_or(item.width, 640.0).max(320.0))
            .unwrap_or(640.0);
        let height = viewport
            .as_ref()
            .map(|item| finite_or(item.height, 480.0).max(240.0))
            .unwrap_or(480.0);
        let start_x = (width / 2.0 - view.x) / view.zoom - 80.0;
        let start_y = (height / 2.0 - view.y) / view.zoom - 70.0;
        let mut created = Vec::new();
        let result = (|| {
            for (index, payload) in payloads.iter().enumerate() {
                let id = Uuid::new_v4().to_string();
                let file_name = if payload.name.trim().is_empty() {
                    format!("{id}.png")
                } else {
                    payload.name.clone()
                };
                let relative = PathBuf::from("pending")
                    .join(unique_name(&file_name, &id))
                    .to_string_lossy()
                    .into_owned();
                let absolute = safe_join(&self.root, &relative)?;
                let mut file = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&absolute)?;
                file.write_all(&payload.data)?;
                file.sync_all()?;
                created.push(absolute);
                let image = ImageRecord {
                    id: id.clone(),
                    file_name,
                    relative_path: relative,
                    status: "pending".into(),
                    category_id: None,
                    canvas_id: Some(canvas_id.into()),
                    x: js_round(start_x + (index % 3) as f64 * 190.0),
                    y: js_round(start_y + (index / 3) as f64 * 180.0),
                    width: 160.0,
                    height: 140.0,
                    created_at: now(),
                    data_url: None,
                };
                self.state_mut().images.insert(id.clone(), image);
                self.state_mut().canvases[canvas_index].image_ids.push(id);
            }
            self.write_state()
        })();
        if let Err(error) = result {
            self.state = Some(before);
            for path in created {
                let _ = fs::remove_file(path);
            }
            return Err(error);
        }
        self.hydrate_state()?;
        self.snapshot()
    }

    pub fn paste_image(&mut self, canvas_id: &str) -> Result<(AppState, bool), AppError> {
        self.ensure_loaded()?;
        let Some(data) = crate::clipboard::read_image_png()? else {
            return Ok((self.snapshot()?, false));
        };
        let payload = ImportImagePayload {
            name: format!("粘贴图片-{}.png", Utc::now().timestamp_millis()),
            data,
        };
        Ok((self.import_images(canvas_id, vec![payload], None)?, true))
    }

    pub fn set_active_canvas(&mut self, canvas_id: &str) -> Result<AppState, AppError> {
        self.ensure_loaded()?;
        self.canvas_index(canvas_id)?;
        self.state_mut().active_canvas_id = canvas_id.into();
        self.write_state()?;
        self.snapshot()
    }

    pub fn set_canvas_viewport(
        &mut self,
        canvas_id: &str,
        viewport: CanvasViewport,
    ) -> Result<AppState, AppError> {
        self.ensure_loaded()?;
        let index = self.canvas_index(canvas_id)?;
        self.state_mut().canvases[index].viewport = normalize_viewport(&viewport);
        self.write_state()?;
        self.snapshot()
    }

    pub fn create_canvas(&mut self) -> Result<AppState, AppError> {
        self.ensure_loaded()?;
        let canvas = CanvasRecord {
            id: Uuid::new_v4().to_string(),
            name: format!("画布 {}", self.state_ref().canvases.len() + 1),
            image_ids: Vec::new(),
            created_at: now(),
            viewport: DEFAULT_VIEWPORT.clone(),
        };
        self.state_mut().active_canvas_id = canvas.id.clone();
        self.state_mut().canvases.push(canvas);
        self.write_state()?;
        self.snapshot()
    }

    pub fn rename_canvas(&mut self, canvas_id: &str, name: &str) -> Result<AppState, AppError> {
        self.ensure_loaded()?;
        let index = self.canvas_index(canvas_id)?;
        let name = name.trim();
        if !name.is_empty() {
            self.state_mut().canvases[index].name = name.into();
        }
        self.write_state()?;
        self.snapshot()
    }

    pub fn delete_canvas(&mut self, canvas_id: &str) -> Result<AppState, AppError> {
        self.ensure_loaded()?;
        let before = self.snapshot()?;
        let index = self.canvas_index(canvas_id)?;
        let image_ids = self.state_ref().canvases[index].image_ids.clone();
        let mut moved = Vec::new();
        let result = (|| {
            for image_id in &image_ids {
                let Some(image) = self.state_ref().images.get(image_id).cloned() else {
                    continue;
                };
                if image.status == "pending" {
                    let from = self.controlled_source(&image)?.0;
                    fs::create_dir_all(self.root.join(".trash"))?;
                    let to =
                        self.root
                            .join(".trash")
                            .join(format!("{}-{}", image.id, Uuid::new_v4()));
                    rename_file_no_replace(&from, &to)?;
                    moved.push((from, to));
                    self.state_mut().images.remove(image_id);
                } else if let Some(record) = self.state_mut().images.get_mut(image_id) {
                    record.canvas_id = None;
                }
            }
            self.state_mut().canvases.remove(index);
            if self.state_ref().canvases.is_empty() {
                self.state_mut().canvases.push(new_canvas("画布 1"));
            }
            if self.state_ref().active_canvas_id == canvas_id {
                self.state_mut().active_canvas_id = self.state_ref().canvases[0].id.clone();
            }
            self.write_state()
        })();
        if let Err(error) = result {
            self.state = Some(before);
            for (from, to) in moved.into_iter().rev() {
                let _ = fs::rename(to, from);
            }
            return Err(error);
        }
        for (_, to) in moved {
            let _ = fs::remove_file(to);
        }
        self.snapshot()
    }

    pub fn create_category(&mut self, name: &str) -> Result<AppState, AppError> {
        self.ensure_loaded()?;
        let name = name.trim();
        if !name.is_empty()
            && !self
                .state_ref()
                .categories
                .iter()
                .any(|item| item.name == name)
        {
            self.state_mut().categories.push(CategoryRecord {
                id: Uuid::new_v4().to_string(),
                name: name.into(),
                created_at: now(),
            });
            self.write_state()?;
        }
        self.snapshot()
    }

    pub fn classify_images(
        &mut self,
        image_ids: &[String],
        category_id: &str,
    ) -> Result<AppState, AppError> {
        self.ensure_loaded()?;
        if !self
            .state_ref()
            .categories
            .iter()
            .any(|item| item.id == category_id)
        {
            return Err(AppError::message("找不到指定分类"));
        }
        validate_category_segment(category_id)?;
        let before = self.snapshot()?;
        let ids = unique_ids(image_ids);
        let mut plans = Vec::new();
        let mut destination_keys = HashSet::new();

        // Plan and validate every move before touching the filesystem. In
        // particular, two images with the same physical basename must fail as
        // a batch rather than leaving a partially reclassified library.
        for image_id in &ids {
            let image = self
                .state_ref()
                .images
                .get(image_id)
                .cloned()
                .ok_or_else(|| AppError::message("找不到指定图片"))?;
            let (source, basename) = self.controlled_source(&image)?;
            let relative = PathBuf::from("classified")
                .join(category_id)
                .join(&basename)
                .to_string_lossy()
                .into_owned();
            let destination = safe_join(&self.root, &relative)?;
            let key = casefold_os(&basename);
            if !destination_keys.insert(key) {
                return Err(AppError::message("分类目标文件名冲突"));
            }
            if !path_eq(&source, &destination) && destination.exists() {
                return Err(AppError::message(format!(
                    "分类目标文件已存在：{}",
                    destination.display()
                )));
            }
            if !path_eq(&source, &destination) {
                if let Some(parent) = destination.parent() {
                    for existing in fs::read_dir(parent).into_iter().flatten().flatten() {
                        if same_filename(existing.file_name().as_os_str(), &basename)
                            && !path_eq(&existing.path(), &source)
                        {
                            return Err(AppError::message("分类目标文件名冲突"));
                        }
                    }
                }
            }
            plans.push((image, source, basename, relative, destination));
        }

        let mut moved = Vec::new();
        let result = (|| {
            for (image, source, _basename, relative, destination) in &plans {
                if !path_eq(source, destination) {
                    if let Some(parent) = destination.parent() {
                        fs::create_dir_all(parent)?;
                    }
                    rename_file_no_replace(source, destination)?;
                    moved.push((source.clone(), destination.clone()));
                }
                let record = self
                    .state_mut()
                    .images
                    .get_mut(&image.id)
                    .ok_or_else(|| AppError::message("找不到指定图片"))?;
                record.relative_path = relative.clone();
                record.status = "classified".into();
                record.category_id = Some(category_id.into());
            }
            self.write_state()
        })();
        if let Err(error) = result {
            self.state = Some(before);
            for (from, to) in moved.into_iter().rev() {
                let _ = rename_file_no_replace(&to, &from);
            }
            return Err(error);
        }
        self.hydrate_state()?;
        self.snapshot()
    }

    pub fn rename_image(&mut self, image_id: &str, name: &str) -> Result<AppState, AppError> {
        self.ensure_loaded()?;
        let image = self
            .state_ref()
            .images
            .get(image_id)
            .cloned()
            .ok_or_else(|| AppError::message("找不到指定图片"))?;
        let (source, old_basename) = self.controlled_source(&image)?;
        let final_name = normalized_image_name(&old_basename, name)?;
        let final_os = OsString::from(&final_name);
        let parent = source
            .parent()
            .ok_or_else(|| AppError::message("图片路径无效"))?;
        ensure_no_name_collision(parent, &final_os, &source)?;
        let destination = parent.join(&final_os);
        let before = self.snapshot()?;
        // Lexical equality is intentionally used here rather than the
        // Windows case-insensitive comparison: a case-only rename must still
        // update the actual directory entry on disk.
        let moved = source != destination;
        if moved {
            rename_file_case_safe(&source, &destination)?;
        }
        let relative = relative_for_image(&image, &final_name)?;
        let record = self
            .state_mut()
            .images
            .get_mut(image_id)
            .ok_or_else(|| AppError::message("找不到指定图片"))?;
        record.file_name = final_name;
        record.relative_path = relative;
        if let Err(error) = self.write_state() {
            self.state = Some(before);
            if moved {
                let _ = rename_file_case_safe(&destination, &source);
            }
            return Err(error);
        }
        self.hydrate_state()?;
        self.snapshot()
    }

    pub fn delete_classified_images(&mut self, image_ids: &[String]) -> Result<AppState, AppError> {
        self.ensure_loaded()?;
        let ids = unique_ids(image_ids);
        if ids.is_empty() {
            return self.snapshot();
        }
        let mut entries = Vec::new();
        for image_id in &ids {
            let image = self
                .state_ref()
                .images
                .get(image_id)
                .cloned()
                .ok_or_else(|| AppError::message("找不到指定图片"))?;
            if image.status != "classified" {
                return Err(AppError::message("只能删除已分类图片"));
            }
            let (source, _) = self.controlled_source(&image)?;
            entries.push(DeleteJournalEntry {
                id: image.id,
                source: source.to_string_lossy().into_owned(),
                status: "prepared".into(),
            });
        }

        // Recycling and state.json cannot be one atomic transaction. The
        // journal records the durable boundary explicitly, and recovery only
        // reconciles records whose files are known to have left their source;
        // it never claims to restore a file from the system recycle bin.
        let mut journal = DeleteJournal {
            version: JOURNAL_VERSION,
            operation: "delete_classified_images".into(),
            phase: "prepared".into(),
            entries,
        };
        self.write_journal(&journal)?;
        let mut recycled_ids = Vec::new();
        for index in 0..journal.entries.len() {
            let source = PathBuf::from(&journal.entries[index].source);
            if let Err(error) = self.recycle_bin.recycle(&source) {
                // The system recycle bin is not transactional. Keep records
                // for entries that were not recycled, but remove the entries
                // already confirmed recycled before persisting a recovery
                // journal. This is not presented as a rollback.
                self.remove_image_records(&recycled_ids);
                self.write_state()?;
                journal.phase = "recycled".into();
                self.write_journal(&journal)?;
                return Err(error);
            }
            journal.entries[index].status = "recycled".into();
            self.write_journal(&journal)?;
            recycled_ids.push(journal.entries[index].id.clone());
        }
        journal.phase = "recycled".into();
        self.write_journal(&journal)?;
        self.remove_image_records(&recycled_ids);
        self.write_state()?;
        journal.phase = "committed".into();
        self.write_journal(&journal)?;
        self.clear_journal()?;
        self.snapshot()
    }

    pub fn remove_image_from_canvas(&mut self, image_id: &str) -> Result<AppState, AppError> {
        self.ensure_loaded()?;
        let before = self.snapshot()?;
        let image = self
            .state_ref()
            .images
            .get(image_id)
            .cloned()
            .ok_or_else(|| AppError::message("找不到指定图片"))?;
        let Some(canvas_id) = image.canvas_id.clone() else {
            return self.snapshot();
        };
        let canvas_index = self.canvas_index(&canvas_id)?;
        self.state_mut().canvases[canvas_index]
            .image_ids
            .retain(|id| id != image_id);
        if let Some(record) = self.state_mut().images.get_mut(image_id) {
            record.canvas_id = None;
        }
        let mut moved = None;
        let result = (|| {
            if image.status == "pending" {
                let from = self.controlled_source(&image)?.0;
                fs::create_dir_all(self.root.join(".trash"))?;
                let to = self
                    .root
                    .join(".trash")
                    .join(format!("{}-{}", image.id, Uuid::new_v4()));
                rename_file_no_replace(&from, &to)?;
                moved = Some((from, to));
                self.state_mut().images.remove(image_id);
            }
            self.write_state()
        })();
        if let Err(error) = result {
            self.state = Some(before);
            if let Some((from, to)) = moved {
                let _ = fs::rename(to, from);
            }
            return Err(error);
        }
        if let Some((_, to)) = moved {
            let _ = fs::remove_file(to);
        }
        self.snapshot()
    }

    pub fn move_image(&mut self, image_id: &str, x: f64, y: f64) -> Result<AppState, AppError> {
        self.ensure_loaded()?;
        if !x.is_finite() || !y.is_finite() {
            return Err(AppError::message("图片坐标无效"));
        }
        let image = self
            .state_mut()
            .images
            .get_mut(image_id)
            .ok_or_else(|| AppError::message("找不到指定图片"))?;
        image.x = js_round(x);
        image.y = js_round(y);
        self.write_state()?;
        self.snapshot()
    }

    pub fn image_paths(&mut self, image_ids: &[String]) -> Result<Vec<PathBuf>, AppError> {
        self.ensure_loaded()?;
        let mut unique = Vec::new();
        for image_id in image_ids {
            let image = self
                .state_ref()
                .images
                .get(image_id)
                .ok_or_else(|| AppError::message("找不到指定图片"))?;
            let path = self.controlled_source(image)?.0;
            if !unique.contains(&path) {
                unique.push(path);
            }
        }
        Ok(unique)
    }

    fn ensure_loaded(&mut self) -> Result<(), AppError> {
        self.ensure_directories()?;
        self.load_internal()?;
        self.hydrate_state()
    }

    fn ensure_directories(&self) -> Result<(), AppError> {
        fs::create_dir_all(self.root.join("pending"))?;
        fs::create_dir_all(self.root.join("classified"))?;
        Ok(())
    }

    fn load_internal(&mut self) -> Result<(), AppError> {
        if self.state.is_none() {
            let state_file = self.root.join("state.json");
            match fs::read_to_string(&state_file) {
                Ok(content) => {
                    let primary_result = match serde_json::from_str::<Value>(&content) {
                        Ok(value) => normalize_state(value),
                        Err(error) => Err(AppError::message(format!(
                            "state.json JSON 解析失败：{error}"
                        ))),
                    };
                    match primary_result {
                        Ok(state) => self.state = Some(state),
                        Err(primary_error) => {
                            let corrupt = self.root.join(format!(
                                "state.json.corrupt-{}",
                                Utc::now().timestamp_millis()
                            ));
                            preserve_corrupt_copy(&state_file, &corrupt)?;
                            let backup = self.root.join("state.json.bak");
                            let backup_content = fs::read_to_string(&backup).map_err(|_| {
                                AppError::message(format!(
                                    "本地状态损坏，原文件已保留（{}）。",
                                    corrupt.display()
                                ))
                            })?;
                            let mut restored =
                                normalize_state(serde_json::from_str::<Value>(&backup_content)?)?;
                            restored.storage_notice = Some(format!(
                                "state.json 损坏，已使用备份恢复；损坏原文件已保留。{}",
                                primary_error.0
                            ));
                            self.state = Some(restored);
                            self.preserve_backup = true;
                            self.write_state()?;
                            self.preserve_backup = false;
                        }
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

    fn hydrate_state(&mut self) -> Result<(), AppError> {
        if self.previews_loaded {
            return Ok(());
        }
        let root = self.root.clone();
        let state = self
            .state
            .as_mut()
            .ok_or_else(|| AppError::message("本地状态尚未加载"))?;
        for image in state.images.values_mut() {
            image.data_url = None;
            if let Ok(path) = safe_join(&root, &image.relative_path) {
                if let Ok(bytes) = fs::read(path) {
                    image.data_url = Some(format!(
                        "data:{};base64,{}",
                        mime_for(&image.file_name),
                        BASE64.encode(bytes)
                    ));
                }
            }
        }
        self.previews_loaded = true;
        Ok(())
    }

    fn write_state(&mut self) -> Result<(), AppError> {
        self.ensure_directories()?;
        let state = self.state_ref();
        let mut persisted = state.clone();
        persisted.storage_notice = None;
        for image in persisted.images.values_mut() {
            image.data_url = None;
        }
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
            replace_state_file(&temporary, &state_file, &backup_file, self.preserve_backup);
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result?;
        self.previews_loaded = false;
        Ok(())
    }

    fn journal_path(&self) -> PathBuf {
        self.root.join(JOURNAL_FILE)
    }

    fn write_journal(&self, journal: &DeleteJournal) -> Result<(), AppError> {
        if journal.version != JOURNAL_VERSION || journal.operation != "delete_classified_images" {
            return Err(AppError::message("本地操作日志版本无效"));
        }
        write_atomic_json(&self.journal_path(), journal)
    }

    fn clear_journal(&self) -> Result<(), AppError> {
        match fs::remove_file(self.journal_path()) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
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
        if journal.version != JOURNAL_VERSION || journal.operation != "delete_classified_images" {
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
        self.remove_image_records(&remove_ids);
        if !remove_ids.is_empty() {
            self.write_state()?;
        }
        self.clear_journal()
    }

    fn remove_image_records(&mut self, image_ids: &[String]) {
        if image_ids.is_empty() {
            return;
        }
        let ids = image_ids.iter().collect::<HashSet<_>>();
        for canvas in &mut self.state_mut().canvases {
            canvas.image_ids.retain(|id| !ids.contains(id));
        }
        for image_id in image_ids {
            self.state_mut().images.remove(image_id);
        }
    }

    fn controlled_source(&self, image: &ImageRecord) -> Result<(PathBuf, OsString), AppError> {
        let source = safe_join(&self.root, &image.relative_path)?;
        let expected_parent = expected_parent(&self.root, image)?;
        let normalized_relative = image.relative_path.replace('\\', "/");
        let persisted_basename = normalized_relative
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

fn now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn new_canvas(name: &str) -> CanvasRecord {
    CanvasRecord {
        id: Uuid::new_v4().to_string(),
        name: name.into(),
        image_ids: Vec::new(),
        created_at: now(),
        viewport: DEFAULT_VIEWPORT.clone(),
    }
}

fn default_state() -> AppState {
    let canvas = new_canvas("画布 1");
    AppState {
        active_canvas_id: canvas.id.clone(),
        canvases: vec![canvas],
        categories: vec![
            CategoryRecord {
                id: Uuid::new_v4().to_string(),
                name: "角色".into(),
                created_at: now(),
            },
            CategoryRecord {
                id: Uuid::new_v4().to_string(),
                name: "其他".into(),
                created_at: now(),
            },
        ],
        images: BTreeMap::new(),
        storage_notice: None,
    }
}

fn finite_or(value: f64, fallback: f64) -> f64 {
    if value.is_finite() {
        value
    } else {
        fallback
    }
}

fn js_round(value: f64) -> f64 {
    if value.is_finite() {
        (value + 0.5).floor()
    } else {
        0.0
    }
}

fn normalize_viewport(value: &CanvasViewport) -> CanvasViewport {
    CanvasViewport {
        x: js_round(finite_or(value.x, DEFAULT_VIEWPORT.x)),
        y: js_round(finite_or(value.y, DEFAULT_VIEWPORT.y)),
        zoom: finite_or(value.zoom, 1.0).clamp(MIN_ZOOM, MAX_ZOOM),
    }
}

fn normalize_import_viewport(value: &ImportViewport) -> CanvasViewport {
    normalize_viewport(&CanvasViewport {
        x: value.x,
        y: value.y,
        zoom: value.zoom,
    })
}

fn unique_name(file_name: &str, id: &str) -> String {
    let extension = Path::new(file_name)
        .extension()
        .and_then(|item| item.to_str())
        .map(|item| format!(".{}", item.to_lowercase()))
        .unwrap_or_else(|| ".png".into());
    format!("{}{}", id, extension)
}

fn mime_for(file_name: &str) -> &'static str {
    match Path::new(file_name)
        .extension()
        .and_then(|item| item.to_str())
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

fn normalize_state(value: Value) -> Result<AppState, AppError> {
    let object = value
        .as_object()
        .ok_or_else(|| AppError::message("本地状态不是有效对象"))?;
    let canvases_value = object
        .get("canvases")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::message("本地状态结构不完整"))?;
    let categories_value = object
        .get("categories")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::message("本地状态结构不完整"))?;
    let images_value = object
        .get("images")
        .and_then(Value::as_object)
        .ok_or_else(|| AppError::message("本地状态结构不完整"))?;
    let canvases = canvases_value
        .iter()
        .map(|value| {
            let item = value
                .as_object()
                .ok_or_else(|| AppError::message("本地状态包含无效画布"))?;
            let id = item
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::message("本地状态包含无效画布"))?;
            let name = item
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::message("本地状态包含无效画布"))?;
            let image_ids = item
                .get("imageIds")
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            let viewport_value = item.get("viewport").and_then(Value::as_object);
            let viewport = CanvasViewport {
                x: js_round(value_number(
                    viewport_value.and_then(|item| item.get("x")),
                    DEFAULT_VIEWPORT.x,
                )),
                y: js_round(value_number(
                    viewport_value.and_then(|item| item.get("y")),
                    DEFAULT_VIEWPORT.y,
                )),
                zoom: value_number(viewport_value.and_then(|item| item.get("zoom")), 1.0)
                    .clamp(MIN_ZOOM, MAX_ZOOM),
            };
            Ok(CanvasRecord {
                id: id.into(),
                name: name.into(),
                image_ids,
                created_at: item
                    .get("createdAt")
                    .and_then(Value::as_str)
                    .unwrap_or("1970-01-01T00:00:00.000Z")
                    .into(),
                viewport,
            })
        })
        .collect::<Result<Vec<_>, AppError>>()?;
    if canvases.is_empty() {
        return Err(AppError::message("本地状态没有有效的当前画布"));
    }
    let active = object
        .get("activeCanvasId")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::message("本地状态没有有效的当前画布"))?;
    if !canvases.iter().any(|canvas| canvas.id == active) {
        return Err(AppError::message("本地状态没有有效的当前画布"));
    }
    let categories = categories_value
        .iter()
        .map(|value| {
            let item = value
                .as_object()
                .ok_or_else(|| AppError::message("本地状态包含无效分类"))?;
            let id = item
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::message("本地状态包含无效分类"))?;
            let name = item
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::message("本地状态包含无效分类"))?;
            Ok(CategoryRecord {
                id: id.into(),
                name: name.into(),
                created_at: item
                    .get("createdAt")
                    .and_then(Value::as_str)
                    .unwrap_or("1970-01-01T00:00:00.000Z")
                    .into(),
            })
        })
        .collect::<Result<Vec<_>, AppError>>()?;
    let mut images = BTreeMap::new();
    for (id, value) in images_value {
        let item = value
            .as_object()
            .ok_or_else(|| AppError::message("本地状态包含无效图片记录"))?;
        let record_id = item
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::message("本地状态包含无效图片记录"))?;
        if record_id != id {
            return Err(AppError::message("本地状态包含无效图片记录"));
        }
        let status = if item.get("status").and_then(Value::as_str) == Some("classified") {
            "classified"
        } else {
            "pending"
        };
        // Current camelCase keys are preferred, with snake_case and the old
        // short names accepted so an upgraded app can still read old state.
        let relative_path_value = first_string(item, &["relativePath", "relative_path", "path"]);
        let file_name_value = first_string(item, &["fileName", "file_name", "name"]);
        let file_name = file_name_value
            .map(str::to_owned)
            .or_else(|| {
                relative_path_value.and_then(|relative| {
                    Path::new(relative)
                        .file_name()
                        .and_then(OsStr::to_str)
                        .map(str::to_owned)
                })
            })
            .ok_or_else(|| AppError::message("本地状态包含无效图片记录"))?;
        let category_id = first_string(item, &["categoryId", "category_id"]).map(str::to_owned);
        let relative_path = if let Some(relative) = relative_path_value {
            // Keep the persisted location for compatibility, but reject
            // malformed paths when an operation later asks for the physical
            // source. Legacy records without a relative path are synthesized
            // from their status/category and display name below.
            relative.to_owned()
        } else {
            relative_for_status_values(status, category_id.as_deref(), &file_name)?
        };
        images.insert(
            id.clone(),
            ImageRecord {
                id: id.clone(),
                file_name,
                relative_path,
                status: status.into(),
                category_id,
                canvas_id: first_string(item, &["canvasId", "canvas_id"]).map(str::to_owned),
                x: js_round(value_number(item.get("x"), 0.0)),
                y: js_round(value_number(item.get("y"), 0.0)),
                width: js_round(value_number(item.get("width"), 160.0)).max(1.0),
                height: js_round(value_number(item.get("height"), 140.0)).max(1.0),
                created_at: item
                    .get("createdAt")
                    .or_else(|| item.get("created_at"))
                    .and_then(Value::as_str)
                    .unwrap_or("1970-01-01T00:00:00.000Z")
                    .into(),
                data_url: None,
            },
        );
    }
    Ok(AppState {
        active_canvas_id: active.into(),
        canvases,
        categories,
        images,
        storage_notice: None,
    })
}

fn first_string<'a>(item: &'a serde_json::Map<String, Value>, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| item.get(*key).and_then(Value::as_str))
}

fn value_number(value: Option<&Value>, fallback: f64) -> f64 {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .unwrap_or(fallback)
}

fn unique_ids(ids: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    ids.iter()
        .filter(|id| seen.insert((*id).clone()))
        .cloned()
        .collect()
}

fn validate_category_segment(category_id: &str) -> Result<(), AppError> {
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

fn relative_for_status_values(
    status: &str,
    category_id: Option<&str>,
    file_name: &str,
) -> Result<String, AppError> {
    validate_filename(OsStr::new(file_name))?;
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

fn expected_parent(root: &Path, image: &ImageRecord) -> Result<PathBuf, AppError> {
    match image.status.as_str() {
        "pending" => Ok(root.join("pending")),
        "classified" => {
            let category_id = image
                .category_id
                .as_deref()
                .ok_or_else(|| AppError::message("本地状态缺少图片分类"))?;
            validate_category_segment(category_id)?;
            Ok(root.join("classified").join(category_id))
        }
        _ => Err(AppError::message("图片状态无效")),
    }
}

fn relative_for_image(image: &ImageRecord, file_name: &str) -> Result<String, AppError> {
    relative_for_status_values(&image.status, image.category_id.as_deref(), file_name)
}

fn normalized_image_name(old_basename: &OsStr, requested: &str) -> Result<String, AppError> {
    validate_filename(OsStr::new(requested))?;
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
    validate_filename(OsStr::new(&result))?;
    Ok(result)
}

fn validate_filename(name: &OsStr) -> Result<(), AppError> {
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
    if name
        .to_string_lossy()
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

fn casefold_os(value: &OsStr) -> String {
    value.to_string_lossy().to_lowercase()
}

fn same_filename(left: &OsStr, right: &OsStr) -> bool {
    casefold_os(left) == casefold_os(right)
}

fn path_eq(left: &Path, right: &Path) -> bool {
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

fn ensure_no_name_collision(parent: &Path, target: &OsStr, source: &Path) -> Result<(), AppError> {
    let entries = fs::read_dir(parent)?;
    for entry in entries {
        let entry = entry?;
        if same_filename(entry.file_name().as_os_str(), target) && !path_eq(&entry.path(), source) {
            return Err(AppError::message("图片目标文件名已存在"));
        }
    }
    Ok(())
}

fn rename_file_case_safe(source: &Path, destination: &Path) -> Result<(), AppError> {
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
fn rename_file_no_replace(source: &Path, destination: &Path) -> Result<(), AppError> {
    fs::rename(source, destination).map_err(Into::into)
}

#[cfg(windows)]
fn rename_file_no_replace(source: &Path, destination: &Path) -> Result<(), AppError> {
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

fn write_atomic_json<T: Serialize>(path: &Path, value: &T) -> Result<(), AppError> {
    let content = serde_json::to_vec_pretty(value)?;
    let temporary = path.with_file_name(format!(
        "{}.tmp-{}",
        path.file_name()
            .and_then(OsStr::to_str)
            .unwrap_or("journal"),
        Uuid::new_v4()
    ));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    file.write_all(&content)?;
    file.sync_all()?;
    drop(file);
    let result = replace_existing_atomic(&temporary, path);
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(not(windows))]
fn replace_existing_atomic(temporary: &Path, destination: &Path) -> Result<(), AppError> {
    // POSIX rename replaces the destination atomically. Keep this path as a
    // single rename so a crash cannot expose a missing journal/state file.
    fs::rename(temporary, destination).map_err(Into::into)
}

#[cfg(windows)]
fn replace_existing_atomic(temporary: &Path, destination: &Path) -> Result<(), AppError> {
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

fn preserve_corrupt_copy(source: &Path, destination: &Path) -> Result<(), AppError> {
    fs::copy(source, destination).map(|_| ()).map_err(|error| {
        AppError::message(format!(
            "无法保留损坏的 state.json（{}），已保留原文件：{error}",
            source.display()
        ))
    })
}

fn replace_state_file(
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

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn shell_item_accepts_storage_paths_with_forward_slashes() {
        use windows::core::PCWSTR;
        use windows::Win32::System::Com::{
            CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED,
        };
        use windows::Win32::UI::Shell::{IShellItem, SHCreateItemFromParsingName};
        let root = std::env::temp_dir().join(format!("picboard-shell-{}", uuid::Uuid::new_v4()));
        let folder = root.join("classified").join("分类 空格");
        std::fs::create_dir_all(&folder).unwrap();
        let file = folder.join("测试 图片.png");
        std::fs::write(&file, b"shell parsing only").unwrap();
        let path = crate::paths::safe_join(&root, "classified/分类 空格/测试 图片.png").unwrap();
        let wide = shell_parsing_path(&path).unwrap();
        let result = std::thread::spawn(move || {
            unsafe {
                CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok().unwrap();
            }
            let result = unsafe {
                SHCreateItemFromParsingName::<_, _, IShellItem>(PCWSTR(wide.as_ptr()), None)
            };
            let status = result
                .as_ref()
                .map(|_| ())
                .map_err(|error| error.to_string());
            drop(result);
            unsafe {
                CoUninitialize();
            }
            status
        })
        .join()
        .unwrap();
        assert!(
            file.exists(),
            "Shell item creation must not delete the test file"
        );
        std::fs::remove_dir_all(&root).unwrap();
        assert!(result.is_ok(), "Shell item creation failed: {result:?}");
    }

    use std::sync::{Arc, Mutex};
    use tempfile::TempDir;

    struct FakeRecycleBin {
        calls: Arc<Mutex<Vec<PathBuf>>>,
        fail_at: Option<usize>,
    }

    impl RecycleBin for FakeRecycleBin {
        fn recycle(&self, path: &Path) -> Result<(), AppError> {
            let mut calls = self.calls.lock().unwrap();
            let index = calls.len();
            if self.fail_at == Some(index) {
                return Err(AppError::message("fake recycle failure"));
            }
            calls.push(path.to_path_buf());
            fs::remove_file(path)?;
            Ok(())
        }
    }

    fn storage(
        temp: &TempDir,
        calls: Arc<Mutex<Vec<PathBuf>>>,
        fail_at: Option<usize>,
    ) -> ImageBoardStorage {
        ImageBoardStorage::with_recycle_bin(
            temp.path().to_path_buf(),
            Box::new(FakeRecycleBin { calls, fail_at }),
        )
    }

    #[test]
    fn rename_updates_disk_basename_and_preserves_extension() {
        let temp = tempfile::tempdir().unwrap();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let mut store = storage(&temp, calls, None);
        let state = store.load_state().unwrap();
        let canvas = state.active_canvas_id.clone();
        let state = store
            .import_images(
                &canvas,
                vec![ImportImagePayload {
                    name: "photo.JPG".into(),
                    data: b"x".to_vec(),
                }],
                None,
            )
            .unwrap();
        let id = state.images.keys().next().unwrap().clone();
        let old = safe_join(temp.path(), &state.images[&id].relative_path).unwrap();
        let state = store.rename_image(&id, "renamed").unwrap();
        let image = &state.images[&id];
        assert_eq!(image.file_name, "renamed.jpg");
        assert!(
            image.relative_path.ends_with("pending\\renamed.jpg")
                || image.relative_path.ends_with("pending/renamed.jpg")
        );
        assert!(!old.exists());
        assert!(safe_join(temp.path(), &image.relative_path)
            .unwrap()
            .is_file());
    }

    #[test]
    fn invalid_names_and_extension_changes_are_rejected() {
        assert!(validate_filename(OsStr::new("a/b")).is_err());
        assert!(validate_filename(OsStr::new("CON")).is_err());
        assert!(validate_filename(OsStr::new("a.")).is_err());
        assert!(validate_filename(OsStr::new("a ")).is_err());
        assert!(normalized_image_name(OsStr::new("x.jpg"), "x.png").is_err());
        assert!(normalized_image_name(OsStr::new("x"), "x.png").is_err());
    }

    #[test]
    fn classify_preserves_current_physical_basename() {
        let temp = tempfile::tempdir().unwrap();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let mut store = storage(&temp, calls, None);
        let state = store.load_state().unwrap();
        let canvas = state.active_canvas_id.clone();
        let state = store
            .import_images(
                &canvas,
                vec![ImportImagePayload {
                    name: "display.png".into(),
                    data: b"x".to_vec(),
                }],
                None,
            )
            .unwrap();
        let id = state.images.keys().next().unwrap().clone();
        let physical = Path::new(&state.images[&id].relative_path)
            .file_name()
            .unwrap()
            .to_owned();
        let category = state.categories[0].id.clone();
        let state = store.classify_images(&[id.clone()], &category).unwrap();
        let image = &state.images[&id];
        assert_eq!(
            Path::new(&image.relative_path).file_name().unwrap(),
            physical
        );
        assert!(
            image
                .relative_path
                .contains(&format!("classified/{category}"))
                || image
                    .relative_path
                    .contains(&format!("classified\\{category}"))
        );
        assert_eq!(image.file_name, "display.png");
    }

    #[test]
    fn classified_delete_removes_all_canvas_references() {
        let temp = tempfile::tempdir().unwrap();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let mut store = storage(&temp, calls.clone(), None);
        let state = store.load_state().unwrap();
        let canvas = state.active_canvas_id.clone();
        let state = store
            .import_images(
                &canvas,
                vec![ImportImagePayload {
                    name: "x.png".into(),
                    data: b"x".to_vec(),
                }],
                None,
            )
            .unwrap();
        let id = state.images.keys().next().unwrap().clone();
        let category = state.categories[0].id.clone();
        store.classify_images(&[id.clone()], &category).unwrap();
        let second = store.create_canvas().unwrap().active_canvas_id;
        store
            .state_mut()
            .canvases
            .iter_mut()
            .find(|c| c.id == second)
            .unwrap()
            .image_ids
            .push(id.clone());
        store.write_state().unwrap();
        let state = store
            .delete_classified_images(std::slice::from_ref(&id))
            .unwrap();
        assert!(!state.images.contains_key(&id));
        assert!(state
            .canvases
            .iter()
            .all(|canvas| !canvas.image_ids.contains(&id)));
        assert_eq!(calls.lock().unwrap().len(), 1);
    }

    #[test]
    fn recycle_failure_leaves_unrecycled_state_and_file() {
        let temp = tempfile::tempdir().unwrap();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let mut store = storage(&temp, calls, Some(0));
        let state = store.load_state().unwrap();
        let canvas = state.active_canvas_id.clone();
        let state = store
            .import_images(
                &canvas,
                vec![ImportImagePayload {
                    name: "x.png".into(),
                    data: b"x".to_vec(),
                }],
                None,
            )
            .unwrap();
        let id = state.images.keys().next().unwrap().clone();
        let category = state.categories[0].id.clone();
        let state = store.classify_images(&[id.clone()], &category).unwrap();
        let path = safe_join(temp.path(), &state.images[&id].relative_path).unwrap();
        assert!(store.delete_classified_images(&[id.clone()]).is_err());
        assert!(store.state_ref().images.contains_key(&id));
        assert!(path.exists());
    }

    #[test]
    fn classify_conflict_is_preflighted_without_moving_source() {
        let temp = tempfile::tempdir().unwrap();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let mut store = storage(&temp, calls, None);
        let state = store.load_state().unwrap();
        let canvas = state.active_canvas_id.clone();
        let state = store
            .import_images(
                &canvas,
                vec![ImportImagePayload {
                    name: "display.png".into(),
                    data: b"x".to_vec(),
                }],
                None,
            )
            .unwrap();
        let id = state.images.keys().next().unwrap().clone();
        let source = safe_join(temp.path(), &state.images[&id].relative_path).unwrap();
        let basename = source.file_name().unwrap().to_owned();
        let category = state.categories[0].id.clone();
        let target_dir = temp.path().join("classified").join(&category);
        fs::create_dir_all(&target_dir).unwrap();
        fs::write(target_dir.join(&basename), b"existing").unwrap();

        assert!(store.classify_images(&[id.clone()], &category).is_err());
        let current = store.state_ref().images.get(&id).unwrap();
        assert_eq!(current.status, "pending");
        assert_eq!(
            Path::new(&current.relative_path).file_name().unwrap(),
            basename
        );
        assert!(source.is_file());
    }

    #[test]
    fn rename_rejects_existing_target_without_overwriting_source() {
        let temp = tempfile::tempdir().unwrap();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let mut store = storage(&temp, calls, None);
        let state = store.load_state().unwrap();
        let canvas = state.active_canvas_id.clone();
        let state = store
            .import_images(
                &canvas,
                vec![ImportImagePayload {
                    name: "one.png".into(),
                    data: b"one".to_vec(),
                }],
                None,
            )
            .unwrap();
        let id = state.images.keys().next().unwrap().clone();
        let source = safe_join(temp.path(), &state.images[&id].relative_path).unwrap();
        let target = source.parent().unwrap().join("taken.png");
        fs::write(&target, b"taken").unwrap();

        assert!(store.rename_image(&id, "taken.png").is_err());
        assert_eq!(fs::read(&source).unwrap(), b"one");
        assert_eq!(fs::read(&target).unwrap(), b"taken");
        assert_eq!(store.state_ref().images[&id].file_name, "one.png");
    }

    #[test]
    fn filename_validation_uses_windows_character_units_and_device_aliases() {
        // 130 CJK code points are 130 UTF-16 units but 390 UTF-8 bytes, so a
        // Windows component-length check must not reject them as oversized.
        let cjk = "界".repeat(130);
        assert!(validate_filename(OsStr::new(&cjk)).is_ok());
        assert!(validate_filename(OsStr::new(&"😀".repeat(128))).is_err());
        assert!(validate_filename(OsStr::new("COM¹.txt")).is_err());
        assert!(validate_filename(OsStr::new("LPT²")).is_err());
    }

    #[test]
    fn recycled_journal_recovery_removes_recycled_references_idempotently() {
        let temp = tempfile::tempdir().unwrap();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let mut store = storage(&temp, calls, None);
        let state = store.load_state().unwrap();
        let canvas = state.active_canvas_id.clone();
        let state = store
            .import_images(
                &canvas,
                vec![ImportImagePayload {
                    name: "x.png".into(),
                    data: b"x".to_vec(),
                }],
                None,
            )
            .unwrap();
        let id = state.images.keys().next().unwrap().clone();
        let category = state.categories[0].id.clone();
        let state = store.classify_images(&[id.clone()], &category).unwrap();
        let source = safe_join(temp.path(), &state.images[&id].relative_path).unwrap();
        fs::remove_file(&source).unwrap();
        store
            .write_journal(&DeleteJournal {
                version: JOURNAL_VERSION,
                operation: "delete_classified_images".into(),
                phase: "recycled".into(),
                entries: vec![DeleteJournalEntry {
                    id: id.clone(),
                    source: source.to_string_lossy().into_owned(),
                    status: "recycled".into(),
                }],
            })
            .unwrap();

        let mut recovered = storage(&temp, Arc::new(Mutex::new(Vec::new())), None);
        let state = recovered.load_state().unwrap();
        assert!(!state.images.contains_key(&id));
        assert!(state
            .canvases
            .iter()
            .all(|canvas| !canvas.image_ids.contains(&id)));
        assert!(!temp.path().join(JOURNAL_FILE).exists());

        let state = recovered.load_state().unwrap();
        assert!(!state.images.contains_key(&id));
    }

    #[test]
    fn corrupt_primary_copy_failure_is_reported_without_touching_primary() {
        let temp = tempfile::tempdir().unwrap();
        let state_file = temp.path().join("state.json");
        let corrupt = temp.path().join("missing").join("state.json.corrupt-test");
        fs::write(&state_file, b"{ definitely not json").unwrap();

        let error = preserve_corrupt_copy(&state_file, &corrupt).unwrap_err();

        assert!(error.0.contains("无法保留损坏的 state.json"));
        assert_eq!(fs::read(&state_file).unwrap(), b"{ definitely not json");
        assert!(!corrupt.exists());
    }

    #[test]
    fn malformed_primary_json_restores_backup_and_keeps_corrupt_copy() {
        let temp = tempfile::tempdir().unwrap();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let mut store = storage(&temp, calls, None);
        let state = store.load_state().unwrap();
        let canvas = state.active_canvas_id.clone();
        let state = store
            .import_images(
                &canvas,
                vec![ImportImagePayload {
                    name: "recover.png".into(),
                    data: b"recover".to_vec(),
                }],
                None,
            )
            .unwrap();
        let id = state.images.keys().next().unwrap().clone();
        fs::copy(
            temp.path().join("state.json"),
            temp.path().join("state.json.bak"),
        )
        .unwrap();
        fs::write(temp.path().join("state.json"), b"{ definitely not json").unwrap();

        let mut recovered = storage(&temp, Arc::new(Mutex::new(Vec::new())), None);
        let restored = recovered.load_state().unwrap();
        assert!(restored.images.contains_key(&id));
        assert!(restored
            .storage_notice
            .as_deref()
            .is_some_and(|notice| notice.contains("已使用备份恢复")));
        let corrupt_copies = fs::read_dir(temp.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("state.json.corrupt-")
            })
            .count();
        assert_eq!(corrupt_copies, 1);
        assert_eq!(
            fs::read_to_string(temp.path().join("state.json.bak")).is_ok(),
            true
        );
    }

    #[test]
    fn controlled_source_rejects_status_category_parent_mismatch() {
        let temp = tempfile::tempdir().unwrap();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let mut store = storage(&temp, calls, None);
        let state = store.load_state().unwrap();
        let canvas = state.active_canvas_id.clone();
        let state = store
            .import_images(
                &canvas,
                vec![ImportImagePayload {
                    name: "x.png".into(),
                    data: b"x".to_vec(),
                }],
                None,
            )
            .unwrap();
        let id = state.images.keys().next().unwrap().clone();
        let mut tampered = state;
        let actual_relative = tampered.images.get(&id).unwrap().relative_path.clone();
        tampered.images.get_mut(&id).unwrap().relative_path =
            "classified/not-the-status-parent/x.png".into();
        store.state = Some(tampered);
        assert!(store.rename_image(&id, "renamed").is_err());
        store
            .state
            .as_mut()
            .unwrap()
            .images
            .get_mut(&id)
            .unwrap()
            .relative_path = actual_relative;
    }
}
