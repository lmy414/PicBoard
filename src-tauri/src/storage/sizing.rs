//! Node sizing rules shared by every placement path.
//!
//! The renderer draws exactly these sizes, so the host owns the formulas:
//! images scale down to a 320 px box (never up), text nodes wrap at 252 px
//! usable width and grow 20 px per estimated line, links are a fixed card.

use crate::dto::{ContentKind, ContentRecord};

/// Width of a text/rich-text card.
pub const TEXT_WIDTH: f64 = 280.0;
/// Width of a link card.
pub const LINK_WIDTH: f64 = 280.0;
/// Height of a link card.
pub const LINK_HEIGHT: f64 = 88.0;
/// Longest side an image card may occupy before scaling down.
const IMAGE_BOX: f64 = 320.0;
/// Smallest rendered image card edge.
const IMAGE_MIN_EDGE: f64 = 48.0;
/// Size used when the intrinsic image size is unknown.
const UNKNOWN_IMAGE_WIDTH: f64 = 240.0;
const UNKNOWN_IMAGE_HEIGHT: f64 = 180.0;
/// Usable text width available for wrapping a preview line.
const TEXT_USABLE_WIDTH: f64 = 252.0;
const WIDE_CHAR_PX: f64 = 13.0;
const NARROW_CHAR_PX: f64 = 7.0;
const TEXT_BASE_HEIGHT: f64 = 44.0;
const TEXT_LINE_HEIGHT: f64 = 20.0;
const TEXT_MIN_HEIGHT: f64 = 84.0;
const TEXT_MAX_HEIGHT: f64 = 264.0;
/// Text area added above a rich-text card that shows an image cover.
const COVER_HEIGHT: f64 = 128.0;
const COVER_TEXT_MIN_HEIGHT: f64 = 64.0;
const COVER_TEXT_MAX_HEIGHT: f64 = 224.0;
/// Placeholder the renderer writes for embedded images in the plain text.
pub const IMAGE_PLACEHOLDER: &str = "[图片]";
/// Preview lines beyond this no longer grow the card.
const MAX_PREVIEW_LINES: usize = 11;
/// Preview text is clipped to this many chars (newlines kept).
const PREVIEW_CHARS: usize = 500;

/// Leading plain text stored in `ContentRecord::preview`.
pub fn preview_text(text: &str) -> String {
    text.chars().take(PREVIEW_CHARS).collect()
}

/// Full plain-text length in Unicode scalar values.
pub fn text_length(text: &str) -> usize {
    text.chars().count()
}

/// Characters that occupy a full-width glyph cell: CJK ideographs and kana,
/// hangul, full-width forms and emoji.
pub fn is_wide_char(ch: char) -> bool {
    matches!(ch,
        '\u{1100}'..='\u{115F}'      // Hangul Jamo
        | '\u{2E80}'..='\u{303E}'    // CJK radicals, punctuation
        | '\u{3041}'..='\u{33FF}'    // kana, CJK compatibility
        | '\u{3400}'..='\u{4DBF}'    // CJK extension A
        | '\u{4E00}'..='\u{9FFF}'    // CJK unified ideographs
        | '\u{A000}'..='\u{A4CF}'    // Yi
        | '\u{AC00}'..='\u{D7A3}'    // Hangul syllables
        | '\u{F900}'..='\u{FAFF}'    // CJK compatibility ideographs
        | '\u{FE30}'..='\u{FE4F}'    // CJK compatibility forms
        | '\u{FF00}'..='\u{FF60}'    // full-width forms
        | '\u{FFE0}'..='\u{FFE6}'    // full-width signs
        | '\u{1F000}'..='\u{1FAFF}'  // emoji and pictographs
        | '\u{20000}'..='\u{3FFFD}'  // CJK extensions B+
    )
}

fn char_px(ch: char) -> f64 {
    if is_wide_char(ch) {
        WIDE_CHAR_PX
    } else {
        NARROW_CHAR_PX
    }
}

/// Estimated wrapped line count of `preview`, starting from its real newlines.
pub fn estimated_line_count(preview: &str) -> usize {
    let mut total = 0usize;
    for line in preview.split('\n') {
        let px: f64 = line.chars().map(char_px).sum();
        let wrapped = if px <= 0.0 {
            1
        } else {
            (px / TEXT_USABLE_WIDTH).ceil() as usize
        };
        total += wrapped.max(1);
    }
    total.max(1)
}

/// Height of a text/rich-text card for the given preview.
pub fn text_node_height(preview: &str) -> f64 {
    let lines = estimated_line_count(preview).min(MAX_PREVIEW_LINES) as f64;
    (TEXT_BASE_HEIGHT + TEXT_LINE_HEIGHT * lines).clamp(TEXT_MIN_HEIGHT, TEXT_MAX_HEIGHT)
}

/// Height of a rich-text card that shows an image cover: the image band plus a
/// shorter text area, estimated from the preview with the `[图片]` placeholders
/// removed.
pub fn cover_text_height(preview: &str) -> f64 {
    let without_placeholders = preview.replace(IMAGE_PLACEHOLDER, "");
    let lines = estimated_line_count(&without_placeholders).min(MAX_PREVIEW_LINES) as f64;
    COVER_HEIGHT
        + (TEXT_BASE_HEIGHT + TEXT_LINE_HEIGHT * lines)
            .clamp(COVER_TEXT_MIN_HEIGHT, COVER_TEXT_MAX_HEIGHT)
}

/// Height of an image card after scaling the intrinsic size into a 320 px box.
pub fn image_node_size(width: u32, height: u32) -> (f64, f64) {
    if width == 0 || height == 0 {
        return (UNKNOWN_IMAGE_WIDTH, UNKNOWN_IMAGE_HEIGHT);
    }
    let (width, height) = (width as f64, height as f64);
    let scale = (IMAGE_BOX / width.max(height)).min(1.0);
    let scaled_width = (width * scale).round().max(IMAGE_MIN_EDGE);
    let scaled_height = (height * scale).round().max(IMAGE_MIN_EDGE);
    (scaled_width, scaled_height)
}

/// Size of a new node for `content`.
pub fn node_size(content: &ContentRecord) -> (f64, f64) {
    match content.kind {
        ContentKind::Text => (TEXT_WIDTH, text_node_height(&content.preview)),
        ContentKind::RichText => {
            let height = if content.cover_asset.is_some() {
                cover_text_height(&content.preview)
            } else {
                text_node_height(&content.preview)
            };
            (TEXT_WIDTH, height)
        }
        ContentKind::Link => (LINK_WIDTH, LINK_HEIGHT),
        ContentKind::Image => {
            let (width, height) = content
                .image
                .as_ref()
                .map(|image| (image.width, image.height))
                .unwrap_or((0, 0));
            image_node_size(width, height)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dto::ContentSource;

    #[test]
    fn cover_cards_reserve_an_image_band_and_clamp_the_text_area() {
        // One short line: 44 + 20 = 64 -> the cover's minimum text area.
        assert_eq!(cover_text_height("hello"), 192.0);
        // Placeholders do not count as text.
        assert_eq!(cover_text_height("[图片][图片]"), 192.0);
        // Removing an inline placeholder leaves an empty source line, which
        // still counts as one line.
        assert_eq!(cover_text_height("[图片]\na"), 212.0);
        // Four lines: 44 + 80 = 124 -> 128 + 124 = 252.
        assert_eq!(cover_text_height("a\nb\nc\nd"), 252.0);
        // The text area is capped at 224, so the card never exceeds 352.
        assert_eq!(cover_text_height(&"a\n".repeat(40)), 352.0);
        assert_eq!(cover_text_height(""), 192.0);
    }

    #[test]
    fn node_size_uses_the_cover_rule_only_for_rich_text_with_a_cover() {
        let base = ContentRecord {
            id: "c".into(),
            kind: ContentKind::RichText,
            preview: "hello".into(),
            text_length: 5,
            url: None,
            image: None,
            category_id: None,
            source: ContentSource::Clipboard,
            created_at: String::new(),
            updated_at: String::new(),
            last_used_at: String::new(),
            hash: String::new(),
            cover_asset: None,
        };
        assert_eq!(node_size(&base), (280.0, 84.0));
        let with_cover = ContentRecord {
            cover_asset: Some("c/asset".into()),
            ..base.clone()
        };
        assert_eq!(node_size(&with_cover), (280.0, 192.0));
        // Plain text never uses the cover rule.
        let text = ContentRecord {
            kind: ContentKind::Text,
            cover_asset: Some("c/asset".into()),
            ..base
        };
        assert_eq!(node_size(&text), (280.0, 84.0));
    }

    #[test]
    fn image_cards_scale_into_the_320_box_without_growing() {
        assert_eq!(image_node_size(320, 240), (320.0, 240.0));
        assert_eq!(image_node_size(100, 50), (100.0, 50.0));
        // 640x480 -> exactly half.
        assert_eq!(image_node_size(640, 480), (320.0, 240.0));
        // Portrait keeps the ratio on the longest side.
        assert_eq!(image_node_size(480, 960), (160.0, 320.0));
        // Degenerate sources clamp to the minimum card edge.
        assert_eq!(image_node_size(4000, 1), (320.0, 48.0));
        assert_eq!(image_node_size(0, 900), (240.0, 180.0));
        assert_eq!(image_node_size(0, 0), (240.0, 180.0));
    }

    #[test]
    fn text_height_grows_per_wrapped_line_and_clamps() {
        // One short line: 44 + 20 = 64 -> clamped to the 84 minimum.
        assert_eq!(text_node_height("hello"), 84.0);
        assert_eq!(text_node_height(""), 84.0);
        // Two lines.
        assert_eq!(text_node_height("a\nb"), 84.0);
        // Three lines: 44 + 60 = 104.
        assert_eq!(text_node_height("a\nb\nc"), 104.0);
        // Wide chars wrap at 252/13 = 19 per line (19*13=247, 20*13=260).
        let long_cjk = "界".repeat(40);
        assert_eq!(estimated_line_count(&long_cjk), 3);
        assert_eq!(text_node_height(&long_cjk), 104.0);
        // Narrow chars wrap at 252/7 = 36 per line.
        let long_ascii = "a".repeat(37);
        assert_eq!(estimated_line_count(&long_ascii), 2);
        // Line count is capped so a long preview never exceeds 264.
        assert_eq!(text_node_height(&"a\n".repeat(40)), 264.0);
    }

    #[test]
    fn preview_keeps_newlines_and_clips_at_500_chars() {
        assert_eq!(preview_text("a\nb"), "a\nb");
        let long = "x".repeat(600);
        assert_eq!(preview_text(&long).chars().count(), 500);
        // Multi-byte characters count as one char each, never split.
        let cjk = "界".repeat(600);
        let preview = preview_text(&cjk);
        assert_eq!(preview.chars().count(), 500);
        assert_eq!(text_length(&cjk), 600);
    }

    #[test]
    fn wide_character_classes_cover_cjk_fullwidth_and_emoji() {
        assert!(is_wide_char('界'));
        assert!(is_wide_char('あ'));
        assert!(is_wide_char('한'));
        assert!(is_wide_char('Ａ'));
        assert!(is_wide_char('😀'));
        assert!(!is_wide_char('a'));
        assert!(!is_wide_char(' '));
        assert!(!is_wide_char('é'));
    }
}
