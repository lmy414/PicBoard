//! Plugin discovery.
//!
//! This phase only lists plugins: one folder per plugin directly below
//! `<dataRoot>/plugins`, each with a `manifest.json` (≤ 64 KiB, JSON object)
//! and an entry module (`manifest.main`, default `main.js`, ≤ 1 MiB UTF-8).
//! The manifest contract is documented in `docs/PLUGIN-API.md`; one broken
//! folder never hides the others, its failure is reported in `errors`.

use crate::dto::{PluginError, PluginListing, PluginSource};
use crate::error::AppError;
use crate::paths::safe_join;
use crate::SharedStorage;
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::path::Path;

const MANIFEST_FILE: &str = "manifest.json";
const DEFAULT_ENTRY: &str = "main.js";
const PLUGIN_API_VERSION: u64 = 1;
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_CODE_BYTES: u64 = 1024 * 1024;
const MAX_ID_CHARS: usize = 64;

/// List every plugin folder below `<dataRoot>/plugins` (created on demand).
pub fn list(storage: &SharedStorage) -> Result<PluginListing, AppError> {
    let root = {
        let store = storage
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        store.root.clone()
    };
    let directory = root.join("plugins");
    fs::create_dir_all(&directory)?;

    let mut folders = Vec::new();
    for entry in fs::read_dir(&directory)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            folders.push(entry.file_name().to_string_lossy().into_owned());
        }
    }
    folders.sort();

    let mut plugins = Vec::new();
    let mut errors = Vec::new();
    let mut seen_ids = HashSet::new();
    for folder in folders {
        match load_plugin(&directory, &folder, &mut seen_ids) {
            Ok(plugin) => plugins.push(plugin),
            Err(message) => errors.push(PluginError { folder, message }),
        }
    }
    Ok(PluginListing {
        directory: directory.to_string_lossy().into_owned(),
        plugins,
        errors,
    })
}

fn load_plugin(
    directory: &Path,
    folder: &str,
    seen_ids: &mut HashSet<String>,
) -> Result<PluginSource, String> {
    let folder_path = directory.join(folder);
    let manifest_path = folder_path.join(MANIFEST_FILE);
    let metadata = fs::metadata(&manifest_path).map_err(|_| format!("缺少 {MANIFEST_FILE}"))?;
    if !metadata.is_file() {
        return Err(format!("{MANIFEST_FILE} 不是普通文件"));
    }
    if metadata.len() > MAX_MANIFEST_BYTES {
        return Err(format!("{MANIFEST_FILE} 超过 64 KiB"));
    }
    let text = fs::read_to_string(&manifest_path)
        .map_err(|error| format!("无法读取 {MANIFEST_FILE}：{error}"))?;
    let manifest: Value = serde_json::from_str(&text)
        .map_err(|error| format!("{MANIFEST_FILE} 不是有效 JSON：{error}"))?;
    let object = manifest
        .as_object()
        .ok_or_else(|| format!("{MANIFEST_FILE} 必须是 JSON 对象"))?;

    if object.get("apiVersion").and_then(Value::as_u64) != Some(PLUGIN_API_VERSION) {
        return Err(format!("apiVersion 必须为 {PLUGIN_API_VERSION}"));
    }
    let id = object
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "缺少插件 id".to_owned())?;
    if !valid_plugin_id(id) {
        return Err("插件 id 无效（小写字母、数字和连字符，1-64 位且以字母或数字开头）".into());
    }
    if object
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .is_empty()
    {
        return Err("插件名称不能为空".into());
    }
    if object
        .get("version")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .is_empty()
    {
        return Err("插件版本不能为空".into());
    }

    let entry = match object.get("main") {
        None | Some(Value::Null) => DEFAULT_ENTRY.to_owned(),
        Some(Value::String(value)) => value.clone(),
        Some(_) => return Err("manifest.main 必须是字符串".into()),
    };
    if entry.trim().is_empty() {
        return Err("manifest.main 不能为空".into());
    }
    let code_path = safe_join(&folder_path, &entry)
        .map_err(|error| format!("插件入口路径无效：{}", error.0))?;
    let metadata = fs::metadata(&code_path).map_err(|_| format!("入口文件不存在：{entry}"))?;
    if !metadata.is_file() {
        return Err(format!("入口文件不是普通文件：{entry}"));
    }
    if metadata.len() > MAX_CODE_BYTES {
        return Err("入口文件超过 1 MiB".into());
    }
    let code = fs::read_to_string(&code_path)
        .map_err(|error| format!("入口文件不是 UTF-8 文本：{error}"))?;

    // Duplicate ids are checked last so a broken folder never shadows a valid
    // plugin that declares the same id.
    if !seen_ids.insert(id.to_owned()) {
        return Err(format!("插件 id 重复：{id}"));
    }
    Ok(PluginSource {
        folder: folder.to_owned(),
        manifest,
        code,
    })
}

/// Manifest ids: lowercase ASCII letters, digits and hyphens, 1-64 chars,
/// starting with a letter or digit.
fn valid_plugin_id(id: &str) -> bool {
    let mut chars = id.chars();
    match chars.next() {
        Some(first) if first.is_ascii_lowercase() || first.is_ascii_digit() => {}
        _ => return false,
    }
    id.chars().count() <= MAX_ID_CHARS
        && id
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    fn storage(root: &Path) -> SharedStorage {
        // Plugin discovery only touches the data root, so an unloaded storage
        // with the platform recycle bin is enough (it is never used).
        Arc::new(Mutex::new(crate::storage::ImageBoardStorage::new(
            root.to_path_buf(),
        )))
    }

    fn manifest(id: &str, main: Option<&str>) -> String {
        let main = main.map(|value| format!(r#","main":"{value}""#)).unwrap_or_default();
        format!(
            r#"{{"apiVersion":1,"id":"{id}","name":"插件 {id}","version":"1.0.0"{main}}}"#
        )
    }

    fn write_plugin(root: &Path, folder: &str, manifest: &str, entry: Option<&str>) -> PathBuf {
        let dir = root.join("plugins").join(folder);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("manifest.json"), manifest).unwrap();
        if let Some(entry) = entry {
            fs::write(dir.join(entry), "picboard.registerProcessor({});").unwrap();
        }
        dir
    }

    #[test]
    fn lists_valid_plugins_sorted_and_creates_the_directory() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        write_plugin(root, "beta", &manifest("beta-plugin", Some("index.js")), Some("index.js"));
        write_plugin(root, "alpha", &manifest("alpha", None), Some("main.js"));
        let shared = storage(root);

        let listing = list(&shared).unwrap();

        assert!(root.join("plugins").is_dir());
        assert_eq!(
            listing
                .plugins
                .iter()
                .map(|plugin| plugin.folder.as_str())
                .collect::<Vec<_>>(),
            vec!["alpha", "beta"]
        );
        assert!(listing.errors.is_empty());
        assert_eq!(
            listing.plugins[0].code,
            "picboard.registerProcessor({});"
        );
        assert_eq!(listing.plugins[0].manifest["id"], "alpha");
        assert_eq!(listing.directory, root.join("plugins").to_string_lossy());
    }

    #[test]
    fn reports_each_broken_folder_without_hiding_the_good_ones() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        write_plugin(root, "good", &manifest("good", None), Some("main.js"));
        write_plugin(root, "bad-json", "{not json", Some("main.js"));
        write_plugin(root, "not-object", "[]", Some("main.js"));
        write_plugin(root, "missing-entry", &manifest("missing-entry", None), None);
        let _ = write_plugin(
            root,
            "escape",
            &manifest("escape", Some("../../secret.js")),
            None,
        );
        let _ = write_plugin(
            root,
            "absolute",
            &manifest("absolute", Some("C:/Windows/win.ini")),
            None,
        );
        write_plugin(
            root,
            "wrong-api",
            r#"{"apiVersion":2,"id":"wrong-api","name":"x","version":"1"}"#,
            Some("main.js"),
        );
        write_plugin(
            root,
            "bad-id",
            r#"{"apiVersion":1,"id":"Bad Id","name":"x","version":"1"}"#,
            Some("main.js"),
        );
        write_plugin(
            root,
            "no-name",
            r#"{"apiVersion":1,"id":"no-name","name":" ","version":"1"}"#,
            Some("main.js"),
        );
        write_plugin(
            root,
            "no-version",
            r#"{"apiVersion":1,"id":"no-version","name":"x"}"#,
            Some("main.js"),
        );
        let oversized = root.join("plugins").join("huge");
        fs::create_dir_all(&oversized).unwrap();
        fs::write(
            oversized.join("manifest.json"),
            format!("{{\"pad\":\"{}\"}}", "x".repeat(70 * 1024)),
        )
        .unwrap();
        fs::write(oversized.join("main.js"), "x").unwrap();
        let shared = storage(root);

        let listing = list(&shared).unwrap();

        assert_eq!(listing.plugins.len(), 1);
        assert_eq!(listing.plugins[0].folder, "good");
        let message = |folder: &str| {
            listing
                .errors
                .iter()
                .find(|error| error.folder == folder)
                .unwrap_or_else(|| panic!("missing error for {folder}"))
                .message
                .clone()
        };
        assert_eq!(listing.errors.len(), 10, "{:?}", listing.errors);
        assert!(message("bad-json").contains("不是有效 JSON"));
        assert!(message("not-object").contains("JSON 对象"));
        assert!(message("missing-entry").contains("入口文件不存在"));
        assert!(message("escape").contains("入口路径无效"));
        assert!(message("absolute").contains("入口路径无效"));
        assert!(message("wrong-api").contains("apiVersion"));
        assert!(message("bad-id").contains("插件 id 无效"));
        assert!(message("no-name").contains("名称不能为空"));
        assert!(message("no-version").contains("版本不能为空"));
        assert!(message("huge").contains("64 KiB"));
    }

    #[test]
    fn duplicate_ids_keep_the_first_folder_and_report_the_rest() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        write_plugin(root, "a-first", &manifest("shared-id", None), Some("main.js"));
        write_plugin(root, "b-second", &manifest("shared-id", None), Some("main.js"));
        let shared = storage(root);

        let listing = list(&shared).unwrap();

        assert_eq!(listing.plugins.len(), 1);
        assert_eq!(listing.plugins[0].folder, "a-first");
        assert_eq!(listing.errors.len(), 1);
        assert_eq!(listing.errors[0].folder, "b-second");
        assert!(listing.errors[0].message.contains("插件 id 重复"));
    }

    #[test]
    fn a_broken_folder_does_not_shadow_the_same_id_later() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        // Missing entry file: the folder fails, so the id is still free.
        write_plugin(root, "a-broken", &manifest("shared-id", None), None);
        write_plugin(root, "b-valid", &manifest("shared-id", None), Some("main.js"));
        let shared = storage(root);

        let listing = list(&shared).unwrap();

        assert_eq!(listing.plugins.len(), 1);
        assert_eq!(listing.plugins[0].folder, "b-valid");
        assert_eq!(listing.errors.len(), 1);
    }

    #[test]
    fn rejects_entry_files_over_one_mebibyte() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let dir = write_plugin(root, "big", &manifest("big", None), None);
        fs::write(dir.join("main.js"), "x".repeat(1024 * 1024 + 1)).unwrap();
        let shared = storage(root);

        let listing = list(&shared).unwrap();

        assert!(listing.plugins.is_empty());
        assert!(listing.errors[0].message.contains("1 MiB"));
    }
}
