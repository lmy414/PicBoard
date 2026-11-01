//! The Windows "HTML Format" clipboard payload (CF_HTML) and the small amount
//! of HTML parsing the host needs.
//!
//! The host never renders HTML; it only has to (a) read the fragment another
//! application published, (b) publish a fragment with a header the receiver can
//! byte-slice, and (c) decide whether a fragment carries visible text at all.

/// Marker tags the CF_HTML offsets point at.
const START_MARKER: &str = "<!--StartFragment-->";
const END_MARKER: &str = "<!--EndFragment-->";
const DOCUMENT_PREFIX: &str = "<html><body>";
const DOCUMENT_SUFFIX: &str = "</body></html>";

struct Offsets {
    start_html: Option<usize>,
    end_html: Option<usize>,
    start_fragment: Option<usize>,
    end_fragment: Option<usize>,
}

/// Wrap `fragment` in a `Version:0.9` CF_HTML document whose offsets are byte
/// offsets into the returned string (UTF-8).
pub fn build_document(fragment: &str) -> String {
    // The header uses fixed-width decimals, so formatting a placeholder first
    // gives the exact header length.
    let header_len = render_header(0, 0, 0, 0).len();
    let body_prefix = format!("{DOCUMENT_PREFIX}{START_MARKER}");
    let start_html = header_len;
    let start_fragment = start_html + body_prefix.len();
    let end_fragment = start_fragment + fragment.len();
    let end_html = end_fragment + END_MARKER.len() + DOCUMENT_SUFFIX.len();
    let mut output = render_header(start_html, end_html, start_fragment, end_fragment);
    output.push_str(&body_prefix);
    output.push_str(fragment);
    output.push_str(END_MARKER);
    output.push_str(DOCUMENT_SUFFIX);
    output
}

fn render_header(
    start_html: usize,
    end_html: usize,
    start_fragment: usize,
    end_fragment: usize,
) -> String {
    format!(
        "Version:0.9\r\nStartHTML:{start_html:010}\r\nEndHTML:{end_html:010}\r\nStartFragment:{start_fragment:010}\r\nEndFragment:{end_fragment:010}\r\n"
    )
}

fn parse_offsets(raw: &str) -> Offsets {
    let mut offsets = Offsets {
        start_html: None,
        end_html: None,
        start_fragment: None,
        end_fragment: None,
    };
    for line in raw.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let Ok(number) = value.trim().parse::<usize>() else {
            continue;
        };
        match key.trim() {
            "StartHTML" => offsets.start_html = Some(number),
            "EndHTML" => offsets.end_html = Some(number),
            "StartFragment" => offsets.start_fragment = Some(number),
            "EndFragment" => offsets.end_fragment = Some(number),
            _ => {}
        }
    }
    offsets
}

/// Extract the fragment from a raw CF_HTML payload. Uses StartFragment/
/// EndFragment with StartHTML/EndHTML as the fallback; a payload without usable
/// offsets (or with offsets that do not land on character boundaries) is
/// returned unchanged.
pub fn parse_fragment(raw: &str) -> String {
    let offsets = parse_offsets(raw);
    let start = offsets.start_fragment.or(offsets.start_html);
    let end = offsets.end_fragment.or(offsets.end_html);
    if let (Some(start), Some(end)) = (start, end) {
        // `StartHTML` is always past the header, so `start > 0` rejects an
        // all-zero (broken) header; `start == end` is a legitimately empty
        // fragment.
        if start > 0 && start <= end && end <= raw.len() {
            if let Some(fragment) = raw.get(start..end) {
                return fragment.to_owned();
            }
        }
    }
    raw.to_owned()
}

/// Visible text of an HTML fragment: comments, `<script>` and `<style>` bodies
/// removed, tags stripped, entities decoded.
pub fn visible_text(html: &str) -> String {
    let without_comments = strip_comments(html);
    let without_hidden = strip_element(&strip_element(&without_comments, "script"), "style");
    decode_entities(&strip_tags(&without_hidden))
}

fn strip_comments(input: &str) -> String {
    let lower = input.to_ascii_lowercase();
    let mut output = String::with_capacity(input.len());
    let mut cursor = 0;
    while let Some(relative) = lower[cursor..].find("<!--") {
        let start = cursor + relative;
        output.push_str(&input[cursor..start]);
        match lower[start..].find("-->") {
            Some(relative_end) => cursor = start + relative_end + 3,
            None => {
                cursor = input.len();
                break;
            }
        }
    }
    output.push_str(&input[cursor..]);
    output
}

/// Remove `<tag …>…</tag>` blocks. The ASCII-lowercased copy has the same byte
/// length, so indices stay valid for the original.
fn strip_element(input: &str, tag: &str) -> String {
    let lower = input.to_ascii_lowercase();
    let open = format!("<{tag}");
    let close = format!("</{tag}");
    let mut output = String::with_capacity(input.len());
    let mut cursor = 0;
    while let Some(relative) = lower[cursor..].find(&open) {
        let start = cursor + relative;
        // Must be a real tag name boundary (`<scripture>` is not a script).
        let after = start + open.len();
        let boundary = lower[after..]
            .chars()
            .next()
            .map(|ch| ch.is_whitespace() || ch == '>' || ch == '/')
            .unwrap_or(true);
        if !boundary {
            output.push_str(&input[cursor..after]);
            cursor = after;
            continue;
        }
        output.push_str(&input[cursor..start]);
        match lower[start..].find(&close) {
            Some(relative_close) => {
                let close_start = start + relative_close;
                match lower[close_start..].find('>') {
                    Some(relative_gt) => cursor = close_start + relative_gt + 1,
                    None => {
                        cursor = input.len();
                        break;
                    }
                }
            }
            None => {
                cursor = input.len();
                break;
            }
        }
    }
    output.push_str(&input[cursor..]);
    output
}

fn strip_tags(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut cursor = 0;
    while let Some(relative) = input[cursor..].find('<') {
        let start = cursor + relative;
        output.push_str(&input[cursor..start]);
        match input[start..].find('>') {
            Some(relative_gt) => cursor = start + relative_gt + 1,
            None => {
                cursor = input.len();
                break;
            }
        }
    }
    output.push_str(&input[cursor..]);
    output
}

/// Decode the named entities Windows apps emit plus numeric references.
pub fn decode_entities(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(index) = rest.find('&') {
        output.push_str(&rest[..index]);
        let tail = &rest[index..];
        let (decoded, consumed) = decode_entity(tail).unwrap_or((None, 1));
        match decoded {
            Some(ch) => output.push(ch),
            None => output.push_str(&tail[..consumed]),
        }
        rest = &tail[consumed..];
    }
    output.push_str(rest);
    output
}

/// Decode one entity at the start of `input`; returns the character (if it is a
/// known entity) and how many bytes were consumed.
fn decode_entity(input: &str) -> Option<(Option<char>, usize)> {
    let end = input.find(';')?;
    if end > 10 {
        return None;
    }
    let entity = &input[1..end];
    let consumed = end + 1;
    let named = match entity {
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        "apos" => Some('\''),
        "nbsp" => Some('\u{00A0}'),
        _ => None,
    };
    if named.is_some() {
        return Some((named, consumed));
    }
    let numeric = if let Some(hex) = entity
        .strip_prefix("#x")
        .or_else(|| entity.strip_prefix("#X"))
    {
        u32::from_str_radix(hex, 16).ok()
    } else {
        entity.strip_prefix('#').and_then(|value| value.parse().ok())
    };
    let value = numeric.and_then(char::from_u32);
    Some((value, consumed))
}

/// Escape text for inclusion in an HTML fragment.
pub fn escape_text(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '&' => output.push_str("&amp;"),
            '<' => output.push_str("&lt;"),
            '>' => output.push_str("&gt;"),
            '"' => output.push_str("&quot;"),
            '\'' => output.push_str("&#39;"),
            _ => output.push(ch),
        }
    }
    output
}

/// Escape text as an HTML paragraph, keeping source newlines as `<br>`.
pub fn text_paragraph(input: &str) -> String {
    let mut output = String::with_capacity(input.len() + 7);
    output.push_str("<p>");
    let mut first = true;
    for line in input.split('\n') {
        if !first {
            output.push_str("<br>");
        }
        first = false;
        output.push_str(&escape_text(line));
    }
    output.push_str("</p>");
    output
}

/// Escape text for use inside an attribute value.
pub fn escape_attribute(input: &str) -> String {
    escape_text(input)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_and_parse_round_trip_uses_byte_offsets_for_multibyte_text() {
        let fragment = "<p>中文 😀 <b>bold</b></p>";
        let document = build_document(fragment);
        assert!(document.starts_with("Version:0.9\r\n"));
        let offsets = parse_offsets(&document);
        let start_html = offsets.start_html.unwrap();
        let end_html = offsets.end_html.unwrap();
        let start_fragment = offsets.start_fragment.unwrap();
        let end_fragment = offsets.end_fragment.unwrap();
        // The advertised offsets are byte offsets into the UTF-8 payload.
        assert_eq!(&document[start_fragment..end_fragment], fragment);
        assert_eq!(&document[start_html..start_html + "<html><body>".len()], "<html><body>");
        assert_eq!(
            &document[end_html - "</body></html>".len()..end_html],
            "</body></html>"
        );
        assert_eq!(parse_fragment(&document), fragment);
    }

    #[test]
    fn parse_fragment_falls_back_to_document_offsets() {
        let fragment = "<p>fallback</p>";
        let header = |start: usize, end: usize| {
            format!("Version:0.9\r\nStartHTML:{start:010}\r\nEndHTML:{end:010}\r\n")
        };
        let body = format!("<html><body>{fragment}</body></html>");
        let start_html = header(0, 0).len();
        let end_html = start_html + body.len();
        let document = format!("{}{}", header(start_html, end_html), body);
        assert_eq!(parse_fragment(&document), body);
    }

    #[test]
    fn parse_fragment_accepts_plain_html_without_header() {
        assert_eq!(parse_fragment("<b>hi</b>"), "<b>hi</b>");
    }

    #[test]
    fn visible_text_removes_scripts_styles_and_tags() {
        let html = "<html><head><style>p{color:red}</style><script>alert('x')</script></head>\
                    <body><!-- comment --><p>Hello &amp; <b>world</b></p><p>第二行</p></body></html>";
        assert_eq!(visible_text(html), "Hello & world第二行");
        assert_eq!(visible_text("<p>&nbsp;</p>"), "\u{00A0}");
        assert!(visible_text("<script>only()</script><style>x{}</style>")
            .trim()
            .is_empty());
        // `<scripture>` is not a script element.
        assert_eq!(visible_text("<scripture>text</scripture>"), "text");
        assert_eq!(visible_text("&#65;&#x42;&bogus;"), "AB&bogus;");
    }

    #[test]
    fn paragraphs_escape_markup_and_keep_newlines() {
        assert_eq!(text_paragraph("a<b\nc&d"), "<p>a&lt;b<br>c&amp;d</p>");
        assert_eq!(escape_attribute("a\"b"), "a&quot;b");
    }

    #[test]
    fn offsets_stay_stable_for_empty_fragment() {
        let document = build_document("");
        let offsets = parse_offsets(&document);
        assert_eq!(offsets.start_fragment, offsets.end_fragment);
        assert_eq!(parse_fragment(&document), "");
    }
}
