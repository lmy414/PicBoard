//! Windows-specific low-level helper: physical cursor position. All
//! coordinates here are physical pixels; the host keeps the monitor/work-area
//! logic in the window controller so scaling stays in one place.

use crate::error::AppError;

/// Current physical cursor position from Win32 (used by the titlebar drag).
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
