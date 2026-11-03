//! Local image opening/export. No original is overwritten by library edits.
use crate::dto::{ImageOpenResult, ImportImagePayload};
use crate::error::AppError;
use crate::SharedStorage;
use std::path::{Path, PathBuf};
use std::collections::VecDeque;
use std::sync::{mpsc, Arc, Mutex};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

pub const EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "bmp", "gif"];
const MAX_BYTES: usize = 128 * 1024 * 1024;
/// Launch paths can arrive before storage or either webview exists. One lock
/// owns the queue and delivery handoff; it is never held across storage/window APIs.
#[derive(Default)]
pub struct PendingImage {
    state: Arc<Mutex<PendingImageState>>,
}

#[derive(Default)]
struct PendingImageState {
    paths: VecDeque<PathBuf>,
    setup_ready: bool,
    activation_requested: bool,
    wake: Option<mpsc::Sender<()>>,
    renderer_ready: bool,
    content_id: Option<String>,
}

impl PendingImage {
    fn lock(&self) -> std::sync::MutexGuard<'_, PendingImageState> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub(crate) fn enqueue(&self, paths: impl IntoIterator<Item = PathBuf>) {
        let mut state = self.lock();
        state.paths.extend(paths);
        if !state.paths.is_empty() {
            if let Some(wake) = &state.wake {
                let _ = wake.send(());
            }
        }
    }

    /// Unlike a first launch, manually running a second instance without an
    /// image is an explicit request to activate the existing main window.
    fn enqueue_second_instance(&self, args: &[String], cwd: &Path) {
        let paths = paths_from_args(args, cwd);
        if paths.is_empty() && !args.iter().any(|arg| arg == "--autostart") {
            self.lock().activation_requested = true;
        }
        self.enqueue(paths);
    }

    fn activation_ready(&self) -> bool {
        let state = self.lock();
        state.setup_ready && state.activation_requested
    }

    fn take_activation(&self) -> bool {
        let mut state = self.lock();
        state.setup_ready && std::mem::take(&mut state.activation_requested)
    }

    pub(crate) fn mark_setup_ready(&self) {
        self.lock().setup_ready = true;
    }

    /// Claim the one worker only after all host surfaces and close handling
    /// exist. Empty/autostart launches do not even create an image worker.
    fn worker_channel(&self) -> Option<ImageWorkerLease> {
        let mut state = self.lock();
        if !state.setup_ready || state.paths.is_empty() || state.wake.is_some() {
            return None;
        }
        let (wake, receiver) = mpsc::channel();
        let _ = wake.send(());
        state.wake = Some(wake);
        Some(ImageWorkerLease { state: Arc::clone(&self.state), receiver })
    }

    fn next_path(&self) -> Option<PathBuf> {
        self.lock().paths.pop_front()
    }

    /// Exactly one navigation route: before the renderer handshake keep the
    /// latest result for take_pending_image; afterwards only emit image:opened.
    fn publish(&self, content_id: String) -> bool {
        let mut state = self.lock();
        if state.renderer_ready {
            true
        } else {
            state.content_id = Some(content_id);
            false
        }
    }

    fn take_for_renderer(&self) -> Option<String> {
        let mut state = self.lock();
        state.renderer_ready = true;
        state.content_id.take()
    }

    pub(crate) fn renderer_loading(&self) {
        self.lock().renderer_ready = false;
    }
}

/// Dropping an unstarted worker (including spawn_worker failure) releases its
/// claim without removing any paths, so the next request can retry safely.
struct ImageWorkerLease {
    state: Arc<Mutex<PendingImageState>>,
    receiver: mpsc::Receiver<()>,
}

impl ImageWorkerLease {
    fn wait(&self) -> Result<(), mpsc::RecvError> {
        self.receiver.recv()
    }
}

impl Drop for ImageWorkerLease {
    fn drop(&mut self) {
        self.state.lock().unwrap_or_else(|p| p.into_inner()).wake = None;
    }
}

pub fn validate_image(bytes: &[u8]) -> Result<(), AppError> {
    if bytes.is_empty() || bytes.len() > MAX_BYTES { return Err(AppError::message("图片文件大小须在 128 MB 以内")); }
    let reader = image::ImageReader::new(std::io::Cursor::new(bytes)).with_guessed_format()?;
    let (width, height) = reader.into_dimensions().map_err(|_| AppError::message("无法识别图片，支持 PNG、JPEG、WebP、BMP 和 GIF"))?;
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 40_000_000 {
        return Err(AppError::message("图片尺寸超过上限（4000 万像素）"));
    }
    Ok(())
}

pub fn open_path(app: &tauri::AppHandle, path: &Path) -> Result<ImageOpenResult, AppError> {
    let metadata = std::fs::metadata(path)?;
    if !metadata.is_file() || metadata.len() > MAX_BYTES as u64 { return Err(AppError::message("图片文件不可用或超过 128 MB")); }
    let bytes = std::fs::read(path)?;
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let storage = app.state::<SharedStorage>();
    let result = storage.lock().unwrap_or_else(|p| p.into_inner()).save_image_copy(&name, &bytes)?;
    let _ = app.emit(crate::STATE_CHANGED_EVENT, &result.state);
    Ok(result)
}

/// Options consume their values; a data-root ending in .png is never opened.
pub fn paths_from_args(args: &[String], cwd: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let mut skip = false;
    for arg in args.iter().skip(1) {
        if skip { skip = false; continue; }
        if arg == "--data-root" || arg == "--preferences-export" { skip = true; continue; }
        if arg.starts_with('-') { continue; }
        let path = PathBuf::from(arg);
        if !path.extension().and_then(|v| v.to_str()).is_some_and(|v| EXTENSIONS.contains(&v.to_ascii_lowercase().as_str())) { continue; }
        paths.push(if path.is_absolute() { path } else { cwd.join(path) });
    }
    paths
}

pub fn receive_args(app: &tauri::AppHandle, args: Vec<String>, cwd: String) {
    if let Some(pending) = app.try_state::<PendingImage>() {
        pending.enqueue_second_instance(&args, Path::new(&cwd));
    }
    process_pending_activation(app);
    process_pending_images(app);
}

/// A second manual launch may arrive while setup is still constructing the
/// windows. Consume its buffered activation only inside a started worker:
/// thread-spawn failure leaves it pending for the next attempt.
pub(crate) fn process_pending_activation(app: &tauri::AppHandle) {
    let Some(pending) = app.try_state::<PendingImage>() else { return; };
    if !pending.activation_ready() { return; }
    let app = app.clone();
    crate::platform::spawn_worker("picboard-main-activate", move || {
        if !app.state::<PendingImage>().take_activation() { return; }
        if let Some(controller) = app.try_state::<crate::window_controller::WindowController>() {
            if let Err(error) = controller.show_main_window(&app, None) {
                eprintln!("[image-open] main activation failed: {error}");
            }
        }
    });
}

/// Drain until quiet, including paths received while another image is being
/// ingested. Returning false prevents an empty launch from revealing main.
fn drain_paths(pending: &PendingImage, mut open: impl FnMut(PathBuf)) -> bool {
    let mut processed = false;
    while let Some(path) = pending.next_path() {
        processed = true;
        open(path);
    }
    processed
}

/// Shared by setup and second-instance requests. The readiness gate is owned
/// by PendingImage, not the mere presence of storage (which is managed earlier).
pub(crate) fn process_pending_images(app: &tauri::AppHandle) {
    let Some(pending) = app.try_state::<PendingImage>() else { return; };
    let Some(worker) = pending.worker_channel() else { return; };
    let app = app.clone();
    crate::platform::spawn_worker("picboard-open-image", move || {
        while worker.wait().is_ok() {
            let pending = app.state::<PendingImage>();
            let processed = drain_paths(&pending, |path| {
                match open_path(&app, &path) {
                    Ok(result) => {
                        if pending.publish(result.content_id.clone()) {
                            let _ = app.emit_to("main", "image:opened", &result);
                        }
                    }
                    Err(error) => {
                        eprintln!("[image-open] {error}");
                        let _ = app.emit_to("main", "image:open-error", error.to_string());
                    }
                }
            });
            if processed {
                if let Some(controller) = app.try_state::<crate::window_controller::WindowController>() {
                    let _ = controller.show_main_window(&app, None);
                }
            }
        }
    });
}

#[tauri::command]
pub async fn open_image_file(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<Option<ImageOpenResult>, AppError> {
    let (tx, rx) = std::sync::mpsc::channel();
    window.dialog().file().set_title("打开图片").add_filter("图片", EXTENSIONS).pick_file(move |file| { let _ = tx.send(file.and_then(|file| file.as_path().map(Path::to_path_buf))); });
    let picked = rx.recv().map_err(|_| AppError::message("文件选择器未返回结果"))?;
    picked.map(|path| open_path(&app, &path)).transpose()
}

#[tauri::command]
pub fn take_pending_image(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<Option<ImageOpenResult>, AppError> {
    if window.label() != "main" { return Ok(None); }
    let id = app.state::<PendingImage>().take_for_renderer();
    // Retry an earlier failed worker spawn without taking any queued path on
    // this UI-thread command. The renderer's listener is now registered.
    process_pending_images(&app);
    id.map(|content_id| { let state = app.state::<SharedStorage>().lock().unwrap_or_else(|p| p.into_inner()).load_state()?; Ok(ImageOpenResult { state, content_id }) }).transpose()
}

#[derive(serde::Serialize)]
pub struct ImageBytes { data: Vec<u8>, mime: String }
#[tauri::command]
pub async fn read_image(app: tauri::AppHandle, content_id: String) -> Result<ImageBytes, AppError> {
    let image = app.state::<SharedStorage>().lock().unwrap_or_else(|p| p.into_inner()).resolve_image(&content_id)?;
    let data = std::fs::read(image.path)?;
    validate_image(&data)?;
    Ok(ImageBytes { data, mime: image.mime })
}

#[tauri::command]
pub async fn save_image_copy(app: tauri::AppHandle, image: ImportImagePayload) -> Result<ImageOpenResult, AppError> {
    let result = app.state::<SharedStorage>().lock().unwrap_or_else(|p| p.into_inner()).save_image_copy(&image.name, &image.data)?;
    let _ = app.emit(crate::STATE_CHANGED_EVENT, &result.state);
    Ok(result)
}

#[tauri::command]
pub async fn export_image(window: tauri::WebviewWindow, image: ImportImagePayload) -> Result<Option<String>, AppError> {
    validate_image(&image.data)?;
    let format = image::guess_format(&image.data).map_err(|_| AppError::message("导出格式无效"))?;
    let extension = match format { image::ImageFormat::Png => "png", image::ImageFormat::Jpeg => "jpg", image::ImageFormat::WebP => "webp", _ => return Err(AppError::message("仅支持导出 PNG、JPEG 和 WebP")) };
    let (tx, rx) = std::sync::mpsc::channel();
    window.dialog().file().set_title("另存图片").set_file_name(&image.name).add_filter(extension.to_uppercase(), &[extension]).save_file(move |file| { let _ = tx.send(file.and_then(|file| file.as_path().map(Path::to_path_buf))); });
    let path = rx.recv().map_err(|_| AppError::message("保存对话框未返回结果"))?;
    let Some(path) = path else { return Ok(None); };
    let selected_extension = path.extension().and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase();
    if selected_extension != extension && !(extension == "jpg" && selected_extension == "jpeg") {
        return Err(AppError::message(format!("文件扩展名须为 .{extension}，请重新选择保存位置")));
    }
    std::fs::write(&path, image.data)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn launch_arguments_skip_options_and_accept_unicode_paths() {
        let args = ["app.exe", "--data-root", "data.png", "--open", "中文 空格.JPG", "unrelated.txt"].map(String::from);
        assert_eq!(paths_from_args(&args, Path::new("C:/pictures")), vec![Path::new("C:/pictures").join("中文 空格.JPG")]);
    }
    #[test] fn rejects_invalid_image_data() { assert!(validate_image(b"not an image").is_err()); }

    #[test]
    fn early_launches_queue_in_order_until_host_setup_finishes() {
        let pending = PendingImage::default();
        pending.enqueue([PathBuf::from("initial.png")]);
        pending.enqueue([PathBuf::from("second-instance.jpg")]);
        assert!(pending.worker_channel().is_none());
        // A renderer signal cannot bypass the independent host setup gate.
        assert!(pending.take_for_renderer().is_none());
        assert!(pending.worker_channel().is_none());
        pending.mark_setup_ready();
        let _worker = pending.worker_channel().expect("host is ready");
        assert!(pending.worker_channel().is_none());
        let mut opened = Vec::new();
        assert!(drain_paths(&pending, |path| opened.push(path)));
        assert_eq!(opened, [PathBuf::from("initial.png"), PathBuf::from("second-instance.jpg")]);
    }

    #[test]
    fn initial_normal_and_autostart_launches_leave_visibility_to_readiness() {
        for args in [vec!["app.exe"], vec!["app.exe", "--autostart"]] {
            let pending = PendingImage::default();
            let args: Vec<String> = args.into_iter().map(String::from).collect();
            pending.enqueue(paths_from_args(&args, Path::new("C:/pictures")));
            pending.mark_setup_ready();
            assert!(!pending.activation_ready());
            assert!(pending.worker_channel().is_none());
            assert!(!drain_paths(&pending, |_| panic!("an empty launch ingested an image")));
        }
    }

    #[test]
    fn requests_arriving_during_ingestion_are_not_lost_or_repeated() {
        let pending = PendingImage::default();
        pending.enqueue([PathBuf::from("first.png")]);
        pending.mark_setup_ready();
        let _worker = pending.worker_channel().unwrap();
        let mut opened = Vec::new();
        assert!(drain_paths(&pending, |path| {
            if path == Path::new("first.png") {
                pending.enqueue([PathBuf::from("arrived-during-ingest.png")]);
            }
            opened.push(path);
        }));
        assert_eq!(opened.len(), 2);
        assert_eq!(opened[1], Path::new("arrived-during-ingest.png"));
        assert!(!drain_paths(&pending, |_| panic!("a path was ingested twice")));
    }

    #[test]
    fn a_request_after_the_queue_drains_wakes_the_existing_worker() {
        let pending = PendingImage::default();
        pending.enqueue([PathBuf::from("first.png")]);
        pending.mark_setup_ready();
        let worker = pending.worker_channel().unwrap();
        worker.wait().unwrap();
        assert!(drain_paths(&pending, |_| {}));
        pending.enqueue([PathBuf::from("later.png")]);
        worker.wait().unwrap();
        assert!(pending.worker_channel().is_none());
        let mut opened = Vec::new();
        assert!(drain_paths(&pending, |path| opened.push(path)));
        assert_eq!(opened, [PathBuf::from("later.png")]);
    }

    #[test]
    fn failed_worker_spawn_releases_the_claim_and_keeps_queued_paths() {
        let pending = PendingImage::default();
        pending.enqueue([PathBuf::from("retry.png")]);
        pending.mark_setup_ready();
        let worker = pending.worker_channel().unwrap();
        // spawn_worker drops the unstarted closure if thread creation fails.
        let unstarted_worker = move || { let _ = worker.wait(); };
        drop(unstarted_worker);
        let _retry = pending.worker_channel().expect("spawn failure must be retryable");
        assert_eq!(pending.next_path(), Some(PathBuf::from("retry.png")));
    }

    #[test]
    fn concurrent_single_instance_requests_are_all_ingested_once() {
        let pending = Arc::new(PendingImage::default());
        let mut writers = Vec::new();
        for producer in 0..4 {
            let pending = Arc::clone(&pending);
            writers.push(std::thread::spawn(move || {
                for image in 0..25 {
                    pending.enqueue([PathBuf::from(format!("{producer}-{image}.png"))]);
                }
            }));
        }
        for writer in writers { writer.join().unwrap(); }
        pending.mark_setup_ready();
        let _worker = pending.worker_channel().unwrap();
        let mut opened = std::collections::HashSet::new();
        assert!(drain_paths(&pending, |path| { assert!(opened.insert(path)); }));
        assert_eq!(opened.len(), 100);
    }

    #[test]
    fn the_renderer_handshake_chooses_one_delivery_route() {
        let pending = PendingImage::default();
        assert!(!pending.publish("first".into()));
        assert!(!pending.publish("latest".into()));
        assert_eq!(pending.take_for_renderer().as_deref(), Some("latest"));
        assert!(pending.take_for_renderer().is_none());
        assert!(pending.publish("live-event".into()));
        assert!(pending.take_for_renderer().is_none());
    }

    #[test]
    fn completion_racing_the_renderer_handshake_is_delivered_exactly_once() {
        for _ in 0..64 {
            let pending = Arc::new(PendingImage::default());
            let barrier = Arc::new(std::sync::Barrier::new(2));
            let writer = {
                let pending = Arc::clone(&pending);
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    pending.publish("image".into())
                })
            };
            barrier.wait();
            let taken = pending.take_for_renderer();
            let emitted = writer.join().unwrap();
            assert_eq!(usize::from(taken.is_some()) + usize::from(emitted), 1);
            assert!(pending.take_for_renderer().is_none());
        }
    }

    #[test]
    fn reloading_main_buffers_new_images_until_the_new_listener_handshakes() {
        let pending = PendingImage::default();
        assert!(pending.take_for_renderer().is_none());
        assert!(pending.publish("before-reload".into()));
        pending.renderer_loading();
        assert!(!pending.publish("during-reload".into()));
        assert_eq!(pending.take_for_renderer().as_deref(), Some("during-reload"));
        assert!(pending.publish("after-reload".into()));
        assert!(pending.take_for_renderer().is_none());
    }

    #[test]
    fn a_second_manual_launch_activates_without_an_empty_image_worker() {
        let pending = PendingImage::default();
        pending.mark_setup_ready();
        pending.enqueue_second_instance(&["app.exe".into()], Path::new("C:/pictures"));
        assert!(pending.activation_ready());
        assert!(pending.take_activation());
        assert!(!pending.take_activation());
        assert!(pending.worker_channel().is_none());
    }

    #[test]
    fn a_second_autostart_launch_stays_silent() {
        let pending = PendingImage::default();
        pending.mark_setup_ready();
        pending.enqueue_second_instance(&["app.exe".into(), "--autostart".into()], Path::new("C:/pictures"));
        assert!(!pending.activation_ready());
        assert!(!pending.take_activation());
        assert!(pending.worker_channel().is_none());
    }

    #[test]
    fn an_early_second_manual_launch_waits_for_setup_and_is_consumed_once() {
        let pending = PendingImage::default();
        pending.enqueue_second_instance(&["app.exe".into()], Path::new("C:/pictures"));
        assert!(!pending.activation_ready());
        assert!(!pending.take_activation());
        assert!(pending.worker_channel().is_none());
        pending.mark_setup_ready();
        assert!(pending.activation_ready());
        // Scheduling does not consume the request: a failed spawn can retry.
        assert!(pending.activation_ready());
        assert!(pending.take_activation());
        assert!(!pending.activation_ready());
        assert!(pending.worker_channel().is_none());
    }

    #[test]
    fn a_second_launch_with_an_image_uses_image_delivery_not_empty_activation() {
        let pending = PendingImage::default();
        pending.enqueue_second_instance(&["app.exe".into(), "photo.png".into()], Path::new("C:/pictures"));
        pending.mark_setup_ready();
        assert!(!pending.activation_ready());
        assert!(pending.worker_channel().is_some());
        assert_eq!(pending.next_path(), Some(Path::new("C:/pictures").join("photo.png")));
    }
}
