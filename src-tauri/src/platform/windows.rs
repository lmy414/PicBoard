//! Windows-specific low-level helpers (cursor position and physical mouse
//! button state). All coordinates here are physical pixels. The host keeps the
//! full monitor/work-area logic in the window controller so scaling stays in
//! one place.

use crate::error::AppError;

/// Current physical cursor position from Win32.
#[cfg(windows)]
pub fn cursor_position() -> Result<(i32, i32), AppError> {
    unsafe {
        let mut point = windows_sys::Win32::Foundation::POINT { x: 0, y: 0 };
        if windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos(&mut point) == 0 {
            return Err(AppError::message("无法读取鼠标位置"));
        }
        Ok((point.x, point.y))
    }
}

#[cfg(not(windows))]
pub fn cursor_position() -> Result<(i32, i32), AppError> {
    Err(AppError::message("当前平台不支持鼠标位置读取"))
}

/// Physical left-button release detection (Win32). Returns true when the left
/// mouse button is currently up. Used as a host-side drag fallback because the
/// renderer may miss pointerup when the button is released outside the window.
#[cfg(windows)]
pub fn left_button_released() -> bool {
    const VK_LBUTTON: i32 = 0x01;
    const KEY_UP: i16 = 0;
    unsafe {
        // Short negative means "pressed"; zero means up.
        windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(VK_LBUTTON) as i16
            == KEY_UP
    }
}

#[cfg(not(windows))]
pub fn left_button_released() -> bool {
    true
}
