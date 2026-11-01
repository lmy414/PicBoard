//! System tray icon.
//!
//! LEFT click toggles the tray flyout panel (anchored to the clicked icon);
//! RIGHT click opens the native menu with 打开 PicBoard / 退出.

use crate::error::AppError;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

const TRAY_ID: &str = "picboard-tray";
const MENU_OPEN: &str = "tray-open";
const MENU_QUIT: &str = "tray-quit";

/// Build and attach the tray icon. Called once at startup.
pub fn setup_tray(app: &AppHandle) -> Result<(), AppError> {
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| AppError::message("缺少托盘图标"))?;

    let open = MenuItem::with_id(app, MENU_OPEN, "打开 PicBoard", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "退出", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&open, &PredefinedMenuItem::separator(app)?, &quit],
    )?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("PicBoard")
        .menu(&menu)
        .show_menu_on_left_click(false);

    builder = builder.on_menu_event(move |handle, event| {
        // Tray menu events arrive inside a shell COM callback: defer the
        // window APIs to a worker thread.
        let handle = handle.clone();
        let action = if event.id() == MENU_QUIT {
            Some(false)
        } else if event.id() == MENU_OPEN {
            Some(true)
        } else {
            None
        };
        if let Some(open) = action {
            crate::platform::spawn_worker("picboard-tray-menu", move || {
                if open {
                    if let Err(error) = show_main(&handle) {
                        eprintln!("[tray] open failed: {error}");
                    }
                } else {
                    handle.exit(0);
                }
            });
        }
    });

    let toggle_app = app.clone();
    builder = builder.on_tray_icon_event(move |_tray, event| {
        // Tray click events arrive inside a shell COM callback: the toggle
        // (which calls window APIs) is deferred to a worker thread, and the
        // physical icon rect is copied out of the event first. The tray rect
        // is documented in physical pixels.
        let click = match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                rect:
                    tauri::Rect {
                        position: tauri::Position::Physical(position),
                        size: tauri::Size::Physical(size),
                    },
                ..
            } => Some((
                f64::from(position.x),
                f64::from(position.y),
                f64::from(size.width),
                f64::from(size.height),
            )),
            _ => None,
        };
        if let Some((icon_x, icon_y, icon_width, icon_height)) = click {
            // `State` borrows from the app handle; move the handle instead.
            let handle = toggle_app.clone();
            crate::platform::spawn_worker("picboard-tray-click", move || {
                handle
                    .state::<crate::window_controller::WindowController>()
                    .toggle_tray_panel_at(icon_x, icon_y, icon_width, icon_height);
            });
        }
    });

    builder.build(app)?;
    Ok(())
}

fn show_main(handle: &AppHandle) -> Result<(), AppError> {
    handle.state::<crate::window_controller::WindowController>().show_main_window(handle, None)
}
