//! Cross-platform clipboard façade.
//!
//! The Windows implementation is native (no Electron, no PowerShell helper):
//! one `OpenClipboard`/`CloseClipboard` session reads every format the capture
//! logic needs, and one ownership window publishes every format a copy-out
//! needs. Non-Windows targets refuse instead of pretending success (the product
//! targets Windows).
//!
//! `Capture` types are plain data so classification and CF_HTML handling stay
//! unit-testable without touching the real system clipboard.

pub mod classify;
pub mod html;
pub mod monitor;

#[cfg(windows)]
mod windows;

pub use classify::{capture_decision, classify_capture, is_excluded, validate_url};
pub use monitor::ClipboardMonitor;

use crate::dto::ContentKind;
use crate::error::AppError;
use std::path::{Path, PathBuf};

/// One-session read of everything the host can capture.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ClipboardCapture {
    /// A Windows opt-out marker is present: never record this capture.
    pub excluded: bool,
    /// PicBoard's own marker: content ids this application published.
    pub self_marker: Option<Vec<String>>,
    /// CF_UNICODETEXT.
    pub text: Option<String>,
    /// CF_UNICODETEXT was present but exceeded the 4 MiB cap.
    pub text_too_large: bool,
    /// The `HTML Format` fragment (already offset-sliced).
    pub html: Option<String>,
    /// PNG bytes decoded from PNG/DIBV5/DIB/BITMAP.
    pub image: Option<Vec<u8>>,
    /// A bitmap format was present but could not be decoded.
    pub image_error: Option<String>,
}

/// The single content a capture represents.
#[derive(Debug, Clone, PartialEq)]
pub enum CapturedContent {
    Link { url: String },
    RichText { text: String, html: String },
    Image { png: Vec<u8> },
    Text { text: String },
}

/// Bound on one text/HTML field read from the clipboard (UTF-8 bytes).
pub const MAX_CAPTURE_BYTES: usize = 4 * 1024 * 1024;

/// One item handed to the clipboard writer.
pub struct CopyContent<'a> {
    pub id: &'a str,
    pub kind: ContentKind,
    pub text: &'a str,
    pub html: Option<&'a str>,
    pub image_path: Option<&'a Path>,
}

/// Native formats to publish in one clipboard ownership window.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ClipboardWrite {
    pub text: Option<String>,
    /// CF_HTML *fragment*; the Windows layer adds the `Version:0.9` header.
    pub html: Option<String>,
    pub files: Vec<PathBuf>,
    /// Source path for a single-image CF_BITMAP.
    pub bitmap: Option<PathBuf>,
    /// Content ids for the PicBoard self marker.
    pub marker: Vec<String>,
}

/// Compose the native payload for a copy-out. Pure, so the join/escape rules
/// are unit-testable.
pub fn compose_write(items: &[CopyContent<'_>]) -> ClipboardWrite {
    let marker: Vec<String> = items.iter().map(|item| item.id.to_owned()).collect();
    let images: Vec<PathBuf> = items
        .iter()
        .filter(|item| item.kind == ContentKind::Image)
        .filter_map(|item| item.image_path.map(Path::to_path_buf))
        .collect();
    let all_images = !items.is_empty() && images.len() == items.len();
    if all_images {
        return ClipboardWrite {
            text: None,
            html: None,
            bitmap: if images.len() == 1 {
                images.first().cloned()
            } else {
                None
            },
            files: images,
            marker,
        };
    }

    let texts: Vec<&str> = items
        .iter()
        .filter(|item| item.kind != ContentKind::Image)
        .map(|item| item.text)
        .collect();
    let text = if texts.is_empty() {
        None
    } else {
        Some(texts.join("\n\n"))
    };
    let has_rich = items.iter().any(|item| item.kind == ContentKind::RichText);
    let html = if has_rich {
        let mut fragment = String::new();
        for item in items {
            match item.kind {
                ContentKind::RichText => match item.html {
                    Some(markup) => fragment.push_str(markup),
                    None => fragment.push_str(&html::text_paragraph(item.text)),
                },
                ContentKind::Text => fragment.push_str(&html::text_paragraph(item.text)),
                ContentKind::Link => {
                    let url = html::escape_attribute(item.text);
                    fragment.push_str(&format!(
                        "<p><a href=\"{url}\">{}</a></p>",
                        html::escape_text(item.text)
                    ));
                }
                ContentKind::Image => {}
            }
        }
        Some(fragment)
    } else {
        None
    };
    ClipboardWrite {
        text,
        html,
        files: images,
        bitmap: None,
        marker,
    }
}

/// Read every supported format from the clipboard in one session.
#[cfg(windows)]
pub fn read_capture() -> Result<ClipboardCapture, AppError> {
    windows::read_capture()
}

#[cfg(not(windows))]
pub fn read_capture() -> Result<ClipboardCapture, AppError> {
    Err(AppError::message("当前平台不支持系统剪贴板读取"))
}

/// Publish `payload` in one clipboard ownership window.
#[cfg(windows)]
pub fn write_contents(payload: &ClipboardWrite) -> Result<(), AppError> {
    windows::write_contents(payload)
}

#[cfg(not(windows))]
pub fn write_contents(_payload: &ClipboardWrite) -> Result<(), AppError> {
    Err(AppError::message("当前平台不支持系统剪贴板写入"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item<'a>(
        id: &'a str,
        kind: ContentKind,
        text: &'a str,
        html: Option<&'a str>,
        image: Option<&'a Path>,
    ) -> CopyContent<'a> {
        CopyContent {
            id,
            kind,
            text,
            html,
            image_path: image,
        }
    }

    #[test]
    fn plain_texts_join_with_a_blank_line_and_never_emit_html() {
        let payload = compose_write(&[
            item("a", ContentKind::Text, "first", None, None),
            item("b", ContentKind::Link, "https://example.com", None, None),
        ]);
        assert_eq!(payload.text.as_deref(), Some("first\n\nhttps://example.com"));
        assert_eq!(payload.html, None);
        assert_eq!(payload.marker, vec!["a".to_owned(), "b".to_owned()]);
        assert!(payload.files.is_empty());
        assert_eq!(payload.bitmap, None);
    }

    #[test]
    fn rich_text_selection_builds_one_html_fragment_in_order() {
        let payload = compose_write(&[
            item("a", ContentKind::RichText, "Hi", Some("<p>Hi</p>"), None),
            item("b", ContentKind::Text, "a<b", None, None),
            item("c", ContentKind::Link, "https://x.test/?a=1&b=2", None, None),
        ]);
        assert_eq!(payload.text.as_deref(), Some("Hi\n\na<b\n\nhttps://x.test/?a=1&b=2"));
        assert_eq!(
            payload.html.as_deref(),
            Some(
                "<p>Hi</p><p>a&lt;b</p><p><a href=\"https://x.test/?a=1&amp;b=2\">https://x.test/?a=1&amp;b=2</a></p>"
            )
        );
    }

    #[test]
    fn image_only_selection_publishes_files_and_a_single_bitmap() {
        let one = compose_write(&[item(
            "a",
            ContentKind::Image,
            "",
            None,
            Some(Path::new("C:/data/content/a/a.png")),
        )]);
        assert_eq!(one.files.len(), 1);
        assert!(one.bitmap.is_some());
        assert_eq!(one.text, None);
        assert_eq!(one.html, None);
        assert_eq!(one.marker, vec!["a".to_owned()]);

        let many = compose_write(&[
            item("a", ContentKind::Image, "", None, Some(Path::new("C:/x/a.png"))),
            item("b", ContentKind::Image, "", None, Some(Path::new("C:/x/b.png"))),
        ]);
        assert_eq!(many.files.len(), 2);
        assert_eq!(many.bitmap, None);
    }

    #[test]
    fn mixed_selection_keeps_images_as_files_and_text_as_text() {
        let payload = compose_write(&[
            item("img", ContentKind::Image, "", None, Some(Path::new("C:/x/a.png"))),
            item("txt", ContentKind::Text, "hello", None, None),
        ]);
        assert_eq!(payload.files.len(), 1);
        assert_eq!(payload.text.as_deref(), Some("hello"));
        assert_eq!(payload.html, None);
        assert_eq!(payload.bitmap, None);
        assert_eq!(payload.marker.len(), 2);
    }

    #[test]
    fn empty_selection_produces_an_empty_payload() {
        let payload = compose_write(&[]);
        assert_eq!(payload, ClipboardWrite::default());
    }
}
