//! System tray icon with 打开画板 / 收起 / 完全退出 actions.
//!
//! Events raised here are emitted to the renderer through the shared event
//! contract (`window:expanded-changed`) so React stays authoritative for
//! expanded state and no invoke round-trip loop is created.

use crate::error::AppError;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

const TRAY_ID: &str = "quick-image-board-tray";
const MENU_OPEN: &str = "tray-open";
const MENU_COLLAPSE: &str = "tray-collapse";
const MENU_QUIT: &str = "tray-quit";

/// Build and attach the tray icon. Called once at startup.
pub fn setup_tray(app: &AppHandle) -> Result<(), AppError> {
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| AppError::message("缺少托盘图标"))?;

    let open = MenuItem::with_id(app, MENU_OPEN, "打开画板", true, None::<&str>)?;
    let collapse = MenuItem::with_id(app, MENU_COLLAPSE, "收起", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "完全退出", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&open, &collapse, &PredefinedMenuItem::separator(app)?, &quit],
    )?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("快捷图片画布")
        .menu(&menu)
        .show_menu_on_left_click(false);

    builder = builder.on_menu_event(move |handle, event| {
        if event.id() == MENU_QUIT {
            handle.exit(0);
        } else if event.id() == MENU_OPEN || event.id() == MENU_COLLAPSE {
            let expanded = event.id() == MENU_OPEN;
            let result = (|| -> Result<(), AppError> {
                let window = handle
                    .get_webview_window("main")
                    .ok_or_else(|| AppError::message("主窗口不存在"))?;
                if expanded {
                    window.show()?;
                    window.set_focus()?;
                }
                // Resize the native window first, then tell the renderer. React
                // only listens; it never re-invokes, so no event recursion.
                crate::window_controller::set_window_expanded_state(handle, expanded)?;
                Ok(())
            })();
            if let Err(error) = result {
                eprintln!("[tray] action failed: {error}");
            }
        }
    });

    let open_app2 = app.clone();
    builder = builder.on_tray_icon_event(move |_tray, event| {
        // Left-click (single) on the tray opens the board; right-click shows the
        // context menu (Tauri default on Windows).
        if let TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        } = event
        {
            let result = (|| -> Result<(), AppError> {
                let window = open_app2
                    .get_webview_window("main")
                    .ok_or_else(|| AppError::message("主窗口不存在"))?;
                window.show()?;
                window.set_focus()?;
                crate::window_controller::set_window_expanded_state(&open_app2, true)?;
                Ok(())
            })();
            if let Err(error) = result {
                eprintln!("[tray] open failed: {error}");
            }
        }
    });

    builder.build(app)?;
    Ok(())
}

/// Emit the expanded-state change to the renderer (Tauri event name matches
/// the contract: `window:expanded-changed`).
pub fn emit_expanded(app: &AppHandle, expanded: bool) -> Result<(), AppError> {
    app.emit("window:expanded-changed", expanded)?;
    Ok(())
}
