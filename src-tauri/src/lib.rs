//! Tauri 2 host for quick-image-board.
//!
//! Startup sequence (mirrors Electron `app.whenReady`):
//! 1. Resolve an explicit isolated data root (`--data-root`, env var, or legacy
//!    default). Dev runs always pass an explicit root via `npm run dev:rust`.
//! 2. Build storage and pre-load state so recovery/default-creation failures
//!    surface before the renderer issues its first `loadState`.
//! 3. Create one borderless transparent always-on-top window (hidden until the
//!    page reports readiness) that loads the Vite dev URL in dev and the
//!    embedded dist in production.
//! 4. Register all commands and start cursor tracking once the page is ready.
//!
//! The bridge contract is `window.imageBoard` (see `shared/image-board.ts`);
//! renderer code only talks to that object.

mod clipboard;
mod commands;
mod desktop;
mod dto;
mod error;
mod paths;
mod platform;
mod preferences;
pub(crate) mod startup_readiness;
mod storage;
mod window_controller;
mod window_geometry;

use crate::commands::SharedStorage;
use crate::startup_readiness::StartupReadiness;
use crate::storage::ImageBoardStorage;
use crate::window_controller::WindowController;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::Listener;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

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

fn reveal_initial_window(
    app: &tauri::AppHandle,
    controller: &WindowController,
    readiness: &StartupReadiness,
    page_ready: bool,
) {
    let reveal = || {
        let Some(window) = app.get_webview_window("main") else {
            return false;
        };
        let visible = window.is_visible().unwrap_or(false);
        if !visible && window.show().is_err() {
            return false;
        }
        controller.start_cursor_tracking();
        true
    };
    if page_ready {
        let _ = readiness.page_ready_and_reveal(reveal);
    } else {
        let _ = readiness.placement_ready_and_reveal(reveal);
    }
}

fn setup_app(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    install_preferences(app);
    // Desktop host: tray icon, close behavior, auto-start availability.
    crate::desktop::setup_desktop(app)?;
    let data_root = resolve_data_root()?;
    eprintln!("[host] data root: {}", data_root.display());

    // Pre-load the state once so corrupt-file recovery and default creation
    // happen before the first renderer call.
    let mut store = ImageBoardStorage::new(data_root);
    if let Err(error) = store.load_state() {
        eprintln!("[host] failed to preload state: {error}");
    }
    let storage: SharedStorage = Arc::new(Mutex::new(store));
    app.manage(storage);

    let window_controller = WindowController::new(app.handle().clone());
    app.manage(window_controller.clone());
    let readiness = StartupReadiness::default();
    app.manage(readiness.clone());
    let app_handle = app.handle().clone();

    // Register before creating the webview. The renderer emits `host:ready`
    // only once, so registering on the window after build can lose the event.
    let ready_app = app_handle.clone();
    let ready_controller = window_controller.clone();
    let ready_state = readiness.clone();
    let _ = app.listen("host:ready", move |_| {
        reveal_initial_window(&ready_app, &ready_controller, &ready_state, true);
    });

    // Create the main window hidden and undecorated.
    let url = if tauri::is_dev() {
        WebviewUrl::External("http://127.0.0.1:5173".parse()?)
    } else {
        WebviewUrl::App("index.html".into())
    };
    let page_app = app_handle.clone();
    let page_controller = window_controller.clone();
    let page_state = readiness.clone();
    let window = WebviewWindowBuilder::new(app, "main", url)
        .title("快捷图片画布")
        .inner_size(88.0, 88.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .visible(false)
        // The renderer implements its own HTML5 file drop handlers (both on the
        // collapsed ball and the expanded canvas). On Windows that only fires
        // when the native WebView2 drag/drop handler is disabled; otherwise the
        // webview swallows the OS-level drop before the DOM sees it.
        .disable_drag_drop_handler()
        .on_page_load(move |_webview, payload| {
            let event = match payload.event() {
                tauri::webview::PageLoadEvent::Started => "Started",
                tauri::webview::PageLoadEvent::Finished => "Finished",
            };
            eprintln!("[host] page load event: {event} url={}", payload.url());
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                // Native page-load finished is the fallback for a renderer
                // `host:ready` event lost during initial navigation.
                reveal_initial_window(&page_app, &page_controller, &page_state, true);
            }
        })
        .build()?;
    window_controller.place_initial()?;
    reveal_initial_window(&app_handle, &window_controller, &readiness, false);

    // Clean up background loops when the window is destroyed.
    let close_controller = window_controller.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Destroyed = event {
            // Worker loops may be inside native window APIs that marshal back to
            // the UI thread. Never join them from the UI destruction callback.
            // Signal-only teardown keeps this UI callback non-blocking; worker
            // handles are reclaimed on a separate thread.
            close_controller.request_teardown();
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
        .plugin(tauri_plugin_dialog::init())
        .setup(setup_app)
        .invoke_handler(tauri::generate_handler![
            commands::bootstrap_preferences,
            commands::load_state,
            commands::import_images,
            commands::paste_image,
            commands::set_active_canvas,
            commands::set_canvas_viewport,
            commands::create_canvas,
            commands::rename_canvas,
            commands::delete_canvas,
            commands::create_category,
            commands::classify_images,
            commands::remove_image_from_canvas,
            commands::move_image,
            commands::copy_image_files,
            commands::set_expanded,
            commands::close_window,
            commands::start_window_drag,
            commands::end_window_drag,
            commands::get_desktop_settings,
            commands::set_desktop_settings,
            commands::pick_directory,
        ]);
    builder
        .run(tauri::generate_context!())
        .expect("failed to run quick-image-board");
}
