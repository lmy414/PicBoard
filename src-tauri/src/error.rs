use std::{fmt, io};

#[derive(Debug)]
pub struct AppError(pub String);

impl AppError {
    pub fn message(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for AppError {}

impl From<io::Error> for AppError {
    fn from(value: io::Error) -> Self {
        Self(value.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(value: serde_json::Error) -> Self {
        Self(value.to_string())
    }
}

impl From<image::ImageError> for AppError {
    fn from(value: image::ImageError) -> Self {
        Self(format!("图片解码失败：{value}"))
    }
}

impl From<tauri::Error> for AppError {
    fn from(value: tauri::Error) -> Self {
        Self(value.to_string())
    }
}

impl serde::Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}
