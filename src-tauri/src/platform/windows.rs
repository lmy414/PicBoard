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
fn left_button_is_released(state: i16) -> bool {
    (state as u16 & 0x8000) == 0
}

#[cfg(windows)]
pub fn left_button_released() -> bool {
    const VK_LBUTTON: i32 = 0x01;
    unsafe {
        left_button_is_released(
            windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(VK_LBUTTON) as i16,
        )
    }
}

#[cfg(not(windows))]
pub fn left_button_released() -> bool {
    true
}

#[cfg(test)]
mod tests {
    #[test]
    fn left_button_release_ignores_async_transition_bit() {
        assert!(super::left_button_is_released(0));
        assert!(super::left_button_is_released(1));
        assert!(!super::left_button_is_released(i16::MIN));
        assert!(!super::left_button_is_released(i16::MIN | 1));
    }
}
