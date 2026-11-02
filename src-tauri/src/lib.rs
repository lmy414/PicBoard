//! Tauri 2 host for PicBoard.
//!
//! Startup sequence (mirrors Electron `app.whenReady`):
//! 1. Resolve an explicit isolated data root (`--data-root`, env var, or legacy
//!    default). Dev runs always pass an explicit root via `npm run dev:rust`.
//! 2. Build storage and pre-load state so recovery/migration/default-creation
//!    failures surface before the renderer issues its first `loadState`.
//! 3. Create one borderless transparent always-on-top window (hidden until the
//!    page reports readiness) that loads the Vite dev URL in dev and the
//!    embedded dist in production.
//! 4. Start the clipboard monitor and the history-retention timer, register all
//!    commands (plus the `picboard` image protocol) and start cursor tracking
//!    once the page is ready.
//!
//! The bridge contract is `window.imageBoard` (see `shared/image-board.ts`);
//! renderer code only talks to that object.

mod clipboard;
mod commands;
mod desktop;
mod dto;
mod error;
mod image_files;
mod paths;
mod platform;
mod plugins;
mod preferences;
mod protocol;
pub(crate) mod retention;
pub(crate) mod startup_readiness;
mod storage;
mod window_controller;
mod window_geometry;

use crate::startup_readiness::StartupReadiness;
use crate::storage::ImageBoardStorage;
use crate::window_controller::WindowController;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

/// Every command layer shares this handle. Locking it serializes all
/// read-modify-write storage transactions.
pub(crate) type SharedStorage = Arc<Mutex<ImageBoardStorage>>;

/// Event emitted to the main window whenever background work (clipboard
/// capture, retention cleanup) changed the state.
pub(crate) const STATE_CHANGED_EVENT: &str = "state-changed";

/// Data root override that takes precedence over everything else. Dev scripts
/// pass `--data-root` so development never touches real user data.
fn data_root_override() -> Option<PathBuf> {
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--data-root" {
            if let Some(value) = args.next() {
                return Some(PathBuf::from(value));
            }
        }
    }
    std::env::var("QUICK_IMAGE_BOARD_DATA_ROOT")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
}

fn resolve_data_root() -> Result<PathBuf, error::AppError> {
    paths::resolve_root(data_root_override())
}

/// Optional validated preference export supplied via `--preferences-export`.
fn preference_export_path() -> Option<PathBuf> {
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--preferences-export" {
            if let Some(value) = args.next() {
                return Some(PathBuf::from(value));
            }
        }
    }
    None
}

fn install_preferences(app: &mut tauri::App) {
    let store = preferences::PreferenceStore::default();
    if let Some(path) = preference_export_path() {
        match preferences::load_preference_export(&path) {
            Ok(export) => {
                let normalized = preferences::normalize_export(export);
                eprintln!(
                    "[host] loaded {} preference key(s) from {}",
                    normalized.len(),
                    path.display()
                );
                store.install(normalized);
            }
            Err(error) => {
                eprintln!("[host] failed to load preference export: {error}");
            }
        }
    }
    app.manage(store);
}

/// True when the process was started by the Windows auto-start entry.
fn autostart_launch() -> bool {
    std::env::args().any(|arg| arg == "--autostart")
}

/// Show and focus the main window. Returns false when the reveal must be
/// deferred (auto-start launch, readiness not reached yet, or a failed
/// `show()`), in which case a later signal retries.
fn reveal_main_window(app: &tauri::AppHandle) -> bool {
    let Some(window) = app.get_webview_window("main") else {
        return false;
    };
    if window.show().is_err() {
        return false;
    }
    window.set_focus().ok();
    true
}

/// Defer the reveal onto a worker thread: `on_page_load` runs inside a
/// WebView2 COM event callback, and window APIs must never be invoked
/// re-entrantly from there (they marshal back to the UI thread from a worker).
fn spawn_main_reveal(app: &tauri::AppHandle) {
    let app = app.clone();
    crate::platform::spawn_worker("picboard-main-reveal", move || {
        if reveal_main_window(&app) {
            if let Some(readiness) = app.try_state::<StartupReadiness>() {
                readiness.mark_revealed("main");
            }
        }
    });
}

fn setup_app(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    install_preferences(app);
    // Desktop host: tray icon, close behavior, auto-start availability.
    crate::desktop::setup_desktop(app)?;
    let data_root = resolve_data_root()?;
    eprintln!("[host] data root: {}", data_root.display());

    // Pre-load the state once so corrupt-file recovery, v1 migration and
    // default creation happen before the first renderer call.
    let mut store = ImageBoardStorage::new(data_root);
    // Placement resolution needs the user's grid settings, including for the
    // one-time v1 relayout during migration.
    let desktop_prefs = app.state::<desktop::DesktopState>().current();
    store.set_layout_settings(desktop_prefs.snap_to_grid, desktop_prefs.grid_size.size());
    if let Err(error) = store.load_state() {
        eprintln!("[host] failed to preload state: {error}");
    }
    // Expire history once, before the renderer can read a stale snapshot.
    let retention_days = app
        .state::<desktop::DesktopState>()
        .current()
        .history_retention_days
        .days();
    match store.cleanup_history(chrono::Utc::now(), retention_days) {
        Ok((_, removed)) if removed > 0 => {
            eprintln!("[host] retention removed {removed} expired content(s)");
        }
        Ok(_) => {}
        Err(error) => eprintln!("[host] retention cleanup failed: {error}"),
    }
    let storage: SharedStorage = Arc::new(Mutex::new(store));
    app.manage(storage.clone());
    let args: Vec<String> = std::env::args().collect();
    let mut paths = image_files::paths_from_args(&args, &std::env::current_dir()?);
    paths.extend(std::mem::take(&mut *app.state::<image_files::PendingImage>().paths.lock().unwrap_or_else(|p| p.into_inner())));
    for path in paths {
        match image_files::open_path(app.handle(), &path) {
            Ok(result) => *app.state::<image_files::PendingImage>().content_id.lock().unwrap_or_else(|p| p.into_inner()) = Some(result.content_id),
            Err(error) => eprintln!("[image-open] {error}"),
        }
    }

    let window_controller = WindowController::new(app.handle().clone());
    app.manage(window_controller.clone());
    let readiness = StartupReadiness::default();
    app.manage(readiness.clone());
    let app_handle = app.handle().clone();

    // Background capture and retention both need the AppHandle and the shared
    // storage; they start after the storage is managed.
    let capture_enabled = app
        .state::<desktop::DesktopState>()
        .capture_enabled_flag();
    app.manage(clipboard::ClipboardMonitor::start(
        app_handle.clone(),
        storage.clone(),
        capture_enabled,
    ));
    app.manage(retention::RetentionTimer::start(
        app_handle.clone(),
        storage,
    ));

    // The main window reveals itself when its own page has loaded AND its
    // placement is applied — both signals are scoped to the "main" label, so
    // the tray webview (same bundle, also emits host:ready) can never consume
    // or delay main's reveal.
    let start_in_tray = autostart_launch();
    if start_in_tray {
        eprintln!("[host] auto-start launch: staying in the tray");
    }

    // Main window: a normal desktop window (frameless with the renderer's own
    // title bar). Created hidden; bounds/flags are applied before the reveal.
    let url = if tauri::is_dev() {
        WebviewUrl::External("http://127.0.0.1:5173".parse()?)
    } else {
        WebviewUrl::App("index.html".into())
    };
    let page_app = app_handle.clone();
    let page_state = readiness.clone();
    let page_start_in_tray = start_in_tray;
    let window = WebviewWindowBuilder::new(app, "main", url)
        .title("PicBoard")
        .inner_size(1000.0, 700.0)
        .resizable(true)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .visible(false)
        // Drag-in is not a feature: the native WebView2 drag/drop handler is
        // disabled so an OS-level file drop can never navigate or load the
        // dropped file; the renderer simply receives (and ignores) the DOM
        // events.
        .disable_drag_drop_handler()
        .on_page_load(move |_webview, payload| {
            let event = match payload.event() {
                tauri::webview::PageLoadEvent::Started => "Started",
                tauri::webview::PageLoadEvent::Finished => "Finished",
            };
            eprintln!("[host] page load event: {event} url={}", payload.url());
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                // Native page-load finished is the reveal fallback: the
                // renderer's host:ready cannot fire while the window is hidden
                // (WebView2 suspends rendering, so rAF never runs).
                if !page_start_in_tray {
                    page_state.mark_page_loaded("main");
                    if page_state.should_reveal("main") {
                        spawn_main_reveal(&page_app);
                    }
                }
            }
        })
        .build()?;
    window_controller.restore_main_bounds()?;

    // Tray flyout panel: created hidden so the first left click shows it
    // instantly. Same frontend, different surface.
    let tray_url = if tauri::is_dev() {
        WebviewUrl::External("http://127.0.0.1:5173/?surface=tray".parse()?)
    } else {
        WebviewUrl::App("index.html?surface=tray".into())
    };
    let tray_panel = WebviewWindowBuilder::new(app, "tray", tray_url)
        .title("PicBoard")
        .inner_size(
            window_geometry::TRAY_PANEL_WIDTH as f64,
            window_geometry::TRAY_PANEL_HEIGHT as f64,
        )
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .visible(false)
        .disable_drag_drop_handler()
        .build()?;
    // Hide the flyout whenever it loses focus (clicking elsewhere in the
    // system dismisses it, like any tray flyout). The hide is deferred to a
    // worker thread: window APIs must not run re-entrantly inside a window
    // event callback.
    let blur_panel = tray_panel.clone();
    tray_panel.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Focused(false)) {
            let panel = blur_panel.clone();
            crate::platform::spawn_worker("picboard-tray-blur", move || {
                let _ = panel.hide();
            });
        }
    });

    if !start_in_tray {
        readiness.mark_placement_done("main");
        if readiness.should_reveal("main") {
            spawn_main_reveal(app.handle());
        }
    }

    // Clean up background loops when the window is destroyed, and remember the
    // user's expanded-window bounds while they resize/move the panel.
    let close_app = app_handle.clone();
    let close_controller = window_controller.clone();
    window.on_window_event(move |event| {
        match event {
            WindowEvent::Resized(_) | WindowEvent::Moved(_) => {
                close_controller.note_window_geometry_changed();
            }
            WindowEvent::Destroyed => {
                // Worker loops may be inside native window APIs that marshal back to
                // the UI thread. Never join them from the UI destruction callback.
                // Signal-only teardown keeps this UI callback non-blocking; worker
                // handles are reclaimed on a separate thread.
                close_controller.request_teardown();
                if let Some(monitor) = close_app.try_state::<clipboard::ClipboardMonitor>() {
                    monitor.request_teardown();
                }
                if let Some(timer) = close_app.try_state::<retention::RetentionTimer>() {
                    timer.request_teardown();
                }
            }
            _ => {}
        }
    });

    // Intercept close requests: float/tray prevent the close and run their
    // own action; quit lets the window close naturally.
    crate::desktop::install_close_behavior(&window)?;

    // Initial visibility is owned by the one-shot readiness state. An
    // unconditional delayed show would undo a deliberate tray-hide.

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .manage(image_files::PendingImage::default())
        // Image bytes are served by this scheme (`convertFileSrc` on the
        // renderer side builds `http://picboard.localhost/thumb%2F<id>`).
        // Requests are queued to a fixed worker pool, so decoding and thumbnail
        // generation never run on the UI thread and never spawn one thread per
        // request.
        .register_asynchronous_uri_scheme_protocol("picboard", |context, request, responder| {
            protocol::submit(
                context.app_handle().clone(),
                request.uri().path().to_owned(),
                responder,
            );
        })
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| image_files::receive_args(app, args, cwd)))
        .plugin(tauri_plugin_dialog::init())
        .setup(setup_app)
        .invoke_handler(tauri::generate_handler![
            commands::bootstrap_preferences,
            commands::load_state,
            image_files::read_image,
            image_files::save_image_copy,
            image_files::export_image,
            image_files::open_image_file,
            image_files::take_pending_image,
            desktop::image_association::get_image_association,
            desktop::image_association::configure_image_association,
            commands::paste_clipboard,
            commands::place_content,
            commands::create_content_node,
            commands::set_active_canvas,
            commands::set_canvas_viewport,
            commands::create_canvas,
            commands::move_canvas,
            commands::set_canvas_frame,
            commands::group_nodes_into_canvas,
            commands::ungroup_canvas,
            commands::move_nodes_to_canvas,
            commands::rename_canvas,
            commands::delete_canvas,
            commands::move_nodes,
            commands::remove_nodes,
            commands::create_edge,
            commands::delete_edges,
            commands::get_content_body,
            commands::update_text_content,
            commands::update_link_content,
            commands::add_content_asset,
            commands::rename_image,
            commands::delete_contents,
            commands::copy_contents,
            commands::create_category,
            commands::classify_contents,
            commands::open_external_url,
            commands::list_plugins,
            commands::show_main_window,
            commands::hide_tray_panel,
            commands::minimize_window,
            commands::quit_app,
            commands::toggle_maximized,
            commands::start_titlebar_drag,
            commands::is_maximized,
            commands::close_window,
            commands::get_desktop_settings,
            commands::set_desktop_settings,
            commands::pick_directory,
        ]);
    let mut context = tauri::generate_context!();
    // Isolated dev/test data roots get independent single-instance channels.
    // A release with normal user data always keeps its stable application id.
    if let Some(root) = data_root_override() {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        root.hash(&mut hasher);
        context.config_mut().identifier = format!("com.quickimageboard.isolated.{:x}", hasher.finish());
    }
    builder
        .run(context)
        .expect("failed to run PicBoard");
}
