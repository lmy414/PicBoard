//! Wire types shared with `shared/image-board.ts`.
//!
//! Every struct is `camelCase` on the wire. `Option` fields that the contract
//! declares as `| null` serialize as `null` (never skipped); only the optional
//! `storageNotice` is omitted when absent. The persisted `state.json` uses the
//! same shape with `version: 2` and one extra internal field per content
//! (`hash`, used by capture de-duplication).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Persisted schema version of `state.json`.
pub const STATE_VERSION: u32 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ContentKind {
    Text,
    RichText,
    Link,
    Image,
}

impl ContentKind {
    /// Stable token used by the capture hash. Never change these: a hash is
    /// persisted with every content and must stay comparable across releases.
    pub fn token(self) -> &'static str {
        match self {
            ContentKind::Text => "text",
            ContentKind::RichText => "richText",
            ContentKind::Link => "link",
            ContentKind::Image => "image",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ContentSource {
    Clipboard,
    Paste,
    Drop,
    Migrated,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInfo {
    /// Display name of the image file (`preview` mirrors it).
    pub file_name: String,
    /// Data-root-relative path. Host-internal: never rendered as a URL.
    pub relative_path: String,
    /// Intrinsic pixel size; `0` means "unknown".
    pub width: u32,
    pub height: u32,
    pub byte_size: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentRecord {
    pub id: String,
    pub kind: ContentKind,
    /// text/richText: leading plain text (≤ 500 chars, newlines kept);
    /// link: the URL; image: the file name.
    pub preview: String,
    /// Full plain-text length in chars for text/richText; 0 otherwise.
    pub text_length: usize,
    pub url: Option<String>,
    pub image: Option<ImageInfo>,
    pub category_id: Option<String>,
    pub source: ContentSource,
    pub created_at: String,
    pub updated_at: String,
    /// Recency + retention clock. Bumped by capture, identical re-capture,
    /// paste, placement, removal from a canvas, copy-out and edits.
    pub last_used_at: String,
    /// Internal: FNV-1a 64 (hex) over kind + payload. Persisted so capture
    /// de-duplication survives restarts; harmless in snapshots.
    #[serde(default)]
    pub hash: String,
    /// richText only: `<contentId>/<assetId>` of the first embedded image, used
    /// as the canvas-card cover. Always `null` for other kinds (serialized as
    /// null, never skipped).
    pub cover_asset: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentBody {
    pub text: String,
    pub html: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasNode {
    pub id: String,
    pub content_id: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Directed edge between canvas nodes. Edges are global; a canvas draws one
/// when both ends resolve on it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeRecord {
    pub id: String,
    pub from_node: String,
    pub to_node: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasFrame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasViewport {
    pub x: f64,
    pub y: f64,
    pub zoom: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasRecord {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub frame: Option<CanvasFrame>,
    /// Bottom-to-top z-order.
    pub nodes: Vec<CanvasNode>,
    pub created_at: String,
    pub viewport: CanvasViewport,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryRecord {
    pub id: String,
    pub name: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    /// Persisted schema version; harmless extra field for the renderer.
    pub version: u32,
    /// Monotonic change counter, persisted and incremented by every successful
    /// state write. Renderers drop snapshots older than the one they hold.
    pub revision: u64,
    pub active_canvas_id: String,
    pub canvases: Vec<CanvasRecord>,
    pub categories: Vec<CategoryRecord>,
    pub contents: BTreeMap<String, ContentRecord>,
    pub edges: Vec<EdgeRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub storage_notice: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportImagePayload {
    /// Unused by the host (the format is sniffed from the bytes); kept so the
    /// renderer can keep sending its File objects unchanged.
    #[serde(default)]
    #[allow(dead_code)]
    pub name: String,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportViewport {
    pub x: f64,
    pub y: f64,
    pub zoom: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasPoint {
    pub x: f64,
    pub y: f64,
}

/// Destination for `showMainWindow` navigation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MainView {
    Canvas,
    Library,
    Settings,
}

/// Optional navigation payload emitted as `main:navigate` after the main
/// window is shown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MainNavigation {
    pub view: Option<MainView>,
    pub content_id: Option<String>,
}

/// One node's proposed position in a move gesture.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeMove {
    pub node_id: String,
    pub x: f64,
    pub y: f64,
}

/// An image embedded in a rich-text content.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentAsset {
    pub asset_id: String,
    pub mime: String,
    pub width: u32,
    pub height: u32,
    pub byte_size: u64,
}

/// Result of a paste: the new state plus whether anything was placed.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PasteResult {
    pub state: AppState,
    pub placed: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct CopyResult {
    pub copied: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSettingsDto {
    pub close_behavior: crate::desktop::CloseBehavior,
    pub auto_start: bool,
    pub auto_start_available: bool,
    pub capture_enabled: bool,
    pub history_retention_days: crate::desktop::HistoryRetentionDays,
    pub snap_to_grid: bool,
    pub grid_size: crate::desktop::GridSize,
}

/// One discovered plugin folder.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSource {
    /// Folder name below `<dataRoot>/plugins`.
    pub folder: String,
    /// Raw `manifest.json` value.
    pub manifest: serde_json::Value,
    /// Entry module source (≤ 1 MiB, UTF-8).
    pub code: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginError {
    pub folder: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginListing {
    /// Absolute path of the plugins root.
    pub directory: String,
    pub plugins: Vec<PluginSource>,
    pub errors: Vec<PluginError>,
}
