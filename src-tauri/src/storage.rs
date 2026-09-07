use crate::{dto::{AppState, CanvasRecord, CanvasViewport, CategoryRecord, ImageRecord, ImportImagePayload, ImportViewport}, error::AppError, paths::{safe_join, sanitize_segment}};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chrono::Utc;
use serde_json::Value;
use std::{collections::BTreeMap, fs, io::Write, path::{Path, PathBuf}};
use uuid::Uuid;

const DEFAULT_VIEWPORT: CanvasViewport = CanvasViewport { x: -900.0, y: -500.0, zoom: 1.0 };
const MIN_ZOOM: f64 = 0.5;
const MAX_ZOOM: f64 = 1.5;

pub struct ImageBoardStorage {
    pub root: PathBuf,
    state: Option<AppState>,
    previews_loaded: bool,
    /// True after recovering from a corrupt primary file. While set, the next
    /// successful write must not copy the (bad) primary over the good backup.
    preserve_backup: bool,
}

impl ImageBoardStorage {
    pub fn new(root: PathBuf) -> Self { Self { root, state: None, previews_loaded: false, preserve_backup: false } }

    pub fn load_state(&mut self) -> Result<AppState, AppError> {
        self.ensure_directories()?;
        self.load_internal()?;
        self.hydrate_state()?;
        self.snapshot()
    }

    pub fn import_images(&mut self, canvas_id: &str, payloads: Vec<ImportImagePayload>, viewport: Option<ImportViewport>) -> Result<AppState, AppError> {
        self.ensure_loaded()?;
        let before = self.snapshot()?;
        let canvas_index = self.canvas_index(canvas_id)?;
        let view = viewport.as_ref().map(normalize_import_viewport).unwrap_or_else(|| self.state_ref().canvases[canvas_index].viewport.clone());
        self.state_mut().canvases[canvas_index].viewport = view.clone();
        let width = viewport.as_ref().map(|item| finite_or(item.width, 640.0).max(320.0)).unwrap_or(640.0);
        let height = viewport.as_ref().map(|item| finite_or(item.height, 480.0).max(240.0)).unwrap_or(480.0);
        let start_x = (width / 2.0 - view.x) / view.zoom - 80.0;
        let start_y = (height / 2.0 - view.y) / view.zoom - 70.0;
        let mut created = Vec::new();
        let result = (|| {
            for (index, payload) in payloads.iter().enumerate() {
                let id = Uuid::new_v4().to_string();
                let file_name = if payload.name.trim().is_empty() { format!("{id}.png") } else { payload.name.clone() };
                let relative = PathBuf::from("pending").join(unique_name(&file_name, &id)).to_string_lossy().into_owned();
                let absolute = safe_join(&self.root, &relative)?;
                let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&absolute)?;
                file.write_all(&payload.data)?;
                file.sync_all()?;
                created.push(absolute);
                let image = ImageRecord { id: id.clone(), file_name, relative_path: relative, status: "pending".into(), category_id: None, canvas_id: Some(canvas_id.into()), x: js_round(start_x + (index % 3) as f64 * 190.0), y: js_round(start_y + (index / 3) as f64 * 180.0), width: 160.0, height: 140.0, created_at: now(), data_url: None };
                self.state_mut().images.insert(id.clone(), image);
                self.state_mut().canvases[canvas_index].image_ids.push(id);
            }
            self.write_state()
        })();
        if let Err(error) = result {
            self.state = Some(before);
            for path in created { let _ = fs::remove_file(path); }
            return Err(error);
        }
        self.hydrate_state()?;
        self.snapshot()
    }

    pub fn paste_image(&mut self, canvas_id: &str) -> Result<(AppState, bool), AppError> {
        self.ensure_loaded()?;
        let Some(data) = crate::clipboard::read_image_png()? else { return Ok((self.snapshot()?, false)); };
        let payload = ImportImagePayload { name: format!("粘贴图片-{}.png", Utc::now().timestamp_millis()), data };
        Ok((self.import_images(canvas_id, vec![payload], None)?, true))
    }

    pub fn set_active_canvas(&mut self, canvas_id: &str) -> Result<AppState, AppError> {
        self.ensure_loaded()?;
        self.canvas_index(canvas_id)?;
        self.state_mut().active_canvas_id = canvas_id.into();
        self.write_state()?;
        self.snapshot()
    }

    pub fn set_canvas_viewport(&mut self, canvas_id: &str, viewport: CanvasViewport) -> Result<AppState, AppError> {
        self.ensure_loaded()?;
        let index = self.canvas_index(canvas_id)?;
        self.state_mut().canvases[index].viewport = normalize_viewport(&viewport);
        self.write_state()?;
        self.snapshot()
    }

    pub fn create_canvas(&mut self) -> Result<AppState, AppError> {
        self.ensure_loaded()?;
        let canvas = CanvasRecord { id: Uuid::new_v4().to_string(), name: format!("画布 {}", self.state_ref().canvases.len() + 1), image_ids: Vec::new(), created_at: now(), viewport: DEFAULT_VIEWPORT.clone() };
        self.state_mut().active_canvas_id = canvas.id.clone();
        self.state_mut().canvases.push(canvas);
        self.write_state()?;
        self.snapshot()
    }

    pub fn rename_canvas(&mut self, canvas_id: &str, name: &str) -> Result<AppState, AppError> {
        self.ensure_loaded()?;
        let index = self.canvas_index(canvas_id)?;
        let name = name.trim();
        if !name.is_empty() { self.state_mut().canvases[index].name = name.into(); }
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
                let Some(image) = self.state_ref().images.get(image_id).cloned() else { continue };
                if image.status == "pending" {
                    let from = safe_join(&self.root, &image.relative_path)?;
                    let to = self.root.join(".trash").join(format!("{}-{}", image.id, Uuid::new_v4()));
                    fs::rename(&from, &to)?;
                    moved.push((from, to));
                    self.state_mut().images.remove(image_id);
                } else if let Some(record) = self.state_mut().images.get_mut(image_id) { record.canvas_id = None; }
            }
            self.state_mut().canvases.remove(index);
            if self.state_ref().canvases.is_empty() { self.state_mut().canvases.push(new_canvas("画布 1")); }
            if self.state_ref().active_canvas_id == canvas_id { self.state_mut().active_canvas_id = self.state_ref().canvases[0].id.clone(); }
            self.write_state()
        })();
        if let Err(error) = result {
            self.state = Some(before);
            for (from, to) in moved.into_iter().rev() { let _ = fs::rename(to, from); }
            return Err(error);
        }
        for (_, to) in moved { let _ = fs::remove_file(to); }
        self.snapshot()
    }

    pub fn create_category(&mut self, name: &str) -> Result<AppState, AppError> {
        self.ensure_loaded()?;
        let name = name.trim();
        if !name.is_empty() && !self.state_ref().categories.iter().any(|item| item.name == name) {
            self.state_mut().categories.push(CategoryRecord { id: Uuid::new_v4().to_string(), name: name.into(), created_at: now() });
            self.write_state()?;
        }
        self.snapshot()
    }

    pub fn classify_images(&mut self, image_ids: &[String], category_id: &str) -> Result<AppState, AppError> {
        self.ensure_loaded()?;
        if !self.state_ref().categories.iter().any(|item| item.id == category_id) { return Err(AppError::message("找不到指定分类")); }
        let before = self.snapshot()?;
        let mut moved = Vec::new();
        let result = (|| {
            for image_id in image_ids {
                let image = self.state_ref().images.get(image_id).cloned().ok_or_else(|| AppError::message("找不到指定图片"))?;
                let relative = PathBuf::from("classified").join(sanitize_segment(category_id)).join(unique_name(&image.file_name, &image.id)).to_string_lossy().into_owned();
                let destination = safe_join(&self.root, &relative)?;
                if image.status != "classified" || image.category_id.as_deref() != Some(category_id) || image.relative_path != relative {
                    if let Some(parent) = destination.parent() { fs::create_dir_all(parent)?; }
                    let source = safe_join(&self.root, &image.relative_path)?;
                    fs::rename(&source, &destination)?;
                    moved.push((source, destination.clone()));
                    let record = self.state_mut().images.get_mut(image_id).ok_or_else(|| AppError::message("找不到指定图片"))?;
                    record.relative_path = relative;
                    record.status = "classified".into();
                }
                if let Some(record) = self.state_mut().images.get_mut(image_id) { record.category_id = Some(category_id.into()); }
            }
            self.write_state()
        })();
        if let Err(error) = result {
            self.state = Some(before);
            for (from, to) in moved.into_iter().rev() { let _ = fs::rename(to, from); }
            return Err(error);
        }
        self.hydrate_state()?;
        self.snapshot()
    }

    pub fn remove_image_from_canvas(&mut self, image_id: &str) -> Result<AppState, AppError> {
        self.ensure_loaded()?;
        let before = self.snapshot()?;
        let image = self.state_ref().images.get(image_id).cloned().ok_or_else(|| AppError::message("找不到指定图片"))?;
        let Some(canvas_id) = image.canvas_id.clone() else { return self.snapshot(); };
        let canvas_index = self.canvas_index(&canvas_id)?;
        self.state_mut().canvases[canvas_index].image_ids.retain(|id| id != image_id);
        if let Some(record) = self.state_mut().images.get_mut(image_id) { record.canvas_id = None; }
        let mut moved = None;
        let result = (|| {
            if image.status == "pending" {
                let from = safe_join(&self.root, &image.relative_path)?;
                let to = self.root.join(".trash").join(format!("{}-{}", image.id, Uuid::new_v4()));
                fs::rename(&from, &to)?;
                moved = Some((from, to));
                self.state_mut().images.remove(image_id);
            }
            self.write_state()
        })();
        if let Err(error) = result {
            self.state = Some(before);
            if let Some((from, to)) = moved { let _ = fs::rename(to, from); }
            return Err(error);
        }
        if let Some((_, to)) = moved { let _ = fs::remove_file(to); }
        self.snapshot()
    }

    pub fn move_image(&mut self, image_id: &str, x: f64, y: f64) -> Result<AppState, AppError> {
        self.ensure_loaded()?;
        if !x.is_finite() || !y.is_finite() { return Err(AppError::message("图片坐标无效")); }
        let image = self.state_mut().images.get_mut(image_id).ok_or_else(|| AppError::message("找不到指定图片"))?;
        image.x = js_round(x); image.y = js_round(y);
        self.write_state()?;
        self.snapshot()
    }

    pub fn image_paths(&mut self, image_ids: &[String]) -> Result<Vec<PathBuf>, AppError> {
        self.ensure_loaded()?;
        let mut unique = Vec::new();
        for image_id in image_ids {
            let image = self.state_ref().images.get(image_id).ok_or_else(|| AppError::message("找不到指定图片"))?;
            let path = safe_join(&self.root, &image.relative_path)?;
            if !unique.contains(&path) { unique.push(path); }
        }
        for path in &unique { if !path.is_file() { return Err(AppError::message(format!("图片文件不存在：{}", path.display()))); } }
        Ok(unique)
    }

    fn ensure_loaded(&mut self) -> Result<(), AppError> { self.ensure_directories()?; self.load_internal()?; self.hydrate_state() }

    fn ensure_directories(&self) -> Result<(), AppError> {
        fs::create_dir_all(self.root.join("pending"))?;
        fs::create_dir_all(self.root.join("classified"))?;
        fs::create_dir_all(self.root.join(".trash"))?;
        Ok(())
    }

    fn load_internal(&mut self) -> Result<(), AppError> {
        if self.state.is_some() { return Ok(()); }
        let state_file = self.root.join("state.json");
        match fs::read_to_string(&state_file) {
            Ok(content) => match normalize_state(serde_json::from_str::<Value>(&content)?) {
                Ok(state) => self.state = Some(state),
                Err(primary_error) => {
                    let corrupt = self.root.join(format!("state.json.corrupt-{}", Utc::now().timestamp_millis()));
                    let _ = fs::copy(&state_file, &corrupt);
                    let backup = self.root.join("state.json.bak");
                    let backup_content = fs::read_to_string(&backup).map_err(|_| AppError::message(format!("本地状态损坏，原文件已保留（{}）。", corrupt.display())))?;
                    let mut restored = normalize_state(serde_json::from_str::<Value>(&backup_content)?)?;
                    restored.storage_notice = Some(format!("state.json 损坏，已使用备份恢复；损坏原文件已保留。{}", primary_error.0));
                    self.state = Some(restored);
                    self.preserve_backup = true;
                    self.write_state()?;
                    self.preserve_backup = false;
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                self.state = Some(default_state());
                self.write_state()?;
            },
            Err(error) => return Err(error.into()),
        }
        Ok(())
    }

    fn hydrate_state(&mut self) -> Result<(), AppError> {
        if self.previews_loaded { return Ok(()); }
        let root = self.root.clone();
        let state = self.state.as_mut().ok_or_else(|| AppError::message("本地状态尚未加载"))?;
        for image in state.images.values_mut() {
            image.data_url = None;
            if let Ok(path) = safe_join(&root, &image.relative_path) {
                if let Ok(bytes) = fs::read(path) {
                    image.data_url = Some(format!("data:{};base64,{}", mime_for(&image.file_name), BASE64.encode(bytes)));
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
        for image in persisted.images.values_mut() { image.data_url = None; }
        let content = serde_json::to_vec_pretty(&persisted)?;
        let state_file = self.root.join("state.json");
        let temporary = self.root.join(format!("state.json.tmp-{}", Uuid::new_v4()));
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&temporary)?;
        file.write_all(&content)?;
        file.sync_all()?;
        drop(file);
        let backup_file = self.root.join("state.json.bak");
        if !self.preserve_backup {
            // Keep a copy of the current primary as the rollback point. A missing
            // primary (first run) is fine; other failures must abort the write.
            if let Err(error) = fs::copy(&state_file, &backup_file) {
                if error.kind() != std::io::ErrorKind::NotFound { return Err(error.into()); }
            }
        }
        if state_file.exists() { fs::remove_file(&state_file)?; }
        if let Err(error) = fs::rename(&temporary, &state_file) { let _ = fs::remove_file(&temporary); return Err(error.into()); }
        self.previews_loaded = false;
        Ok(())
    }

    fn snapshot(&self) -> Result<AppState, AppError> { self.state.clone().ok_or_else(|| AppError::message("本地状态尚未加载")) }
    fn state_ref(&self) -> &AppState { self.state.as_ref().expect("state loaded") }
    fn state_mut(&mut self) -> &mut AppState { self.state.as_mut().expect("state loaded") }
    fn canvas_index(&self, id: &str) -> Result<usize, AppError> { self.state_ref().canvases.iter().position(|canvas| canvas.id == id).ok_or_else(|| AppError::message("找不到指定画布")) }
}

fn now() -> String { Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true) }
fn new_canvas(name: &str) -> CanvasRecord { CanvasRecord { id: Uuid::new_v4().to_string(), name: name.into(), image_ids: Vec::new(), created_at: now(), viewport: DEFAULT_VIEWPORT.clone() } }
fn default_state() -> AppState {
    let canvas = new_canvas("画布 1");
    AppState { active_canvas_id: canvas.id.clone(), canvases: vec![canvas], categories: vec![CategoryRecord { id: Uuid::new_v4().to_string(), name: "角色".into(), created_at: now() }, CategoryRecord { id: Uuid::new_v4().to_string(), name: "其他".into(), created_at: now() }], images: BTreeMap::new(), storage_notice: None }
}
fn finite_or(value: f64, fallback: f64) -> f64 { if value.is_finite() { value } else { fallback } }
fn js_round(value: f64) -> f64 { if value.is_finite() { (value + 0.5).floor() } else { 0.0 } }
fn normalize_viewport(value: &CanvasViewport) -> CanvasViewport { CanvasViewport { x: js_round(finite_or(value.x, DEFAULT_VIEWPORT.x)), y: js_round(finite_or(value.y, DEFAULT_VIEWPORT.y)), zoom: finite_or(value.zoom, 1.0).clamp(MIN_ZOOM, MAX_ZOOM) } }
fn normalize_import_viewport(value: &ImportViewport) -> CanvasViewport { normalize_viewport(&CanvasViewport { x: value.x, y: value.y, zoom: value.zoom }) }
fn unique_name(file_name: &str, id: &str) -> String { let extension = Path::new(file_name).extension().and_then(|item| item.to_str()).map(|item| format!(".{}", item.to_lowercase())).unwrap_or_else(|| ".png".into()); format!("{}{}", id, extension) }
fn mime_for(file_name: &str) -> &'static str { match Path::new(file_name).extension().and_then(|item| item.to_str()).unwrap_or_default().to_ascii_lowercase().as_str() { "jpg" | "jpeg" => "image/jpeg", "png" => "image/png", "gif" => "image/gif", "webp" => "image/webp", "bmp" => "image/bmp", _ => "application/octet-stream" } }

fn normalize_state(value: Value) -> Result<AppState, AppError> {
    let object = value.as_object().ok_or_else(|| AppError::message("本地状态不是有效对象"))?;
    let canvases_value = object.get("canvases").and_then(Value::as_array).ok_or_else(|| AppError::message("本地状态结构不完整"))?;
    let categories_value = object.get("categories").and_then(Value::as_array).ok_or_else(|| AppError::message("本地状态结构不完整"))?;
    let images_value = object.get("images").and_then(Value::as_object).ok_or_else(|| AppError::message("本地状态结构不完整"))?;
    let canvases = canvases_value.iter().map(|value| {
        let item = value.as_object().ok_or_else(|| AppError::message("本地状态包含无效画布"))?;
        let id = item.get("id").and_then(Value::as_str).ok_or_else(|| AppError::message("本地状态包含无效画布"))?;
        let name = item.get("name").and_then(Value::as_str).ok_or_else(|| AppError::message("本地状态包含无效画布"))?;
        let image_ids = item.get("imageIds").and_then(Value::as_array).map(|values| values.iter().filter_map(Value::as_str).map(str::to_owned).collect()).unwrap_or_default();
        let viewport_value = item.get("viewport").and_then(Value::as_object);
        let viewport = CanvasViewport { x: js_round(value_number(viewport_value.and_then(|item| item.get("x")), DEFAULT_VIEWPORT.x)), y: js_round(value_number(viewport_value.and_then(|item| item.get("y")), DEFAULT_VIEWPORT.y)), zoom: value_number(viewport_value.and_then(|item| item.get("zoom")), 1.0).clamp(MIN_ZOOM, MAX_ZOOM) };
        Ok(CanvasRecord { id: id.into(), name: name.into(), image_ids, created_at: item.get("createdAt").and_then(Value::as_str).unwrap_or("1970-01-01T00:00:00.000Z").into(), viewport })
    }).collect::<Result<Vec<_>, AppError>>()?;
    if canvases.is_empty() { return Err(AppError::message("本地状态没有有效的当前画布")); }
    let active = object.get("activeCanvasId").and_then(Value::as_str).ok_or_else(|| AppError::message("本地状态没有有效的当前画布"))?;
    if !canvases.iter().any(|canvas| canvas.id == active) { return Err(AppError::message("本地状态没有有效的当前画布")); }
    let categories = categories_value.iter().map(|value| {
        let item = value.as_object().ok_or_else(|| AppError::message("本地状态包含无效分类"))?;
        let id = item.get("id").and_then(Value::as_str).ok_or_else(|| AppError::message("本地状态包含无效分类"))?;
        let name = item.get("name").and_then(Value::as_str).ok_or_else(|| AppError::message("本地状态包含无效分类"))?;
        Ok(CategoryRecord { id: id.into(), name: name.into(), created_at: item.get("createdAt").and_then(Value::as_str).unwrap_or("1970-01-01T00:00:00.000Z").into() })
    }).collect::<Result<Vec<_>, AppError>>()?;
    let mut images = BTreeMap::new();
    for (id, value) in images_value {
        let item = value.as_object().ok_or_else(|| AppError::message("本地状态包含无效图片记录"))?;
        let record_id = item.get("id").and_then(Value::as_str).ok_or_else(|| AppError::message("本地状态包含无效图片记录"))?;
        if record_id != id { return Err(AppError::message("本地状态包含无效图片记录")); }
        let file_name = item.get("fileName").and_then(Value::as_str).ok_or_else(|| AppError::message("本地状态包含无效图片记录"))?;
        let relative_path = item.get("relativePath").and_then(Value::as_str).ok_or_else(|| AppError::message("本地状态包含无效图片记录"))?;
        images.insert(id.clone(), ImageRecord { id: id.clone(), file_name: file_name.into(), relative_path: relative_path.into(), status: if item.get("status").and_then(Value::as_str) == Some("classified") { "classified" } else { "pending" }.into(), category_id: item.get("categoryId").and_then(Value::as_str).map(str::to_owned), canvas_id: item.get("canvasId").and_then(Value::as_str).map(str::to_owned), x: js_round(value_number(item.get("x"), 0.0)), y: js_round(value_number(item.get("y"), 0.0)), width: js_round(value_number(item.get("width"), 160.0)).max(1.0), height: js_round(value_number(item.get("height"), 140.0)).max(1.0), created_at: item.get("createdAt").and_then(Value::as_str).unwrap_or("1970-01-01T00:00:00.000Z").into(), data_url: None });
    }
    Ok(AppState { active_canvas_id: active.into(), canvases, categories, images, storage_notice: None })
}
fn value_number(value: Option<&Value>, fallback: f64) -> f64 { value.and_then(Value::as_f64).filter(|value| value.is_finite()).unwrap_or(fallback) }
