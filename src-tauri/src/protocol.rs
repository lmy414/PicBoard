//! The `picboard` URI scheme protocol used for image bytes.
//!
//! The renderer builds URLs with `convertFileSrc(`${variant}/${contentId}`,
//! "picboard")`, i.e. `http://picboard.localhost/thumb%2F<id>` on Windows.
//! Only `thumb/<id>` and `full/<id>` for an existing *image* content resolve;
//! everything else is a 404. Paths are resolved under the storage lock (so a
//! concurrent delete cannot race the lookup), and all file IO — including
//! thumbnail generation — happens afterwards on a worker thread.

use crate::storage::ResolvedImage;
use crate::SharedStorage;
use std::path::Path;
use std::sync::mpsc;
use std::sync::{Arc, LazyLock, Mutex};
use tauri::http::Response;
use tauri::{Manager, UriSchemeResponder};

/// Longest side a thumbnail may keep before it is downscaled.
const THUMB_LONGEST_SIDE: f64 = 768.0;
/// Fixed number of thumbnail workers. Bounded so a library full of
/// uncached screenshots cannot start dozens of full-resolution decodes at once
/// (a 4K RGBA decode alone is ~33 MB); four workers already saturate the disk
/// and CPU for a desktop panel.
const THUMBNAIL_WORKERS: usize = 4;
/// Original bytes require file IO only. Separate workers keep an interactive
/// full-image request from waiting behind cold thumbnail decodes.
const ORIGINAL_WORKERS: usize = 2;

type ProtocolJob = (tauri::AppHandle, String, UriSchemeResponder);

/// Fixed worker pool for image requests, created on first use.
struct ProtocolPool {
    sender: Mutex<mpsc::Sender<ProtocolJob>>,
}

static THUMBNAIL_POOL: LazyLock<ProtocolPool> =
    LazyLock::new(|| ProtocolPool::start("thumbnail", THUMBNAIL_WORKERS));
static ORIGINAL_POOL: LazyLock<ProtocolPool> =
    LazyLock::new(|| ProtocolPool::start("original", ORIGINAL_WORKERS));

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RequestLane {
    Original,
    Thumbnail,
}

fn request_lane(path: &str) -> RequestLane {
    match parse_request_path(path) {
        Some(ImageRequest::Full(_) | ImageRequest::Asset { .. }) => RequestLane::Original,
        _ => RequestLane::Thumbnail,
    }
}

fn request_pool(path: &str) -> &'static ProtocolPool {
    match request_lane(path) {
        RequestLane::Original => &ORIGINAL_POOL,
        RequestLane::Thumbnail => &THUMBNAIL_POOL,
    }
}

impl ProtocolPool {
    fn start(lane: &str, workers: usize) -> Self {
        let (sender, receiver) = mpsc::channel::<ProtocolJob>();
        let receiver = Arc::new(Mutex::new(receiver));
        for index in 0..workers {
            let receiver = Arc::clone(&receiver);
            let spawned = std::thread::Builder::new()
                .name(format!("picboard-image-{lane}-{index}"))
                .spawn(move || loop {
                    let job = {
                        // Hold the lock only while taking a job, never while
                        // decoding or touching the disk.
                        let guard = receiver
                            .lock()
                            .unwrap_or_else(|poison| poison.into_inner());
                        guard.recv()
                    };
                    match job {
                        Ok((app, path, responder)) => responder.respond(respond(&app, &path)),
                        Err(_) => return,
                    }
                });
            if let Err(error) = spawned {
                eprintln!("[protocol] failed to start image worker {index}: {error}");
            }
        }
        Self {
            sender: Mutex::new(sender),
        }
    }

    fn submit(&self, job: ProtocolJob) -> Result<(), ProtocolJob> {
        self.sender
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .send(job)
            .map_err(|error| error.0)
    }
}

/// Hand one request to the pool. Cheap: the calling (WebView2) thread only
/// enqueues; decoding, cache generation and file IO happen on a worker.
pub fn submit(app: tauri::AppHandle, path: String, responder: UriSchemeResponder) {
    if let Err((_app, _path, responder)) = request_pool(&path).submit((app, path, responder)) {
        // The pool is gone; answer instead of leaving the request hanging.
        responder.respond(not_found());
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImageRequest {
    Thumb(String),
    Full(String),
    /// `asset/<contentId>/<assetId>`: original asset bytes.
    Asset {
        content_id: String,
        asset_id: String,
    },
    /// `asset-thumb/<contentId>/<assetId>`: thumbnail of an asset.
    AssetThumb {
        content_id: String,
        asset_id: String,
    },
}

/// Parse `/thumb%2F<id>`, `/full%2F<id>`, `/asset%2F<contentId>%2F<assetId>` and
/// `/asset-thumb%2F<contentId>%2F<assetId>`. Asset ids must be UUID-shaped, so
/// no separator can smuggle a path.
pub fn parse_request_path(raw: &str) -> Option<ImageRequest> {
    let decoded = percent_decode(raw)?;
    let trimmed = decoded.strip_prefix('/').unwrap_or(&decoded);
    let parts: Vec<&str> = trimmed.split('/').collect();
    match parts.as_slice() {
        ["thumb", id] if is_safe_id(id) => Some(ImageRequest::Thumb((*id).to_owned())),
        ["full", id] if is_safe_id(id) => Some(ImageRequest::Full((*id).to_owned())),
        ["asset", content_id, asset_id]
            if crate::storage::is_uuid_shaped(content_id)
                && crate::storage::is_uuid_shaped(asset_id) =>
        {
            Some(ImageRequest::Asset {
                content_id: (*content_id).to_owned(),
                asset_id: (*asset_id).to_owned(),
            })
        }
        ["asset-thumb", content_id, asset_id]
            if crate::storage::is_uuid_shaped(content_id)
                && crate::storage::is_uuid_shaped(asset_id) =>
        {
            Some(ImageRequest::AssetThumb {
                content_id: (*content_id).to_owned(),
                asset_id: (*asset_id).to_owned(),
            })
        }
        _ => None,
    }
}

fn is_safe_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
}

fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = hex_digit(*bytes.get(index + 1)?)?;
            let low = hex_digit(*bytes.get(index + 2)?)?;
            output.push(high * 16 + low);
            index += 3;
        } else {
            output.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(output).ok()
}

fn hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn not_found() -> Response<Vec<u8>> {
    Response::builder()
        .status(404)
        .header("Content-Type", "text/plain; charset=utf-8")
        .body(Vec::new())
        .expect("static 404 response is valid")
}

fn image_response(bytes: Vec<u8>, content_type: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(200)
        .header("Content-Type", content_type)
        .header("Cache-Control", "public, max-age=31536000, immutable")
        .body(bytes)
        .unwrap_or_else(|_| not_found())
}

/// Build the response for one protocol request.
pub fn respond(app: &tauri::AppHandle, raw_path: &str) -> Response<Vec<u8>> {
    let Some(request) = parse_request_path(raw_path) else {
        return not_found();
    };
    let Some(storage) = app.try_state::<SharedStorage>() else {
        return not_found();
    };
    let resolved = {
        let mut store = storage
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        match &request {
            ImageRequest::Thumb(id) | ImageRequest::Full(id) => store.resolve_image(id),
            ImageRequest::Asset {
                content_id,
                asset_id,
            }
            | ImageRequest::AssetThumb {
                content_id,
                asset_id,
            } => store.resolve_asset(content_id, asset_id),
        }
    };
    let Ok(resolved) = resolved else {
        return not_found();
    };
    match request {
        ImageRequest::Thumb(id) => thumb_or_original(&id, &resolved),
        ImageRequest::AssetThumb { asset_id, .. } => thumb_or_original(&asset_id, &resolved),
        // Originals: content images and rich-text assets alike.
        ImageRequest::Full(_) | ImageRequest::Asset { .. } => serve_original(&resolved),
    }
}

fn serve_original(resolved: &ResolvedImage) -> Response<Vec<u8>> {
    match std::fs::read(&resolved.path) {
        Ok(bytes) => image_response(bytes, &resolved.mime),
        Err(error) => {
            eprintln!(
                "[protocol] cannot read {}: {error}",
                resolved.path.display()
            );
            not_found()
        }
    }
}

fn thumb_or_original(cache_id: &str, resolved: &ResolvedImage) -> Response<Vec<u8>> {
    match thumbnail(cache_id, resolved) {
        Some((bytes, content_type)) => image_response(bytes, &content_type),
        None => serve_original(resolved),
    }
}

/// `(bytes, content type)` for the cached/generated thumbnail, or `None` when
/// the original should be served unchanged (GIF or already small enough).
fn thumbnail(id: &str, image: &ResolvedImage) -> Option<(Vec<u8>, String)> {
    if image.gif {
        return None;
    }
    let (width, height) = intrinsic_size(image);
    if width == 0 || height == 0 {
        return None;
    }
    let longest = width.max(height) as f64;
    if longest <= THUMB_LONGEST_SIDE {
        return None;
    }
    for (extension, content_type) in [("png", "image/png"), ("jpg", "image/jpeg")] {
        let cached = image.cache_dir.join(format!("{id}.{extension}"));
        if let Ok(bytes) = std::fs::read(&cached) {
            return Some((bytes, content_type.to_owned()));
        }
    }

    let decoded = image::ImageReader::open(&image.path)
        .ok()?
        .with_guessed_format()
        .ok()?
        .decode()
        .ok()?;
    let scale = THUMB_LONGEST_SIDE / longest;
    let target_width = ((width as f64 * scale).round() as u32).max(1);
    let target_height = ((height as f64 * scale).round() as u32).max(1);
    // `thumbnail` is the integer fast path: one pass, no Lanczos kernels, and
    // it preserves the aspect ratio while fitting inside the target box.
    let resized = decoded.thumbnail(target_width, target_height);
    let (bytes, extension, content_type) = if has_transparency(&resized) {
        let rgba = resized.to_rgba8();
        let bytes = crate::storage::encode_png(rgba.as_raw(), rgba.width(), rgba.height()).ok()?;
        (bytes, "png", "image/png")
    } else {
        let rgb = resized.to_rgb8();
        let bytes = crate::storage::encode_jpeg(rgb.as_raw(), rgb.width(), rgb.height()).ok()?;
        (bytes, "jpg", "image/jpeg")
    };
    // Concurrent requests may generate the same thumbnail: each writes a temp
    // file and replaces the destination atomically, so the cache never holds a
    // half-written image.
    let path = image.cache_dir.join(format!("{id}.{extension}"));
    if let Err(error) = crate::storage::write_atomic_bytes(&path, &bytes) {
        eprintln!("[protocol] cannot cache thumbnail {}: {error}", path.display());
    }
    Some((bytes, content_type.to_owned()))
}

fn intrinsic_size(image: &ResolvedImage) -> (u32, u32) {
    if image.width > 0 && image.height > 0 {
        return (image.width, image.height);
    }
    read_image_dimensions(&image.path).unwrap_or((0, 0))
}

/// True only when a pixel is actually not fully opaque. A PNG that *has* an
/// alpha channel but is fully opaque can still be cached as JPEG.
fn has_transparency(image: &image::DynamicImage) -> bool {
    if !image.color().has_alpha() {
        return false;
    }
    image
        .to_rgba8()
        .pixels()
        .any(|pixel| pixel.0[3] != u8::MAX)
}

fn read_image_dimensions(path: &Path) -> Option<(u32, u32)> {
    let reader = image::ImageReader::open(path).ok()?.with_guessed_format().ok()?;
    reader.into_dimensions().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn original_content_and_assets_use_a_queue_separate_from_thumbnail_decodes() {
        let content = "6f1e0f3c-1234-4a5b-8c9d-0123456789ab";
        let asset = "7f1e0f3c-1234-4a5b-8c9d-0123456789ab";
        assert_eq!(request_lane("/full%2Fplain_id"), RequestLane::Original);
        assert_eq!(request_lane(&format!("/asset/{content}/{asset}")), RequestLane::Original);
        assert_eq!(request_lane("/thumb%2Fplain_id"), RequestLane::Thumbnail);
        assert_eq!(request_lane(&format!("/asset-thumb/{content}/{asset}")), RequestLane::Thumbnail);
        assert_eq!(request_lane("/full/../secret"), RequestLane::Thumbnail);

    }

    #[test]
    #[ignore = "Set PICBOARD_PROTOCOL_BENCH_PATHS to local image files; run --ignored --nocapture"]
    fn benchmark_original_lookup_and_read() {
        use std::time::Instant;
        let paths = std::env::var_os("PICBOARD_PROTOCOL_BENCH_PATHS").expect("benchmark input paths");
        let root = tempfile::tempdir().unwrap();
        let mut store = crate::storage::ImageBoardStorage::new(root.path().join("data"));
        for path in std::env::split_paths(&paths) {
            let bytes = std::fs::read(&path).unwrap();
            let name = path.file_name().unwrap().to_str().unwrap();
            let ingest_started = Instant::now();
            let saved = store.save_image_copy(name, &bytes).unwrap();
            let ingest_ms = ingest_started.elapsed().as_secs_f64() * 1000.0;
            // Ingestion is reported separately from the original read path.
            let mut lookup = Vec::new();
            let mut total = Vec::new();
            for _ in 0..20 {
                let started = Instant::now();
                let resolved = store.resolve_image(&saved.content_id).unwrap();
                lookup.push(started.elapsed().as_secs_f64() * 1000.0);
                let response = serve_original(&resolved);
                total.push(started.elapsed().as_secs_f64() * 1000.0);
                assert_eq!(response.status(), 200);
                assert_eq!(response.body(), &bytes, "original bytes remain unchanged");
            }
            lookup.sort_by(f64::total_cmp);
            total.sort_by(f64::total_cmp);
            eprintln!("PICBOARD_ORIGINAL_BENCH name={name} bytes={} ingest_ms={ingest_ms:.3} lookup_median_ms={:.3} lookup_max_ms={:.3} lookup_read_median_ms={:.3} lookup_read_max_ms={:.3}", bytes.len(), lookup[10], lookup[19], total[10], total[19]);
        }
    }

    #[test]
    fn accepts_thumb_and_full_for_plain_ids() {
        assert_eq!(
            parse_request_path("/thumb%2F6f1e0f3c-1234-4a5b-8c9d-0123456789ab"),
            Some(ImageRequest::Thumb(
                "6f1e0f3c-1234-4a5b-8c9d-0123456789ab".into()
            ))
        );
        assert_eq!(
            parse_request_path("/full/abc_123"),
            Some(ImageRequest::Full("abc_123".into()))
        );
        assert_eq!(
            parse_request_path("/full%2Fabc"),
            Some(ImageRequest::Full("abc".into()))
        );
    }

    #[test]
    fn rejects_traversal_unknown_variants_and_extra_segments() {
        // A percent-encoded slash inside the id creates a third segment.
        assert_eq!(parse_request_path("/thumb%2F..%2F..%2Fsecret"), None);
        assert_eq!(parse_request_path("/thumb%2F..%2Fsecret"), None);
        assert_eq!(parse_request_path("/full/.."), None);
        assert_eq!(parse_request_path("/full/."), None);
        assert_eq!(parse_request_path("/other/abc"), None);
        assert_eq!(parse_request_path("/thumb"), None);
        assert_eq!(parse_request_path("/thumb/abc/def"), None);
        assert_eq!(parse_request_path("thumb/abc"), Some(ImageRequest::Thumb("abc".into())));
        assert_eq!(parse_request_path("/thumb/"), None);
        assert_eq!(parse_request_path("/thumb/a%5Cb"), None);
        assert_eq!(parse_request_path("/thumb/%2e%2e"), None);
        // Windows drive letters cannot become a cache path prefix.
        assert_eq!(parse_request_path("/thumb/C%3Aevil"), None);
        // Invalid percent escapes are not guessed at.
        assert_eq!(parse_request_path("/thumb/%zz"), None);
        assert_eq!(parse_request_path("/thumb/%2"), None);
    }

    #[test]
    fn percent_decoding_handles_multibyte_utf8() {
        assert_eq!(percent_decode("%E4%B8%AD"), Some("中".to_owned()));
        assert_eq!(percent_decode("plain"), Some("plain".to_owned()));
        assert_eq!(percent_decode("%FF"), None);
    }

    const CONTENT: &str = "33333333-3333-4333-8333-333333333333";
    const ASSET: &str = "44444444-4444-4444-8444-444444444444";

    #[test]
    fn accepts_asset_and_asset_thumb_routes() {
        assert_eq!(
            parse_request_path(&format!("/asset%2F{CONTENT}%2F{ASSET}")),
            Some(ImageRequest::Asset {
                content_id: CONTENT.into(),
                asset_id: ASSET.into(),
            })
        );
        assert_eq!(
            parse_request_path(&format!("/asset-thumb/{CONTENT}/{ASSET}")),
            Some(ImageRequest::AssetThumb {
                content_id: CONTENT.into(),
                asset_id: ASSET.into(),
            })
        );
        // Plain segments work for assets too (no encoding required).
        assert_eq!(
            parse_request_path(&format!("/asset/{CONTENT}/{ASSET}")),
            Some(ImageRequest::Asset {
                content_id: CONTENT.into(),
                asset_id: ASSET.into(),
            })
        );
    }

    #[test]
    fn rejects_asset_routes_with_bad_ids_or_extra_segments() {
        assert_eq!(parse_request_path("/asset/not-a-uuid/abc"), None);
        assert_eq!(
            parse_request_path(&format!("/asset/{CONTENT}/not-a-uuid")),
            None
        );
        assert_eq!(
            parse_request_path(&format!("/asset%2F{CONTENT}%2F{ASSET}%2Fextra")),
            None
        );
        assert_eq!(parse_request_path(&format!("/asset-thumb/{CONTENT}")), None);
        // A percent-encoded traversal inside an id is rejected by the id shape.
        assert_eq!(
            parse_request_path(&format!("/asset%2F..%2F..%2F{CONTENT}%2F{ASSET}")),
            None
        );
        // The content-image routes keep their own id rules.
        assert!(matches!(
            parse_request_path("/thumb/abc"),
            Some(ImageRequest::Thumb(_))
        ));
    }

    fn resolved(
        path: &Path,
        width: u32,
        height: u32,
        gif: bool,
        cache: &Path,
    ) -> ResolvedImage {
        ResolvedImage {
            path: path.to_path_buf(),
            mime: "image/png".into(),
            width,
            height,
            gif,
            cache_dir: cache.to_path_buf(),
        }
    }

    #[test]
    fn thumbnails_downscale_large_images_and_cache_the_encoding() {
        let temp = tempfile::tempdir().unwrap();
        let cache = temp.path().join("thumbs");

        // Opaque 2000x1000: 768x384, encoded as JPEG and cached.
        let opaque = temp.path().join("opaque.png");
        let pixels = vec![255u8; 2000 * 1000 * 4];
        std::fs::write(
            &opaque,
            crate::storage::encode_png(&pixels, 2000, 1000).unwrap(),
        )
        .unwrap();
        let image = resolved(&opaque, 2000, 1000, false, &cache);
        let (thumb, mime) = thumbnail("opaque", &image).expect("generated");
        assert_eq!(mime, "image/jpeg");
        let decoded = image::load_from_memory(&thumb).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (768, 384));
        assert!(cache.join("opaque.jpg").is_file());
        // The cache is reused instead of re-encoding.
        let (cached, mime) = thumbnail("opaque", &image).unwrap();
        assert_eq!(mime, "image/jpeg");
        assert_eq!(cached, thumb);

        // Transparent pixels keep PNG; the intrinsic size is read from the file
        // when the record has none.
        let transparent = temp.path().join("transparent.png");
        let mut pixels = vec![255u8; 1200 * 900 * 4];
        for pixel in pixels.chunks_exact_mut(4) {
            pixel[3] = 0;
        }
        std::fs::write(
            &transparent,
            crate::storage::encode_png(&pixels, 1200, 900).unwrap(),
        )
        .unwrap();
        let image = resolved(&transparent, 0, 0, false, &cache);
        let (thumb, mime) = thumbnail("transparent", &image).expect("generated");
        assert_eq!(mime, "image/png");
        let decoded = image::load_from_memory(&thumb).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (768, 576));
        assert!(cache.join("transparent.png").is_file());
    }

    #[test]
    fn thumbnails_skip_small_and_animated_images() {
        let temp = tempfile::tempdir().unwrap();
        let cache = temp.path().join("thumbs");
        let small = temp.path().join("small.png");
        std::fs::write(
            &small,
            crate::storage::encode_png(&vec![255u8; 100 * 50 * 4], 100, 50).unwrap(),
        )
        .unwrap();
        assert_eq!(thumbnail("small", &resolved(&small, 100, 50, false, &cache)), None);
        // Exactly 768 on the longest side is served as the original.
        assert_eq!(thumbnail("edge", &resolved(&small, 768, 500, false, &cache)), None);
        // GIFs are never re-encoded (animation would be lost).
        assert_eq!(thumbnail("anim", &resolved(&small, 4000, 4000, true, &cache)), None);
        assert!(!cache.exists());
    }
}
