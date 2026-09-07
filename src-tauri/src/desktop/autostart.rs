//! Launch-at-startup manager (Windows current-user Run key, HKCU only).
//!
//! Hard safety rules shared with the renderer contract:
//! - Debug/dev builds NEVER write an entry; the availability flag is `false`
//!   so the UI cannot even offer the toggle.
//! - Release builds only act when the user explicitly enables/disables it via
//!   `setDesktopSettings`; no implicit registration ever happens.
//! - The current system state is always read back from the registry before a
//!   response is returned; a failed read/write surfaces as an error instead of
//!   pretending success.
//! - Disabling only removes our own value name.

use crate::error::AppError;
use std::path::{Path, PathBuf};

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const VALUE_NAME: &str = "QuickImageBoard";

#[cfg(windows)]
mod sys {
    use super::*;
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS, WIN32_ERROR};
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegDeleteValueW, RegGetValueW, RegOpenKeyExW, RegSetValueExW, HKEY,
        HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE, REG_SZ, RRF_RT_REG_SZ, RRF_SUBKEY_WOW6464KEY,
    };

    pub fn read_command() -> Result<Option<PathBuf>, AppError> {
        let mut hkey: HKEY = std::ptr::null_mut();
        let key = RUN_KEY.encode_utf16().collect::<Vec<u16>>();
        let status: WIN32_ERROR =
            unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, key.as_ptr(), 0, KEY_READ, &mut hkey) };
        if status == ERROR_FILE_NOT_FOUND {
            return Ok(None);
        }
        if status != ERROR_SUCCESS {
            return Err(AppError::message(format!("无法打开启动项注册表：{status}")));
        }
        let mut buffer = vec![0u16; 1024];
        let mut size = (buffer.len() * 2) as u32;
        let mut kind: u32 = 0;
        let mut value_name = VALUE_NAME.encode_utf16().collect::<Vec<u16>>();
        value_name.push(0);
        let result = unsafe {
            RegGetValueW(
                hkey,
                std::ptr::null(),
                value_name.as_ptr(),
                RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY,
                &mut kind,
                buffer.as_mut_ptr() as *mut _,
                &mut size,
            )
        };
        unsafe {
            RegCloseKey(hkey);
        }
        if result == ERROR_FILE_NOT_FOUND {
            return Ok(None);
        }
        if result != ERROR_SUCCESS {
            return Err(AppError::message(format!("无法读取启动项注册表：{result}")));
        }
        buffer.truncate(size as usize / 2);
        let value = String::from_utf16_lossy(&buffer);
        let value = value.trim_end_matches('\0').trim().to_owned();
        if value.is_empty() {
            Ok(None)
        } else {
            Ok(Some(PathBuf::from(value)))
        }
    }

    pub fn set_command(command: &str) -> Result<(), AppError> {
        let mut hkey: HKEY = std::ptr::null_mut();
        let key = RUN_KEY.encode_utf16().collect::<Vec<u16>>();
        let status: WIN32_ERROR =
            unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, key.as_ptr(), 0, KEY_SET_VALUE, &mut hkey) };
        if status != ERROR_SUCCESS {
            return Err(AppError::message(format!(
                "无法打开启动项注册表（写入）：{status}"
            )));
        }
        let mut value_name = VALUE_NAME.encode_utf16().collect::<Vec<u16>>();
        value_name.push(0);
        let data: Vec<u16> = command.encode_utf16().collect();
        let result = unsafe {
            RegSetValueExW(
                hkey,
                value_name.as_ptr(),
                0,
                REG_SZ,
                data.as_ptr() as *const u8,
                (data.len() * 2) as u32,
            )
        };
        unsafe {
            RegCloseKey(hkey);
        }
        if result != ERROR_SUCCESS {
            return Err(AppError::message(format!(
                "无法写入启动项注册表：{result}"
            )));
        }
        Ok(())
    }

    pub fn remove_command() -> Result<(), AppError> {
        let mut hkey: HKEY = std::ptr::null_mut();
        let key = RUN_KEY.encode_utf16().collect::<Vec<u16>>();
        let status: WIN32_ERROR =
            unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, key.as_ptr(), 0, KEY_SET_VALUE, &mut hkey) };
        if status == ERROR_FILE_NOT_FOUND {
            return Ok(());
        }
        if status != ERROR_SUCCESS {
            return Err(AppError::message(format!(
                "无法打开启动项注册表（删除）：{status}"
            )));
        }
        let mut value_name = VALUE_NAME.encode_utf16().collect::<Vec<u16>>();
        value_name.push(0);
        let result = unsafe { RegDeleteValueW(hkey, value_name.as_ptr()) };
        unsafe {
            RegCloseKey(hkey);
        }
        if result != ERROR_SUCCESS && result != ERROR_FILE_NOT_FOUND {
            return Err(AppError::message(format!(
                "无法删除启动项注册表：{result}"
            )));
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod sys {
    use super::*;

    pub fn read_command() -> Result<Option<PathBuf>, AppError> {
        Err(AppError::message("仅支持 Windows 自启动管理"))
    }
    pub fn set_command(_command: &str) -> Result<(), AppError> {
        Err(AppError::message("仅支持 Windows 自启动管理"))
    }
    pub fn remove_command() -> Result<(), AppError> {
        Err(AppError::message("仅支持 Windows 自启动管理"))
    }
}

/// Launch entry descriptor. `available` reflects whether this build/runtime may
/// ever manage a real auto-start entry.
#[derive(Debug, Clone)]
pub struct AutoStartAvailability {
    pub available: bool,
}

pub struct AutoStartManager {
    availability: AutoStartAvailability,
    /// Absolute command of the current executable (release builds only).
    own_command: Option<PathBuf>,
}

impl AutoStartManager {
    /// Debug/dev builds report availability false and never touch the registry.
    pub fn new_dev() -> Self {
        Self {
            availability: AutoStartAvailability { available: false },
            own_command: None,
        }
    }

    /// Release build: auto-start is available for this executable path.
    pub fn new_release(exe: &Path) -> Self {
        Self {
            availability: AutoStartAvailability { available: true },
            own_command: Some(exe.to_path_buf()),
        }
    }

    pub fn availability(&self) -> &AutoStartAvailability {
        &self.availability
    }

    /// Current real system state. `false` also covers unsupported/dev builds.
    pub fn is_enabled(&self) -> bool {
        if !self.availability.available {
            return false;
        }
        let Some(own) = &self.own_command else {
            return false;
        };
        match sys::read_command() {
            Ok(Some(command)) => command == *own,
            Ok(None) => false,
            Err(error) => {
                eprintln!("[autostart] read failed: {error}");
                false
            }
        }
    }

    /// Enable/disable launch at startup. Only writes when this manager is
    /// available (release); failures surface as errors so the UI never shows a
    /// fabricated success.
    pub fn set_enabled(&self, enabled: bool) -> Result<(), AppError> {
        if !self.availability.available {
            return Err(AppError::message("当前为开发模式，不修改系统启动项"));
        }
        let Some(own) = &self.own_command else {
            return Err(AppError::message("无法确定本程序路径，未修改启动项"));
        };
        if enabled {
            let quoted = quote_command(own);
            sys::set_command(&quoted)?;
            // Read back to prove the real value before reporting success.
            match sys::read_command()? {
                Some(current) if current == *own => Ok(()),
                Some(_) => Err(AppError::message("系统启动项写入后读回不一致")),
                None => Err(AppError::message("系统启动项写入后未读回值")),
            }
        } else {
            sys::remove_command()?;
            if sys::read_command()?.is_some() {
                return Err(AppError::message("系统启动项删除后仍存在"));
            }
            Ok(())
        }
    }
}

/// Launch command quoted for the shell (a path with spaces must be quoted).
fn quote_command(exe: &Path) -> String {
    let raw = exe.to_string_lossy();
    if raw.starts_with('"') && raw.ends_with('"') {
        raw.into_owned()
    } else {
        format!("\"{raw}\"")
    }
}
