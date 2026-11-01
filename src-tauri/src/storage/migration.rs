//! One-way v1 → v2 conversion.
//!
//! v1 kept one flat image library (`images`, one canvas per image) with file
//! moves on classify. v2 stores *contents* (one file set per content) and
//! *placements* (nodes on canvases). Migration therefore never moves a byte on
//! disk: legacy files keep their `pending/…` or `classified/…` location and
//! the new content record points at it.

use crate::dto::{
    AppState, CanvasFrame, CanvasNode, CanvasRecord, CanvasViewport, CategoryRecord,
    ContentKind, ContentRecord, ContentSource, ImageInfo, STATE_VERSION,
};
use crate::error::AppError;
use crate::paths::safe_join;
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::Path;
use uuid::Uuid;

use super::files::{self, relative_for_status_values};
use super::ingest::hash_bytes;
use super::layout::{self, GridOptions, Rect};
use super::model::{
    first_string, js_round, repair_canvas_hierarchy, repair_node_assignments, value_number,
    DEFAULT_VIEWPORT, MAX_ZOOM, MIN_ZOOM,
};
use super::sizing::image_node_size;

pub(crate) fn migrate_v1(
    root: &Path,
    grid: GridOptions,
    value: Value,
) -> Result<AppState, AppError> {
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

    let mut canvases = Vec::with_capacity(canvases_value.len());
    let mut placements: Vec<Vec<String>> = Vec::with_capacity(canvases_value.len());
    let mut canvas_ids = HashSet::new();
    for item in canvases_value {
        let (canvas, image_ids) = parse_v1_canvas(item)?;
        if canvas_ids.insert(canvas.id.clone()) {
            canvases.push(canvas);
            placements.push(image_ids);
        }
    }
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
        .map(parse_v1_category)
        .collect::<Result<Vec<_>, AppError>>()?;

    let mut contents = BTreeMap::new();
    let mut legacy = BTreeMap::new();
    for (key, value) in images_value {
        let record = parse_v1_image(key, value)?;
        // A category that no longer exists is a dangling reference: keep the
        // content, drop the classification.
        let category_id = record
            .category_id
            .clone()
            .filter(|category_id| {
                record.classified
                    && categories.iter().any(|category| category.id == *category_id)
            });
        let (intrinsic, byte_size, hash) = inspect_legacy_file(root, &record.relative_path);
        contents.insert(
            record.id.clone(),
            ContentRecord {
                id: record.id.clone(),
                kind: ContentKind::Image,
                preview: record.file_name.clone(),
                text_length: 0,
                url: None,
                image: Some(ImageInfo {
                    file_name: record.file_name.clone(),
                    relative_path: record.relative_path.clone(),
                    width: intrinsic.0,
                    height: intrinsic.1,
                    byte_size,
                }),
                // A category only exists for images that were classified in
                // v1; pending images are unclassified history entries.
                category_id,
                source: ContentSource::Migrated,
                created_at: record.created_at.clone(),
                updated_at: record.created_at.clone(),
                last_used_at: record.created_at.clone(),
                hash,
                // v1 had no rich text, so no content can have a cover.
                cover_asset: None,
            },
        );
        legacy.insert(record.id.clone(), record);
    }

    // Placements come from each canvas's `imageIds` order; an image is placed
    // at most once even if a hand-edited file lists it on two canvases.
    let mut placed = HashSet::new();
    for (canvas, ids) in canvases.iter_mut().zip(placements) {
        for content_id in ids {
            if !placed.insert(content_id.clone()) {
                continue;
            }
            let Some(record) = legacy.get(&content_id) else {
                continue;
            };
            let content = contents.get(&content_id).expect("content exists");
            let (width, height) = match content
                .image
                .as_ref()
                .filter(|image| image.width > 0 && image.height > 0)
            {
                Some(image) => image_node_size(image.width, image.height),
                // Unknown intrinsic size: keep the size v1 rendered with.
                None => (record.width, record.height),
            };
            canvas.nodes.push(CanvasNode {
                id: Uuid::new_v4().to_string(),
                content_id,
                x: record.x,
                y: record.y,
                width,
                height,
            });
        }
    }

    let mut canvases = repair_canvas_hierarchy(canvases);
    repair_node_assignments(&mut canvases, &contents);
    // Upgraded boards start overlap-free: keep each canvas's first node and
    // resolve the rest against what is already placed (cards included).
    relayout_canvases(&mut canvases, grid);

    Ok(AppState {
        version: STATE_VERSION,
        revision: 0,
        active_canvas_id: active.into(),
        canvases,
        categories,
        contents,
        edges: Vec::new(),
        storage_notice: None,
    })
}

/// Intrinsic size, byte size and capture hash of a legacy file. Missing files
/// keep the record (the renderer shows a broken image) instead of deleting user
/// data during a schema upgrade.
fn inspect_legacy_file(root: &Path, relative_path: &str) -> ((u32, u32), u64, String) {
    let Ok(path) = safe_join(root, relative_path) else {
        return ((0, 0), 0, String::new());
    };
    let byte_size = fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
    let intrinsic = files::image_intrinsic_size_path(&path);
    let hash = fs::read(&path)
        .map(|bytes| hash_bytes(ContentKind::Image.token(), &bytes))
        .unwrap_or_default();
    (intrinsic, byte_size, hash)
}

struct LegacyImage {
    id: String,
    file_name: String,
    relative_path: String,
    classified: bool,
    category_id: Option<String>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    created_at: String,
}

fn parse_v1_canvas(value: &Value) -> Result<(CanvasRecord, Vec<String>), AppError> {
    let invalid = || AppError::message("本地状态包含无效画布");
    let item = value.as_object().ok_or_else(invalid)?;
    let id = item.get("id").and_then(Value::as_str).ok_or_else(invalid)?;
    let name = item.get("name").and_then(Value::as_str).ok_or_else(invalid)?;
    let viewport_value = item.get("viewport").and_then(Value::as_object);
    let image_ids = item
        .get("imageIds")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok((
        CanvasRecord {
            id: id.into(),
            name: name.into(),
            parent_id: item
                .get("parentId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_owned),
            frame: item.get("frame").and_then(|frame| {
                let frame = frame.as_object()?;
                Some(CanvasFrame {
                    x: value_number(frame.get("x"), f64::NAN),
                    y: value_number(frame.get("y"), f64::NAN),
                    width: value_number(frame.get("width"), f64::NAN),
                    height: value_number(frame.get("height"), f64::NAN),
                })
            }),
            nodes: Vec::new(),
            created_at: item
                .get("createdAt")
                .and_then(Value::as_str)
                .unwrap_or("1970-01-01T00:00:00.000Z")
                .into(),
            viewport: CanvasViewport {
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
            },
        },
        image_ids,
    ))
}

fn parse_v1_category(value: &Value) -> Result<CategoryRecord, AppError> {
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

fn parse_v1_image(key: &str, value: &Value) -> Result<LegacyImage, AppError> {
    let invalid = || AppError::message("本地状态包含无效图片记录");
    let item = value.as_object().ok_or_else(invalid)?;
    if item.get("id").and_then(Value::as_str) != Some(key) {
        return Err(invalid());
    }
    let classified = item.get("status").and_then(Value::as_str) == Some("classified");
    // Current camelCase keys are preferred, with snake_case and the old short
    // names accepted so an upgraded app can still read old state.
    let relative_path_value = first_string(item, &["relativePath", "relative_path", "path"]);
    let file_name = first_string(item, &["fileName", "file_name", "name"])
        .map(str::to_owned)
        .or_else(|| {
            relative_path_value.and_then(|relative| {
                Path::new(relative)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .map(str::to_owned)
            })
        })
        .ok_or_else(invalid)?;
    let category_id = first_string(item, &["categoryId", "category_id"]).map(str::to_owned);
    let relative_path = match relative_path_value {
        Some(relative) => relative.to_owned(),
        None => relative_for_status_values(
            if classified { "classified" } else { "pending" },
            category_id.as_deref(),
            &file_name,
        )?,
    };
    Ok(LegacyImage {
        id: key.to_owned(),
        file_name,
        relative_path,
        classified,
        category_id,
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
    })
}

/// Resolve overlaps inside one migrated canvas: every node (the first one
/// included) is resolved against the cards and the nodes already placed; cards
/// stay where they are.
fn relayout_canvases(canvases: &mut [CanvasRecord], grid: GridOptions) {
    let mut cards: std::collections::HashMap<String, Vec<Rect>> = std::collections::HashMap::new();
    for canvas in canvases.iter() {
        if let (Some(parent), Some(frame)) = (canvas.parent_id.as_deref(), canvas.frame) {
            cards.entry(parent.to_owned()).or_default().push(Rect {
                x: frame.x,
                y: frame.y,
                width: frame.width,
                height: frame.height,
            });
        }
    }
    for canvas in canvases.iter_mut() {
        let mut placed = cards.get(&canvas.id).cloned().unwrap_or_default();
        for node in canvas.nodes.iter_mut() {
            let rect = Rect {
                x: node.x,
                y: node.y,
                width: node.width,
                height: node.height,
            };
            let offset = layout::resolve(&[rect], &placed, grid);
            node.x = js_round(rect.x + offset.dx);
            node.y = js_round(rect.y + offset.dy);
            placed.push(Rect {
                x: node.x,
                y: node.y,
                ..rect
            });
        }
    }
}
