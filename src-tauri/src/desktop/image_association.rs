//! Opt-in per-user file association registration; Windows owns default choice.
use crate::error::AppError;
use std::path::Path;

const CAPABILITIES: &str = r"Software\PicBoard\Capabilities";
const PROG_ID: &str = "PicBoard.Image";

fn registration(exe: &Path) -> Vec<(String, String, String)> {
    let exe = exe.to_string_lossy();
    let command = format!("\"{exe}\" --open \"%1\"");
    let icon = format!("\"{exe}\",0");
    let mut entries = vec![
        (format!(r"Software\Classes\{PROG_ID}"), String::new(), "PicBoard 图片".into()),
        (format!(r"Software\Classes\{PROG_ID}\DefaultIcon"), String::new(), icon.clone()),
        (format!(r"Software\Classes\{PROG_ID}\shell\open\command"), String::new(), command.clone()),
        (CAPABILITIES.into(), "ApplicationName".into(), "PicBoard".into()),
        (CAPABILITIES.into(), "ApplicationDescription".into(), "查看、批注、裁剪和转换本地图片".into()),
        (CAPABILITIES.into(), "ApplicationIcon".into(), icon),
        (r"Software\RegisteredApplications".into(), "PicBoard".into(), CAPABILITIES.into()),
        (r"Software\Classes\Applications\picboard.exe".into(), "FriendlyAppName".into(), "PicBoard".into()),
        (r"Software\Classes\Applications\picboard.exe\shell\open\command".into(), String::new(), command),
    ];
    for extension in crate::image_files::EXTENSIONS {
        let extension = format!(".{extension}");
        entries.push((format!(r"{CAPABILITIES}\FileAssociations"), extension.clone(), PROG_ID.into()));
        entries.push((format!(r"Software\Classes\{extension}\OpenWithProgids"), PROG_ID.into(), String::new()));
        entries.push((r"Software\Classes\Applications\picboard.exe\SupportedTypes".into(), extension, String::new()));
    }
    entries
}

#[derive(serde::Serialize)]
pub struct ImageAssociation { available: bool, registered: bool }

#[tauri::command]
pub fn get_image_association() -> Result<ImageAssociation, AppError> {
    let available = cfg!(windows) && !super::host::is_dev_build();
    #[cfg(windows)]
    let registered = sys::read_command().is_some_and(|value| value == format!("\"{}\" --open \"%1\"", std::env::current_exe().unwrap_or_default().display()));
    #[cfg(not(windows))]
    let registered = false;
    Ok(ImageAssociation { available, registered })
}

#[tauri::command]
pub fn configure_image_association() -> Result<(), AppError> {
    if super::host::is_dev_build() { return Err(AppError::message("请在正式便携版中设置默认应用，开发版不会修改文件关联")); }
    #[cfg(windows)]
    {
        for (key, name, value) in registration(&std::env::current_exe()?) { sys::set_string(&key, &name, &value)?; }
        unsafe { windows_sys::Win32::UI::Shell::SHChangeNotify(windows_sys::Win32::UI::Shell::SHCNE_ASSOCCHANGED as i32, windows_sys::Win32::UI::Shell::SHCNF_IDLIST, std::ptr::null(), std::ptr::null()); }
        return crate::commands::open_in_shell("ms-settings:defaultapps?registeredAppUser=PicBoard");
    }
    #[cfg(not(windows))]
    Err(AppError::message("文件关联仅支持 Windows"))
}

#[cfg(windows)]
mod sys {
    use super::*;
    use windows_sys::Win32::System::Registry::*;
    fn wide(value: &str) -> Vec<u16> { value.encode_utf16().chain(std::iter::once(0)).collect() }
    pub fn set_string(path: &str, name: &str, value: &str) -> Result<(), AppError> {
        let mut key = std::ptr::null_mut();
        let status = unsafe { RegCreateKeyExW(HKEY_CURRENT_USER, wide(path).as_ptr(), 0, std::ptr::null(), 0, KEY_SET_VALUE, std::ptr::null(), &mut key, std::ptr::null_mut()) };
        if status != 0 { return Err(AppError::message(format!("无法注册图片查看器：{status}"))); }
        let data = wide(value);
        let status = unsafe { RegSetValueExW(key, wide(name).as_ptr(), 0, REG_SZ, data.as_ptr().cast(), (data.len() * 2) as u32) };
        unsafe { RegCloseKey(key); }
        if status != 0 { return Err(AppError::message(format!("写入图片关联失败：{status}"))); }
        Ok(())
    }
    pub fn read_command() -> Option<String> {
        let mut data = vec![0u16; 4096];
        let mut size = (data.len() * 2) as u32;
        let result = unsafe { RegGetValueW(HKEY_CURRENT_USER, wide(r"Software\Classes\PicBoard.Image\shell\open\command").as_ptr(), std::ptr::null(), RRF_RT_REG_SZ, std::ptr::null_mut(), data.as_mut_ptr().cast(), &mut size) };
        if result != 0 { return None; }
        data.truncate(size as usize / 2);
        Some(String::from_utf16_lossy(&data).trim_end_matches('\0').into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn plan_is_additive_and_quotes_paths() {
        let plan = registration(Path::new(r"C:\Program Files\PicBoard\picboard.exe"));
        assert!(plan.iter().any(|(key, _, value)| key.ends_with(r"shell\open\command") && value == r#""C:\Program Files\PicBoard\picboard.exe" --open "%1""#));
        assert!(plan.iter().all(|(key, _, _)| !key.contains("UserChoice")));
        for extension in crate::image_files::EXTENSIONS { assert!(plan.iter().any(|(key, name, _)| key.ends_with("FileAssociations") && name == &format!(".{extension}"))); }
    }
}
