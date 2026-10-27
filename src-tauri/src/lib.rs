#[cfg(target_os = "windows")]
mod pointer;
mod overlay_server;
mod schedule;
mod sources;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{Manager, State};

/// Единый движок приложения: его держат и команда `rig_call`, и планировщик
/// кадров. Блокировка берётся на один вызов ядра, поэтому `create`,
/// `updateBase` и `tick` не могут выполняться одновременно.
#[tauri::command]
fn rig_call(state: State<'_, Arc<schedule::Shared>>, request: &str) -> String {
    match state.store.lock() {
        Ok(mut store) => store.call_json(request),
        Err(_) => "{\"ok\":false,\"error\":\"Rust runtime lock is poisoned\"}".into(),
    }
}

/// Открывает веб-ссылку в браузере по умолчанию.
///
/// Ссылки из интерфейса (консоль разработчика Twitch, страница активации кода)
/// нельзя открывать внутри вебвью: навигация заменила бы окно студии чужой
/// страницей, и вернуться было бы некуда. Отсюда адрес уходит системе.
///
/// Адрес проверяется: только `http`/`https` и только символы обычного URL.
/// Это не формальность — строка попадает в системную команду, поэтому `&`,
/// кавычки и переводы строк отсекаются до запуска.
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    let scheme = url.starts_with("https://") || url.starts_with("http://");
    let clean = !url
        .chars()
        .any(|c| c.is_control() || c.is_whitespace() || "\"'`^|&;<>()$".contains(c));
    if !scheme || !clean {
        return Err(format!("недопустимый адрес ссылки: {url}"));
    }
    #[cfg(target_os = "windows")]
    let spawned = std::process::Command::new("cmd")
        .args(["/C", "start", "", url.as_str()])
        .spawn();
    #[cfg(target_os = "macos")]
    let spawned = std::process::Command::new("open").arg(url.as_str()).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let spawned = std::process::Command::new("xdg-open").arg(url.as_str()).spawn();
    #[cfg(not(any(windows, unix)))]
    let spawned: std::io::Result<std::process::Child> = Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "на этой платформе нет способа открыть браузер",
    ));
    spawned.map(|_| ()).map_err(|error| error.to_string())
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

/// Файл объекта, который редактор отдаёт на запись в папку пресета.
///
/// `data` — готовый data URL (`data:image/png;base64,…`): так редактору не нужно
/// решать, в каком виде передавать байты, а Rust сам отделяет заголовок.
#[derive(serde::Deserialize)]
struct AssetFile {
    id: String,
    name: String,
    mime: String,
    data: String,
}

/// Запись в `index.json` папки `<имя>.assets`: паспорт файла без байтов.
#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct AssetEntry {
    id: String,
    name: String,
    mime: String,
    size: u64,
    /// Имя файла внутри папки.
    file: String,
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct AssetIndex {
    #[serde(default)]
    version: u32,
    assets: Vec<AssetEntry>,
}

const BASE64_TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Папка файлов рядом с пресетом: `риг.yappy.json` → `риг.yappy.assets`.
fn asset_dir(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("preset");
    let stem = name.strip_suffix(".yappy.json").unwrap_or(name);
    let stem = stem.strip_suffix(".json").unwrap_or(stem);
    let folder = format!("{}.assets", stem);
    match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.join(folder),
        _ => PathBuf::from(folder),
    }
}

fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() / 3 * 4 + 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(BASE64_TABLE[(triple >> 18) as usize & 63] as char);
        out.push(BASE64_TABLE[(triple >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            BASE64_TABLE[(triple >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            BASE64_TABLE[triple as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

fn base64_decode(text: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3 + 3);
    let mut bits: u32 = 0;
    let mut count = 0;
    for byte in text.bytes() {
        if byte == b'=' {
            break;
        }
        let Some(index) = BASE64_TABLE.iter().position(|&symbol| symbol == byte) else {
            if byte.is_ascii_whitespace() {
                continue;
            }
            return Err("файл пришёл не в base64".into());
        };
        bits = (bits << 6) | index as u32;
        count += 1;
        if count == 4 {
            out.extend_from_slice(&bits.to_be_bytes()[1..]);
            bits = 0;
            count = 0;
        }
    }
    // Хвост: два символа — один байт, три — два.
    if count == 2 {
        out.push((bits >> 4) as u8);
    } else if count == 3 {
        out.push((bits >> 10) as u8);
        out.push((bits >> 2) as u8);
    }
    Ok(out)
}

/// Расширение по типу файла: папка должна открываться глазами, а не списком `.bin`.
fn extension_for(mime: &str, name: &str) -> String {
    if let Some(extension) = Path::new(name).extension().and_then(|value| value.to_str()) {
        let clean: String = extension
            .chars()
            .filter(|symbol| symbol.is_ascii_alphanumeric())
            .take(8)
            .collect();
        if !clean.is_empty() {
            return clean.to_lowercase();
        }
    }
    let known = match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/avif" => "avif",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        "video/quicktime" => "mov",
        "audio/mpeg" => "mp3",
        "audio/wav" | "audio/x-wav" => "wav",
        "audio/ogg" => "ogg",
        "audio/mp4" => "m4a",
        "audio/flac" => "flac",
        _ => "bin",
    };
    known.to_string()
}

fn safe_file_name(id: &str) -> String {
    let clean: String = id
        .chars()
        .map(|symbol| {
            if symbol.is_ascii_alphanumeric() || symbol == '-' || symbol == '_' {
                symbol
            } else {
                '_'
            }
        })
        .take(120)
        .collect();
    if clean.is_empty() {
        "asset".to_string()
    } else {
        clean
    }
}

/// Пишет файлы объектов в `<имя>.assets` рядом с пресетом и обновляет `index.json`.
///
/// Пресет при этом ссылается на файлы короткими ссылками `asset:<id>`: сам JSON
/// остаётся маленьким, а папка переносится вместе с ним. Возвращает число
/// записанных файлов. Уборка старых файлов — отдельная команда
/// (`preset_clean_assets`): она вызывается после успешной записи пресета, чтобы
/// прерванное сохранение ничего не потеряло.
#[tauri::command]
fn preset_write_assets(path: String, assets: Vec<AssetFile>) -> Result<usize, String> {
    let dir = asset_dir(Path::new(&path));
    std::fs::create_dir_all(&dir).map_err(|error| write_error(&dir, &error.to_string()))?;
    let mut entries: Vec<AssetEntry> = Vec::with_capacity(assets.len());
    for asset in assets {
        // data URL → чистый base64: заголовок уже разобран на стороне редактора.
        let payload = match asset.data.split_once(',') {
            Some((_, rest)) if asset.data.starts_with("data:") => rest,
            _ => asset.data.as_str(),
        };
        let bytes = base64_decode(payload)?;
        let file = format!(
            "{}.{}",
            safe_file_name(&asset.id),
            extension_for(&asset.mime, &asset.name)
        );
        let target = dir.join(&file);
        std::fs::write(&target, &bytes)
            .map_err(|error| write_error(&target, &error.to_string()))?;
        entries.push(AssetEntry {
            id: asset.id,
            name: asset.name,
            mime: asset.mime,
            size: bytes.len() as u64,
            file,
        });
    }
    let index = AssetIndex {
        version: 1,
        assets: entries,
    };
    let text = serde_json::to_string_pretty(&index)
        .map_err(|error| format!("index.json: {}", error))?;
    let manifest = dir.join("index.json");
    std::fs::write(&manifest, text).map_err(|error| write_error(&manifest, &error.to_string()))?;
    Ok(index.assets.len())
}

/// Убирает из папки файлы, которых нет в `index.json`.
///
/// Папка принадлежит приложению: свои файлы туда класть нельзя, иначе уборка
/// их удалит. Вызывается только после успешной записи пресета — так неудачное
/// сохранение не оставляет сцену без картинок.
#[tauri::command]
fn preset_clean_assets(path: String) -> Result<usize, String> {
    let dir = asset_dir(Path::new(&path));
    let text = match std::fs::read_to_string(dir.join("index.json")) {
        Ok(text) => text,
        Err(_) => return Ok(0),
    };
    let index: AssetIndex = match serde_json::from_str(&text) {
        Ok(index) => index,
        Err(_) => return Ok(0),
    };
    let known: Vec<String> = index.assets.into_iter().map(|entry| entry.file).collect();
    let mut removed = 0;
    if let Ok(files) = std::fs::read_dir(&dir) {
        for file in files.flatten() {
            let Some(name) = file.file_name().to_str().map(|name| name.to_string()) else {
                continue;
            };
            if name == "index.json" || known.iter().any(|known| known == &name) {
                continue;
            }
            if std::fs::remove_file(file.path()).is_ok() {
                removed += 1;
            }
        }
    }
    Ok(removed)
}

/// Паспорта файлов из папки пресета: редактору нужно знать, чего на диске нет,
/// не читая сами байты.
#[tauri::command]
fn preset_asset_index(path: String) -> Result<Vec<AssetEntry>, String> {
    let manifest = asset_dir(Path::new(&path)).join("index.json");
    let text = match std::fs::read_to_string(&manifest) {
        Ok(text) => text,
        // Папки нет — это не ошибка: пресет может быть совсем новым.
        Err(_) => return Ok(Vec::new()),
    };
    match serde_json::from_str::<AssetIndex>(&text) {
        Ok(index) => Ok(index.assets),
        Err(_) => Ok(Vec::new()),
    }
}

/// Читает файл объекта из папки пресета и отдаёт его data URL.
///
/// Редактор спрашивает файл лениво — только когда объект действительно нужно
/// нарисовать. `None` означает «файла нет или папку перенесли без него».
#[tauri::command]
fn preset_read_asset(path: String, id: String) -> Result<Option<String>, String> {
    let dir = asset_dir(Path::new(&path));
    let text = match std::fs::read_to_string(dir.join("index.json")) {
        Ok(text) => text,
        Err(_) => return Ok(None),
    };
    let index: AssetIndex = match serde_json::from_str(&text) {
        Ok(index) => index,
        Err(_) => return Ok(None),
    };
    let Some(entry) = index.assets.into_iter().find(|entry| entry.id == id) else {
        return Ok(None);
    };
    let bytes = match std::fs::read(dir.join(&entry.file)) {
        Ok(bytes) => bytes,
        Err(_) => return Ok(None),
    };
    Ok(Some(format!(
        "data:{};base64,{}",
        entry.mime,
        base64_encode(&bytes)
    )))
}

/// Кладёт скачанное приложение рядом с работающим и возвращает путь.
///
/// Заменить `.exe` на ходу нельзя: Windows держит файл открытым, пока процесс
/// жив. Поэтому байты сначала ложатся в соседний `….update`, а перестановкой
/// занимается помощник уже после выхода окна (`update_restart`). Так обновление
/// не может оставить вместо программы половину файла: пока скачанный файл не
/// лёг целиком, ничего не меняется.
#[tauri::command]
fn update_stage(payload: String) -> Result<String, String> {
    let bytes = base64_decode(&payload)?;
    if bytes.len() < 1024 * 256 {
        return Err("скачанный файл слишком маленький: загрузка не удалась".into());
    }
    #[cfg(target_os = "windows")]
    if !bytes.starts_with(b"MZ") {
        return Err("скачанный файл не похож на программу Windows".into());
    }
    let current = std::env::current_exe().map_err(|error| error.to_string())?;
    let staged = current.with_extension("update");
    std::fs::write(&staged, &bytes).map_err(|error| write_error(&staged, &error.to_string()))?;
    Ok(staged.to_string_lossy().into_owned())
}

/// Скрипт-помощник: ждёт выхода программы, подменяет файл и запускает новый.
///
/// Отдельный процесс нужен потому, что сам себя заменить нельзя. Скрипт лежит
/// во временной папке и удаляет себя в конце, поэтому мусора не остаётся.
#[cfg(target_os = "windows")]
fn update_helper(staged: &Path, target: &Path) -> Result<PathBuf, String> {
    let name = target
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("yappytuberplus.exe");
    let script = std::env::temp_dir().join(format!("yappytuberplus-update-{}.bat", std::process::id()));
    let text = format!(
        "@echo off\r\n\
         :wait\r\n\
         tasklist /FI \"PID eq {pid}\" /NH | find /I \"{name}\" >nul\r\n\
         if not errorlevel 1 (\r\n\
         \x20 timeout /t 1 /nobreak >nul\r\n\
         \x20 goto wait\r\n\
         )\r\n\
         move /y \"{staged}\" \"{target}\" >nul\r\n\
         if errorlevel 1 (\r\n\
         \x20 timeout /t 3 /nobreak >nul\r\n\
         \x20 move /y \"{staged}\" \"{target}\" >nul\r\n\
         )\r\n\
         start \"\" \"{target}\"\r\n\
         del \"%~f0\"\r\n",
        pid = std::process::id(),
        name = name,
        staged = staged.display(),
        target = target.display(),
    );
    std::fs::write(&script, text).map_err(|error| write_error(&script, &error.to_string()))?;
    Ok(script)
}

#[cfg(not(target_os = "windows"))]
fn update_helper(staged: &Path, target: &Path) -> Result<PathBuf, String> {
    use std::os::unix::fs::PermissionsExt;
    let script = std::env::temp_dir().join(format!("yappytuberplus-update-{}.sh", std::process::id()));
    let text = format!(
        "#!/bin/sh\n\
         while kill -0 {pid} 2>/dev/null; do sleep 1; done\n\
         mv -f \"{staged}\" \"{target}\" && chmod 755 \"{target}\"\n\
         \"{target}\" >/dev/null 2>&1 &\n\
         rm -f \"$0\"\n",
        pid = std::process::id(),
        staged = staged.display(),
        target = target.display(),
    );
    std::fs::write(&script, text).map_err(|error| write_error(&script, &error.to_string()))?;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))
        .map_err(|error| error.to_string())?;
    Ok(script)
}

#[cfg(target_os = "windows")]
fn spawn_helper(script: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    // CREATE_NO_WINDOW: помощник не должен мигать консолью поверх студии.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("cmd")
        .arg("/C")
        .arg(script)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[cfg(not(target_os = "windows"))]
fn spawn_helper(script: &Path) -> Result<(), String> {
    std::process::Command::new("sh")
        .arg(script)
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// Запускает помощника и закрывает программу: обновление закончится без неё.
#[tauri::command]
fn update_restart(app: tauri::AppHandle, staged: String) -> Result<(), String> {
    let target = std::env::current_exe().map_err(|error| error.to_string())?;
    let staged = PathBuf::from(staged);
    if !staged.is_file() {
        return Err(format!("скачанный файл не найден: {}", staged.display()));
    }
    // Защита от чужого пути: обновлять можно только свою программу.
    if staged.parent() != target.parent() {
        return Err("скачанный файл лежит не рядом с программой".into());
    }
    let script = update_helper(&staged, &target)?;
    spawn_helper(&script)?;
    app.exit(0);
    Ok(())
}

fn write_error(path: &Path, reason: &str) -> String {
    format!("{}: {}", path.display(), reason)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let shared = Arc::new(schedule::Shared::new());
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(shared)
        // Внешние источники: HTTP, SSE и OSC живут в Rust, WebSocket — в окне.
        .manage(sources::Sources::default())
        .setup(|app| {
            // Глобальные клавиатура и мышь: хук только читает ввод и шлёт события
            // в окно редактора. На других платформах модули работают от window.
            #[cfg(target_os = "windows")]
            pointer::spawn(app.handle().clone());
            // Встроенный сервер оверлея: страница для источника браузера OBS и
            // релей сообщений. Отдельный `npm run overlay:bridge` больше не нужен.
            let server = overlay_server::start(app.handle().clone());
            app.manage(server);
            let _ = app;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            rig_call,
            open_external,
            preset_default_dir,
            preset_write,
            preset_read,
            preset_write_assets,
            preset_clean_assets,
            preset_read_asset,
            preset_asset_index,
            update_stage,
            update_restart,
            schedule::rig_schedule_start,
            schedule::rig_schedule_inputs,
            schedule::rig_schedule_pause,
            schedule::rig_schedule_reset_clock,
            schedule::rig_schedule_stop,
            schedule::rig_schedule_status,
            overlay_server::overlay_server_url,
            overlay_server::overlay_server_status,
            sources::source_request,
            sources::source_probe,
            sources::source_start,
            sources::source_stop,
            sources::source_stop_all
        ])
        .run(tauri::generate_context!())
        .expect("error while running YappyTuberPlus");
}
