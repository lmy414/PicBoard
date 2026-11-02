//! Storage behaviour tests: migration, multi-reference contents, cascades,
//! edges, capture de-duplication, retention and text bodies.

use super::*;
use crate::clipboard::{CapturedContent, ClipboardCapture};
use crate::dto::{
    AppState, CanvasFrame, CanvasNode, CanvasPoint, ContentBody, ContentKind, ContentSource,
    ImportImagePayload, ImportViewport, NewContentInput, NodeMove,
};
use crate::paths::safe_join;
use std::fs;
use chrono::Utc;
use std::path::{Path, PathBuf};
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

fn no_bin() -> Arc<Mutex<Vec<PathBuf>>> {
    Arc::new(Mutex::new(Vec::new()))
}

fn png_bytes(width: u32, height: u32) -> Vec<u8> {
    let rgba = vec![160u8; (width * height * 4) as usize];
    super::encode_png(&rgba, width, height).unwrap()
}

#[test]
fn saving_image_copies_keeps_original_bytes_and_distinct_ids() {
    let temp = TempDir::new().unwrap();
    let mut store = storage(&temp, no_bin(), None);
    let bytes = png_bytes(32, 24);
    let first = store.save_image_copy("原图.png", &bytes).unwrap();
    let second = store.save_image_copy("编辑副本.png", &bytes).unwrap();
    assert_ne!(first.content_id, second.content_id);
    assert_eq!(second.state.contents.len(), 2);
    for id in [&first.content_id, &second.content_id] {
        let image = store.resolve_image(id).unwrap();
        assert_eq!(fs::read(image.path).unwrap(), bytes);
    }
    let before = store.load_state().unwrap();
    assert!(store.save_image_copy("bad.png", b"invalid image").is_err());
    assert_eq!(store.load_state().unwrap(), before);
}

/// Ingest one image content (no placement) and return its id.
fn ingest_named(store: &mut ImageBoardStorage, name: &str, bytes: &[u8]) -> String {
    store
        .ingest_image(Some(name), bytes, ContentSource::Drop)
        .unwrap()
        .id
}

/// Ingest one image and place it on `canvas` (the old drag-in flow).
fn import_one(store: &mut ImageBoardStorage, canvas: &str, name: &str) -> String {
    let id = ingest_named(store, name, name.as_bytes());
    store
        .place_content(&id, canvas, CanvasPoint { x: 40.0, y: 40.0 })
        .unwrap();
    id
}

/// Ingest a rich-text content and return its id.
fn ingest_rich(store: &mut ImageBoardStorage, text: &str, html: &str) -> String {
    let state = store
        .ingest_capture(&CapturedContent::RichText {
            text: text.into(),
            html: html.into(),
        })
        .unwrap();
    state
        .contents
        .values()
        .find(|content| {
            content.kind == ContentKind::RichText && content.preview == text
        })
        .unwrap()
        .id
        .clone()
}

fn nodes_for<'a>(state: &'a AppState, content_id: &str) -> Vec<&'a CanvasNode> {
    state
        .canvases
        .iter()
        .flat_map(|canvas| canvas.nodes.iter())
        .filter(|node| node.content_id == content_id)
        .collect()
}

fn node_for<'a>(state: &'a AppState, content_id: &str) -> &'a CanvasNode {
    nodes_for(state, content_id)
        .into_iter()
        .next()
        .expect("node exists")
}

fn age_content(store: &mut ImageBoardStorage, content_id: &str, stamp: &str) {
    store
        .state
        .as_mut()
        .unwrap()
        .contents
        .get_mut(content_id)
        .unwrap()
        .last_used_at = stamp.to_owned();
    store.write_state().unwrap();
}

fn viewport() -> Option<ImportViewport> {
    Some(ImportViewport {
        x: 0.0,
        y: 0.0,
        zoom: 1.0,
        width: 1280.0,
        height: 800.0,
    })
}

fn rect_of(node: &CanvasNode) -> super::layout::Rect {
    super::layout::Rect {
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
    }
}

fn all_nodes(state: &AppState) -> Vec<&CanvasNode> {
    state
        .canvases
        .iter()
        .flat_map(|canvas| canvas.nodes.iter())
        .collect()
}

fn overlaps_any(state: &AppState) -> bool {
    let nodes = all_nodes(state);
    nodes.iter().enumerate().any(|(index, left)| {
        nodes[index + 1..]
            .iter()
            .any(|right| rect_of(left).collides(rect_of(right)))
    })
}

/// Create a text content without placing a node.
fn text_content(store: &mut ImageBoardStorage, text: &str) -> String {
    let state = store
        .ingest_capture(&CapturedContent::Text { text: text.into() })
        .unwrap();
    state
        .contents
        .values()
        .find(|content| content.kind == ContentKind::Text && content.preview == text)
        .unwrap()
        .id
        .clone()
}

// ---------------------------------------------------------------------------
// v1 → v2 migration
// ---------------------------------------------------------------------------

fn legacy_state_json() -> String {
    r#"{
        "activeCanvasId": "root",
        "canvases": [
            {
                "id": "root", "name": "画布 1", "imageIds": ["img-a"],
                "createdAt": "2021-01-01T00:00:00.000Z",
                "viewport": {"x": 0, "y": 0, "zoom": 1}
            },
            {
                "id": "child", "name": "组 1", "imageIds": ["img-b"],
                "createdAt": "2021-01-02T00:00:00.000Z",
                "viewport": {"x": 0, "y": 0, "zoom": 1},
                "parentId": "root",
                "frame": {"x": 1000, "y": 1000, "width": 300, "height": 200}
            }
        ],
        "categories": [{"id": "cat-1", "name": "角色", "createdAt": "2020-01-01T00:00:00.000Z"}],
        "images": {
            "img-a": {
                "id": "img-a", "fileName": "legacy-a.png", "relativePath": "pending/legacy-a.png",
                "status": "pending", "categoryId": "cat-1", "canvasId": "root",
                "x": 100, "y": 200, "width": 160, "height": 140,
                "createdAt": "2021-01-01T00:00:00.000Z"
            },
            "img-b": {
                "id": "img-b", "fileName": "legacy-b.png", "relativePath": "classified/cat-1/legacy-b.png",
                "status": "classified", "categoryId": "cat-1", "canvasId": "child",
                "x": 10, "y": 20, "width": 150, "height": 120,
                "createdAt": "2021-01-02T00:00:00.000Z"
            },
            "img-c": {
                "id": "img-c", "fileName": "legacy-c.png", "relativePath": "classified/cat-1/legacy-c.png",
                "status": "classified", "categoryId": "cat-1", "canvasId": null,
                "x": 0, "y": 0, "width": 160, "height": 140,
                "createdAt": "2021-01-03T00:00:00.000Z"
            }
        }
    }"#
    .to_owned()
}

#[test]
fn v1_migration_preserves_placements_categories_and_files() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    fs::create_dir_all(root.join("pending")).unwrap();
    fs::create_dir_all(root.join("classified").join("cat-1")).unwrap();
    let a_bytes = png_bytes(640, 480);
    fs::write(root.join("pending/legacy-a.png"), &a_bytes).unwrap();
    fs::write(root.join("classified/cat-1/legacy-b.png"), b"not-a-real-image").unwrap();
    fs::write(root.join("classified/cat-1/legacy-c.png"), png_bytes(100, 400)).unwrap();
    let legacy = legacy_state_json();
    fs::write(root.join("state.json"), &legacy).unwrap();

    let mut store = storage(&temp, no_bin(), None);
    // This test is about migration fidelity, so migrations must not re-snap
    // positions: with snapping off a collision-free board keeps its layout.
    store.set_layout_settings(false, 24);
    let state = store.load_state().unwrap();

    assert_eq!(state.version, 2);
    assert_eq!(state.contents.len(), 3);
    // Canvas hierarchy and order survive.
    assert_eq!(
        state.canvases.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
        vec!["root", "child"]
    );
    assert_eq!(state.canvases[1].parent_id.as_deref(), Some("root"));
    assert_eq!(state.active_canvas_id, "root");
    assert_eq!(state.categories.len(), 1);

    // img-a: pending file, category dropped, intrinsic size from the header.
    let a = &state.contents["img-a"];
    assert_eq!(a.kind, ContentKind::Image);
    assert_eq!(a.source, ContentSource::Migrated);
    assert_eq!(a.preview, "legacy-a.png");
    assert_eq!(a.category_id, None);
    assert_eq!(a.text_length, 0);
    let image = a.image.clone().unwrap();
    assert_eq!(image.relative_path, "pending/legacy-a.png");
    assert_eq!((image.width, image.height), (640, 480));
    assert_eq!(image.byte_size, a_bytes.len() as u64);
    assert_eq!(a.created_at, "2021-01-01T00:00:00.000Z");
    assert_eq!(a.updated_at, a.created_at);
    assert_eq!(a.last_used_at, a.created_at);

    // img-b: classified stays classified; unknown intrinsic size keeps the v1
    // node size.
    let b = &state.contents["img-b"];
    assert_eq!(b.category_id.as_deref(), Some("cat-1"));
    assert_eq!(b.image.as_ref().unwrap().relative_path, "classified/cat-1/legacy-b.png");

    // img-c is classified but unplaced: a content without a node.
    let c = &state.contents["img-c"];
    assert_eq!(c.category_id.as_deref(), Some("cat-1"));
    assert!(nodes_for(&state, "img-c").is_empty());

    // Placements: order, positions and the image sizing rule.
    assert_eq!(state.canvases[0].nodes.len(), 1);
    let node_a = &state.canvases[0].nodes[0];
    assert_eq!(node_a.content_id, "img-a");
    assert_eq!((node_a.x, node_a.y), (100.0, 200.0));
    assert_eq!((node_a.width, node_a.height), (320.0, 240.0));
    let node_b = &state.canvases[1].nodes[0];
    assert_eq!(node_b.content_id, "img-b");
    assert_eq!((node_b.x, node_b.y), (10.0, 20.0));
    assert_eq!((node_b.width, node_b.height), (150.0, 120.0));

    // Files never move during migration.
    assert!(root.join("pending/legacy-a.png").is_file());
    assert!(root.join("classified/cat-1/legacy-b.png").is_file());
    assert!(root.join("classified/cat-1/legacy-c.png").is_file());
    assert!(!root.join("content").read_dir().unwrap().any(|_| true));

    // The untouched v1 file is backed up, and the state is now v2.
    let backup = root.join("state.v1-backup.json");
    assert_eq!(fs::read_to_string(&backup).unwrap(), legacy);
    let persisted: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(root.join("state.json")).unwrap()).unwrap();
    assert_eq!(persisted["version"], 2);
    assert!(persisted.get("images").is_none());

    // Reloading is idempotent and never rewrites the backup.
    let backup_before = fs::read(&backup).unwrap();
    let mut reloaded = storage(&temp, no_bin(), None);
    let again = reloaded.load_state().unwrap();
    assert_eq!(again.contents.len(), 3);
    assert_eq!(nodes_for(&again, "img-a").len(), 1);
    assert_eq!(fs::read(&backup).unwrap(), backup_before);

    // A later write still leaves the v1 backup alone.
    reloaded.set_active_canvas("child").unwrap();
    assert_eq!(fs::read(&backup).unwrap(), backup_before);
}

#[test]
fn migration_drops_placements_whose_content_disappeared() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    fs::create_dir_all(root.join("pending")).unwrap();
    fs::write(
        root.join("state.json"),
        r#"{
            "activeCanvasId": "root",
            "canvases": [{
                "id": "root", "name": "画布 1", "imageIds": ["ghost", "img-a"],
                "createdAt": "2021-01-01T00:00:00.000Z",
                "viewport": {"x": 0, "y": 0, "zoom": 1}
            }],
            "categories": [],
            "images": {
                "img-a": {
                    "id": "img-a", "fileName": "a.png", "relativePath": "pending/a.png",
                    "status": "pending", "categoryId": null, "canvasId": "root",
                    "x": 5, "y": 6, "width": 160, "height": 140,
                    "createdAt": "2021-01-01T00:00:00.000Z"
                }
            }
        }"#,
    )
    .unwrap();

    let mut store = storage(&temp, no_bin(), None);
    let state = store.load_state().unwrap();

    assert_eq!(state.contents.len(), 1);
    assert_eq!(state.canvases[0].nodes.len(), 1);
    assert_eq!(state.canvases[0].nodes[0].content_id, "img-a");
    assert_eq!(state.edges.len(), 0);
}

// ---------------------------------------------------------------------------
// Imports and multi-reference contents
// ---------------------------------------------------------------------------

#[test]
fn captured_ingest_classifies_kinds_sizes_and_bodies() {
    let temp = tempfile::tempdir().unwrap();
    let mut store = storage(&temp, no_bin(), None);

    let state = store
        .ingest_capture(&CapturedContent::Link {
            url: "https://example.com/page".into(),
        })
        .unwrap();
    let link = state.contents.values().next().unwrap();
    assert_eq!(link.kind, ContentKind::Link);
    assert_eq!(link.url.as_deref(), Some("https://example.com/page"));
    assert_eq!(link.preview, "https://example.com/page");
    assert_eq!(link.text_length, 0);
    assert_eq!(link.source, ContentSource::Clipboard);
    // Background capture never places a node; placement is explicit.
    assert!(nodes_for(&state, &link.id).is_empty());

    let state = store
        .ingest_capture(&CapturedContent::RichText {
            text: "first\nsecond".into(),
            html: "<p>first<br>second</p>".into(),
        })
        .unwrap();
    let rich = state
        .contents
        .values()
        .find(|content| content.kind == ContentKind::RichText)
        .unwrap();
    assert_eq!(rich.preview, "first\nsecond");
    assert_eq!(rich.text_length, "first\nsecond".chars().count());
    assert_eq!(rich.url, None);
    assert_eq!(
        store.get_content_body(&rich.id).unwrap(),
        ContentBody {
            text: "first\nsecond".into(),
            html: Some("<p>first<br>second</p>".into())
        }
    );
}

#[test]
fn free_mode_is_the_default_and_snapping_is_opt_in() {
    let temp = tempfile::tempdir().unwrap();
    let mut store = storage(&temp, no_bin(), None);
    let root = store.load_state().unwrap().active_canvas_id;
    let content = text_content(&mut store, "free");
    // Default (free mode): a sub-grid proposal keeps its exact position.
    let state = store
        .place_content(&content, &root, CanvasPoint { x: 151.0, y: 53.0 })
        .unwrap();
    let node = node_for(&state, &content);
    assert_eq!((node.x, node.y), (11.0, 11.0));

    // Opting into the grid rounds the same kind of proposal.
    store.set_layout_settings(true, 24);
    let snapped = text_content(&mut store, "snapped");
    let state = store
        .place_content(&snapped, &root, CanvasPoint { x: 5151.0, y: 53.0 })
        .unwrap();
    let node = node_for(&state, &snapped);
    assert_eq!((node.x % 24.0, node.y % 24.0), (0.0, 0.0));
}

#[test]
fn placements_snap_to_the_grid_and_avoid_existing_items() {
    let temp = tempfile::tempdir().unwrap();
    let mut store = storage(&temp, no_bin(), None);
    // Snapping is off by default; this test is about the grid mode.
    store.set_layout_settings(true, 24);
    let root = store.load_state().unwrap().active_canvas_id;
    let first = text_content(&mut store, "first");
    let second = text_content(&mut store, "second");

    // Proposed center (140, 42) -> top-left (0, 0); an off-grid center must
    // snap to the 24 px lattice.
    let state = store
        .place_content(&first, &root, CanvasPoint { x: 151.0, y: 53.0 })
        .unwrap();
    let node = node_for(&state, &first);
    assert_eq!((node.x % 24.0, node.y % 24.0), (0.0, 0.0));
    let first_rect = rect_of(node);

    // Same spot again: the second placement must not overlap the first and
    // must still sit on the lattice.
    let state = store
        .place_content(&second, &root, CanvasPoint { x: 151.0, y: 53.0 })
        .unwrap();
    let second_rect = rect_of(node_for(&state, &second));
    assert!(!first_rect.collides(second_rect));
    assert_eq!((second_rect.x % 24.0, second_rect.y % 24.0), (0.0, 0.0));
}

#[test]
fn move_nodes_keeps_relative_layout_and_stays_overlap_free() {
    let temp = tempfile::tempdir().unwrap();
    let mut store = storage(&temp, no_bin(), None);
    // Snapping is off by default; assert the grid mode explicitly.
    store.set_layout_settings(true, 24);
    let root = store.load_state().unwrap().active_canvas_id;
    let anchor = text_content(&mut store, "anchor");
    let first = text_content(&mut store, "first");
    let second = text_content(&mut store, "second");
    // Anchor at the origin; the moving pair starts far away, 300 px apart.
    let state = store
        .place_content(&anchor, &root, CanvasPoint { x: 140.0, y: 42.0 })
        .unwrap();
    let anchor_rect = rect_of(node_for(&state, &anchor));
    let state = store
        .place_content(&first, &root, CanvasPoint { x: 5140.0, y: 42.0 })
        .unwrap();
    let first_node = node_for(&state, &first).clone();
    let state = store
        .place_content(&second, &root, CanvasPoint { x: 5440.0, y: 42.0 })
        .unwrap();
    let second_node = node_for(&state, &second).clone();
    let relative_x = second_node.x - first_node.x;

    // Drop both straight onto the anchor in one gesture.
    let state = store
        .move_nodes(&[
            NodeMove {
                node_id: first_node.id.clone(),
                x: anchor_rect.x + 10.0,
                y: anchor_rect.y + 10.0,
            },
            NodeMove {
                node_id: second_node.id.clone(),
                x: anchor_rect.x + 10.0 + relative_x,
                y: anchor_rect.y + 10.0,
            },
        ])
        .unwrap();

    let moved_first = node_for(&state, &first);
    let moved_second = node_for(&state, &second);
    // Relative layout preserved.
    assert_eq!(moved_second.x - moved_first.x, relative_x);
    assert_eq!(moved_second.y, moved_first.y);
    // Cleared the anchor and snapped.
    assert!(!rect_of(moved_first).collides(anchor_rect));
    assert_eq!((moved_first.x % 24.0, moved_first.y % 24.0), (0.0, 0.0));
    assert!(!overlaps_any(&state));
}

#[test]
fn move_nodes_rejects_cross_canvas_gestures_and_bad_coordinates() {
    let temp = tempfile::tempdir().unwrap();
    let mut store = storage(&temp, no_bin(), None);
    let root = store.load_state().unwrap().active_canvas_id;
    let here = text_content(&mut store, "here");
    let other = store.create_canvas(None, None).unwrap().active_canvas_id;
    let there = text_content(&mut store, "there");
    store
        .place_content(&here, &root, CanvasPoint { x: 400.0, y: 300.0 })
        .unwrap();
    store
        .place_content(&there, &other, CanvasPoint { x: 400.0, y: 300.0 })
        .unwrap();
    let state = store.load_state().unwrap();
    let here_node = node_for(&state, &here).id.clone();
    let there_node = node_for(&state, &there).id.clone();

    assert_eq!(
        store
            .move_nodes(&[
                NodeMove {
                    node_id: here_node.clone(),
                    x: 0.0,
                    y: 0.0
                },
                NodeMove {
                    node_id: there_node,
                    x: 10.0,
                    y: 10.0
                },
            ])
            .unwrap_err()
            .0,
        "所选节点不在同一画布"
    );
    assert_eq!(
        store
            .move_nodes(&[NodeMove {
                node_id: here_node,
                x: f64::NAN,
                y: 0.0
            }])
            .unwrap_err()
            .0,
        "节点坐标无效"
    );
    assert_eq!(
        store
            .move_nodes(&[NodeMove {
                node_id: "missing".into(),
                x: 0.0,
                y: 0.0
            }])
            .unwrap_err()
            .0,
        "找不到指定节点"
    );
}

#[test]
fn growth_pushes_down_overlapping_items_and_cascades() {
    let temp = tempfile::tempdir().unwrap();
    let mut store = storage(&temp, no_bin(), None);
    // Exact push positions: no snapping.
    store.set_layout_settings(false, 24);
    let root = store.load_state().unwrap().active_canvas_id;
    let a = text_content(&mut store, "a");
    let b = text_content(&mut store, "b");
    let c = text_content(&mut store, "c");
    for (content, y) in [(&a, 0.0), (&b, 142.0), (&c, 300.0)] {
        store
            .place_content(content, &root, CanvasPoint { x: 140.0, y: 42.0 + y })
            .unwrap();
    }
    let state = store.load_state().unwrap();
    let a_node = node_for(&state, &a).clone();
    assert_eq!((a_node.x, a_node.y, a_node.height), (0.0, 0.0, 84.0));
    assert_eq!(node_for(&state, &b).y, 142.0);
    assert_eq!(node_for(&state, &c).y, 300.0);

    // Grow A to the maximum text height (264): B must move below it.
    let long = "line\n".repeat(12);
    let state = store
        .update_text_content(
            &a,
            ContentBody {
                text: long.clone(),
                html: None,
            },
        )
        .unwrap();
    let a_node = node_for(&state, &a).clone();
    assert_eq!(a_node.y, 0.0, "the grown node never moves");
    assert_eq!(a_node.height, 264.0);
    let b_node = node_for(&state, &b).clone();
    assert_eq!(b_node.y, 264.0 + 16.0);

    // Growing B cascades into C.
    let state = store
        .update_text_content(
            &b,
            ContentBody {
                text: long,
                html: None,
            },
        )
        .unwrap();
    let b_node = node_for(&state, &b).clone();
    assert_eq!(b_node.height, 264.0);
    let c_node = node_for(&state, &c).clone();
    assert_eq!(c_node.y, b_node.y + b_node.height + 16.0);
    assert!(!overlaps_any(&state));
    // A was above B and stays put.
    assert_eq!(node_for(&state, &a).y, 0.0);
}

#[test]
fn rich_text_cover_sets_the_card_height_and_survives_edits() {
    let temp = tempfile::tempdir().unwrap();
    let mut store = storage(&temp, no_bin(), None);
    let root = store.load_state().unwrap().active_canvas_id;
    let text = text_content(&mut store, "rich");
    store
        .place_content(&text, &root, CanvasPoint { x: 140.0, y: 42.0 })
        .unwrap();
    let asset = store
        .add_content_asset(
            &text,
            ImportImagePayload {
                name: "cover.png".into(),
                data: png_bytes(10, 6),
            },
        )
        .unwrap();
    let with_cover = format!(
        r#"<p>rich</p><img data-asset="{text}/{}">"#,
        asset.asset_id
    );

    let state = store
        .update_text_content(
            &text,
            ContentBody {
                text: "rich".into(),
                html: Some(with_cover),
            },
        )
        .unwrap();
    let content = &state.contents[&text];
    assert_eq!(content.kind, ContentKind::RichText);
    assert_eq!(content.cover_asset.as_deref(), Some(format!("{text}/{}", asset.asset_id).as_str()));
    let node = node_for(&state, &text);
    assert_eq!((node.width, node.height), (280.0, 192.0));

    // Removing the image clears the cover and restores the plain text height.
    let state = store
        .update_text_content(
            &text,
            ContentBody {
                text: "rich".into(),
                html: Some("<p>rich</p>".into()),
            },
        )
        .unwrap();
    assert_eq!(state.contents[&text].cover_asset, None);
    let node = node_for(&state, &text);
    assert_eq!((node.width, node.height), (280.0, 84.0));
}

#[test]
fn cover_ingest_sets_the_cover_and_sizes_the_node() {
    let temp = tempfile::tempdir().unwrap();
    let mut store = storage(&temp, no_bin(), None);
    let root = store.load_state().unwrap().active_canvas_id;
    // A source content owning the asset.
    let source = text_content(&mut store, "source");
    let asset = store
        .add_content_asset(
            &source,
            ImportImagePayload {
                name: "pic.png".into(),
                data: png_bytes(8, 8),
            },
        )
        .unwrap();
    let html = format!(
        r#"<p>copy</p><img data-asset="{source}/{}">"#,
        asset.asset_id
    );

    let copy_id = ingest_rich(&mut store, "copy", &html);
    let state = store.load_state().unwrap();
    let copy = &state.contents[&copy_id];
    let cover = copy.cover_asset.clone().expect("cover after localization");
    // Localization copied the asset, so the cover points at the new content.
    assert!(cover.starts_with(&format!("{}/", copy.id)));
    // The cover changes the card height once the content is placed.
    store
        .place_content(&copy_id, &root, CanvasPoint { x: 40.0, y: 40.0 })
        .unwrap();
    let state = store.load_state().unwrap();
    assert_eq!(node_for(&state, &copy_id).height, 192.0);
}

/// True when no two items on the same canvas (nodes and child-canvas cards)
/// overlap.
fn items_overlap_free(state: &AppState) -> bool {
    for canvas in &state.canvases {
        let mut rects: Vec<super::layout::Rect> = canvas.nodes.iter().map(rect_of).collect();
        for child in &state.canvases {
            if child.parent_id.as_deref() != Some(canvas.id.as_str()) {
                continue;
            }
            if let Some(frame) = child.frame {
                rects.push(super::layout::Rect {
                    x: frame.x,
                    y: frame.y,
                    width: frame.width,
                    height: frame.height,
                });
            }
        }
        if rects
            .iter()
            .enumerate()
            .any(|(index, left)| rects[index + 1..].iter().any(|right| left.collides(*right)))
        {
            return false;
        }
    }
    true
}

fn card_rect(frame: CanvasFrame) -> super::layout::Rect {
    super::layout::Rect {
        x: frame.x,
        y: frame.y,
        width: frame.width,
        height: frame.height,
    }
}

#[test]
fn migration_resolves_every_node_against_cards_and_other_nodes() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    fs::create_dir_all(root.join("pending")).unwrap();
    fs::write(
        root.join("state.json"),
        r#"{
            "activeCanvasId": "root",
            "canvases": [
                {
                    "id": "root", "name": "画布 1", "imageIds": ["a", "b", "c"],
                    "createdAt": "2021-01-01T00:00:00.000Z",
                    "viewport": {"x": 0, "y": 0, "zoom": 1}
                },
                {
                    "id": "child", "name": "组 1", "imageIds": [],
                    "createdAt": "2021-01-01T00:00:00.000Z",
                    "viewport": {"x": 0, "y": 0, "zoom": 1},
                    "parentId": "root",
                    "frame": {"x": 0, "y": 0, "width": 300, "height": 200}
                }
            ],
            "categories": [],
            "images": {
                "a": {"id":"a","fileName":"a.png","relativePath":"pending/a.png","status":"pending","categoryId":null,"canvasId":"root","x":10,"y":10,"width":160,"height":140,"createdAt":"2021-01-01T00:00:00.000Z"},
                "b": {"id":"b","fileName":"b.png","relativePath":"pending/b.png","status":"pending","categoryId":null,"canvasId":"root","x":20,"y":20,"width":160,"height":140,"createdAt":"2021-01-01T00:00:00.000Z"},
                "c": {"id":"c","fileName":"c.png","relativePath":"pending/c.png","status":"pending","categoryId":null,"canvasId":"root","x":30,"y":30,"width":160,"height":140,"createdAt":"2021-01-01T00:00:00.000Z"}
            }
        }"#,
    )
    .unwrap();

    let mut store = storage(&temp, no_bin(), None);
    store.set_layout_settings(false, 24);
    let state = store.load_state().unwrap();

    // The card is a fixed obstacle and stays where it was.
    let child = state.canvases.iter().find(|c| c.id == "child").unwrap();
    let frame = child.frame.unwrap();
    assert_eq!((frame.x, frame.y, frame.width, frame.height), (0.0, 0.0, 300.0, 200.0));
    // Every node is resolved, the first one included (it overlapped the card).
    let nodes = &state.canvases[0].nodes;
    assert_eq!(nodes.len(), 3);
    assert_ne!((nodes[0].x, nodes[0].y), (10.0, 10.0));
    assert!(items_overlap_free(&state));
    // Deterministic: reloading the written v2 file must not move anything.
    let positions: Vec<(f64, f64)> = nodes.iter().map(|node| (node.x, node.y)).collect();
    let mut reloaded = storage(&temp, no_bin(), None);
    let again = reloaded.load_state().unwrap();
    assert_eq!(
        again.canvases[0]
            .nodes
            .iter()
            .map(|node| (node.x, node.y))
            .collect::<Vec<_>>(),
        positions
    );
}

#[test]
fn child_cards_avoid_parent_nodes_and_sibling_cards() {
    let temp = tempfile::tempdir().unwrap();
    let mut store = storage(&temp, no_bin(), None);
    let root = store.load_state().unwrap().active_canvas_id;
    let content = text_content(&mut store, "anchor");
    // A 280x84 card centered on (260, 162) sits exactly at (120, 120), which is
    // also the default auto placement of the first child card.
    store
        .place_content(&content, &root, CanvasPoint { x: 260.0, y: 162.0 })
        .unwrap();
    let node_rect = {
        let state = store.load_state().unwrap();
        rect_of(node_for(&state, &content))
    };

    // Auto-placed card: must move clear of the node.
    let first = store
        .create_canvas(Some(root.clone()), None)
        .unwrap()
        .active_canvas_id;
    let state = store.load_state().unwrap();
    let first_frame = state
        .canvases
        .iter()
        .find(|canvas| canvas.id == first)
        .unwrap()
        .frame
        .unwrap();
    assert!(!node_rect.collides(card_rect(first_frame)));
    assert!(items_overlap_free(&state));

    // Explicit frame dropped onto existing items is resolved too.
    let second = store
        .create_canvas(
            Some(root.clone()),
            Some(CanvasFrame {
                x: 0.0,
                y: 0.0,
                width: 280.0,
                height: 180.0,
            }),
        )
        .unwrap()
        .active_canvas_id;
    let state = store.load_state().unwrap();
    let second_frame = state
        .canvases
        .iter()
        .find(|canvas| canvas.id == second)
        .unwrap()
        .frame
        .unwrap();
    assert!(!node_rect.collides(card_rect(second_frame)));
    assert!(!card_rect(second_frame).collides(card_rect(first_frame)));
    assert!(items_overlap_free(&state));

    // Reparenting a root canvas under this one resolves the auto placement
    // against the node and both sibling cards.
    let other = store.create_canvas(None, None).unwrap().active_canvas_id;
    let state = store.move_canvas(&other, Some(root.clone()), None).unwrap();
    let moved = state.canvases.iter().find(|canvas| canvas.id == other).unwrap();
    assert_eq!(moved.parent_id.as_deref(), Some(root.as_str()));
    assert!(items_overlap_free(&state));
}


// ---------------------------------------------------------------------------
// Manual content creation (canvas new-node menu)
// ---------------------------------------------------------------------------

#[test]
fn create_content_node_creates_manual_text_rich_and_link_contents() {
    let temp = tempfile::tempdir().unwrap();
    let mut store = storage(&temp, no_bin(), None);
    let root = store.load_state().unwrap().active_canvas_id;

    let text = store
        .create_content_node(
            &root,
            CanvasPoint { x: 400.0, y: 300.0 },
            NewContentInput::Text,
        )
        .unwrap();
    let text_record = &text.state.contents[&text.content_id];
    assert_eq!(text_record.kind, ContentKind::Text);
    assert_eq!(text_record.source, ContentSource::Manual);
    assert_eq!(
        store.get_content_body(&text.content_id).unwrap(),
        ContentBody {
            text: String::new(),
            html: None
        }
    );
    let text_node = text
        .state
        .canvases
        .iter()
        .flat_map(|canvas| &canvas.nodes)
        .find(|node| node.id == text.node_id)
        .expect("returned text node exists in the returned state");
    assert_eq!(text_node.content_id, text.content_id);
    let text_dir = temp.path().join("content").join(&text.content_id);
    assert!(text_dir.join("text.txt").is_file());
    assert!(!text_dir.join("content.html").exists());

    let rich = store
        .create_content_node(
            &root,
            CanvasPoint { x: 800.0, y: 300.0 },
            NewContentInput::RichText,
        )
        .unwrap();
    let rich_record = &rich.state.contents[&rich.content_id];
    assert_eq!(rich_record.kind, ContentKind::RichText);
    assert_eq!(rich_record.source, ContentSource::Manual);
    assert_eq!(
        store.get_content_body(&rich.content_id).unwrap(),
        ContentBody {
            text: String::new(),
            html: Some("<p></p>".into())
        }
    );
    let rich_node = rich
        .state
        .canvases
        .iter()
        .flat_map(|canvas| &canvas.nodes)
        .find(|node| node.id == rich.node_id)
        .expect("returned rich node exists in the returned state");
    assert_eq!(rich_node.content_id, rich.content_id);
    let rich_dir = temp.path().join("content").join(&rich.content_id);
    assert_eq!(fs::read_to_string(rich_dir.join("text.txt")).unwrap(), "");
    assert_eq!(
        fs::read_to_string(rich_dir.join("content.html")).unwrap(),
        "<p></p>"
    );

    let link = store
        .create_content_node(
            &root,
            CanvasPoint { x: 1200.0, y: 300.0 },
            NewContentInput::Link {
                url: " https://example.com/a ".into(),
            },
        )
        .unwrap();
    let link_record = &link.state.contents[&link.content_id];
    assert_eq!(link_record.kind, ContentKind::Link);
    assert_eq!(link_record.source, ContentSource::Manual);
    assert_eq!(link_record.url.as_deref(), Some("https://example.com/a"));
    assert_eq!(link_record.preview, "https://example.com/a");
    assert_eq!(link_record.text_length, 0);
    assert_eq!(
        store.get_content_body(&link.content_id).unwrap(),
        ContentBody {
            text: "https://example.com/a".into(),
            html: None
        }
    );
    let link_node = link
        .state
        .canvases
        .iter()
        .flat_map(|canvas| &canvas.nodes)
        .find(|node| node.id == link.node_id)
        .expect("returned link node exists in the returned state");
    assert_eq!(link_node.content_id, link.content_id);
    // Links own no body files.
    assert!(!temp.path().join("content").join(&link.content_id).exists());
}

#[test]
fn consecutive_empty_rich_text_creations_are_independent_contents() {
    let temp = tempfile::tempdir().unwrap();
    let mut store = storage(&temp, no_bin(), None);
    let root = store.load_state().unwrap().active_canvas_id;

    let first = store
        .create_content_node(
            &root,
            CanvasPoint { x: 300.0, y: 300.0 },
            NewContentInput::RichText,
        )
        .unwrap();
    let second = store
        .create_content_node(
            &root,
            CanvasPoint { x: 900.0, y: 300.0 },
            NewContentInput::RichText,
        )
        .unwrap();

    assert_ne!(first.content_id, second.content_id);
    assert_ne!(first.node_id, second.node_id);
    assert_eq!(second.state.contents.len(), 2);
    for content_id in [&first.content_id, &second.content_id] {
        assert_eq!(
            second.state.contents[content_id].kind,
            ContentKind::RichText
        );
        assert_eq!(
            second.state.contents[content_id].source,
            ContentSource::Manual
        );
        assert_eq!(
            store.get_content_body(content_id).unwrap(),
            ContentBody {
                text: String::new(),
                html: Some("<p></p>".into())
            }
        );
    }
    assert_eq!(all_nodes(&second.state).len(), 2);
}

#[test]
fn manual_contents_and_nodes_survive_storage_reopen() {
    let temp = tempfile::tempdir().unwrap();
    let (root, text, rich, link) = {
        let mut store = storage(&temp, no_bin(), None);
        let root = store.load_state().unwrap().active_canvas_id;
        let text = store
            .create_content_node(
                &root,
                CanvasPoint { x: 300.0, y: 300.0 },
                NewContentInput::Text,
            )
            .unwrap();
        let rich = store
            .create_content_node(
                &root,
                CanvasPoint { x: 700.0, y: 300.0 },
                NewContentInput::RichText,
            )
            .unwrap();
        let link = store
            .create_content_node(
                &root,
                CanvasPoint { x: 1100.0, y: 300.0 },
                NewContentInput::Link {
                    url: "https://example.com/persisted".into(),
                },
            )
            .unwrap();
        (root, text, rich, link)
    };

    let mut reopened = storage(&temp, no_bin(), None);
    let state = reopened.load_state().unwrap();
    let root_canvas = state
        .canvases
        .iter()
        .find(|canvas| canvas.id == root)
        .expect("root canvas survives reopen");
    assert_eq!(root_canvas.nodes.len(), 3);

    for created in [&text, &rich, &link] {
        assert_eq!(
            state.contents[&created.content_id].source,
            ContentSource::Manual
        );
        assert!(
            root_canvas
                .nodes
                .iter()
                .any(|node| node.id == created.node_id
                    && node.content_id == created.content_id),
            "node {} still references content {}",
            created.node_id,
            created.content_id
        );
    }
    assert_eq!(state.contents[&text.content_id].kind, ContentKind::Text);
    assert_eq!(state.contents[&rich.content_id].kind, ContentKind::RichText);
    assert_eq!(state.contents[&link.content_id].kind, ContentKind::Link);
    assert_eq!(
        state.contents[&link.content_id].url.as_deref(),
        Some("https://example.com/persisted")
    );
    assert_eq!(
        reopened.get_content_body(&text.content_id).unwrap(),
        ContentBody {
            text: String::new(),
            html: None
        }
    );
    assert_eq!(
        reopened.get_content_body(&rich.content_id).unwrap(),
        ContentBody {
            text: String::new(),
            html: Some("<p></p>".into())
        }
    );
    assert_eq!(
        reopened.get_content_body(&link.content_id).unwrap(),
        ContentBody {
            text: "https://example.com/persisted".into(),
            html: None
        }
    );
}

#[test]
fn create_content_node_rejects_invalid_input_without_side_effects() {
    let temp = tempfile::tempdir().unwrap();
    let mut store = storage(&temp, no_bin(), None);
    let root = store.load_state().unwrap().active_canvas_id;
    let before = store.load_state().unwrap();
    let state_json_before = fs::read_to_string(temp.path().join("state.json")).unwrap();
    let content_files_before = fs::read_dir(temp.path().join("content")).unwrap().count();

    for url in [
        "",
        "not a url",
        "ftp://example.com/file",
        "https://",
    ] {
        assert!(
            store
                .create_content_node(
                    &root,
                    CanvasPoint { x: 400.0, y: 300.0 },
                    NewContentInput::Link { url: url.into() },
                )
                .is_err(),
            "link {url:?} must be rejected"
        );
    }
    for center in [
        CanvasPoint {
            x: f64::NAN,
            y: 300.0,
        },
        CanvasPoint {
            x: 400.0,
            y: f64::INFINITY,
        },
    ] {
        assert!(
            store
                .create_content_node(&root, center, NewContentInput::RichText)
                .is_err(),
            "center {center:?} must be rejected"
        );
    }
    assert!(store
        .create_content_node(
            "missing-canvas",
            CanvasPoint { x: 400.0, y: 300.0 },
            NewContentInput::Text,
        )
        .is_err());

    assert_eq!(store.load_state().unwrap(), before);
    assert_eq!(
        fs::read_to_string(temp.path().join("state.json")).unwrap(),
        state_json_before
    );
    assert_eq!(
        fs::read_dir(temp.path().join("content")).unwrap().count(),
        content_files_before
    );
    assert!(before.contents.is_empty());
    assert!(all_nodes(&before).is_empty());
}

#[test]
fn create_content_node_rolls_back_when_the_state_write_fails() {
    let temp = tempfile::tempdir().unwrap();
    let mut store = storage(&temp, no_bin(), None);
    let root = store.load_state().unwrap().active_canvas_id;
    let before = store.load_state().unwrap();
    let state_json_before = fs::read_to_string(temp.path().join("state.json")).unwrap();
    // A directory at the backup path makes the next publish fail after the
    // content files and the node have already been prepared.
    fs::create_dir(temp.path().join("state.json.bak")).unwrap();

    assert!(store
        .create_content_node(
            &root,
            CanvasPoint { x: 300.0, y: 300.0 },
            NewContentInput::RichText,
        )
        .is_err());

    assert_eq!(store.load_state().unwrap(), before);
    assert_eq!(
        fs::read_to_string(temp.path().join("state.json")).unwrap(),
        state_json_before
    );
    assert!(all_nodes(store.state_ref()).is_empty());
    assert!(store.state_ref().contents.is_empty());
    assert_eq!(
        fs::read_dir(temp.path().join("content")).unwrap().count(),
        0
    );
}

#[test]
fn create_content_node_snaps_to_grid_and_avoids_existing_items() {
    let temp = tempfile::tempdir().unwrap();
    let mut store = storage(&temp, no_bin(), None);
    // Snapping is off by default; assert the grid mode explicitly.
    store.set_layout_settings(true, 24);
    let root = store.load_state().unwrap().active_canvas_id;

    let first = store
        .create_content_node(
            &root,
            CanvasPoint { x: 151.0, y: 53.0 },
            NewContentInput::Text,
        )
        .unwrap();
    let first_node = node_for(&first.state, &first.content_id);
    assert_eq!(
        (first_node.x % 24.0, first_node.y % 24.0),
        (0.0, 0.0)
    );
    let first_rect = rect_of(first_node);

    // The same proposal must be relocated clear of the first node, and both
    // positions stay on the lattice. The exact replacement spot is owned by
    // the shared layout resolver, not duplicated here.
    let second = store
        .create_content_node(
            &root,
            CanvasPoint { x: 151.0, y: 53.0 },
            NewContentInput::Text,
        )
        .unwrap();
    let second_node = node_for(&second.state, &second.content_id);
    assert!(!first_rect.collides(rect_of(second_node)));
    assert!(!overlaps_any(&second.state));
    assert_eq!(
        (second_node.x % 24.0, second_node.y % 24.0),
        (0.0, 0.0)
    );
}

// ---------------------------------------------------------------------------
// Multi-reference content, cascades, edges, dedupe, retention (capture flow)
// ---------------------------------------------------------------------------

fn ingest_rich_at(store: &mut ImageBoardStorage, canvas: &str, text: &str, html: &str) -> String {
    let id = ingest_rich(store, text, html);
    store
        .place_content(&id, canvas, CanvasPoint { x: 40.0, y: 40.0 })
        .unwrap();
    id
}

fn ingest_link_at(store: &mut ImageBoardStorage, canvas: &str, url: &str) -> String {
    let state = store
        .ingest_capture(&CapturedContent::Link { url: url.into() })
        .unwrap();
    let id = state
        .contents
        .values()
        .find(|content| content.kind == ContentKind::Link && content.url.as_deref() == Some(url))
        .unwrap()
        .id
        .clone();
    store
        .place_content(&id, canvas, CanvasPoint { x: 40.0, y: 40.0 })
        .unwrap();
    id
}

#[test]
fn shared_content_updates_every_placement_and_survives_one_removal() {
    let temp = tempfile::tempdir().unwrap();
    let mut store = storage(&temp, no_bin(), None);
    let root = store.load_state().unwrap().active_canvas_id;
    let content_id = ingest_rich_at(&mut store, &root, "short", "<p>short</p>");
    let second = store.create_canvas(None, None).unwrap().active_canvas_id;
    store
        .place_content(&content_id, &second, CanvasPoint { x: 40.0, y: 50.0 })
        .unwrap();

    // Edit once: both placements see the new preview and the new height.
    let long = "wrapped line\n".repeat(8) + "tail";
    let state = store
        .update_text_content(
            &content_id,
            ContentBody {
                text: long.clone(),
                html: Some(format!("<p>{}</p>", long.replace('\n', "<br>"))),
            },
        )
        .unwrap();
    let content = &state.contents[&content_id];
    assert_eq!(content.preview, long);
    assert_eq!(content.text_length, long.chars().count());
    assert_eq!(content.updated_at, content.last_used_at);
    let expected_height = super::sizing::text_node_height(&long);
    let nodes = nodes_for(&state, &content_id);
    assert_eq!(nodes.len(), 2);
    for node in &nodes {
        assert_eq!(node.height, expected_height);
        assert_eq!(node.width, 280.0);
    }

    // Removing one placement keeps the content and the other node.
    let first_node = state.canvases[0].nodes[0].id.clone();
    age_content(&mut store, &content_id, "2020-01-01T00:00:00.000Z");
    let state = store.remove_nodes(&[first_node]).unwrap();
    assert_eq!(nodes_for(&state, &content_id).len(), 1);
    assert!(state.contents.contains_key(&content_id));
    assert_ne!(
        state.contents[&content_id].last_used_at,
        "2020-01-01T00:00:00.000Z"
    );
    assert!(temp
        .path()
        .join("content")
        .join(&content_id)
        .join("text.txt")
        .is_file());
}

#[test]
fn delete_canvas_cascade_removes_nodes_and_edges_but_keeps_contents() {
    let temp = tempfile::tempdir().unwrap();
    let mut store = storage(&temp, no_bin(), None);
    let root = store.load_state().unwrap().active_canvas_id;
    let child = store.create_canvas(Some(root.clone()), None).unwrap().active_canvas_id;
    let first = import_one(&mut store, &child, "child-a.png");
    let second = import_one(&mut store, &child, "child-b.png");
    let outside = import_one(&mut store, &root, "root-a.png");
    let state = store.load_state().unwrap();
    let first_node = node_for(&state, &first).id.clone();
    let second_node = node_for(&state, &second).id.clone();
    store.create_edge(&first_node, &second_node).unwrap();
    age_content(&mut store, &first, "2020-01-01T00:00:00.000Z");
    let first_file = safe_join(
        temp.path(),
        &store.state_ref().contents[&first]
            .image
            .as_ref()
            .unwrap()
            .relative_path,
    )
    .unwrap();
    assert!(first_file.is_file());

    let state = store.delete_canvas(&child).unwrap();

    assert!(state.canvases.iter().all(|canvas| canvas.id != child));
    assert_eq!(state.edges.len(), 0);
    assert!(nodes_for(&state, &first).is_empty());
    assert!(nodes_for(&state, &second).is_empty());
    assert_eq!(nodes_for(&state, &outside).len(), 1);
    assert!(state.contents.contains_key(&first));
    assert!(state.contents.contains_key(&second));
    assert_ne!(
        state.contents[&first].last_used_at,
        "2020-01-01T00:00:00.000Z"
    );
    assert!(first_file.is_file());
    assert_eq!(state.active_canvas_id, root);
}

#[test]
fn delete_contents_removes_every_placement_edge_and_file() {
    let temp = tempfile::tempdir().unwrap();
    let calls = no_bin();
    let mut store = storage(&temp, calls.clone(), None);
    let root = store.load_state().unwrap().active_canvas_id;
    let doomed = import_one(&mut store, &root, "doomed.png");
    let survivor = import_one(&mut store, &root, "survivor.png");
    let second = store.create_canvas(None, None).unwrap().active_canvas_id;
    store
        .place_content(&doomed, &second, CanvasPoint { x: 0.0, y: 0.0 })
        .unwrap();
    let state = store.load_state().unwrap();
    let doomed_node = node_for(&state, &doomed).id.clone();
    let survivor_node = node_for(&state, &survivor).id.clone();
    store.create_edge(&doomed_node, &survivor_node).unwrap();

    let state = store.delete_contents(&[doomed.clone()]).unwrap();

    assert!(!state.contents.contains_key(&doomed));
    assert!(state.contents.contains_key(&survivor));
    assert!(nodes_for(&state, &doomed).is_empty());
    assert_eq!(nodes_for(&state, &survivor).len(), 1);
    assert!(state.edges.is_empty());
    assert_eq!(calls.lock().unwrap().len(), 1);
    assert!(!temp.path().join(JOURNAL_FILE).exists());
}

#[test]
fn delete_contents_removes_text_bodies_and_keeps_the_rest() {
    let temp = tempfile::tempdir().unwrap();
    let mut store = storage(&temp, no_bin(), None);
    let root = store.load_state().unwrap().active_canvas_id;
    let id = ingest_rich_at(
        &mut store,
        &root,
        "body",
        "<p>body</p>",
    );
    let text_path = temp.path().join("content").join(&id).join("text.txt");
    let html_path = temp.path().join("content").join(&id).join("content.html");
    assert!(text_path.is_file());
    assert!(html_path.is_file());

    store.delete_contents(&[id.clone()]).unwrap();

    assert!(!text_path.exists());
    assert!(!html_path.exists());
    assert!(!temp.path().join("content").join(&id).exists());
}

#[test]
fn edges_validate_and_survive_grouping_moves() {
    let temp = tempfile::tempdir().unwrap();
    let mut store = storage(&temp, no_bin(), None);
    let root = store.load_state().unwrap().active_canvas_id;
    let first = import_one(&mut store, &root, "edge-a.png");
    let second = import_one(&mut store, &root, "edge-b.png");
    let state = store.load_state().unwrap();
    let first_node = node_for(&state, &first).id.clone();
    let second_node = node_for(&state, &second).id.clone();

    assert_eq!(
        store.create_edge(&first_node, &first_node).unwrap_err().0,
        "不能连接到节点自身"
    );
    assert_eq!(
        store
            .create_edge(&first_node, "missing-node")
            .unwrap_err()
            .0,
        "找不到指定节点"
    );
    let state = store.create_edge(&first_node, &second_node).unwrap();
    assert_eq!(state.edges.len(), 1);
    let edge_id = state.edges[0].id.clone();
    assert_eq!(
        store
            .create_edge(&first_node, &second_node)
            .unwrap_err()
            .0,
        "该连接已存在"
    );

    let state = store
        .group_nodes_into_canvas(&[first_node.clone(), second_node.clone()])
        .unwrap();
    let group = state
        .canvases
        .iter()
        .find(|canvas| canvas.parent_id.as_deref() == Some(root.as_str()))
        .unwrap()
        .clone();
    assert_eq!(
        group.nodes.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(),
        vec![first_node.as_str(), second_node.as_str()]
    );
    assert_eq!(state.edges[0].id, edge_id);

    let state = store.ungroup_canvas(&group.id).unwrap();
    assert!(state.canvases.iter().all(|canvas| canvas.id != group.id));
    assert_eq!(state.edges[0].id, edge_id);
    assert_eq!(nodes_for(&state, &first).len(), 1);

    let other = store.create_canvas(None, None).unwrap().active_canvas_id;
    let state = store
        .move_nodes_to_canvas(&[first_node.clone()], &other, CanvasPoint { x: 0.0, y: 0.0 })
        .unwrap();
    assert_eq!(state.edges[0].id, edge_id);
    assert_eq!(
        state
            .canvases
            .iter()
            .find(|canvas| canvas.id == other)
            .unwrap()
            .nodes[0]
            .id,
        first_node
    );
    assert_eq!(
        store
            .group_nodes_into_canvas(&[first_node.clone(), second_node.clone()])
            .unwrap_err()
            .0,
        "所选节点不在同一画布"
    );

    let state = store.remove_nodes(&[second_node]).unwrap();
    assert!(state.edges.is_empty());
    assert_eq!(nodes_for(&state, &second).len(), 0);
    assert!(state.contents.contains_key(&second));
}

#[test]
fn deleting_edges_is_tolerant_of_unknown_ids() {
    let temp = tempfile::tempdir().unwrap();
    let mut store = storage(&temp, no_bin(), None);
    let root = store.load_state().unwrap().active_canvas_id;
    let first = import_one(&mut store, &root, "a.png");
    let second = import_one(&mut store, &root, "b.png");
    let state = store.load_state().unwrap();
    let edge = store
        .create_edge(
            &node_for(&state, &first).id,
            &node_for(&state, &second).id,
        )
        .unwrap()
        .edges[0]
        .id
        .clone();
    let state = store.delete_edges(&[edge, "unknown".into()]).unwrap();
    assert!(state.edges.is_empty());
    let state = store.delete_edges(&["unknown".into()]).unwrap();
    assert!(state.edges.is_empty());
}

#[test]
fn capture_dedupe_reuses_only_the_newest_identical_content() {
    let temp = tempfile::tempdir().unwrap();
    let mut store = storage(&temp, no_bin(), None);
    let root = store.load_state().unwrap().active_canvas_id;
    let bytes = b"identical-image-bytes".to_vec();

    let first = ingest_named(&mut store, "one.png", &bytes);
    store
        .place_content(&first, &root, CanvasPoint { x: 40.0, y: 40.0 })
        .unwrap();
    age_content(&mut store, &first, "2020-01-01T00:00:00.000Z");

    // Identical bytes while it is the newest content: reused, not duplicated.
    let again = ingest_named(&mut store, "two.png", &bytes);
    assert_eq!(again, first);
    store
        .place_content(&again, &root, CanvasPoint { x: 40.0, y: 40.0 })
        .unwrap();
    let state = store.load_state().unwrap();
    assert_eq!(state.contents.len(), 1);
    assert_eq!(nodes_for(&state, &first).len(), 2);
    assert_eq!(state.contents[&first].preview, "one.png");
    assert_ne!(
        state.contents[&first].last_used_at,
        "2020-01-01T00:00:00.000Z"
    );

    // A different capture in between makes the older one non-current.
    let other = ingest_named(&mut store, "other.png", b"other-bytes");
    store
        .place_content(&other, &root, CanvasPoint { x: 40.0, y: 40.0 })
        .unwrap();
    let third = ingest_named(&mut store, "three.png", &bytes);
    assert_ne!(third, first);
    let state = store.load_state().unwrap();
    assert_eq!(state.contents.len(), 3);
}

#[test]
fn capture_dedupe_applies_to_text_captures() {
    let temp = tempfile::tempdir().unwrap();
    let mut store = storage(&temp, no_bin(), None);
    let captured = CapturedContent::Text {
        text: "same text".into(),
    };
    let first = store.ingest_capture(&captured).unwrap();
    let id = first.contents.values().next().unwrap().id.clone();
    assert!(nodes_for(&first, &id).is_empty());
    age_content(&mut store, &id, "2020-01-01T00:00:00.000Z");

    let second = store.ingest_capture(&captured).unwrap();
    assert_eq!(second.contents.len(), 1);
    assert_ne!(
        second.contents[&id].last_used_at,
        "2020-01-01T00:00:00.000Z"
    );
}

#[test]
fn self_marker_paste_places_existing_contents_without_importing() {
    let temp = tempfile::tempdir().unwrap();
    let mut store = storage(&temp, no_bin(), None);
    let root = store.load_state().unwrap().active_canvas_id;
    let first = import_one(&mut store, &root, "marker-a.png");
    let second = import_one(&mut store, &root, "marker-b.png");
    let before = store.load_state().unwrap().contents.len();

    let capture = ClipboardCapture {
        self_marker: Some(vec![first.clone(), second.clone(), "deleted-id".into()]),
        text: Some("ignored payload".into()),
        ..ClipboardCapture::default()
    };
    let (state, placed) = store
        .paste_clipboard(&root, viewport(), capture)
        .unwrap();

    assert!(placed);
    assert_eq!(state.contents.len(), before);
    assert_eq!(nodes_for(&state, &first).len(), 2);
    assert_eq!(nodes_for(&state, &second).len(), 2);

    let capture = ClipboardCapture {
        self_marker: Some(vec!["deleted-id".into()]),
        ..ClipboardCapture::default()
    };
    let (state, placed) = store
        .paste_clipboard(&root, viewport(), capture)
        .unwrap();
    assert!(!placed);
    assert_eq!(state.contents.len(), before);
}

#[test]
fn paste_imports_supported_capture_and_ignores_unsupported_ones() {
    let temp = tempfile::tempdir().unwrap();
    let mut store = storage(&temp, no_bin(), None);
    store.set_layout_settings(false, 24);
    let root = store.load_state().unwrap().active_canvas_id;

    let capture = ClipboardCapture {
        text: Some("https://example.com/x".into()),
        ..ClipboardCapture::default()
    };
    let (state, placed) = store
        .paste_clipboard(&root, viewport(), capture)
        .unwrap();
    assert!(placed);
    let link = state
        .contents
        .values()
        .find(|content| content.kind == ContentKind::Link)
        .unwrap();
    assert_eq!(link.source, ContentSource::Paste);
    let node = node_for(&state, &link.id);
    assert_eq!((node.x, node.y), (500.0, 356.0));

    let (state, placed) = store
        .paste_clipboard(&root, viewport(), ClipboardCapture::default())
        .unwrap();
    assert!(!placed);
    assert_eq!(state.contents.len(), 1);
}

#[test]
fn retention_keeps_placed_classified_and_recent_history() {
    let temp = tempfile::tempdir().unwrap();
    let mut store = storage(&temp, no_bin(), None);
    let root = store.load_state().unwrap().active_canvas_id;
    let placed = import_one(&mut store, &root, "placed.png");
    let classified = import_one(&mut store, &root, "classified.png");
    let recent = import_one(&mut store, &root, "recent.png");
    let old = import_one(&mut store, &root, "old.png");
    let category = store.state_ref().categories[0].id.clone();
    store
        .classify_contents(&[classified.clone()], Some(&category))
        .unwrap();
    let state = store.load_state().unwrap();
    let unplace: Vec<String> = [&classified, &recent, &old]
        .iter()
        .flat_map(|id| nodes_for(&state, id).into_iter().map(|node| node.id.clone()))
        .collect();
    store.remove_nodes(&unplace).unwrap();

    age_content(&mut store, &placed, "2020-01-01T00:00:00.000Z");
    age_content(&mut store, &classified, "2020-01-01T00:00:00.000Z");
    age_content(&mut store, &old, "2020-01-01T00:00:00.000Z");
    let old_file = safe_join(
        temp.path(),
        &store.state_ref().contents[&old]
            .image
            .as_ref()
            .unwrap()
            .relative_path,
    )
    .unwrap();
    assert!(old_file.is_file());

    let (state, removed) = store.cleanup_history(Utc::now(), 0).unwrap();
    assert_eq!(removed, 0);
    assert_eq!(state.contents.len(), 4);

    let (state, removed) = store.cleanup_history(Utc::now(), 30).unwrap();
    assert_eq!(removed, 1);
    assert!(!state.contents.contains_key(&old));
    assert!(!old_file.exists());
    assert!(state.contents.contains_key(&placed));
    assert!(state.contents.contains_key(&classified));
    assert!(state.contents.contains_key(&recent));
    assert_eq!(
        fs::read_dir(temp.path().join("content")).unwrap().count(),
        3
    );
}

#[test]
fn retention_also_expires_old_text_bodies() {
    let temp = tempfile::tempdir().unwrap();
    let mut store = storage(&temp, no_bin(), None);
    let root = store.load_state().unwrap().active_canvas_id;
    let id = ingest_rich_at(&mut store, &root, "old thought", "<p>old thought</p>");
    let node = node_for(&store.load_state().unwrap(), &id).id.clone();
    store.remove_nodes(&[node]).unwrap();
    age_content(&mut store, &id, "2019-05-05T00:00:00.000Z");
    let text_path = temp.path().join("content").join(&id).join("text.txt");
    assert!(text_path.is_file());

    let (state, removed) = store.cleanup_history(Utc::now(), 7).unwrap();

    assert_eq!(removed, 1);
    assert!(!state.contents.contains_key(&id));
    assert!(!text_path.exists());
    assert!(!temp.path().join("content").join(&id).exists());
}

#[test]
fn classify_contents_only_sets_the_field_and_null_clears_it() {
    let temp = tempfile::tempdir().unwrap();
    let mut store = storage(&temp, no_bin(), None);
    let root = store.load_state().unwrap().active_canvas_id;
    let id = import_one(&mut store, &root, "keep-file.png");
    let before = store.state_ref().contents[&id].clone();
    let file_before = safe_join(temp.path(), &before.image.as_ref().unwrap().relative_path).unwrap();
    let category = store.state_ref().categories[0].id.clone();

    let state = store
        .classify_contents(&[id.clone()], Some(&category))
        .unwrap();
    assert_eq!(state.contents[&id].category_id.as_deref(), Some(category.as_str()));
    assert_eq!(
        state.contents[&id].image.as_ref().unwrap().relative_path,
        before.image.as_ref().unwrap().relative_path
    );
    assert!(file_before.is_file());
    assert!(!temp.path().join("classified").exists());
    assert!(!temp.path().join(JOURNAL_FILE).exists());

    let state = store.classify_contents(&[id.clone()], None).unwrap();
    assert_eq!(state.contents[&id].category_id, None);

    assert_eq!(
        store
            .classify_contents(&[id], Some("missing"))
            .unwrap_err()
            .0,
        "找不到指定分类"
    );
}

#[test]
fn text_body_round_trip_switches_kinds_and_rejects_oversized_edits() {
    let temp = tempfile::tempdir().unwrap();
    let mut store = storage(&temp, no_bin(), None);
    let root = store.load_state().unwrap().active_canvas_id;
    let id = ingest_rich_at(&mut store, &root, "plain", "<p>plain</p>");
    assert_eq!(
        store.get_content_body(&id).unwrap(),
        ContentBody {
            text: "plain".into(),
            html: Some("<p>plain</p>".into())
        }
    );

    let state = store
        .update_text_content(
            &id,
            ContentBody {
                text: "rich".into(),
                html: Some("<p>rich</p>".into()),
            },
        )
        .unwrap();
    assert_eq!(state.contents[&id].kind, ContentKind::RichText);
    let html_path = temp.path().join("content").join(&id).join("content.html");
    assert_eq!(fs::read_to_string(&html_path).unwrap(), "<p>rich</p>");

    let state = store
        .update_text_content(
            &id,
            ContentBody {
                text: "back to plain".into(),
                html: None,
            },
        )
        .unwrap();
    assert_eq!(state.contents[&id].kind, ContentKind::Text);
    assert!(!html_path.exists());
    assert_eq!(
        store.get_content_body(&id).unwrap(),
        ContentBody {
            text: "back to plain".into(),
            html: None
        }
    );

    let oversized = "x".repeat(4 * 1024 * 1024 + 1);
    assert_eq!(
        store
            .update_text_content(
                &id,
                ContentBody {
                    text: oversized,
                    html: None
                }
            )
            .unwrap_err()
            .0,
        "内容过大"
    );

    let image = import_one(&mut store, &root, "not-text.png");
    assert_eq!(
        store
            .update_text_content(
                &image,
                ContentBody {
                    text: "x".into(),
                    html: None
                }
            )
            .unwrap_err()
            .0,
        "只有文本内容可以编辑"
    );
    assert_eq!(
        store.get_content_body(&image).unwrap_err().0,
        "图片内容没有文本正文"
    );
}

#[test]
fn update_link_content_validates_and_updates_preview() {
    let temp = tempfile::tempdir().unwrap();
    let mut store = storage(&temp, no_bin(), None);
    let root = store.load_state().unwrap().active_canvas_id;
    let id = ingest_link_at(&mut store, &root, "https://example.com/a");

    let state = store
        .update_link_content(&id, "https://example.com/b?q=1")
        .unwrap();
    assert_eq!(
        state.contents[&id].url.as_deref(),
        Some("https://example.com/b?q=1")
    );
    assert_eq!(state.contents[&id].preview, "https://example.com/b?q=1");
    assert_eq!(
        store
            .update_link_content(&id, "javascript:alert(1)")
            .unwrap_err()
            .0,
        "链接必须是 http 或 https 地址"
    );
    let image = import_one(&mut store, &root, "image-link.png");
    assert_eq!(
        store
            .update_link_content(&image, "https://example.com")
            .unwrap_err()
            .0,
        "只有链接内容可以修改链接"
    );
}

#[test]
fn copy_payloads_resolve_under_the_lock_and_bump_recency_after() {
    let temp = tempfile::tempdir().unwrap();
    let mut store = storage(&temp, no_bin(), None);
    let root = store.load_state().unwrap().active_canvas_id;
    let image = import_one(&mut store, &root, "copy.png");
    let rich = ingest_rich_at(&mut store, &root, "copied words", "<p>copied words</p>");

    let items = store.copy_payloads(&[image.clone(), rich.clone()]).unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0].kind, ContentKind::Image);
    assert!(items[0].image_path.as_ref().unwrap().is_file());
    assert_eq!(items[1].text, "copied words");
    assert_eq!(items[1].html.as_deref(), Some("<p>copied words</p>"));

    age_content(&mut store, &rich, "2020-01-01T00:00:00.000Z");
    let state = store.touch_contents(&[rich.clone()]).unwrap();
    assert_ne!(state.contents[&rich].last_used_at, "2020-01-01T00:00:00.000Z");
    assert_eq!(
        store.copy_payloads(&["missing".into()]).unwrap_err().0,
        "找不到指定内容"
    );
}

#[test]
fn resolve_image_rejects_non_image_contents_and_missing_ids() {
    let temp = tempfile::tempdir().unwrap();
    let mut store = storage(&temp, no_bin(), None);
    let root = store.load_state().unwrap().active_canvas_id;
    let image = import_one(&mut store, &root, "resolved.png");
    let resolved = store.resolve_image(&image).unwrap();
    assert!(resolved.path.is_file());
    assert_eq!(resolved.mime, "image/png");
    assert!(!resolved.gif);

    let text = ingest_rich_at(&mut store, &root, "text", "<p>text</p>");
    assert_eq!(store.resolve_image(&text).unwrap_err().0, "该内容不是图片");
    assert_eq!(
        store.resolve_image("missing").unwrap_err().0,
        "找不到指定内容"
    );
}

#[test]
fn journal_recovery_removes_recycled_contents_on_load() {
    let temp = tempfile::tempdir().unwrap();
    let mut store = storage(&temp, no_bin(), None);
    let root = store.load_state().unwrap().active_canvas_id;
    let id = import_one(&mut store, &root, "journal.png");
    let state = store.load_state().unwrap();
    let path = safe_join(
        temp.path(),
        &state.contents[&id].image.as_ref().unwrap().relative_path,
    )
    .unwrap();
    fs::remove_file(&path).unwrap();
    store
        .write_journal(&DeleteJournal {
            version: JOURNAL_VERSION,
            operation: "delete_contents".into(),
            phase: "recycled".into(),
            entries: vec![DeleteJournalEntry {
                id: id.clone(),
                source: path.to_string_lossy().into_owned(),
                status: "recycled".into(),
            }],
        })
        .unwrap();

    let mut recovered = storage(&temp, no_bin(), None);
    let state = recovered.load_state().unwrap();

    assert!(!state.contents.contains_key(&id));
    assert!(nodes_for(&state, &id).is_empty());
    assert!(!temp.path().join(JOURNAL_FILE).exists());
}

#[test]
fn v2_state_repairs_hierarchy_duplicates_and_dangling_references() {
    let temp = tempfile::tempdir().unwrap();
    let content = |id: &str| {
        format!(
            r#""{id}": {{
                "id": "{id}", "kind": "image", "preview": "{id}.png", "textLength": 0,
                "url": null, "categoryId": null, "source": "clipboard",
                "image": {{ "fileName": "{id}.png", "relativePath": "content/{id}/{id}.png", "width": 100, "height": 80, "byteSize": 12 }},
                "createdAt": "2020-01-01T00:00:00.000Z",
                "updatedAt": "2020-01-01T00:00:00.000Z",
                "lastUsedAt": "2020-01-01T00:00:00.000Z"
            }}"#
        )
    };
    let canvas = |id: &str, parent: &str, nodes: &str, frame: &str| {
        format!(
            r#"{{ "id": "{id}", "name": "{id}", "parentId": {parent}, "frame": {frame},
                 "nodes": {nodes}, "createdAt": "2020-01-01T00:00:00.000Z",
                 "viewport": {{"x": 0, "y": 0, "zoom": 1}} }}"#
        )
    };
    let node = |id: &str, content: &str| {
        format!(r#"{{ "id": "{id}", "contentId": "{content}", "x": 1, "y": 2, "width": 100, "height": 50 }}"#)
    };
    let state = format!(
        r#"{{
            "version": 2,
            "revision": 7,
            "activeCanvasId": "a",
            "canvases": [
                {a},
                {b},
                {c},
                {dup},
                {child}
            ],
            "categories": [],
            "contents": {{ {c1}, {c2} }},
            "edges": [
                {{ "id": "e-ok", "fromNode": "n1", "toNode": "n3", "createdAt": "2020-01-01T00:00:00.000Z" }},
                {{ "id": "e-dup", "fromNode": "n1", "toNode": "n3", "createdAt": "2020-01-01T00:00:00.000Z" }},
                {{ "id": "e-self", "fromNode": "n1", "toNode": "n1", "createdAt": "2020-01-01T00:00:00.000Z" }},
                {{ "id": "e-gone", "fromNode": "n1", "toNode": "gone", "createdAt": "2020-01-01T00:00:00.000Z" }}
            ]
        }}"#,
        a = canvas(
            "a",
            r#""missing""#,
            &format!(
                "[{}, {}]",
                node("n1", "c1"),
                node("n2", "missing-content")
            ),
            r#"{"x": 10, "y": 10, "width": 200, "height": 100}"#
        ),
        b = canvas("b", r#""c""#, &format!("[{}]", node("n3", "c2")), "null"),
        c = canvas("c", r#""b""#, "[]", "null"),
        dup = canvas("a", "null", "[]", "null"),
        child = canvas("child", r#""a""#, &format!("[{}]", node("n1", "c1")), "null"),
        c1 = content("c1"),
        c2 = content("c2"),
    );
    let state = state.replace("\"categoryId\": null", "\"categoryId\": \"gone-category\"");
    fs::write(temp.path().join("state.json"), state).unwrap();

    let mut store = storage(&temp, no_bin(), None);
    let state = store.load_state().unwrap();

    assert_eq!(
        state.canvases.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
        vec!["a", "b", "c", "child"]
    );
    let by_id = |id: &str| state.canvases.iter().find(|c| c.id == id).unwrap();
    assert_eq!(by_id("a").parent_id, None);
    assert_eq!(by_id("a").frame, None);
    assert_eq!(by_id("b").parent_id, None);
    assert_eq!(by_id("c").parent_id, None);
    assert_eq!(by_id("child").parent_id.as_deref(), Some("a"));
    let frame = by_id("child").frame.unwrap();
    assert_eq!((frame.x, frame.y, frame.width, frame.height), (120.0, 120.0, 280.0, 180.0));
    assert_eq!(
        by_id("a").nodes.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(),
        vec!["n1"]
    );
    assert!(by_id("child").nodes.is_empty());
    assert_eq!(by_id("b").nodes.len(), 1);
    assert_eq!(
        state.edges.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
        vec!["e-ok"]
    );
    assert_eq!(state.contents.len(), 2);
    assert!(state.contents.values().all(|content| content.category_id.is_none()));
    // The persisted revision survives a load untouched.
    assert_eq!(state.revision, 7);
    // The next write bumps it.
    store.set_active_canvas("b").unwrap();
    let bumped = store.load_state().unwrap();
    assert_eq!(bumped.revision, 8);
}

#[test]
fn revision_is_monotonic_across_writes() {
    let temp = tempfile::tempdir().unwrap();
    let mut store = storage(&temp, no_bin(), None);
    let root = store.load_state().unwrap().active_canvas_id;
    let start = store.load_state().unwrap().revision;
    let a = ingest_rich_at(&mut store, &root, "a", "<p>a</p>");
    let after_a = store.load_state().unwrap().revision;
    assert!(after_a > start);
    store
        .place_content(&a, &root, CanvasPoint { x: 40.0, y: 40.0 })
        .unwrap();
    let after_place = store.load_state().unwrap().revision;
    assert_eq!(after_place, after_a + 1);
    // The persisted file carries the same revision.
    let persisted: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(temp.path().join("state.json")).unwrap()).unwrap();
    assert_eq!(persisted["revision"], after_place);
}
