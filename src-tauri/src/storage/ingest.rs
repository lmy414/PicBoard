//! Shared ingestion: stable capture hash, de-duplication and content creation.
//!
//! Consecutive identical captures are recorded once: if the *newest* content in
//! the library carries the same hash, that content is reused (its `lastUsedAt`
//! is bumped) instead of creating a duplicate. Anything older does not count —
//! copying A, B, A must produce a fresh A at the top of the history.

use crate::dto::{ContentKind, ContentRecord, ContentSource, ImageInfo};
use crate::error::AppError;
use crate::paths::safe_join;
use std::ffi::OsStr;
use std::fs;
use std::path::PathBuf;
use uuid::Uuid;

use super::files::{self, write_atomic_bytes};
use super::model::now;
use super::sizing::{preview_text, text_length};
use super::ImageBoardStorage;

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

fn fnv_update(state: &mut u64, bytes: &[u8]) {
    for byte in bytes {
        *state ^= u64::from(*byte);
        *state = state.wrapping_mul(FNV_PRIME);
    }
}

/// FNV-1a 64 over `kind`, a NUL separator and every payload part (NUL
/// separated). Rendered as 16 lowercase hex digits.
pub(crate) fn hash_parts(kind: &str, parts: &[&[u8]]) -> String {
    let mut state = FNV_OFFSET;
    fnv_update(&mut state, kind.as_bytes());
    fnv_update(&mut state, &[0]);
    for (index, part) in parts.iter().enumerate() {
        if index > 0 {
            fnv_update(&mut state, &[0]);
        }
        fnv_update(&mut state, part);
    }
    format!("{state:016x}")
}

pub(crate) fn hash_bytes(kind: &str, payload: &[u8]) -> String {
    hash_parts(kind, &[payload])
}

pub(crate) fn hash_text(kind: ContentKind, text: &str, html: Option<&str>) -> String {
    match kind {
        ContentKind::RichText => hash_parts(
            kind.token(),
            &[text.as_bytes(), html.unwrap_or_default().as_bytes()],
        ),
        _ => hash_parts(kind.token(), &[text.as_bytes()]),
    }
}

/// Files created by one ingest call, for rollback by the enclosing operation.
pub(crate) struct Ingested {
    pub id: String,
    pub files: Vec<PathBuf>,
}

impl ImageBoardStorage {
    /// Content whose `lastUsedAt` is the newest, if it matches `hash`.
    fn newest_matching(&self, hash: &str) -> Option<String> {
        if hash.is_empty() {
            return None;
        }
        let newest = self
            .state_ref()
            .contents
            .values()
            .max_by(|left, right| left.last_used_at.cmp(&right.last_used_at))?;
        if newest.hash == hash {
            Some(newest.id.clone())
        } else {
            None
        }
    }

    fn touch(&mut self, content_id: &str) {
        let stamp = now();
        if let Some(record) = self.state_mut().contents.get_mut(content_id) {
            record.last_used_at = stamp;
        }
    }

    fn text_like_hash(
        kind: ContentKind,
        text: &str,
        html: Option<&str>,
        url: Option<&str>,
    ) -> String {
        match kind {
            ContentKind::Link => hash_bytes(kind.token(), url.unwrap_or_default().as_bytes()),
            _ => hash_text(kind, text, html),
        }
    }

    /// Create (or reuse) a text/rich-text/link content. Links own no files.
    pub(crate) fn ingest_text_like(
        &mut self,
        kind: ContentKind,
        text: String,
        html: Option<String>,
        url: Option<String>,
        source: ContentSource,
    ) -> Result<Ingested, AppError> {
        let hash = Self::text_like_hash(kind, &text, html.as_deref(), url.as_deref());
        if let Some(id) = self.newest_matching(&hash) {
            self.touch(&id);
            return Ok(Ingested {
                id,
                files: Vec::new(),
            });
        }
        self.insert_text_like(kind, text, html, url, source, hash)
    }

    /// Create a fresh text/rich-text/link content. Manual creation must never
    /// reuse an existing content, even for an identical payload.
    pub(crate) fn create_text_like(
        &mut self,
        kind: ContentKind,
        text: String,
        html: Option<String>,
        url: Option<String>,
        source: ContentSource,
    ) -> Result<Ingested, AppError> {
        let hash = Self::text_like_hash(kind, &text, html.as_deref(), url.as_deref());
        self.insert_text_like(kind, text, html, url, source, hash)
    }

    fn insert_text_like(
        &mut self,
        kind: ContentKind,
        text: String,
        html: Option<String>,
        url: Option<String>,
        source: ContentSource,
        hash: String,
    ) -> Result<Ingested, AppError> {
        let id = Uuid::new_v4().to_string();
        let mut created = Vec::new();
        let mut cover_asset = None;
        let result = (|| -> Result<(), AppError> {
            if kind != ContentKind::Link {
                let text_path = files::content_text_path(&self.root, &id);
                write_atomic_bytes(&text_path, text.as_bytes())?;
                created.push(text_path);
                if let Some(html) = html.as_deref() {
                    // The hash is over the captured HTML, so identical
                    // re-captures still dedupe after localization rewrites ids.
                    let stored = if kind == ContentKind::RichText {
                        let (localized, copies) =
                            super::assets::localize_html(&self.root, &id, html)?;
                        created.extend(copies);
                        cover_asset = super::assets::first_asset_reference(&localized, &id);
                        localized
                    } else {
                        html.to_owned()
                    };
                    let html_path = files::content_html_path(&self.root, &id);
                    write_atomic_bytes(&html_path, stored.as_bytes())?;
                    created.push(html_path);
                }
            }
            let stamp = now();
            let preview = preview_text(&text);
            self.state_mut().contents.insert(
                id.clone(),
                ContentRecord {
                    id: id.clone(),
                    kind,
                    preview,
                    // `textLength` is only meaningful for text/richText.
                    text_length: if kind == ContentKind::Link {
                        0
                    } else {
                        text_length(&text)
                    },
                    url,
                    image: None,
                    category_id: None,
                    source,
                    created_at: stamp.clone(),
                    updated_at: stamp.clone(),
                    last_used_at: stamp,
                    hash,
                    cover_asset,
                },
            );
            Ok(())
        })();
        if let Err(error) = result {
            rollback_files(&created);
            let _ = fs::remove_dir(files::content_dir(&self.root, &id));
            return Err(error);
        }
        Ok(Ingested { id, files: created })
    }

    /// Store image bytes as a new content (or reuse an identical newest one).
    pub(crate) fn ingest_image(
        &mut self,
        requested_name: Option<&str>,
        bytes: &[u8],
        source: ContentSource,
    ) -> Result<Ingested, AppError> {
        let hash = hash_bytes(ContentKind::Image.token(), bytes);
        if let Some(id) = self.newest_matching(&hash) {
            self.touch(&id);
            return Ok(Ingested {
                id,
                files: Vec::new(),
            });
        }

        self.create_image(requested_name, bytes, source)
    }

    pub(crate) fn create_image(
        &mut self,
        requested_name: Option<&str>,
        bytes: &[u8],
        source: ContentSource,
    ) -> Result<Ingested, AppError> {
        let hash = hash_bytes(ContentKind::Image.token(), bytes);
        let id = Uuid::new_v4().to_string();
        let requested = requested_name.map(str::trim).unwrap_or_default();
        // Store the file under the user-visible name so copying it out
        // (CF_HDROP) yields the name the user sees; only an unusable name falls
        // back to `<id>.<ext>`. Each content owns its folder, so a display name
        // can never collide with another content's file.
        let display_name = if requested.is_empty()
            || files::validate_image_name(OsStr::new(requested)).is_err()
        {
            files::fallback_file_name(&id, bytes)
        } else {
            requested.to_owned()
        };
        let physical = display_name.clone();
        let directory = files::content_dir(&self.root, &id);
        let relative_path = format!("{}/{}/{}", files::CONTENT_DIR, id, physical);
        let absolute = safe_join(&self.root, &relative_path)?;
        let mut created = Vec::new();
        let result = (|| -> Result<(), AppError> {
            fs::create_dir_all(&directory)?;
            write_atomic_bytes(&absolute, bytes)?;
            created.push(absolute.clone());
            let (width, height) = files::image_intrinsic_size(bytes);
            let stamp = now();
            self.state_mut().contents.insert(
                id.clone(),
                ContentRecord {
                    id: id.clone(),
                    kind: ContentKind::Image,
                    preview: display_name.clone(),
                    text_length: 0,
                    url: None,
                    image: Some(ImageInfo {
                        file_name: display_name,
                        relative_path,
                        width,
                        height,
                        byte_size: bytes.len() as u64,
                    }),
                    category_id: None,
                    source,
                    created_at: stamp.clone(),
                    updated_at: stamp.clone(),
                    last_used_at: stamp,
                    hash,
                    cover_asset: None,
                },
            );
            Ok(())
        })();
        if let Err(error) = result {
            rollback_files(&created);
            let _ = fs::remove_dir(&directory);
            return Err(error);
        }
        Ok(Ingested { id, files: created })
    }
}

/// Remove files created by a failed transaction and any directory they leave
/// empty. Best effort: the original error is what the caller reports.
pub(crate) fn rollback_files(files: &[PathBuf]) {
    for path in files {
        let _ = fs::remove_file(path);
        if let Some(parent) = path.parent() {
            files::remove_dir_if_empty(parent);
        }
    }
}

