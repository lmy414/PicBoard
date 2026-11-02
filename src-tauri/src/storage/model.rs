//! Persisted schema (v2) and all tolerance repairs applied on load.
//!
//! The same types serve as the renderer snapshot; `state.json` stores them with
//! `version: 2` and one internal `hash` per content record.

use crate::dto::{
    AppState, CanvasFrame, CanvasNode, CanvasRecord, CanvasViewport, CategoryRecord,
    ContentKind, ContentRecord, ContentSource, EdgeRecord, STATE_VERSION,
};
use crate::error::AppError;
use chrono::Utc;
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;
use uuid::Uuid;

pub(crate) const DEFAULT_VIEWPORT: CanvasViewport = CanvasViewport {
    x: -900.0,
    y: -500.0,
    zoom: 1.0,
};
pub(crate) const MIN_ZOOM: f64 = 0.5;
pub(crate) const MAX_ZOOM: f64 = 1.5;
pub(crate) const DEFAULT_FRAME_WIDTH: f64 = 280.0;
pub(crate) const DEFAULT_FRAME_HEIGHT: f64 = 180.0;
pub(crate) const FRAME_MIN_WIDTH: f64 = 120.0;
pub(crate) const FRAME_MIN_HEIGHT: f64 = 80.0;
pub(crate) const GROUP_PADDING: f64 = 32.0;
pub(crate) const GROUP_MIN_WIDTH: f64 = 240.0;
pub(crate) const GROUP_MIN_HEIGHT: f64 = 160.0;

const FALLBACK_NODE_WIDTH: f64 = 120.0;
const FALLBACK_NODE_HEIGHT: f64 = 80.0;

/// Everything `copy_contents` needs, resolved under the storage lock.
#[derive(Debug, Clone)]
pub struct CopyItem {
    pub id: String,
    pub kind: ContentKind,
    /// Plain text payload (text body, rich-text plain text, or the URL).
    pub text: String,
    pub html: Option<String>,
    pub image_path: Option<PathBuf>,
}

/// Absolute location of an image content plus the facts the protocol handler
/// needs after the storage lock is released.
#[derive(Debug, Clone)]
pub struct ResolvedImage {
    pub path: PathBuf,
    pub mime: String,
    /// Intrinsic size; `0` when unknown.
    pub width: u32,
    pub height: u32,
    pub gif: bool,
    pub cache_dir: PathBuf,
}

pub(crate) fn now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub(crate) fn new_canvas(name: &str) -> CanvasRecord {
    CanvasRecord {
        id: Uuid::new_v4().to_string(),
        name: name.into(),
        parent_id: None,
        frame: None,
        nodes: Vec::new(),
        created_at: now(),
        viewport: DEFAULT_VIEWPORT,
    }
}

pub(crate) fn default_state() -> AppState {
    let canvas = new_canvas("画布 1");
    AppState {
        version: STATE_VERSION,
        revision: 0,
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
        contents: BTreeMap::new(),
        edges: Vec::new(),
        storage_notice: None,
    }
}

pub(crate) fn finite_or(value: f64, fallback: f64) -> f64 {
    if value.is_finite() {
        value
    } else {
        fallback
    }
}

pub(crate) fn js_round(value: f64) -> f64 {
    if value.is_finite() {
        (value + 0.5).floor()
    } else {
        0.0
    }
}

pub(crate) fn normalize_viewport(value: &CanvasViewport) -> CanvasViewport {
    CanvasViewport {
        x: js_round(finite_or(value.x, DEFAULT_VIEWPORT.x)),
        y: js_round(finite_or(value.y, DEFAULT_VIEWPORT.y)),
        zoom: finite_or(value.zoom, 1.0).clamp(MIN_ZOOM, MAX_ZOOM),
    }
}

pub(crate) fn normalize_import_viewport(value: &crate::dto::ImportViewport) -> CanvasViewport {
    normalize_viewport(&CanvasViewport {
        x: value.x,
        y: value.y,
        zoom: value.zoom,
    })
}

pub(crate) fn auto_frame(sibling_index: usize) -> CanvasFrame {
    let offset = sibling_index as f64 * 36.0;
    CanvasFrame {
        x: js_round(120.0 + offset),
        y: js_round(120.0 + offset),
        width: DEFAULT_FRAME_WIDTH,
        height: DEFAULT_FRAME_HEIGHT,
    }
}

pub(crate) fn is_descendant_of(canvases: &[CanvasRecord], mut start: String, ancestor: &str) -> bool {
    let mut steps = 0;
    while steps <= canvases.len() {
        if start == ancestor {
            return true;
        }
        match canvases
            .iter()
            .find(|canvas| canvas.id == start)
            .and_then(|canvas| canvas.parent_id.clone())
        {
            Some(parent) => start = parent,
            None => return false,
        }
        steps += 1;
    }
    true
}

pub(crate) fn unique_ids(ids: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    ids.iter()
        .filter(|id| seen.insert((*id).clone()))
        .cloned()
        .collect()
}

pub(crate) fn normalize_frame_value(frame: CanvasFrame) -> CanvasFrame {
    CanvasFrame {
        x: js_round(finite_or(frame.x, 0.0)),
        y: js_round(finite_or(frame.y, 0.0)),
        width: finite_or(frame.width, DEFAULT_FRAME_WIDTH).max(FRAME_MIN_WIDTH),
        height: finite_or(frame.height, DEFAULT_FRAME_HEIGHT).max(FRAME_MIN_HEIGHT),
    }
}

pub(crate) fn validate_frame(frame: &CanvasFrame) -> Result<CanvasFrame, AppError> {
    if !frame.x.is_finite()
        || !frame.y.is_finite()
        || !frame.width.is_finite()
        || !frame.height.is_finite()
    {
        return Err(AppError::message("画布框架数值无效"));
    }
    if frame.width < FRAME_MIN_WIDTH || frame.height < FRAME_MIN_HEIGHT {
        return Err(AppError::message("画布框架尺寸过小"));
    }
    Ok(normalize_frame_value(*frame))
}

pub(crate) fn value_number(value: Option<&Value>, fallback: f64) -> f64 {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .unwrap_or(fallback)
}

pub(crate) fn value_u32(value: Option<&Value>) -> u32 {
    value
        .and_then(Value::as_u64)
        .filter(|value| *value <= u32::MAX as u64)
        .map(|value| value as u32)
        .unwrap_or(0)
}

pub(crate) fn first_string<'a>(
    item: &'a serde_json::Map<String, Value>,
    keys: &[&str],
) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| item.get(*key).and_then(Value::as_str))
}

/// Dispatch on the persisted schema version: v1 is migrated, v2 is validated,
/// anything newer is refused instead of guessed at.
pub(crate) fn normalize_state(
    root: &std::path::Path,
    grid: super::layout::GridOptions,
    value: Value,
) -> Result<AppState, AppError> {
    match value.get("version").and_then(Value::as_u64) {
        None | Some(1) => super::migration::migrate_v1(root, grid, value),
        Some(version) if version == STATE_VERSION as u64 => parse_v2(value),
        Some(version) => Err(AppError::message(format!(
            "本地状态版本不受支持：{version}"
        ))),
    }
}

fn required_array<'a>(
    object: &'a serde_json::Map<String, Value>,
    key: &str,
) -> Result<&'a Vec<Value>, AppError> {
    object
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::message("本地状态结构不完整"))
}

fn parse_v2(value: Value) -> Result<AppState, AppError> {
    let object = value
        .as_object()
        .ok_or_else(|| AppError::message("本地状态不是有效对象"))?;
    let canvases_value = required_array(object, "canvases")?;
    let categories_value = required_array(object, "categories")?;
    let contents_value = object
        .get("contents")
        .and_then(Value::as_object)
        .ok_or_else(|| AppError::message("本地状态结构不完整"))?;

    let mut canvases = Vec::with_capacity(canvases_value.len());
    let mut canvas_ids = HashSet::new();
    for item in canvases_value {
        let canvas = parse_canvas(item)?;
        // Duplicate canvas ids would make every lookup ambiguous: keep the
        // first record and forget the rest.
        if canvas_ids.insert(canvas.id.clone()) {
            canvases.push(canvas);
        }
    }
    let canvases = repair_canvas_hierarchy(canvases);
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
        .map(parse_category)
        .collect::<Result<Vec<_>, AppError>>()?;

    let mut contents = BTreeMap::new();
    for (key, value) in contents_value {
        let mut record = parse_content(key, value)?;
        // A category that no longer exists is a dangling reference: keep the
        // content, drop the classification (it must not block retention).
        if let Some(category_id) = record.category_id.as_deref() {
            if !categories.iter().any(|category| category.id == category_id) {
                record.category_id = None;
            }
        }
        contents.insert(record.id.clone(), record);
    }

    let mut canvases = canvases;
    repair_node_assignments(&mut canvases, &contents);

    let mut edges = Vec::new();
    let mut edge_ids = HashSet::new();
    if let Some(values) = object.get("edges").and_then(Value::as_array) {
        for item in values {
            if let Some(edge) = parse_edge(item) {
                if edge_ids.insert(edge.id.clone()) {
                    edges.push(edge);
                }
            }
        }
    }
    repair_edges(&mut edges, &canvases);

    Ok(AppState {
        version: STATE_VERSION,
        revision: object.get("revision").and_then(Value::as_u64).unwrap_or(0),
        active_canvas_id: active.into(),
        canvases,
        categories,
        contents,
        edges,
        storage_notice: None,
    })
}

fn parse_canvas(value: &Value) -> Result<CanvasRecord, AppError> {
    let invalid = || AppError::message("本地状态包含无效画布");
    let item = value.as_object().ok_or_else(invalid)?;
    let id = item.get("id").and_then(Value::as_str).ok_or_else(invalid)?;
    let name = item.get("name").and_then(Value::as_str).ok_or_else(invalid)?;
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
    let nodes = item
        .get("nodes")
        .and_then(Value::as_array)
        .map(|values| values.iter().filter_map(parse_node).collect())
        .unwrap_or_default();
    Ok(CanvasRecord {
        id: id.into(),
        name: name.into(),
        parent_id: item
            .get("parentId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned),
        frame: item.get("frame").and_then(parse_frame),
        nodes,
        created_at: item
            .get("createdAt")
            .and_then(Value::as_str)
            .unwrap_or("1970-01-01T00:00:00.000Z")
            .into(),
        viewport,
    })
}

fn parse_frame(value: &Value) -> Option<CanvasFrame> {
    let frame = value.as_object()?;
    Some(CanvasFrame {
        x: value_number(frame.get("x"), f64::NAN),
        y: value_number(frame.get("y"), f64::NAN),
        width: value_number(frame.get("width"), f64::NAN),
        height: value_number(frame.get("height"), f64::NAN),
    })
}

/// Nodes without an id or a content reference cannot be repaired into a
/// meaningful placement and are dropped here.
fn parse_node(value: &Value) -> Option<CanvasNode> {
    let item = value.as_object()?;
    let id = item.get("id").and_then(Value::as_str)?.trim();
    let content_id = item.get("contentId").and_then(Value::as_str)?.trim();
    if id.is_empty() || content_id.is_empty() {
        return None;
    }
    Some(CanvasNode {
        id: id.into(),
        content_id: content_id.into(),
        x: js_round(value_number(item.get("x"), 0.0)),
        y: js_round(value_number(item.get("y"), 0.0)),
        width: js_round(value_number(item.get("width"), FALLBACK_NODE_WIDTH)).max(1.0),
        height: js_round(value_number(item.get("height"), FALLBACK_NODE_HEIGHT)).max(1.0),
    })
}

fn parse_category(value: &Value) -> Result<CategoryRecord, AppError> {
    let invalid = || AppError::message("本地状态包含无效分类");
    let item = value.as_object().ok_or_else(invalid)?;
    Ok(CategoryRecord {
        id: item
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?
            .into(),
        name: item
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?
            .into(),
        created_at: item
            .get("createdAt")
            .and_then(Value::as_str)
            .unwrap_or("1970-01-01T00:00:00.000Z")
            .into(),
    })
}

fn parse_content(key: &str, value: &Value) -> Result<ContentRecord, AppError> {
    let invalid = || AppError::message("本地状态包含无效内容");
    let item = value.as_object().ok_or_else(invalid)?;
    let id = item.get("id").and_then(Value::as_str).ok_or_else(invalid)?;
    if id != key {
        return Err(invalid());
    }
    let kind = match item.get("kind").and_then(Value::as_str) {
        Some("text") => ContentKind::Text,
        Some("richText") => ContentKind::RichText,
        Some("link") => ContentKind::Link,
        Some("image") => ContentKind::Image,
        _ => return Err(invalid()),
    };
    let source = match item.get("source").and_then(Value::as_str) {
        Some("clipboard") => ContentSource::Clipboard,
        Some("paste") => ContentSource::Paste,
        Some("drop") => ContentSource::Drop,
        Some("migrated") => ContentSource::Migrated,
        Some("manual") => ContentSource::Manual,
        // Older/hand-written records without a source are treated as migrated
        // so retention never mistakes them for fresh captures.
        _ => ContentSource::Migrated,
    };
    let image = match item.get("image").and_then(Value::as_object) {
        Some(image) => Some(crate::dto::ImageInfo {
            file_name: image
                .get("fileName")
                .and_then(Value::as_str)
                .ok_or_else(invalid)?
                .into(),
            relative_path: image
                .get("relativePath")
                .and_then(Value::as_str)
                .ok_or_else(invalid)?
                .into(),
            width: value_u32(image.get("width")),
            height: value_u32(image.get("height")),
            byte_size: image.get("byteSize").and_then(Value::as_u64).unwrap_or(0),
        }),
        None => None,
    };
    if kind == ContentKind::Image && image.is_none() {
        return Err(invalid());
    }
    let created_at = item
        .get("createdAt")
        .and_then(Value::as_str)
        .unwrap_or("1970-01-01T00:00:00.000Z")
        .to_owned();
    // Only a rich-text content can have a cover, and it must reference this
    // content's own assets (localization guarantees that).
    let cover_asset = item
        .get("coverAsset")
        .and_then(Value::as_str)
        .and_then(crate::storage::files::parse_asset_reference)
        .filter(|(owner, _)| kind == ContentKind::RichText && owner == id)
        .map(|(owner, asset)| format!("{owner}/{asset}"));
    Ok(ContentRecord {
        id: id.into(),
        kind,
        preview: item
            .get("preview")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        text_length: item
            .get("textLength")
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize,
        url: item.get("url").and_then(Value::as_str).map(str::to_owned),
        image,
        category_id: item
            .get("categoryId")
            .and_then(Value::as_str)
            .map(str::to_owned),
        source,
        updated_at: item
            .get("updatedAt")
            .and_then(Value::as_str)
            .unwrap_or(&created_at)
            .to_owned(),
        last_used_at: item
            .get("lastUsedAt")
            .and_then(Value::as_str)
            .unwrap_or(&created_at)
            .to_owned(),
        created_at,
        hash: item
            .get("hash")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        cover_asset,
    })
}

fn parse_edge(value: &Value) -> Option<EdgeRecord> {
    let item = value.as_object()?;
    let id = item.get("id").and_then(Value::as_str)?.trim();
    let from_node = item.get("fromNode").and_then(Value::as_str)?.trim();
    let to_node = item.get("toNode").and_then(Value::as_str)?.trim();
    if id.is_empty() || from_node.is_empty() || to_node.is_empty() {
        return None;
    }
    Some(EdgeRecord {
        id: id.into(),
        from_node: from_node.into(),
        to_node: to_node.into(),
        created_at: item
            .get("createdAt")
            .and_then(Value::as_str)
            .unwrap_or("1970-01-01T00:00:00.000Z")
            .into(),
    })
}

/// Drop placements whose content disappeared and nodes whose id is already
/// used elsewhere (edges address nodes by id and must stay unambiguous).
pub(crate) fn repair_node_assignments(
    canvases: &mut [CanvasRecord],
    contents: &BTreeMap<String, ContentRecord>,
) {
    let mut seen = HashSet::new();
    for canvas in canvases.iter_mut() {
        let mut valid = Vec::with_capacity(canvas.nodes.len());
        for mut node in canvas.nodes.drain(..) {
            if !contents.contains_key(&node.content_id) || !seen.insert(node.id.clone()) {
                continue;
            }
            node.width = node.width.max(1.0);
            node.height = node.height.max(1.0);
            node.x = js_round(finite_or(node.x, 0.0));
            node.y = js_round(finite_or(node.y, 0.0));
            valid.push(node);
        }
        canvas.nodes = valid;
    }
}

/// Drop edges whose ends are gone, self loops and duplicate `from → to` pairs.
pub(crate) fn repair_edges(edges: &mut Vec<EdgeRecord>, canvases: &[CanvasRecord]) {
    let node_ids: HashSet<&str> = canvases
        .iter()
        .flat_map(|canvas| canvas.nodes.iter().map(|node| node.id.as_str()))
        .collect();
    let mut pairs: HashSet<(String, String)> = HashSet::new();
    edges.retain(|edge| {
        edge.from_node != edge.to_node
            && node_ids.contains(edge.from_node.as_str())
            && node_ids.contains(edge.to_node.as_str())
            && pairs.insert((edge.from_node.clone(), edge.to_node.clone()))
    });
}

/// Migrate legacy or hand-edited state: dangling/cyclic parent links become
/// roots, roots drop their frame, and non-root canvases without a finite
/// frame get a default cascaded placement.
pub(crate) fn repair_canvas_hierarchy(mut canvases: Vec<CanvasRecord>) -> Vec<CanvasRecord> {
    let ids: HashSet<String> = canvases.iter().map(|canvas| canvas.id.clone()).collect();
    let original_parent: Vec<(String, Option<String>)> = canvases
        .iter()
        .map(|canvas| (canvas.id.clone(), canvas.parent_id.clone()))
        .collect();
    let mut demoted: HashSet<String> = HashSet::new();
    for (id, parent) in &original_parent {
        let broken = match parent {
            Some(parent) if ids.contains(parent) => {
                // Walk the original chain; returning to this canvas means it
                // sits on a cycle and must be demoted to a root.
                let mut current = parent.clone();
                let mut steps = 0;
                loop {
                    if current == *id {
                        break true;
                    }
                    let next = original_parent
                        .iter()
                        .find(|(canvas_id, _)| canvas_id == &current)
                        .and_then(|(_, parent)| parent.clone());
                    match next {
                        Some(next) => {
                            current = next;
                            steps += 1;
                            if steps > ids.len() {
                                break false;
                            }
                        }
                        None => break false,
                    }
                }
            }
            _ => true,
        };
        if broken {
            demoted.insert(id.clone());
        }
    }
    for index in 0..canvases.len() {
        if demoted.contains(&canvases[index].id) {
            canvases[index].parent_id = None;
        }
        if canvases[index].parent_id.is_none() {
            canvases[index].frame = None;
        } else {
            let finite = canvases[index].frame.as_ref().is_some_and(|frame| {
                frame.x.is_finite()
                    && frame.y.is_finite()
                    && frame.width.is_finite()
                    && frame.height.is_finite()
            });
            if !finite {
                let parent = canvases[index].parent_id.clone();
                let sibling_index = canvases[..index]
                    .iter()
                    .filter(|other| other.parent_id == parent)
                    .count();
                canvases[index].frame = Some(auto_frame(sibling_index));
            }
        }
    }
    canvases
}
