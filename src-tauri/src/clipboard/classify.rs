//! Pure clipboard classification: which single content a capture represents.
//!
//! Precedence (highest first): one absolute http(s) URL, rich text with visible
//! text, image, plain text. The same rules run for the monitor, Ctrl+V and
//! renderer drops; only the "image" step is absent for text-only drops.

use crate::error::AppError;
use url::Url;

use super::{html, CapturedContent, ClipboardCapture};

/// Longest accepted URL, in characters.
pub const MAX_URL_CHARS: usize = 2048;

/// Validate an absolute http(s) URL and return it trimmed.
pub fn validate_url(input: &str) -> Result<String, AppError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(AppError::message("链接不能为空"));
    }
    if trimmed.chars().count() > MAX_URL_CHARS {
        return Err(AppError::message("链接过长"));
    }
    // A URL never contains whitespace; `Url::parse` would percent-encode some
    // of it, which would silently alter what the user asked to open.
    if trimmed
        .chars()
        .any(|ch| ch.is_control() || ch.is_whitespace())
    {
        return Err(AppError::message("链接包含无效字符"));
    }
    let parsed = Url::parse(trimmed).map_err(|_| AppError::message("链接格式无效"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(AppError::message("链接必须是 http 或 https 地址"));
    }
    if parsed.host_str().map(str::is_empty).unwrap_or(true) {
        return Err(AppError::message("链接缺少主机名"));
    }
    Ok(trimmed.to_owned())
}

/// The whole (trimmed) text is exactly one absolute http(s) URL.
fn single_url(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed.chars().any(char::is_whitespace) {
        return None;
    }
    validate_url(trimmed).ok()
}

/// Rich text, when the fragment carries visible text. `text` is the capture's
/// plain text when it has one, otherwise the text derived from the markup.
fn rich_text(text: Option<&str>, raw_html: &str) -> Option<CapturedContent> {
    let visible = html::visible_text(raw_html);
    if visible.trim().is_empty() {
        return None;
    }
    let plain = text
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .unwrap_or(visible);
    Some(CapturedContent::RichText {
        text: plain,
        html: raw_html.to_owned(),
    })
}

/// Classify a full clipboard capture.
pub fn classify_capture(capture: &ClipboardCapture) -> Option<CapturedContent> {
    let text = capture.text.as_deref();
    if let Some(text) = text {
        if let Some(url) = single_url(text) {
            return Some(CapturedContent::Link { url });
        }
    }
    if let Some(raw_html) = capture.html.as_deref() {
        if let Some(rich) = rich_text(text, raw_html) {
            return Some(rich);
        }
    }
    if let Some(png) = capture.image.as_ref() {
        return Some(CapturedContent::Image { png: png.clone() });
    }
    classify_plain(text)
}

fn classify_plain(text: Option<&str>) -> Option<CapturedContent> {
    text.filter(|value| !value.trim().is_empty())
        .map(|value| CapturedContent::Text {
            text: value.to_owned(),
        })
}

/// "Do not record" decision for one clipboard session. Any of the three
/// Windows opt-out markers wins.
pub fn is_excluded(
    exclude_format_present: bool,
    include_in_history_zero: bool,
    viewer_ignore_present: bool,
) -> bool {
    exclude_format_present || include_in_history_zero || viewer_ignore_present
}

/// Decide whether one clipboard update may enter the history.
///
/// `enabled` is the capture switch (the monitor passes `false` while stopped or
/// while the user paused capture). A capture is skipped when it is excluded by
/// its source application, when it is PicBoard's own copy (self marker), or when
/// its only payload was an oversized text that was dropped while reading.
/// Everything else goes through the normal classification precedence.
pub fn capture_decision(enabled: bool, capture: &ClipboardCapture) -> Option<CapturedContent> {
    if !enabled || capture.excluded || capture.self_marker.is_some() {
        return None;
    }
    if capture.text_too_large && capture.html.is_none() && capture.image.is_none() {
        return None;
    }
    classify_capture(capture)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn capture(text: Option<&str>, html: Option<&str>, image: bool) -> ClipboardCapture {
        ClipboardCapture {
            excluded: false,
            self_marker: None,
            text: text.map(str::to_owned),
            text_too_large: false,
            html: html.map(str::to_owned),
            image: image.then(|| b"png".to_vec()),
            image_error: None,
        }
    }

    #[test]
    fn single_url_text_becomes_a_link_before_rich_text() {
        let captured = classify_capture(&capture(
            Some("  https://example.com/a?b=1  "),
            Some("<p>https://example.com/a?b=1</p>"),
            false,
        ));
        assert_eq!(
            captured,
            Some(CapturedContent::Link {
                url: "https://example.com/a?b=1".into()
            })
        );
    }

    #[test]
    fn text_that_only_looks_like_a_url_stays_text() {
        // Not absolute, so it is plain text.
        assert!(matches!(
            classify_capture(&capture(Some("example.com/path"), None, false)),
            Some(CapturedContent::Text { .. })
        ));
        // Two URLs are not "exactly one URL".
        assert!(matches!(
            classify_capture(&capture(Some("https://a.test https://b.test"), None, false)),
            Some(CapturedContent::Text { .. })
        ));
        // Non-http schemes are text, not links.
        assert!(matches!(
            classify_capture(&capture(Some("ftp://example.com/x"), None, false)),
            Some(CapturedContent::Text { .. })
        ));
    }

    #[test]
    fn rich_text_uses_plain_text_and_keeps_the_raw_fragment() {
        let captured = classify_capture(&capture(
            Some("Hello world"),
            Some("<p>Hello <b>world</b></p>"),
            false,
        ));
        assert_eq!(
            captured,
            Some(CapturedContent::RichText {
                text: "Hello world".into(),
                html: "<p>Hello <b>world</b></p>".into(),
            })
        );
        // Without plain text the visible text is derived from the markup.
        let captured = classify_capture(&capture(None, Some("<p>Only <i>markup</i></p>"), false));
        assert_eq!(
            captured,
            Some(CapturedContent::RichText {
                text: "Only markup".into(),
                html: "<p>Only <i>markup</i></p>".into(),
            })
        );
    }

    #[test]
    fn image_beats_plain_text_but_loses_to_rich_text() {
        assert!(matches!(
            classify_capture(&capture(Some("caption"), Some("<style>x</style>"), true)),
            Some(CapturedContent::Image { .. })
        ));
        assert!(matches!(
            classify_capture(&capture(Some("caption"), None, true)),
            Some(CapturedContent::Image { .. })
        ));
        assert!(matches!(
            classify_capture(&capture(Some("caption"), Some("<p>x</p>"), true)),
            Some(CapturedContent::RichText { .. })
        ));
    }

    #[test]
    fn whitespace_only_and_empty_captures_classify_as_nothing() {
        assert_eq!(classify_capture(&capture(Some("  \r\n\t"), None, false)), None);
        assert_eq!(classify_capture(&capture(None, Some("<style>p{}</style>"), false)), None);
        assert_eq!(classify_capture(&capture(None, None, false)), None);
    }

    #[test]
    fn url_validation_rejects_unsafe_or_relative_values() {
        assert_eq!(
            validate_url("https://example.com/a b").unwrap_err().0,
            "链接包含无效字符"
        );
        assert_eq!(
            validate_url("javascript:alert(1)").unwrap_err().0,
            "链接必须是 http 或 https 地址"
        );
        assert_eq!(validate_url("/relative/path").unwrap_err().0, "链接格式无效");
        assert_eq!(validate_url("").unwrap_err().0, "链接不能为空");
        assert_eq!(
            validate_url(&format!("https://example.com/{}", "a".repeat(MAX_URL_CHARS)))
                .unwrap_err()
                .0,
            "链接过长"
        );
        assert_eq!(
            validate_url("  HTTPS://Example.COM/Path  ").unwrap(),
            "HTTPS://Example.COM/Path"
        );
        assert_eq!(validate_url("http://localhost:5173/").unwrap(), "http://localhost:5173/");
    }

    #[test]
    fn exclusion_markers_are_or_ed() {
        assert!(is_excluded(true, false, false));
        assert!(is_excluded(false, true, false));
        assert!(is_excluded(false, false, true));
        assert!(!is_excluded(false, false, false));
    }

    #[test]
    fn capture_decision_skips_when_capture_is_disabled() {
        // A perfectly supported capture must still be ignored while paused.
        let text = capture(Some("hello"), None, false);
        assert_eq!(capture_decision(false, &text), None);
        assert_eq!(
            capture_decision(true, &text),
            Some(CapturedContent::Text {
                text: "hello".into()
            })
        );
        let image = capture(None, None, true);
        assert_eq!(capture_decision(false, &image), None);
        assert!(matches!(
            capture_decision(true, &image),
            Some(CapturedContent::Image { .. })
        ));
    }

    #[test]
    fn capture_decision_skips_excluded_self_marked_and_oversized_captures() {
        let mut excluded = capture(Some("secret"), None, false);
        excluded.excluded = true;
        assert_eq!(capture_decision(true, &excluded), None);

        let mut own = capture(Some("from picboard"), None, false);
        own.self_marker = Some(vec![]);
        assert_eq!(capture_decision(true, &own), None);

        // Text dropped as too large, nothing else readable.
        let oversized = ClipboardCapture {
            text: None,
            text_too_large: true,
            ..ClipboardCapture::default()
        };
        assert_eq!(capture_decision(true, &oversized), None);

        // An oversized text with a usable image still records the image.
        let oversized_with_image = ClipboardCapture {
            text: None,
            text_too_large: true,
            image: Some(b"png".to_vec()),
            ..ClipboardCapture::default()
        };
        assert!(matches!(
            capture_decision(true, &oversized_with_image),
            Some(CapturedContent::Image { .. })
        ));
    }

    #[test]
    fn capture_decision_passes_supported_content_when_enabled() {
        assert_eq!(
            capture_decision(
                true,
                &capture(Some("https://example.com"), None, false)
            ),
            Some(CapturedContent::Link {
                url: "https://example.com".into()
            })
        );
        assert!(matches!(
            capture_decision(true, &capture(None, Some("<p>x</p>"), false)),
            Some(CapturedContent::RichText { .. })
        ));
        assert_eq!(
            capture_decision(true, &capture(Some("   "), None, false)),
            None
        );
    }
}
