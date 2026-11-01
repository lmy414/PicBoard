//! Snapshot-returning operations. Every mutating operation validates its
//! inputs first, takes an in-memory snapshot, and restores that snapshot (plus
//! any files it created) when the durable write fails, mirroring the original
//! Electron-era transactional style.

use crate::clipboard::{CapturedContent, ClipboardCapture};
use crate::dto::{
    AppState, CanvasFrame, CanvasNode, CanvasPoint, CanvasViewport, CategoryRecord, ContentBody,
    ContentKind, ContentSource, EdgeRecord, ImportViewport, NodeMove,
};
use crate::error::AppError;
use chrono::{DateTime, Utc};
use std::collections::HashSet;
use std::ffi::OsString;
use std::fs;
use std::path::PathBuf;
use uuid::Uuid;

use super::files::{self, write_atomic_bytes};
use super::ingest::{self, Ingested};
use super::layout::{self, Rect};
use super::model::{
    auto_frame, finite_or, is_descendant_of, js_round, new_canvas, normalize_frame_value,
    normalize_import_viewport, normalize_viewport, now, unique_ids, validate_frame,
    DEFAULT_FRAME_HEIGHT, DEFAULT_FRAME_WIDTH, GROUP_MIN_HEIGHT, GROUP_MIN_WIDTH, GROUP_PADDING,
};
use super::sizing;
use super::{DeleteJournal, DeleteJournalEntry, ImageBoardStorage, JOURNAL_VERSION};

/// Upper bound for one text field written through `update_text_content`.
const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;
/// Offset applied to each content placed from a PicBoard self-marker paste.
const MARKER_CASCADE: f64 = 28.0;

impl ImageBoardStorage {
    // -----------------------------------------------------------------
    // Imports and clipboard ingestion
    // -----------------------------------------------------------------

    /// Paste the already-read clipboard capture. The caller reads the system
    /// clipboard outside the storage lock; this half only mutates state.
    pub fn paste_clipboard(
        &mut self,
        canvas_id: &str,
        viewport: Option<ImportViewport>,
        capture: ClipboardCapture,
    ) -> Result<(AppState, bool), AppError> {
        self.ensure_loaded()?;
        let canvas_index = self.canvas_index(canvas_id)?;
        let view = viewport
            .as_ref()
            .map(normalize_import_viewport)
            .unwrap_or_else(|| self.state_ref().canvases[canvas_index].viewport);
        let (center_x, center_y) = viewport_center(viewport.as_ref(), &view);

        // A PicBoard self-marker means "these contents are already mine": place
        // them instead of importing the marker's serialized payload again.
        if let Some(marker) = capture.self_marker.as_ref() {
            let known: Vec<String> = marker
                .iter()
                .filter(|id| self.state_ref().contents.contains_key(*id))
                .cloned()
                .collect();
            if known.is_empty() {
                return Ok((self.snapshot()?, false));
            }
            let before = self.snapshot()?;
            let result = (|| {
                for (index, content_id) in known.iter().enumerate() {
                    let offset = index as f64 * MARKER_CASCADE;
                    self.push_centered_node(
                        canvas_index,
                        content_id,
                        center_x + offset,
                        center_y + offset,
                    )?;
                }
                self.state_mut().canvases[canvas_index].viewport = view;
                self.write_state()
            })();
            if let Err(error) = result {
                self.state = Some(before);
                return Err(error);
            }
            return Ok((self.snapshot()?, true));
        }

        let Some(captured) = crate::clipboard::classify_capture(&capture) else {
            if let Some(error) = capture.image_error {
                return Err(AppError::message(error));
            }
            return Ok((self.snapshot()?, false));
        };
        let before = self.snapshot()?;
        let mut created: Vec<PathBuf> = Vec::new();
        let result = (|| {
            let ingested = self.ingest_captured(&captured, ContentSource::Paste)?;
            created.extend(ingested.files.iter().cloned());
            self.state_mut().canvases[canvas_index].viewport = view;
            self.push_centered_node(canvas_index, &ingested.id, center_x, center_y)?;
            self.write_state()
        })();
        if let Err(error) = result {
            self.state = Some(before);
            ingest::rollback_files(&created);
            return Err(error);
        }
        Ok((self.snapshot()?, true))
    }

    /// Background capture: ingest one classified clipboard capture without
    /// placing a node. Returns the state to broadcast.
    pub fn ingest_capture(&mut self, captured: &CapturedContent) -> Result<AppState, AppError> {
        self.ensure_loaded()?;
        let before = self.snapshot()?;
        let ingested = self.ingest_captured(captured, ContentSource::Clipboard)?;
        if let Err(error) = self.write_state() {
            self.state = Some(before);
            ingest::rollback_files(&ingested.files);
            return Err(error);
        }
        self.snapshot()
    }

    /// Store a classified capture. Shared by the monitor, paste and drops.
    pub(crate) fn ingest_captured(
        &mut self,
        captured: &CapturedContent,
        source: ContentSource,
    ) -> Result<Ingested, AppError> {
        match captured {
            CapturedContent::Link { url } => self.ingest_text_like(
                ContentKind::Link,
                url.clone(),
                None,
                Some(url.clone()),
                source,
            ),
            CapturedContent::RichText { text, html } => self.ingest_text_like(
                ContentKind::RichText,
                text.clone(),
                Some(html.clone()),
                None,
                source,
            ),
            CapturedContent::Text { text } => {
                self.ingest_text_like(ContentKind::Text, text.clone(), None, None, source)
            }
            CapturedContent::Image { png } => {
                // Readable, local-time name: it is also the physical file name,
                // so copying the node out lands as a sensible filename.
                let name = format!(
                    "剪贴板图片 {}.png",
                    chrono::Local::now().format("%Y-%m-%d %H%M%S")
                );
                self.ingest_image(Some(&name), png, source)
            }
        }
    }

    /// Place a node for an existing content, centered on `center`.
    pub fn place_content(
        &mut self,
        content_id: &str,
        canvas_id: &str,
        center: CanvasPoint,
    ) -> Result<AppState, AppError> {
        self.ensure_loaded()?;
        let canvas_index = self.canvas_index(canvas_id)?;
        self.content(content_id)?;
        if !center.x.is_finite() || !center.y.is_finite() {
            return Err(AppError::message("节点坐标无效"));
        }
        let before = self.snapshot()?;
        let result = (|| {
            self.push_centered_node(canvas_index, content_id, center.x, center.y)?;
            self.write_state()
        })();
        if let Err(error) = result {
            self.state = Some(before);
            return Err(error);
        }
        self.snapshot()
    }

    // -----------------------------------------------------------------
    // Canvas operations
    // -----------------------------------------------------------------

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

    pub fn create_canvas(
        &mut self,
        parent_id: Option<String>,
        frame: Option<CanvasFrame>,
    ) -> Result<AppState, AppError> {
        self.ensure_loaded()?;
        if let Some(parent) = parent_id.as_deref() {
            self.canvas_index(parent)?;
        }
        let frame = frame.map(normalize_frame_value);
        let frame = match (parent_id.as_deref(), frame) {
            (Some(_), Some(frame)) => Some(frame),
            (Some(parent), None) => {
                let index = self
                    .state_ref()
                    .canvases
                    .iter()
                    .filter(|canvas| canvas.parent_id.as_deref() == Some(parent))
                    .count();
                Some(auto_frame(index))
            }
            _ => None,
        };
        let mut canvas = new_canvas(&format!("画布 {}", self.state_ref().canvases.len() + 1));
        canvas.parent_id = parent_id;
        canvas.frame = frame;
        // A child card is an item on its parent: keep it clear of the parent's
        // nodes and sibling cards.
        if let (Some(parent), Some(frame)) = (canvas.parent_id.clone(), canvas.frame) {
            let obstacles =
                self.canvas_obstacles_by_id(&parent, &HashSet::new(), &HashSet::new());
            let offset = layout::resolve(&[rect_from_frame(frame)], &obstacles, self.grid_options());
            canvas.frame = Some(CanvasFrame {
                x: js_round(frame.x + offset.dx),
                y: js_round(frame.y + offset.dy),
                width: frame.width,
                height: frame.height,
            });
        }
        self.state_mut().active_canvas_id = canvas.id.clone();
        self.state_mut().canvases.push(canvas);
        self.write_state()?;
        self.snapshot()
    }

    pub fn move_canvas(
        &mut self,
        canvas_id: &str,
        parent_id: Option<String>,
        index: Option<usize>,
    ) -> Result<AppState, AppError> {
        self.ensure_loaded()?;
        let old_index = self.canvas_index(canvas_id)?;
        if let Some(parent) = parent_id.as_deref() {
            if parent == canvas_id
                || is_descendant_of(&self.state_ref().canvases, parent.to_string(), canvas_id)
            {
                return Err(AppError::message("不能将画布移动到自身子树内"));
            }
            self.canvas_index(parent)?;
        }
        let parent_changed = self.state_ref().canvases[old_index].parent_id != parent_id;
        let mut record = self.state_mut().canvases.remove(old_index);
        if parent_changed {
            let sibling_count = self
                .state_ref()
                .canvases
                .iter()
                .filter(|canvas| canvas.parent_id == parent_id)
                .count();
            record.parent_id = parent_id.clone();
            record.frame = parent_id.as_deref().map(|_| auto_frame(sibling_count));
            // The auto placement must also clear the new parent's nodes and
            // cards (the record is already out of the list, so it never blocks
            // itself).
            if let (Some(parent), Some(frame)) = (record.parent_id.clone(), record.frame) {
                let obstacles =
                    self.canvas_obstacles_by_id(&parent, &HashSet::new(), &HashSet::new());
                let offset =
                    layout::resolve(&[rect_from_frame(frame)], &obstacles, self.grid_options());
                record.frame = Some(CanvasFrame {
                    x: js_round(frame.x + offset.dx),
                    y: js_round(frame.y + offset.dy),
                    width: frame.width,
                    height: frame.height,
                });
            }
        }
        let insert_at = match index {
            Some(sibling_index) => {
                let mut seen = 0;
                let mut position = self.state_ref().canvases.len();
                for (position_index, canvas) in self.state_ref().canvases.iter().enumerate() {
                    if canvas.parent_id == parent_id {
                        if seen == sibling_index {
                            position = position_index;
                            break;
                        }
                        seen += 1;
                    }
                }
                position
            }
            None if parent_changed => self.state_ref().canvases.len(),
            None => old_index.min(self.state_ref().canvases.len()),
        };
        self.state_mut().canvases.insert(insert_at, record);
        self.write_state()?;
        self.snapshot()
    }

    pub fn set_canvas_frame(
        &mut self,
        canvas_id: &str,
        frame: CanvasFrame,
    ) -> Result<AppState, AppError> {
        self.ensure_loaded()?;
        let index = self.canvas_index(canvas_id)?;
        let parent_id = self.state_ref().canvases[index]
            .parent_id
            .clone()
            .ok_or_else(|| AppError::message("根画布没有框架"))?;
        let frame = validate_frame(&frame)?;
        let parent_index = self.canvas_index(&parent_id)?;
        // The card is an item on the parent: keep it clear of sibling cards and
        // nodes, excluding its own previous frame.
        let mut exclude_cards = HashSet::new();
        exclude_cards.insert(canvas_id);
        let obstacles = self.canvas_obstacles(parent_index, &HashSet::new(), &exclude_cards);
        let offset = layout::resolve(&[rect_from_frame(frame)], &obstacles, self.grid_options());
        self.state_mut().canvases[index].frame = Some(CanvasFrame {
            x: js_round(frame.x + offset.dx),
            y: js_round(frame.y + offset.dy),
            width: frame.width,
            height: frame.height,
        });
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

    /// Cascade-delete a canvas subtree. Placements and their edges disappear;
    /// contents and their files always survive (they return to the history).
    pub fn delete_canvas(&mut self, canvas_id: &str) -> Result<AppState, AppError> {
        self.ensure_loaded()?;
        let before = self.snapshot()?;
        let index = self.canvas_index(canvas_id)?;
        let mut subtree = Vec::new();
        let mut queue = vec![canvas_id.to_string()];
        while let Some(current) = queue.pop() {
            subtree.push(current.clone());
            for canvas in &self.state_ref().canvases {
                if canvas.parent_id.as_deref() == Some(current.as_str()) {
                    queue.push(canvas.id.clone());
                }
            }
        }
        let mut node_ids = HashSet::new();
        let mut affected = Vec::new();
        for canvas in self
            .state_ref()
            .canvases
            .iter()
            .filter(|canvas| subtree.contains(&canvas.id))
        {
            for node in &canvas.nodes {
                if node_ids.insert(node.id.clone()) {
                    affected.push(node.content_id.clone());
                }
            }
        }
        let fallback_parent = self.state_ref().canvases[index].parent_id.clone();
        let result = (|| {
            self.remove_node_records(&node_ids);
            self.bump_contents(&affected);
            self.state_mut()
                .canvases
                .retain(|canvas| !subtree.contains(&canvas.id));
            if self.state_ref().canvases.is_empty() {
                let canvas = new_canvas("画布 1");
                self.state_mut().active_canvas_id = canvas.id.clone();
                self.state_mut().canvases.push(canvas);
            }
            if subtree.contains(&self.state_ref().active_canvas_id) {
                let fallback = fallback_parent
                    .as_deref()
                    .filter(|parent| {
                        self.state_ref()
                            .canvases
                            .iter()
                            .any(|canvas| canvas.id == *parent)
                    })
                    .map(str::to_owned)
                    .unwrap_or_else(|| self.state_ref().canvases[0].id.clone());
                self.state_mut().active_canvas_id = fallback;
            }
            self.write_state()
        })();
        if let Err(error) = result {
            self.state = Some(before);
            return Err(error);
        }
        self.snapshot()
    }

    // -----------------------------------------------------------------
    // Node grouping, moving and removal
    // -----------------------------------------------------------------

    pub fn group_nodes_into_canvas(&mut self, node_ids: &[String]) -> Result<AppState, AppError> {
        self.ensure_loaded()?;
        let ids = unique_ids(node_ids);
        if ids.is_empty() {
            return Err(AppError::message("请选择要成组的节点"));
        }
        let mut nodes: Vec<CanvasNode> = Vec::with_capacity(ids.len());
        let mut source_canvas: Option<String> = None;
        for node_id in &ids {
            let (canvas_index, node_index) = self.node_location(node_id)?;
            let canvas_id = self.state_ref().canvases[canvas_index].id.clone();
            match &source_canvas {
                Some(existing) if existing != &canvas_id => {
                    return Err(AppError::message("所选节点不在同一画布"));
                }
                Some(_) => {}
                None => source_canvas = Some(canvas_id),
            }
            nodes.push(self.state_ref().canvases[canvas_index].nodes[node_index].clone());
        }
        let source_canvas = source_canvas.expect("nodes exist");
        let frame = bounding_frame(&nodes);
        let group_count = self
            .state_ref()
            .canvases
            .iter()
            .filter(|canvas| canvas.name.starts_with("组 "))
            .count();
        let mut canvas = new_canvas(&format!("组 {}", group_count + 1));
        canvas.parent_id = Some(source_canvas.clone());
        canvas.frame = Some(frame);
        canvas.viewport = CanvasViewport {
            x: -GROUP_PADDING,
            y: -GROUP_PADDING,
            zoom: 1.0,
        };
        canvas.nodes = nodes
            .iter()
            .map(|node| CanvasNode {
                x: js_round(node.x - frame.x),
                y: js_round(node.y - frame.y),
                ..node.clone()
            })
            .collect();
        let before = self.snapshot()?;
        let source_index = self.canvas_index(&source_canvas)?;
        self.state_mut().canvases[source_index]
            .nodes
            .retain(|node| !ids.contains(&node.id));
        // The grouped nodes left the parent, so the new card only has to clear
        // the remaining items.
        let obstacles = self.canvas_obstacles(source_index, &HashSet::new(), &HashSet::new());
        let offset = layout::resolve(&[rect_from_frame(frame)], &obstacles, self.grid_options());
        canvas.frame = Some(CanvasFrame {
            x: js_round(frame.x + offset.dx),
            y: js_round(frame.y + offset.dy),
            width: frame.width,
            height: frame.height,
        });
        self.state_mut().canvases.push(canvas);
        if let Err(error) = self.write_state() {
            self.state = Some(before);
            return Err(error);
        }
        self.snapshot()
    }

    pub fn ungroup_canvas(&mut self, canvas_id: &str) -> Result<AppState, AppError> {
        self.ensure_loaded()?;
        let index = self.canvas_index(canvas_id)?;
        let canvas = self.state_ref().canvases[index].clone();
        let parent_id = canvas
            .parent_id
            .clone()
            .ok_or_else(|| AppError::message("根画布不能解组"))?;
        let frame = canvas.frame.unwrap_or(CanvasFrame {
            x: 0.0,
            y: 0.0,
            width: DEFAULT_FRAME_WIDTH,
            height: DEFAULT_FRAME_HEIGHT,
        });
        let child_ids: Vec<String> = self
            .state_ref()
            .canvases
            .iter()
            .filter(|candidate| candidate.parent_id.as_deref() == Some(canvas_id))
            .map(|candidate| candidate.id.clone())
            .collect();
        let before = self.snapshot()?;
        let result = (|| {
            let parent_index = self.canvas_index(&parent_id)?;
            // Released nodes and re-parented cards move as one unit.
            let mut set: Vec<Rect> = canvas
                .nodes
                .iter()
                .map(|node| Rect {
                    x: node.x + frame.x,
                    y: node.y + frame.y,
                    width: node.width,
                    height: node.height,
                })
                .collect();
            let mut child_frames: Vec<(String, CanvasFrame)> = Vec::new();
            for candidate in &self.state_ref().canvases {
                if !child_ids.contains(&candidate.id) {
                    continue;
                }
                let Some(child_frame) = candidate.frame else {
                    continue;
                };
                set.push(Rect {
                    x: child_frame.x + frame.x,
                    y: child_frame.y + frame.y,
                    width: child_frame.width,
                    height: child_frame.height,
                });
                child_frames.push((candidate.id.clone(), child_frame));
            }
            let mut exclude_cards: HashSet<&str> = HashSet::new();
            exclude_cards.insert(canvas_id);
            for child_id in &child_ids {
                exclude_cards.insert(child_id.as_str());
            }
            let obstacles = self.canvas_obstacles(parent_index, &HashSet::new(), &exclude_cards);
            let offset = layout::resolve(&set, &obstacles, self.grid_options());
            let translated: Vec<CanvasNode> = canvas
                .nodes
                .iter()
                .map(|node| CanvasNode {
                    x: js_round(node.x + frame.x + offset.dx),
                    y: js_round(node.y + frame.y + offset.dy),
                    ..node.clone()
                })
                .collect();
            let state = self.state_mut();
            state.canvases[parent_index].nodes.extend(translated);
            for candidate in state.canvases.iter_mut() {
                if !child_frames.iter().any(|(id, _)| *id == candidate.id) {
                    continue;
                }
                candidate.parent_id = Some(parent_id.clone());
                if let Some(child_frame) = candidate.frame.as_mut() {
                    child_frame.x = js_round(child_frame.x + frame.x + offset.dx);
                    child_frame.y = js_round(child_frame.y + frame.y + offset.dy);
                }
            }
            if let Some(removed_index) = state
                .canvases
                .iter()
                .position(|candidate| candidate.id == canvas_id)
            {
                state.canvases.remove(removed_index);
            }
            if state.active_canvas_id == canvas_id {
                state.active_canvas_id = parent_id.clone();
            }
            self.write_state()
        })();
        if let Err(error) = result {
            self.state = Some(before);
            return Err(error);
        }
        self.snapshot()
    }

    pub fn move_nodes_to_canvas(
        &mut self,
        node_ids: &[String],
        target_canvas_id: &str,
        origin: CanvasPoint,
    ) -> Result<AppState, AppError> {
        self.ensure_loaded()?;
        let target_index = self.canvas_index(target_canvas_id)?;
        if !origin.x.is_finite() || !origin.y.is_finite() {
            return Err(AppError::message("节点坐标无效"));
        }
        let ids = unique_ids(node_ids);
        if ids.is_empty() {
            return self.snapshot();
        }
        let mut nodes: Vec<CanvasNode> = Vec::with_capacity(ids.len());
        for node_id in &ids {
            let (canvas_index, node_index) = self.node_location(node_id)?;
            nodes.push(self.state_ref().canvases[canvas_index].nodes[node_index].clone());
        }
        let translated: Vec<CanvasNode> = nodes
            .iter()
            .map(|node| CanvasNode {
                x: js_round(node.x - origin.x),
                y: js_round(node.y - origin.y),
                ..node.clone()
            })
            .collect();
        let set: Vec<Rect> = translated.iter().map(rect_from_node).collect();
        // Nodes already on the target must not block themselves.
        let moving: HashSet<String> = ids.iter().cloned().collect();
        let obstacles = self.canvas_obstacles(target_index, &moving, &HashSet::new());
        let offset = layout::resolve(&set, &obstacles, self.grid_options());
        let placed: Vec<CanvasNode> = translated
            .into_iter()
            .map(|node| CanvasNode {
                x: js_round(node.x + offset.dx),
                y: js_round(node.y + offset.dy),
                ..node
            })
            .collect();
        let before = self.snapshot()?;
        {
            let state = self.state_mut();
            for canvas in state.canvases.iter_mut() {
                canvas.nodes.retain(|node| !ids.contains(&node.id));
            }
            state.canvases[target_index].nodes.extend(placed);
        }
        if let Err(error) = self.write_state() {
            self.state = Some(before);
            return Err(error);
        }
        self.snapshot()
    }

    /// Apply one move gesture: every node on the same canvas, resolved as a
    /// unit so the relative layout is kept and nothing leaves a collision.
    pub fn move_nodes(&mut self, moves: &[NodeMove]) -> Result<AppState, AppError> {
        self.ensure_loaded()?;
        if moves.is_empty() {
            return self.snapshot();
        }
        for node_move in moves {
            if !node_move.x.is_finite() || !node_move.y.is_finite() {
                return Err(AppError::message("节点坐标无效"));
            }
        }
        let mut seen: HashSet<String> = HashSet::new();
        let mut canvas_index: Option<usize> = None;
        let mut set: Vec<Rect> = Vec::with_capacity(moves.len());
        let mut ids: Vec<String> = Vec::with_capacity(moves.len());
        for node_move in moves {
            if !seen.insert(node_move.node_id.clone()) {
                continue;
            }
            let (index, node_index) = self.node_location(&node_move.node_id)?;
            match canvas_index {
                Some(existing) if existing != index => {
                    return Err(AppError::message("所选节点不在同一画布"));
                }
                Some(_) => {}
                None => canvas_index = Some(index),
            }
            let node = &self.state_ref().canvases[index].nodes[node_index];
            set.push(Rect {
                x: node_move.x,
                y: node_move.y,
                width: node.width,
                height: node.height,
            });
            ids.push(node.id.clone());
        }
        let canvas_index = canvas_index.expect("moves are not empty");
        let moving: HashSet<String> = ids.iter().cloned().collect();
        let obstacles = self.canvas_obstacles(canvas_index, &moving, &HashSet::new());
        let offset = layout::resolve(&set, &obstacles, self.grid_options());
        let before = self.snapshot()?;
        {
            let canvas = &mut self.state_mut().canvases[canvas_index];
            for (index, node_id) in ids.iter().enumerate() {
                if let Some(node) = canvas.nodes.iter_mut().find(|node| node.id == *node_id) {
                    node.x = js_round(set[index].x + offset.dx);
                    node.y = js_round(set[index].y + offset.dy);
                }
            }
        }
        if let Err(error) = self.write_state() {
            self.state = Some(before);
            return Err(error);
        }
        self.snapshot()
    }

    /// Remove placements. Contents, their files and their other placements are
    /// untouched; the removed contents go back to the history.
    pub fn remove_nodes(&mut self, node_ids: &[String]) -> Result<AppState, AppError> {
        self.ensure_loaded()?;
        let ids = unique_ids(node_ids);
        if ids.is_empty() {
            return self.snapshot();
        }
        for node_id in &ids {
            self.node_location(node_id)?;
        }
        let before = self.snapshot()?;
        let set: HashSet<String> = ids.into_iter().collect();
        let result = (|| {
            let affected = self.remove_node_records(&set);
            self.bump_contents(&affected);
            self.write_state()
        })();
        if let Err(error) = result {
            self.state = Some(before);
            return Err(error);
        }
        self.snapshot()
    }

    // -----------------------------------------------------------------
    // Edges
    // -----------------------------------------------------------------

    pub fn create_edge(&mut self, from_node_id: &str, to_node_id: &str) -> Result<AppState, AppError> {
        self.ensure_loaded()?;
        if from_node_id == to_node_id {
            return Err(AppError::message("不能连接到节点自身"));
        }
        self.node_location(from_node_id)?;
        self.node_location(to_node_id)?;
        if self.state_ref().edges.iter().any(|edge| {
            edge.from_node == from_node_id && edge.to_node == to_node_id
        }) {
            return Err(AppError::message("该连接已存在"));
        }
        self.state_mut().edges.push(EdgeRecord {
            id: Uuid::new_v4().to_string(),
            from_node: from_node_id.into(),
            to_node: to_node_id.into(),
            created_at: now(),
        });
        self.write_state()?;
        self.snapshot()
    }

    pub fn delete_edges(&mut self, edge_ids: &[String]) -> Result<AppState, AppError> {
        self.ensure_loaded()?;
        let ids: HashSet<&str> = edge_ids.iter().map(String::as_str).collect();
        let before = self.state_ref().edges.len();
        self.state_mut()
            .edges
            .retain(|edge| !ids.contains(edge.id.as_str()));
        if self.state_ref().edges.len() != before {
            self.write_state()?;
        }
        self.snapshot()
    }

    // -----------------------------------------------------------------
    // Content editing
    // -----------------------------------------------------------------

    pub fn get_content_body(&mut self, content_id: &str) -> Result<ContentBody, AppError> {
        self.ensure_loaded()?;
        let content = self.content(content_id)?.clone();
        match content.kind {
            ContentKind::Link => Ok(ContentBody {
                text: content.url.unwrap_or_default(),
                html: None,
            }),
            ContentKind::Image => Err(AppError::message("图片内容没有文本正文")),
            ContentKind::Text | ContentKind::RichText => {
                let text = read_text_file(&files::content_text_path(&self.root, content_id))?;
                let html = if content.kind == ContentKind::RichText {
                    read_optional_text_file(&files::content_html_path(&self.root, content_id))?
                } else {
                    None
                };
                Ok(ContentBody { text, html })
            }
        }
    }

    pub fn update_text_content(
        &mut self,
        content_id: &str,
        body: ContentBody,
    ) -> Result<AppState, AppError> {
        self.ensure_loaded()?;
        if body.text.len() > MAX_BODY_BYTES
            || body
                .html
                .as_ref()
                .map(|html| html.len())
                .unwrap_or(0)
                > MAX_BODY_BYTES
        {
            return Err(AppError::message("内容过大"));
        }
        let content = self.content(content_id)?.clone();
        if !matches!(content.kind, ContentKind::Text | ContentKind::RichText) {
            return Err(AppError::message("只有文本内容可以编辑"));
        }
        let kind = if body.html.is_none() {
            ContentKind::Text
        } else {
            ContentKind::RichText
        };
        let before = self.snapshot()?;
        // Foreign asset references are copied into this content; tags whose
        // file is gone are dropped. The copied files are rolled back if the
        // transaction fails.
        let (stored_html, created_assets) = match body.html.as_deref() {
            Some(html) => {
                let (localized, created) =
                    super::assets::localize_html(&self.root, content_id, html)?;
                (Some(localized), created)
            }
            None => (None, Vec::new()),
        };
        let cover_asset = stored_html
            .as_deref()
            .and_then(|html| super::assets::first_asset_reference(html, content_id));
        let text_path = files::content_text_path(&self.root, content_id);
        let html_path = files::content_html_path(&self.root, content_id);
        let written = write_atomic_bytes(&text_path, body.text.as_bytes()).and_then(|()| {
            match stored_html.as_deref() {
                Some(html) => write_atomic_bytes(&html_path, html.as_bytes()),
                None => files::remove_file_if_exists(&html_path),
            }
        });
        if let Err(error) = written {
            self.state = Some(before);
            ingest::rollback_files(&created_assets);
            return Err(error);
        }
        let preview = sizing::preview_text(&body.text);
        let stamp = now();
        let hash = ingest::hash_text(kind, &body.text, stored_html.as_deref());
        let record = self
            .state_mut()
            .contents
            .get_mut(content_id)
            .ok_or_else(|| AppError::message("找不到指定内容"))?;
        record.kind = kind;
        record.preview = preview;
        record.text_length = sizing::text_length(&body.text);
        record.hash = hash;
        record.cover_asset = cover_asset;
        record.updated_at = stamp.clone();
        record.last_used_at = stamp;
        // The card height follows the new kind/preview/cover.
        let height = {
            let content = self
                .state_ref()
                .contents
                .get(content_id)
                .expect("content still exists");
            sizing::node_size(content).1
        };
        let mut grown: Vec<(usize, String, Rect)> = Vec::new();
        for (canvas_index, canvas) in self.state_mut().canvases.iter_mut().enumerate() {
            for node in canvas.nodes.iter_mut() {
                if node.content_id == content_id {
                    // Width is owned by the layout; only the wrapped height changes.
                    node.height = height;
                    grown.push((
                        canvas_index,
                        node.id.clone(),
                        Rect {
                            x: node.x,
                            y: node.y,
                            width: node.width,
                            height: node.height,
                        },
                    ));
                }
            }
        }
        // A taller card pushes whatever it now overlaps downwards.
        for (canvas_index, node_id, grown_rect) in grown {
            self.push_down_after_growth(canvas_index, &node_id, grown_rect);
        }
        if let Err(error) = self.write_state() {
            self.state = Some(before);
            ingest::rollback_files(&created_assets);
            return Err(error);
        }
        self.snapshot()
    }

    pub fn update_link_content(&mut self, content_id: &str, url: &str) -> Result<AppState, AppError> {
        self.ensure_loaded()?;
        let content = self.content(content_id)?.clone();
        if content.kind != ContentKind::Link {
            return Err(AppError::message("只有链接内容可以修改链接"));
        }
        let url = crate::clipboard::validate_url(url)?;
        let stamp = now();
        let hash = ingest::hash_bytes(ContentKind::Link.token(), url.as_bytes());
        let record = self
            .state_mut()
            .contents
            .get_mut(content_id)
            .ok_or_else(|| AppError::message("找不到指定内容"))?;
        record.url = Some(url.clone());
        record.preview = url;
        record.hash = hash;
        record.updated_at = stamp.clone();
        record.last_used_at = stamp;
        self.write_state()?;
        self.snapshot()
    }

    pub fn rename_image(&mut self, content_id: &str, name: &str) -> Result<AppState, AppError> {
        self.ensure_loaded()?;
        let content = self.content(content_id)?.clone();
        if content.kind != ContentKind::Image {
            return Err(AppError::message("只有图片内容可以重命名"));
        }
        let image = content
            .image
            .clone()
            .ok_or_else(|| AppError::message("图片信息缺失"))?;
        let (source, old_basename) = files::controlled_image_path(&self.root, content_id, &image)?;
        let final_name = files::normalized_image_name(&old_basename, name)?;
        let final_os = OsString::from(&final_name);
        let parent = source
            .parent()
            .ok_or_else(|| AppError::message("图片路径无效"))?;
        files::ensure_no_name_collision(parent, &final_os, &source)?;
        let destination = parent.join(&final_os);
        let before = self.snapshot()?;
        // Lexical equality: a case-only rename must still update the directory
        // entry on disk.
        let moved = source != destination;
        if moved {
            files::rename_file_case_safe(&source, &destination)?;
        }
        let normalized = image.relative_path.replace('\\', "/");
        let directory = normalized
            .rsplit_once('/')
            .map(|(directory, _)| directory.to_owned())
            .unwrap_or_default();
        let relative_path = if directory.is_empty() {
            final_name.clone()
        } else {
            format!("{directory}/{final_name}")
        };
        let stamp = now();
        let record = self
            .state_mut()
            .contents
            .get_mut(content_id)
            .ok_or_else(|| AppError::message("找不到指定内容"))?;
        record.preview = final_name.clone();
        record.updated_at = stamp.clone();
        record.last_used_at = stamp;
        if let Some(image) = record.image.as_mut() {
            image.file_name = final_name;
            image.relative_path = relative_path;
        }
        if let Err(error) = self.write_state() {
            self.state = Some(before);
            if moved {
                let _ = files::rename_file_case_safe(&destination, &source);
            }
            return Err(error);
        }
        self.snapshot()
    }

    // -----------------------------------------------------------------
    // Deletion, copy-out and classification
    // -----------------------------------------------------------------

    /// Delete contents everywhere: every placement, every touching edge, the
    /// thumbnail and the stored files. Image files go to the recycle bin.
    pub fn delete_contents(&mut self, content_ids: &[String]) -> Result<AppState, AppError> {
        self.ensure_loaded()?;
        let ids = unique_ids(content_ids);
        if ids.is_empty() {
            return self.snapshot();
        }
        let mut entries = Vec::new();
        for id in &ids {
            let content = self.content(id)?.clone();
            if let Some(image) = content.image.as_ref() {
                if let Ok((source, _)) = files::controlled_image_path(&self.root, id, image) {
                    entries.push(DeleteJournalEntry {
                        id: content.id,
                        source: source.to_string_lossy().into_owned(),
                        status: "prepared".into(),
                    });
                }
            }
        }

        // Recycling and state.json cannot be one atomic transaction. The
        // journal records the durable boundary; recovery only reconciles
        // records whose files are known to have left their source. Text-only
        // deletions touch no recycled file and need no journal.
        if entries.is_empty() {
            self.remove_content_records(&ids);
            self.write_state()?;
            self.delete_content_aux_files(&ids);
            return self.snapshot();
        }
        let mut journal = DeleteJournal {
            version: JOURNAL_VERSION,
            operation: "delete_contents".into(),
            phase: "prepared".into(),
            entries,
        };
        self.write_journal(&journal)?;
        let mut recycled = Vec::new();
        for index in 0..journal.entries.len() {
            let source = PathBuf::from(&journal.entries[index].source);
            if let Err(error) = self.recycle_bin.recycle(&source) {
                // The system recycle bin is not transactional: keep records
                // for entries that were not recycled, drop the ones already
                // confirmed gone.
                self.remove_content_records(&recycled);
                self.delete_content_aux_files(&recycled);
                self.write_state()?;
                journal.phase = "recycled".into();
                let _ = self.write_journal(&journal);
                return Err(error);
            }
            journal.entries[index].status = "recycled".into();
            self.write_journal(&journal)?;
            recycled.push(journal.entries[index].id.clone());
        }
        journal.phase = "recycled".into();
        self.write_journal(&journal)?;
        self.remove_content_records(&ids);
        self.write_state()?;
        journal.phase = "committed".into();
        self.write_journal(&journal)?;
        self.clear_journal()?;
        self.delete_content_aux_files(&ids);
        self.snapshot()
    }

    /// Resolve clipboard payloads while holding the lock; the caller writes the
    /// clipboard after this returns.
    pub fn copy_payloads(&mut self, content_ids: &[String]) -> Result<Vec<super::model::CopyItem>, AppError> {
        self.ensure_loaded()?;
        let mut items = Vec::with_capacity(content_ids.len());
        for id in content_ids {
            let content = self.content(id)?.clone();
            let item = match content.kind {
                ContentKind::Link => super::model::CopyItem {
                    id: id.clone(),
                    kind: ContentKind::Link,
                    text: content.url.unwrap_or_default(),
                    html: None,
                    image_path: None,
                },
                ContentKind::Image => {
                    let image = content
                        .image
                        .as_ref()
                        .ok_or_else(|| AppError::message("图片信息缺失"))?;
                    let (path, _) = files::controlled_image_path(&self.root, id, image)?;
                    super::model::CopyItem {
                        id: id.clone(),
                        kind: ContentKind::Image,
                        text: String::new(),
                        html: None,
                        image_path: Some(path),
                    }
                }
                ContentKind::Text | ContentKind::RichText => {
                    let text = read_text_file(&files::content_text_path(&self.root, id))?;
                    let html = if content.kind == ContentKind::RichText {
                        // Pasted rich text must carry its images, so asset
                        // references become self-contained data URLs.
                        read_optional_text_file(&files::content_html_path(&self.root, id))?
                            .map(|raw| super::assets::inline_html_assets(&self.root, id, &raw))
                    } else {
                        None
                    };
                    super::model::CopyItem {
                        id: id.clone(),
                        kind: content.kind,
                        text,
                        html,
                        image_path: None,
                    }
                }
            };
            items.push(item);
        }
        Ok(items)
    }

    /// Bump `lastUsedAt` after a successful copy-out.
    pub fn touch_contents(&mut self, content_ids: &[String]) -> Result<AppState, AppError> {
        self.ensure_loaded()?;
        self.bump_contents(content_ids);
        self.write_state()?;
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

    /// Set or clear the plain `categoryId` field. Never moves files.
    pub fn classify_contents(
        &mut self,
        content_ids: &[String],
        category_id: Option<&str>,
    ) -> Result<AppState, AppError> {
        self.ensure_loaded()?;
        if let Some(category_id) = category_id {
            if !self
                .state_ref()
                .categories
                .iter()
                .any(|item| item.id == category_id)
            {
                return Err(AppError::message("找不到指定分类"));
            }
            files::validate_category_segment(category_id)?;
        }
        let ids = unique_ids(content_ids);
        for id in &ids {
            self.content(id)?;
        }
        for id in &ids {
            if let Some(record) = self.state_mut().contents.get_mut(id) {
                record.category_id = category_id.map(str::to_owned);
            }
        }
        self.write_state()?;
        self.snapshot()
    }

    /// Retention cleanup. Deletes contents that are neither placed nor
    /// classified and whose `lastUsedAt` is older than `days`.
    pub fn cleanup_history(
        &mut self,
        now: DateTime<Utc>,
        days: u32,
    ) -> Result<(AppState, usize), AppError> {
        self.ensure_loaded()?;
        if days == 0 {
            return Ok((self.snapshot()?, 0));
        }
        let cutoff = now - chrono::Duration::days(i64::from(days));
        let placed: HashSet<&str> = self
            .state_ref()
            .canvases
            .iter()
            .flat_map(|canvas| canvas.nodes.iter().map(|node| node.content_id.as_str()))
            .collect();
        let removable: Vec<String> = self
            .state_ref()
            .contents
            .values()
            .filter(|content| !placed.contains(content.id.as_str()))
            .filter(|content| content.category_id.is_none())
            .filter(|content| {
                // A timestamp we cannot parse is kept: never delete user data
                // because of a malformed clock.
                DateTime::parse_from_rfc3339(&content.last_used_at)
                    .map(|stamp| stamp.with_timezone(&Utc) < cutoff)
                    .unwrap_or(false)
            })
            .map(|content| content.id.clone())
            .collect();
        if removable.is_empty() {
            return Ok((self.snapshot()?, 0));
        }
        let count = removable.len();
        let mut images = Vec::new();
        for id in &removable {
            let content = self.content(id)?.clone();
            if let Some(image) = content.image.as_ref() {
                if let Ok((path, _)) = files::controlled_image_path(&self.root, id, image) {
                    images.push(path);
                }
            }
        }
        self.remove_content_records(&removable);
        self.write_state()?;
        // Automatic cleanup is permanent: no recycle bin for history expiry.
        for path in images {
            let _ = fs::remove_file(path);
        }
        self.delete_content_aux_files(&removable);
        Ok((self.snapshot()?, count))
    }

    // -----------------------------------------------------------------
    // Internals shared by the operations above
    // -----------------------------------------------------------------

    /// Rects of everything on a canvas: node placements plus the frames of its
    /// direct child canvases. Moving items can be excluded so they do not block
    /// themselves.
    fn canvas_obstacles(
        &self,
        canvas_index: usize,
        exclude_nodes: &HashSet<String>,
        exclude_cards: &HashSet<&str>,
    ) -> Vec<Rect> {
        let canvas_id = self.state_ref().canvases[canvas_index].id.clone();
        self.canvas_obstacles_by_id(&canvas_id, exclude_nodes, exclude_cards)
    }

    /// Same as [`Self::canvas_obstacles`] but addressed by canvas id, so the
    /// lookup stays correct while a canvas is being reparented.
    fn canvas_obstacles_by_id(
        &self,
        canvas_id: &str,
        exclude_nodes: &HashSet<String>,
        exclude_cards: &HashSet<&str>,
    ) -> Vec<Rect> {
        let mut rects = Vec::new();
        for canvas in &self.state_ref().canvases {
            if canvas.parent_id.as_deref() != Some(canvas_id) {
                continue;
            }
            if exclude_cards.contains(canvas.id.as_str()) {
                continue;
            }
            if let Some(frame) = canvas.frame {
                rects.push(rect_from_frame(frame));
            }
        }
        if let Some(index) = self
            .state_ref()
            .canvases
            .iter()
            .position(|canvas| canvas.id == canvas_id)
        {
            for node in &self.state_ref().canvases[index].nodes {
                if exclude_nodes.contains(&node.id) {
                    continue;
                }
                rects.push(rect_from_node(node));
            }
        }
        rects
    }

    /// Insert a node for `content_id` at `proposed`, keeping it clear of every
    /// other item on the canvas.
    fn place_node(
        &mut self,
        canvas_index: usize,
        content_id: &str,
        proposed: Rect,
    ) -> Result<(), AppError> {
        let obstacles = self.canvas_obstacles(canvas_index, &HashSet::new(), &HashSet::new());
        let offset = layout::resolve(&[proposed], &obstacles, self.grid_options());
        self.state_mut().canvases[canvas_index]
            .nodes
            .push(CanvasNode {
                id: Uuid::new_v4().to_string(),
                content_id: content_id.into(),
                x: js_round(proposed.x + offset.dx),
                y: js_round(proposed.y + offset.dy),
                width: proposed.width,
                height: proposed.height,
            });
        self.bump_contents(&[content_id.to_owned()]);
        Ok(())
    }

    /// Insert a node centered on `(center_x, center_y)`.
    fn push_centered_node(
        &mut self,
        canvas_index: usize,
        content_id: &str,
        center_x: f64,
        center_y: f64,
    ) -> Result<(), AppError> {
        let (width, height) = {
            let content = self.content(content_id)?;
            sizing::node_size(content)
        };
        self.place_node(
            canvas_index,
            content_id,
            Rect {
                x: js_round(center_x - width / 2.0),
                y: js_round(center_y - height / 2.0),
                width,
                height,
            },
        )
    }

    /// Push down everything on `canvas_index` that the grown node now
    /// overlaps, cascading to items those pushes overlap. The grown node never
    /// moves.
    fn push_down_after_growth(
        &mut self,
        canvas_index: usize,
        grown_node_id: &str,
        grown: Rect,
    ) {
        enum Target {
            Node(usize),
            Card(usize),
        }
        let canvas_id = self.state_ref().canvases[canvas_index].id.clone();
        let mut targets: Vec<(Target, Rect)> = Vec::new();
        for (index, canvas) in self.state_ref().canvases.iter().enumerate() {
            if canvas.parent_id.as_deref() != Some(canvas_id.as_str()) {
                continue;
            }
            if let Some(frame) = canvas.frame {
                targets.push((Target::Card(index), rect_from_frame(frame)));
            }
        }
        for (index, node) in self.state_ref().canvases[canvas_index]
            .nodes
            .iter()
            .enumerate()
        {
            if node.id == grown_node_id {
                continue;
            }
            targets.push((Target::Node(index), rect_from_node(node)));
        }
        let mut rects: Vec<Rect> = targets.iter().map(|(_, rect)| *rect).collect();
        let before: Vec<f64> = rects.iter().map(|rect| rect.y).collect();
        layout::push_down(grown, &mut rects, self.grid_options());
        if rects.iter().zip(before.iter()).all(|(rect, y)| rect.y == *y) {
            return;
        }
        let state = self.state_mut();
        for (slot, (target, _)) in targets.iter().enumerate() {
            let y = rects[slot].y;
            match *target {
                Target::Node(index) => {
                    state.canvases[canvas_index].nodes[index].y = js_round(y);
                }
                Target::Card(index) => {
                    if let Some(frame) = state.canvases[index].frame.as_mut() {
                        frame.y = js_round(y);
                    }
                }
            }
        }
    }

    /// Drop text/HTML bodies, assets, thumbnails and the now-empty content
    /// folder.
    fn delete_content_aux_files(&mut self, content_ids: &[String]) {
        let cache = files::thumbs_dir(&self.root);
        for id in content_ids {
            let _ = files::remove_file_if_exists(&files::content_text_path(&self.root, id));
            let _ = files::remove_file_if_exists(&files::content_html_path(&self.root, id));
            super::assets::remove_assets(&self.root, id);
            files::remove_thumbnails(&cache, id);
            files::remove_dir_if_empty(&files::content_dir(&self.root, id));
        }
    }
}

fn rect_from_node(node: &CanvasNode) -> Rect {
    Rect {
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
    }
}

fn rect_from_frame(frame: CanvasFrame) -> Rect {
    Rect {
        x: frame.x,
        y: frame.y,
        width: frame.width,
        height: frame.height,
    }
}

/// Center of the viewport in world coordinates; falls back to the persisted
/// canvas viewport when the renderer did not send a live one.
fn viewport_center(viewport: Option<&ImportViewport>, view: &CanvasViewport) -> (f64, f64) {
    let width = viewport
        .map(|item| finite_or(item.width, 640.0).max(320.0))
        .unwrap_or(640.0);
    let height = viewport
        .map(|item| finite_or(item.height, 480.0).max(240.0))
        .unwrap_or(480.0);
    (
        (width / 2.0 - view.x) / view.zoom,
        (height / 2.0 - view.y) / view.zoom,
    )
}

/// Frame of a group canvas: the selection bounding box plus padding.
fn bounding_frame(nodes: &[CanvasNode]) -> CanvasFrame {
    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    for node in nodes {
        min_x = min_x.min(node.x);
        min_y = min_y.min(node.y);
        max_x = max_x.max(node.x + node.width);
        max_y = max_y.max(node.y + node.height);
    }
    CanvasFrame {
        x: js_round(min_x - GROUP_PADDING),
        y: js_round(min_y - GROUP_PADDING),
        width: js_round((max_x - min_x + GROUP_PADDING * 2.0).max(GROUP_MIN_WIDTH)),
        height: js_round((max_y - min_y + GROUP_PADDING * 2.0).max(GROUP_MIN_HEIGHT)),
    }
}

fn read_text_file(path: &std::path::Path) -> Result<String, AppError> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(text),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(AppError::message(format!(
            "无法读取文本内容（{}）：{error}",
            path.display()
        ))),
    }
}

fn read_optional_text_file(path: &std::path::Path) -> Result<Option<String>, AppError> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(AppError::message(format!(
            "无法读取富文本内容（{}）：{error}",
            path.display()
        ))),
    }
}

