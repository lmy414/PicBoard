//! System tray icon, flyout gestures and native menu.

use super::host::{toggle_capture, DesktopState};
use crate::error::AppError;
use crate::window_controller::WindowController;
use crate::window_geometry::Rect;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

const TRAY_ID: &str = "picboard-tray";
const MENU_OPEN: &str = "tray-open";
const MENU_CAPTURE: &str = "tray-capture";
const MENU_QUIT: &str = "tray-quit";

struct CaptureMenuItem(MenuItem<tauri::Wry>);

fn capture_label(enabled: bool) -> &'static str {
    if enabled { "暂停记录" } else { "恢复记录" }
}

pub(super) fn update_capture_menu(app: &AppHandle, enabled: bool) {
    if let Some(menu) = app.try_state::<CaptureMenuItem>() {
        if let Err(error) = menu.0.set_text(capture_label(enabled)) {
            eprintln!("[tray] capture label update failed: {error}");
        }
    }
}

#[derive(Default)]
struct TrayClicks {
    next_visibility: Option<bool>,
    revision: usize,
}

impl TrayClicks {
    fn press(&mut self, visible: bool) {
        self.next_visibility = Some(!visible);
    }

    fn release(&mut self) -> Option<(bool, usize)> {
        let show = self.next_visibility.take()?;
        self.revision = self.revision.wrapping_add(1);
        Some((show, self.revision))
    }

    fn cancel(&mut self) {
        self.next_visibility = None;
        self.revision = self.revision.wrapping_add(1);
    }
}

fn double_click_interval() -> Duration {
    #[cfg(windows)]
    {
        let millis = unsafe { windows_sys::Win32::UI::Input::KeyboardAndMouse::GetDoubleClickTime() };
        Duration::from_millis(u64::from(millis))
    }
    #[cfg(not(windows))]
    {
        Duration::ZERO
    }
}

/// Build and attach the tray icon. Called once at startup.
pub fn setup_tray(app: &AppHandle) -> Result<(), AppError> {
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| AppError::message("缺少托盘图标"))?;

    let open = MenuItem::with_id(app, MENU_OPEN, "打开 PicBoard", true, None::<&str>)?;
    let capture = MenuItem::with_id(
        app,
        MENU_CAPTURE,
        capture_label(app.state::<DesktopState>().current().capture_enabled),
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "退出 PicBoard", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&open, &capture, &PredefinedMenuItem::separator(app)?, &quit],
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
        let id = event.id().clone();
        crate::platform::spawn_worker("picboard-tray-menu", move || {
            let result = match id.as_ref() {
                MENU_OPEN => show_main(&handle),
                MENU_CAPTURE => toggle_capture(&handle),
                MENU_QUIT => {
                    handle.exit(0);
                    Ok(())
                }
                _ => return,
            };
            if let Err(error) = result {
                eprintln!("[tray] menu action failed: {error}");
            }
        });
    });

    let clicks = Arc::new(Mutex::new(TrayClicks::default()));
    let toggle_app = app.clone();
    builder = builder.on_tray_icon_event(move |_tray, event| {
        let Some(controller) = toggle_app.try_state::<WindowController>() else {
            return;
        };
        let mut gesture = clicks.lock().unwrap_or_else(|poison| poison.into_inner());
        match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Down,
                ..
            } => gesture.press(controller.tray_is_shown()),
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                rect:
                    tauri::Rect {
                        position: tauri::Position::Physical(position),
                        size: tauri::Size::Physical(size),
                    },
                ..
            } => {
                if let Some((show, revision)) = gesture.release() {
                    let icon_rect = Rect {
                        x: position.x,
                        y: position.y,
                        width: size.width as i32,
                        height: size.height as i32,
                    };
                    let clicks = Arc::clone(&clicks);
                    let controller = controller.inner().clone();
                    crate::platform::spawn_worker("picboard-tray-click", move || {
                        std::thread::sleep(double_click_interval());
                        let current = clicks.lock().unwrap_or_else(|poison| poison.into_inner()).revision;
                        if current == revision {
                            if let Err(error) = controller.set_tray_panel_at(show, icon_rect) {
                                eprintln!("[tray] panel toggle failed: {error}");
                            }
                        }
                    });
                }
            }
            TrayIconEvent::DoubleClick { button: MouseButton::Left, .. } => {
                gesture.cancel();
                let handle = toggle_app.clone();
                crate::platform::spawn_worker("picboard-tray-double-click", move || {
                    if let Err(error) = show_main(&handle) {
                        eprintln!("[tray] open failed: {error}");
                    }
                });
            }
            TrayIconEvent::Click {
                button: MouseButton::Right,
                button_state: MouseButtonState::Down,
                ..
            } => gesture.cancel(),
            _ => {}
        }
    });

    builder.build(app)?;
    app.manage(CaptureMenuItem(capture));
    Ok(())
}

fn show_main(handle: &AppHandle) -> Result<(), AppError> {
    handle.state::<WindowController>().show_main_window(handle, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn double_click_cancels_the_first_release_and_ignores_its_own_release() {
        let mut clicks = TrayClicks::default();
        clicks.press(false);
        let (show, first) = clicks.release().unwrap();
        assert!(show);
        clicks.cancel();
        assert_ne!(clicks.revision, first);
        assert_eq!(clicks.release(), None);

        clicks.press(true);
        assert!(!clicks.release().unwrap().0);
    }
}
