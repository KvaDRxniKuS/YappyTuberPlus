#[cfg(target_os = "windows")]
mod pointer;

use rig_core::RuntimeStore;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Manager, State};

#[tauri::command]
fn rig_call(state: State<'_, Mutex<RuntimeStore>>, request: &str) -> String {
    match state.lock() {
        Ok(mut store) => store.call_json(request),
        Err(_) => "{\"ok\":false,\"error\":\"Rust runtime lock is poisoned\"}".into(),
    }
}

/// Папка пресетов по умолчанию: `%APPDATA%/com.yappytuberplus.studio/presets`.
#[tauri::command]
fn preset_default_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("presets");
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}

/// Перезапись файла пресета. Родительские папки создаются при необходимости.
#[tauri::command]
fn preset_write(path: String, contents: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
    }
    std::fs::write(&target, contents).map_err(|error| write_error(&target, &error.to_string()))
}

#[tauri::command]
fn preset_read(path: String) -> Result<String, String> {
    let target = Path::new(&path);
    std::fs::read_to_string(target).map_err(|error| write_error(target, &error.to_string()))
}

fn write_error(path: &Path, reason: &str) -> String {
    format!("{}: {}", path.display(), reason)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Mutex::new(RuntimeStore::default()))
        .setup(|app| {
            // Глобальные клавиатура и мышь: хук только читает ввод и шлёт события
            // в окно редактора. На других платформах модули работают от window.
            #[cfg(target_os = "windows")]
            pointer::spawn(app.handle().clone());
            let _ = app;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            rig_call,
            preset_default_dir,
            preset_write,
            preset_read
        ])
        .run(tauri::generate_context!())
        .expect("error while running YappyTuberPlus");
}
