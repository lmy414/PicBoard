//! Image assets embedded in rich-text contents.
//!
//! Assets live in `content/<contentId>/assets/<assetId>.<ext>` and are deleted
//! together with their content folder (never while editing: the editor's undo
//! history may bring a removed image back). Stored HTML references them as
//! `<img data-asset="<contentId>/<assetId>" …>`; the host ignores any `src`
//! attribute that was written next to it.
//!
//! The scanners below are deliberately small: the HTML is produced by TipTap or
//! captured from the clipboard, and only `<img>` tags need attention.

use crate::dto::{ContentAsset, ContentKind, ImportImagePayload};
use crate::error::AppError;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

use super::files::{self, write_atomic_bytes};
use super::ImageBoardStorage;

/// Largest accepted asset upload.
pub(crate) const MAX_ASSET_BYTES: usize = 32 * 1024 * 1024;
/// Largest single image that is inlined as a data URL on copy-out.
const MAX_INLINE_ASSET_BYTES: u64 = 8 * 1024 * 1024;
/// Budget for all inlined images of one copy-out (encoded length).
const MAX_INLINE_TOTAL_BYTES: usize = 24 * 1024 * 1024;

pub(crate) fn assets_dir(root: &Path, content_id: &str) -> PathBuf {
    files::content_dir(root, content_id).join("assets")
}

/// Locate `<assets>/<assetId>.*`.
pub(crate) fn find_asset(root: &Path, content_id: &str, asset_id: &str) -> Option<PathBuf> {
    let entries = fs::read_dir(assets_dir(root, content_id)).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.file_stem().and_then(|stem| stem.to_str()) == Some(asset_id) && path.is_file() {
            return Some(path);
        }
    }
    None
}

/// Remove everything below this content's assets folder (content deletion and
/// retention only).
pub(crate) fn remove_assets(root: &Path, content_id: &str) {
    let dir = assets_dir(root, content_id);
    match fs::remove_dir_all(&dir) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => eprintln!(
            "[storage] failed to remove asset folder {}: {error}",
            dir.display()
        ),
    }
}

impl ImageBoardStorage {
    /// Store one image for a text/rich-text content.
    pub fn add_content_asset(
        &mut self,
        content_id: &str,
        image: ImportImagePayload,
    ) -> Result<ContentAsset, AppError> {
        self.ensure_loaded()?;
        let content = self.content(content_id)?;
        if !matches!(content.kind, ContentKind::Text | ContentKind::RichText) {
            return Err(AppError::message("只有文本内容可以添加图片"));
        }
        if image.data.len() > MAX_ASSET_BYTES {
            return Err(AppError::message("图片过大"));
        }
        let format = image::guess_format(&image.data)
            .map_err(|_| AppError::message("不支持的图片格式"))?;
        let mime =
            files::mime_for_format(format).ok_or_else(|| AppError::message("不支持的图片格式"))?;
        let (width, height) = files::image_intrinsic_size(&image.data);
        let asset_id = Uuid::new_v4().to_string();
        let path = assets_dir(&self.root, content_id)
            .join(format!("{asset_id}{}", files::extension_for_mime(mime)));
        write_atomic_bytes(&path, &image.data)?;
        Ok(ContentAsset {
            asset_id,
            mime: mime.to_owned(),
            width,
            height,
            byte_size: image.data.len() as u64,
        })
    }
}

/// Copy foreign asset references into `content/<target>/assets` and drop tags
/// that cannot be resolved. Returns the rewritten HTML plus the files it
/// created (for rollback when the surrounding transaction fails).
pub(crate) fn localize_html(
    root: &Path,
    target_content_id: &str,
    html: &str,
) -> Result<(String, Vec<PathBuf>), AppError> {
    let tags = scan_img_tags(html);
    if tags.is_empty() {
        return Ok((html.to_owned(), Vec::new()));
    }
    let mut output = String::with_capacity(html.len());
    let mut cursor = 0usize;
    let mut created = Vec::new();
    let mut copies: HashMap<(String, String), String> = HashMap::new();
    for tag in tags {
        output.push_str(&html[cursor..tag.start]);
        cursor = tag.end;
        let Some(reference) = attr(&tag.attrs, "data-asset") else {
            // Not an asset image: leave it exactly as captured.
            output.push_str(&html[tag.start..tag.end]);
            continue;
        };
        let Some((source_content, source_asset)) = parse_reference(reference) else {
            continue; // malformed reference: unusable, drop the tag
        };
        if source_content == target_content_id {
            if find_asset(root, target_content_id, &source_asset).is_some() {
                output.push_str(&html[tag.start..tag.end]);
            }
            continue;
        }
        let key = (source_content.clone(), source_asset.clone());
        let new_asset = if let Some(existing) = copies.get(&key) {
            existing.clone()
        } else {
            let Some(source) = find_asset(root, &source_content, &source_asset) else {
                continue;
            };
            let Ok(bytes) = fs::read(&source) else {
                continue;
            };
            let Some(mime) = files::sniff_image_format(&source)
                .and_then(files::mime_for_format)
                .or_else(|| Some(files::mime_for(&source.to_string_lossy())))
            else {
                continue;
            };
            let new_id = Uuid::new_v4().to_string();
            let destination = assets_dir(root, target_content_id)
                .join(format!("{new_id}{}", files::extension_for_mime(mime)));
            if let Err(error) = write_atomic_bytes(&destination, &bytes) {
                // Do not leave half-localized copies behind.
                for path in &created {
                    let _ = fs::remove_file(path);
                }
                return Err(error);
            }
            created.push(destination);
            copies.insert(key, new_id.clone());
            new_id
        };
        let mut attrs = tag.attrs.clone();
        for (key, value) in attrs.iter_mut() {
            if key == "data-asset" {
                *value = format!("{target_content_id}/{new_asset}");
            }
        }
        output.push_str(&render_img_tag(&attrs, tag.self_closing));
    }
    output.push_str(&html[cursor..]);
    Ok((output, created))
}

/// Rewrite asset references into self-contained data URLs for clipboard
/// copy-out, so pasting into Word/Feishu/browsers keeps the images.
pub(crate) fn inline_html_assets(root: &Path, content_id: &str, html: &str) -> String {
    let tags = scan_img_tags(html);
    if tags.is_empty() {
        return html.to_owned();
    }
    let mut output = String::with_capacity(html.len());
    let mut cursor = 0usize;
    let mut total = 0usize;
    for tag in tags {
        output.push_str(&html[cursor..tag.start]);
        cursor = tag.end;
        let Some(reference) = attr(&tag.attrs, "data-asset") else {
            output.push_str(&html[tag.start..tag.end]);
            continue;
        };
        let Some((source_content, source_asset)) = parse_reference(reference) else {
            continue;
        };
        if source_content != content_id {
            // Foreign references are localized on the way in; keep them as-is
            // rather than guessing which file they mean.
            output.push_str(&html[tag.start..tag.end]);
            continue;
        }
        let Some(path) = find_asset(root, content_id, &source_asset) else {
            continue;
        };
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        if metadata.len() > MAX_INLINE_ASSET_BYTES {
            continue;
        }
        let Ok(bytes) = fs::read(&path) else {
            continue;
        };
        let Some(mime) = files::sniff_image_format(&path)
            .and_then(files::mime_for_format)
            .or_else(|| Some(files::mime_for(&path.to_string_lossy())))
        else {
            continue;
        };
        let encoded = BASE64.encode(&bytes);
        if total + encoded.len() > MAX_INLINE_TOTAL_BYTES {
            continue;
        }
        total += encoded.len();
        let mut attrs: Vec<(String, String)> = tag
            .attrs
            .iter()
            .filter(|(key, _)| key != "data-asset" && key != "src")
            .cloned()
            .collect();
        attrs.insert(0, ("src".into(), format!("data:{mime};base64,{encoded}")));
        output.push_str(&render_img_tag(&attrs, tag.self_closing));
    }
    output.push_str(&html[cursor..]);
    output
}

/// `<contentId>/<assetId>` with both ids UUID-shaped.
fn parse_reference(value: &str) -> Option<(String, String)> {
    files::parse_asset_reference(value)
}

/// First asset reference of already-localized HTML, in `<contentId>/<assetId>`
/// form. This is the canvas-card cover of a rich-text content.
pub(crate) fn first_asset_reference(html: &str, content_id: &str) -> Option<String> {
    for tag in scan_img_tags(html) {
        let Some(value) = attr(&tag.attrs, "data-asset") else {
            continue;
        };
        let Some((owner, asset)) = files::parse_asset_reference(value) else {
            continue;
        };
        if owner == content_id {
            return Some(format!("{owner}/{asset}"));
        }
    }
    None
}

struct ImgTag {
    start: usize,
    end: usize,
    attrs: Vec<(String, String)>,
    self_closing: bool,
}

fn attr<'a>(attrs: &'a [(String, String)], name: &str) -> Option<&'a str> {
    attrs
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
}

/// Find every `<img …>` tag, quote-aware so a `>` inside an attribute value
/// does not end the tag early.
fn scan_img_tags(html: &str) -> Vec<ImgTag> {
    let lower = html.to_ascii_lowercase();
    let bytes = html.as_bytes();
    let mut tags = Vec::new();
    let mut cursor = 0usize;
    while let Some(found) = lower[cursor..].find("<img") {
        let start = cursor + found;
        let after = start + 4;
        let boundary = lower[after..]
            .chars()
            .next()
            .map(|ch| ch.is_whitespace() || ch == '>' || ch == '/')
            .unwrap_or(true);
        if !boundary {
            cursor = after;
            continue;
        }
        let mut index = after;
        let mut quote: Option<u8> = None;
        while index < bytes.len() {
            let byte = bytes[index];
            match quote {
                Some(active) => {
                    if byte == active {
                        quote = None;
                    }
                }
                None => match byte {
                    b'"' | b'\'' => quote = Some(byte),
                    b'>' => break,
                    _ => {}
                },
            }
            index += 1;
        }
        if index >= bytes.len() {
            break;
        }
        let end = index + 1;
        let body = &html[after..index];
        let (attrs, self_closing) = parse_attributes(body);
        tags.push(ImgTag {
            start,
            end,
            attrs,
            self_closing,
        });
        cursor = end;
    }
    tags
}

fn parse_attributes(body: &str) -> (Vec<(String, String)>, bool) {
    let trimmed = body.trim_end();
    let self_closing = trimmed.ends_with('/');
    let body = if self_closing {
        trimmed[..trimmed.len() - 1].trim_end()
    } else {
        body
    };
    let bytes = body.as_bytes();
    let mut attrs = Vec::new();
    let mut index = 0usize;
    while index < bytes.len() {
        while index < bytes.len() && (bytes[index] as char).is_whitespace() {
            index += 1;
        }
        if index >= bytes.len() {
            break;
        }
        let name_start = index;
        while index < bytes.len()
            && !(bytes[index] as char).is_whitespace()
            && bytes[index] != b'='
            && bytes[index] != b'/'
        {
            index += 1;
        }
        let name = body[name_start..index].to_ascii_lowercase();
        while index < bytes.len() && (bytes[index] as char).is_whitespace() {
            index += 1;
        }
        let mut value = String::new();
        if index < bytes.len() && bytes[index] == b'=' {
            index += 1;
            while index < bytes.len() && (bytes[index] as char).is_whitespace() {
                index += 1;
            }
            if index < bytes.len() && (bytes[index] == b'"' || bytes[index] == b'\'') {
                let quote = bytes[index];
                index += 1;
                let value_start = index;
                while index < bytes.len() && bytes[index] != quote {
                    index += 1;
                }
                value = body[value_start..index].to_owned();
                if index < bytes.len() {
                    index += 1;
                }
            } else {
                let value_start = index;
                while index < bytes.len() && !(bytes[index] as char).is_whitespace() {
                    if bytes[index] == b'/' && index + 1 == bytes.len() {
                        break;
                    }
                    index += 1;
                }
                value = body[value_start..index].to_owned();
            }
        }
        if !name.is_empty() {
            attrs.push((name, value));
        }
    }
    (attrs, self_closing)
}

fn render_img_tag(attrs: &[(String, String)], self_closing: bool) -> String {
    let mut output = String::from("<img");
    for (key, value) in attrs {
        output.push(' ');
        output.push_str(key);
        output.push_str("=\"");
        // Values are kept verbatim (they are already entity-escaped); only a
        // raw quote could break the attribute, so escape that.
        output.push_str(&value.replace('"', "&quot;"));
        output.push('"');
    }
    if self_closing {
        output.push_str(" /");
    }
    output.push('>');
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dto::ContentSource;

    const CONTENT_A: &str = "11111111-1111-4111-8111-111111111111";
    const CONTENT_B: &str = "22222222-2222-4222-8222-222222222222";
    const ASSET_1: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const ASSET_2: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const ASSET_3: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

    fn storage(root: &Path) -> ImageBoardStorage {
        ImageBoardStorage::new(root.to_path_buf())
    }

    fn write_asset(root: &Path, content_id: &str, asset_id: &str, bytes: &[u8]) -> PathBuf {
        let dir = assets_dir(root, content_id);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{asset_id}.png"));
        fs::write(&path, bytes).unwrap();
        path
    }

    fn png_bytes(width: u32, height: u32) -> Vec<u8> {
        super::super::encode_png(&vec![255u8; (width * height * 4) as usize], width, height).unwrap()
    }

    #[test]
    fn img_scanning_handles_attribute_order_quotes_and_missing_tags() {
        let html = r#"<p>a</p><img alt='x"y' data-asset="C/A"><IMG SRC=/a.png data-asset='C/B' /><p>b</p>"#;
        let tags = scan_img_tags(html);
        assert_eq!(tags.len(), 2);
        assert_eq!(attr(&tags[0].attrs, "alt"), Some("x\"y"));
        assert_eq!(attr(&tags[0].attrs, "data-asset"), Some("C/A"));
        assert!(!tags[0].self_closing);
        assert_eq!(attr(&tags[1].attrs, "data-asset"), Some("C/B"));
        assert!(tags[1].self_closing);
        assert_eq!(tags[0].end - tags[0].start, "<img alt='x\"y' data-asset=\"C/A\">".len());
        assert!(scan_img_tags("<p>no images</p><image>x</image>").is_empty());
    }

    #[test]
    fn localization_copies_foreign_assets_once_and_drops_unresolvable_tags() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let bytes = png_bytes(8, 6);
        write_asset(root, CONTENT_B, ASSET_1, &bytes);
        let html = format!(
            r#"<p>x</p><img data-asset="{CONTENT_B}/{ASSET_1}" src="ignored"><img data-asset="{CONTENT_B}/{ASSET_1}"><img data-asset="{CONTENT_B}/{ASSET_2}"><img data-asset="garbage"><img src="https://example.com/a.png">"#
        );

        let (localized, created) = localize_html(root, CONTENT_A, &html).unwrap();

        assert_eq!(created.len(), 1, "the same foreign asset is copied once");
        assert_eq!(localized.matches("data-asset=\"").count(), 2);
        assert!(localized.contains(CONTENT_A));
        assert!(!localized.contains(CONTENT_B));
        assert!(localized.contains(r#"<img src="https://example.com/a.png">"#));
        assert!(!localized.contains("garbage"));
        // The copied file is a real asset of the target content.
        let copied = created[0].file_name().unwrap().to_str().unwrap().to_owned();
        let asset_id = copied.split('.').next().unwrap();
        assert!(find_asset(root, CONTENT_A, asset_id).is_some());

        // Localizing again keeps the now-local reference and copies nothing.
        let (again, created) = localize_html(root, CONTENT_A, &localized).unwrap();
        assert!(created.is_empty());
        assert_eq!(again.matches("data-asset=\"").count(), 2);
    }

    #[test]
    fn localization_drops_same_content_references_whose_file_is_gone() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let html = format!(r#"<img data-asset="{CONTENT_A}/{ASSET_1}"><p>tail</p>"#);
        let (localized, created) = localize_html(root, CONTENT_A, &html).unwrap();
        assert!(localized.is_empty() || !localized.contains("<img"));
        assert!(localized.contains("<p>tail</p>"));
        assert!(created.is_empty());
    }

    #[test]
    fn inline_replaces_assets_with_data_urls_and_drops_foreign_or_missing() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let png = png_bytes(4, 3);
        write_asset(root, CONTENT_A, ASSET_1, &png);
        let html = format!(
            r#"<p>t</p><img alt="pic" data-asset="{CONTENT_A}/{ASSET_1}"><img data-asset="{CONTENT_A}/{ASSET_2}"><img data-asset="{CONTENT_B}/{ASSET_1}"><img src="keep.png">"#
        );

        let inlined = inline_html_assets(root, CONTENT_A, &html);

        assert!(inlined.contains("src=\"data:image/png;base64,"));
        assert!(inlined.contains("alt=\"pic\""));
        // The inlined image no longer references an asset…
        assert!(!inlined.contains(&format!("data-asset=\"{CONTENT_A}/")));
        // …while the missing same-content asset is dropped and the foreign
        // reference (impossible after localization) is left untouched.
        assert!(inlined.contains(&format!("data-asset=\"{CONTENT_B}/")));
        assert_eq!(inlined.matches("<img").count(), 3);
        assert!(inlined.contains(r#"src="keep.png""#));
        assert!(inlined.contains(CONTENT_B));
    }

    #[test]
    fn add_content_asset_validates_kind_format_and_size() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = storage(temp.path());
                        let text = store
            .ingest_capture(&crate::clipboard::CapturedContent::RichText {
                text: "rich".into(),
                html: "<p>rich</p>".into(),
            })
            .unwrap()
            .contents
            .keys()
            .next()
            .unwrap()
            .clone();

        let asset = store
            .add_content_asset(
                &text,
                ImportImagePayload {
                    name: "ignored.png".into(),
                    data: png_bytes(12, 9),
                },
            )
            .unwrap();
        assert_eq!(asset.mime, "image/png");
        assert_eq!((asset.width, asset.height), (12, 9));
        assert_eq!(asset.byte_size, png_bytes(12, 9).len() as u64);
        let path = find_asset(temp.path(), &text, &asset.asset_id).expect("asset file");
        assert!(path.ends_with(format!("{}.png", asset.asset_id)));

        // Not an image content.
        let image_id = store
            .ingest_image(Some("img.png"), &png_bytes(4, 4), ContentSource::Drop)
            .unwrap()
            .id;
        assert_eq!(
            store
                .add_content_asset(
                    &image_id,
                    ImportImagePayload {
                        name: "x.png".into(),
                        data: png_bytes(4, 4)
                    }
                )
                .unwrap_err()
                .0,
            "只有文本内容可以添加图片"
        );
        // Unsupported bytes.
        assert_eq!(
            store
                .add_content_asset(
                    &text,
                    ImportImagePayload {
                        name: "x.txt".into(),
                        data: b"not an image".to_vec()
                    }
                )
                .unwrap_err()
                .0,
            "不支持的图片格式"
        );
        // Oversized upload is refused before any file is written.
        let oversized = vec![0u8; MAX_ASSET_BYTES + 1];
        assert_eq!(
            store
                .add_content_asset(
                    &text,
                    ImportImagePayload {
                        name: "big.png".into(),
                        data: oversized
                    }
                )
                .unwrap_err()
                .0,
            "图片过大"
        );
    }

    #[test]
    fn deleting_a_content_removes_its_assets() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = storage(temp.path());
                        let text = store
            .ingest_capture(&crate::clipboard::CapturedContent::RichText {
                text: "rich".into(),
                html: "<p>rich</p>".into(),
            })
            .unwrap()
            .contents
            .keys()
            .next()
            .unwrap()
            .clone();
        let asset = store
            .add_content_asset(
                &text,
                ImportImagePayload {
                    name: "a.png".into(),
                    data: png_bytes(6, 5),
                },
            )
            .unwrap();
        let path = find_asset(temp.path(), &text, &asset.asset_id).unwrap();
        assert!(path.is_file());

        store.delete_contents(&[text.clone()]).unwrap();

        assert!(!path.exists());
        assert!(!assets_dir(temp.path(), &text).exists());
    }

    #[test]
    fn resolve_asset_rejects_missing_content_and_foreign_ids() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = storage(temp.path());
                        let text = store
            .ingest_capture(&crate::clipboard::CapturedContent::RichText {
                text: "rich".into(),
                html: "<p>rich</p>".into(),
            })
            .unwrap()
            .contents
            .keys()
            .next()
            .unwrap()
            .clone();
        let asset = store
            .add_content_asset(
                &text,
                ImportImagePayload {
                    name: "a.png".into(),
                    data: png_bytes(6, 5),
                },
            )
            .unwrap();

        let resolved = store.resolve_asset(&text, &asset.asset_id).unwrap();
        assert_eq!(resolved.mime, "image/png");
        assert!(resolved.path.is_file());
        assert_eq!(
            store
                .resolve_asset(&text, ASSET_2)
                .unwrap_err()
                .0,
            "找不到指定图片资源"
        );
        assert_eq!(
            store
                .resolve_asset(CONTENT_B, &asset.asset_id)
                .unwrap_err()
                .0,
            "找不到指定内容"
        );
        assert!(store.resolve_asset(&text, "not-a-uuid").is_err());
    }

    #[test]
    fn rich_text_ingest_and_edits_localize_referenced_assets() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = storage(temp.path());
        // Source content owning a real asset.
        let source = store
            .ingest_capture(&crate::clipboard::CapturedContent::RichText {
                text: "source".into(),
                html: "<p>source</p>".into(),
            })
            .unwrap()
            .contents
            .keys()
            .next()
            .unwrap()
            .clone();
        let asset = store
            .add_content_asset(
                &source,
                ImportImagePayload {
                    name: "a.png".into(),
                    data: png_bytes(10, 8),
                },
            )
            .unwrap();
        let foreign = format!(
            r#"<p>copy</p><img data-asset="{source}/{}">"#,
            asset.asset_id
        );

        // Drop ingest copies the asset into the new content.
        let state = store
            .ingest_capture(&crate::clipboard::CapturedContent::RichText {
                text: "copy".into(),
                html: foreign.clone(),
            })
            .unwrap();
        let copy_id = state
            .contents
            .values()
            .find(|content| content.kind == ContentKind::RichText && content.id != source)
            .unwrap()
            .id
            .clone();
        let copied = store.get_content_body(&copy_id).unwrap().html.unwrap();
        assert!(copied.contains(&copy_id));
        assert!(!copied.contains(&source));
        let copied_ref = copied
            .split("data-asset=\"")
            .nth(1)
            .unwrap()
            .split('"')
            .next()
            .unwrap()
            .to_owned();
        let copied_asset = copied_ref.split('/').nth(1).unwrap();
        assert!(find_asset(temp.path(), &copy_id, copied_asset).is_some());

        // An edit that references a foreign asset localizes it as well.
        let edit = format!(
            r#"<p>edit</p><img data-asset="{source}/{}">"#,
            asset.asset_id
        );
        store
            .update_text_content(
                &copy_id,
                crate::dto::ContentBody {
                    text: "edit".into(),
                    html: Some(edit),
                },
            )
            .unwrap();
        let body = store.get_content_body(&copy_id).unwrap().html.unwrap();
        assert!(body.contains(&copy_id));
        assert!(!body.contains(&source));
    }

    #[test]
    fn copy_out_inlines_assets_from_the_content_folder() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = storage(temp.path());
                        let text = store
            .ingest_capture(&crate::clipboard::CapturedContent::RichText {
                text: "rich".into(),
                html: "<p>rich</p>".into(),
            })
            .unwrap()
            .contents
            .keys()
            .next()
            .unwrap()
            .clone();
        let asset = store
            .add_content_asset(
                &text,
                ImportImagePayload {
                    name: "a.png".into(),
                    data: png_bytes(7, 5),
                },
            )
            .unwrap();
        store
            .update_text_content(
                &text,
                crate::dto::ContentBody {
                    text: "rich".into(),
                    html: Some(format!(
                        r#"<p>rich</p><img data-asset="{text}/{}">"#,
                        asset.asset_id
                    )),
                },
            )
            .unwrap();

        let items = store.copy_payloads(&[text]).unwrap();

        let html = items[0].html.clone().unwrap();
        assert!(html.contains("src=\"data:image/png;base64,"));
        assert!(!html.contains("data-asset"));
    }

    #[test]
    fn inline_drops_images_over_the_per_image_and_per_copy_budgets() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        // A real PNG header padded past the 8 MiB per-image cap.
        let mut huge = png_bytes(2, 2);
        huge.resize(MAX_INLINE_ASSET_BYTES as usize + 1, 0);
        write_asset(root, CONTENT_A, ASSET_1, &huge);
        let inlined = inline_html_assets(
            root,
            CONTENT_A,
            &format!(r#"<img data-asset="{CONTENT_A}/{ASSET_1}">"#),
        );
        assert!(!inlined.contains("<img"));

        // Three 7 MiB images: base64 pushes the third past the 24 MiB budget.
        let seven = {
            let mut bytes = png_bytes(2, 2);
            bytes.resize(7 * 1024 * 1024, 0);
            bytes
        };
        for asset in [ASSET_1, ASSET_2, ASSET_3] {
            write_asset(root, CONTENT_A, asset, &seven);
        }
        let html = format!(
            r#"<img data-asset="{CONTENT_A}/{ASSET_1}"><img data-asset="{CONTENT_A}/{ASSET_2}"><img data-asset="{CONTENT_A}/{ASSET_3}">"#
        );
        let inlined = inline_html_assets(root, CONTENT_A, &html);
        assert_eq!(inlined.matches("<img").count(), 2);
    }

    #[test]
    fn uuid_shape_guard_accepts_only_canonical_uuids() {
        assert!(files::is_uuid_shaped(CONTENT_A));
        assert!(!files::is_uuid_shaped("11111111111141118111111111111111"));
        assert!(!files::is_uuid_shaped("11111111-1111-4111-8111-11111111111z"));
        assert!(!files::is_uuid_shaped("../11111111-1111-4111-8111-111111111111"));
    }

    #[test]
    fn cover_is_the_first_asset_of_localized_html() {
        let html = format!(
            r#"<p>a</p><img data-asset="{CONTENT_A}/{ASSET_2}"><img data-asset="{CONTENT_A}/{ASSET_1}">"#
        );
        assert_eq!(
            first_asset_reference(&html, CONTENT_A),
            Some(format!("{CONTENT_A}/{ASSET_2}"))
        );
        // A reference to another content never becomes this content's cover.
        assert_eq!(
            first_asset_reference(
                &format!(r#"<img data-asset="{CONTENT_B}/{ASSET_1}">"#),
                CONTENT_A
            ),
            None
        );
        assert_eq!(first_asset_reference("<p>no images</p>", CONTENT_A), None);
        assert_eq!(
            first_asset_reference(&format!(r#"<img data-asset="{CONTENT_A}/garbage">"#), CONTENT_A),
            None
        );
    }
}
