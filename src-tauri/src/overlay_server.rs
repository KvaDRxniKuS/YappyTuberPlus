//! Встроенный сервер оверлея.
//!
//! Раньше источник браузера в OBS требовал отдельного процесса Node
//! (`npm run overlay:bridge`) и страницы, открытой из Vite. Здесь тот же релей и
//! та же страница оверлея отдаются самим приложением:
//!
//! - `GET /overlay.html` — страница оверлея из веб-сборки приложения;
//! - `GET /overlay-ws` — релей сообщений между окнами (протокол не меняется);
//! - `GET /health` — короткий JSON для проверки, что сервер жив.
//!
//! Релей ничего не считает и не хранит состояние рига: он только пересылает
//! непрозрачный JSON между подключёнными клиентами, как и прежний мост. Правило
//! «один активный драйвер» (DESIGN §13.3) поэтому сохраняется: кадры публикует
//! только редактор.
//!
//! Всё написано на стандартной библиотеке: зависимостей не добавляем, а
//! WebSocket здесь нужен ровно один — текст и управляющие кадры без сжатия и
//! расширений, как их присылает браузер OBS.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

/// Порт по умолчанию совпадает с прежним мостом, чтобы ссылки не менялись.
pub const DEFAULT_PORT: u16 = 17800;
const MAX_HEAD: usize = 16 * 1024;
const MAX_PAYLOAD: usize = 8 * 1024 * 1024;
const WS_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/// Что отправить клиенту: текст сообщения или ответ на ping.
enum Out {
    Text(String),
    Pong(Vec<u8>),
}

struct Client {
    id: u64,
    sender: Sender<Out>,
}

pub struct OverlayServer {
    running: AtomicBool,
    url: String,
    web_root: Option<PathBuf>,
    clients: Mutex<Vec<Client>>,
    next_id: AtomicU64,
    connections: AtomicU64,
}

impl OverlayServer {
    fn stopped() -> Self {
        Self {
            running: AtomicBool::new(false),
            url: String::new(),
            web_root: None,
            clients: Mutex::new(Vec::new()),
            next_id: AtomicU64::new(1),
            connections: AtomicU64::new(0),
        }
    }

    pub fn status(&self) -> Value {
        let clients = self.clients.lock().map(|list| list.len()).unwrap_or(0);
        json!({
            "running": self.running.load(Ordering::SeqCst),
            "url": if self.url.is_empty() { Value::Null } else { Value::from(self.url.clone()) },
            "webRoot": self.web_root.as_ref().map(|path| path.to_string_lossy().into_owned()),
            "clients": clients,
            "connections": self.connections.load(Ordering::Relaxed),
        })
    }

    fn broadcast(&self, from: u64, text: String) {
        let Ok(clients) = self.clients.lock() else { return };
        for client in clients.iter() {
            if client.id == from {
                continue;
            }
            let _ = client.sender.send(Out::Text(text.clone()));
        }
    }
}

/// Поднимает сервер и возвращает его состояние. Ошибка порта не валит приложение:
/// просто не будет встроенного источника, а диалог оверлея покажет причину.
pub fn start(app: AppHandle) -> Arc<OverlayServer> {
    let port = std::env::var("YTP_OVERLAY_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(DEFAULT_PORT);
    let host = std::env::var("YTP_OVERLAY_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let web_root = web_root(&app);
    let listener = match TcpListener::bind((host.as_str(), port)) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("встроенный сервер оверлея не запущен: {host}:{port} — {error}");
            return Arc::new(OverlayServer::stopped());
        }
    };
    let state = Arc::new(OverlayServer {
        running: AtomicBool::new(true),
        url: format!("http://{host}:{port}/overlay.html"),
        web_root,
        clients: Mutex::new(Vec::new()),
        next_id: AtomicU64::new(1),
        connections: AtomicU64::new(0),
    });
    match &state.web_root {
        Some(root) => println!("оверлей: {} (веб-сборка: {})", state.url, root.display()),
        None => println!(
            "оверлей: {} — веб-сборка не найдена, откройте /health для подсказки",
            state.url
        ),
    }

    let worker = state.clone();
    thread::Builder::new()
        .name("overlay-server".into())
        .spawn(move || {
            for stream in listener.incoming() {
                match stream {
                    Ok(stream) => {
                        let worker = worker.clone();
                        let _ = thread::Builder::new()
                            .name("overlay-client".into())
                            .spawn(move || {
                                worker.connections.fetch_add(1, Ordering::Relaxed);
                                if let Err(error) = handle(stream, &worker) {
                                    if error.kind() != io::ErrorKind::BrokenPipe {
                                        eprintln!("оверлей: соединение закрыто — {error}");
                                    }
                                }
                            });
                    }
                    Err(error) => {
                        eprintln!("оверлей: ошибка приёма — {error}");
                        thread::sleep(Duration::from_millis(120));
                    }
                }
            }
        })
        .expect("не удалось запустить поток сервера оверлея");
    state
}

/// Где лежит веб-сборка. Порядок: переменная окружения, ресурсы установщика,
/// папка рядом с исполняемым файлом, рабочая папка разработки.
fn web_root(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(value) = std::env::var("YTP_OVERLAY_WEB") {
        candidates.push(PathBuf::from(value));
    }
    if let Ok(dir) = app.path().resource_dir() {
        // Tauri кладёт ресурсы из `../dist` под `_up_/dist`, а рядом лежащие —
        // как есть; проверяем оба варианта.
        candidates.push(dir.join("web"));
        candidates.push(dir.join("_up_/dist"));
        candidates.push(dir.join("dist"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("web"));
            candidates.push(dir.join("dist"));
            candidates.push(dir.join("_up_/dist"));
        }
    }
    candidates.push(PathBuf::from("dist"));
    candidates.push(PathBuf::from("../dist"));
    candidates
        .into_iter()
        .find(|path| path.join("overlay.html").is_file())
}

fn handle(mut stream: TcpStream, state: &Arc<OverlayServer>) -> io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let head = read_head(&mut stream)?;
    if head.is_empty() {
        return Ok(());
    }
    let text = String::from_utf8_lossy(&head).into_owned();
    let mut lines = text.split("\r\n");
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let _method = parts.next().unwrap_or("GET");
    let target = parts.next().unwrap_or("/");
    let path = target.split(['?', '#']).next().unwrap_or("/");

    let mut headers: HashMap<String, String> = HashMap::new();
    for line in lines {
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }

    if path == "/overlay-ws" || path == "/overlay-ws/" {
        return websocket(stream, state, &headers);
    }
    if path == "/health" {
        let body = state.status().to_string();
        return respond(&mut stream, 200, "application/json; charset=utf-8", body.as_bytes());
    }
    serve_static(&mut stream, path, state.web_root.as_deref())
}

fn read_head(stream: &mut TcpStream) -> io::Result<Vec<u8>> {
    let mut buffer = Vec::with_capacity(1024);
    let mut chunk = [0u8; 512];
    loop {
        let read = match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(value) => value,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock || error.kind() == io::ErrorKind::TimedOut => break,
            Err(error) => return Err(error),
        };
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.windows(4).any(|window| window == b"\r\n\r\n") || buffer.len() > MAX_HEAD {
            break;
        }
    }
    Ok(buffer)
}

// ── статика ────────────────────────────────────────────────────────────────

fn serve_static(stream: &mut TcpStream, path: &str, root: Option<&Path>) -> io::Result<()> {
    let relative = path.trim_start_matches('/');
    let relative = if relative.is_empty() { "overlay.html" } else { relative };
    if relative.contains("..") {
        return respond(stream, 400, "text/plain; charset=utf-8", b"bad path");
    }
    if let Some(root) = root {
        let candidate = root.join(relative);
        if candidate.is_file() {
            return match std::fs::read(&candidate) {
                Ok(bytes) => respond(stream, 200, mime(&candidate), &bytes),
                Err(error) => respond(stream, 500, "text/plain; charset=utf-8", error.to_string().as_bytes()),
            };
        }
        // Одностаничные адреса вида `/` уже обработаны выше, остальное — 404.
        let not_found = format!("не найдено: {relative}");
        return respond(stream, 404, "text/plain; charset=utf-8", not_found.as_bytes());
    }
    respond(stream, 200, "text/html; charset=utf-8", FALLBACK.as_bytes())
}

fn mime(path: &Path) -> &'static str {
    match path.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "wasm" => "application/wasm",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

fn respond(stream: &mut TcpStream, status: u16, content_type: &str, body: &[u8]) -> io::Result<()> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        _ => "Internal Server Error",
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()
}

/// Страница-подсказка, если веб-сборки рядом не оказалось.
const FALLBACK: &str = r#"<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>Оверлей: нет веб-сборки</title>
<style>body{font:15px/1.5 ui-sans-serif,system-ui,sans-serif;background:#0f1215;color:#e6edf3;margin:40px}
code{background:#1c2430;padding:2px 6px;border-radius:4px}a{color:#81dbc5}</style></head>
<body><h1>Веб-сборка не найдена</h1>
<p>Сервер оверлея работает, но рядом нет папки со страницей оверлея. Соберите приложение
(<code>npm run build</code> или <code>app-build.bat</code>) — веб-сборка попадёт в ресурсы
установщика, и эта страница заменится настоящим оверлеем.</p>
<p>Другой путь — указать папку вручную переменной <code>YTP_OVERLAY_WEB</code>.</p>
<p><a href="/health">/health</a> — состояние сервера.</p></body></html>
"#;

// ── websocket ──────────────────────────────────────────────────────────────

fn websocket(mut stream: TcpStream, state: &Arc<OverlayServer>, headers: &HashMap<String, String>) -> io::Result<()> {
    let Some(key) = headers.get("sec-websocket-key") else {
        return respond(&mut stream, 400, "text/plain; charset=utf-8", b"no key");
    };
    let accept = base64(&sha1(format!("{key}{WS_GUID}").as_bytes()));
    let handshake = format!(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
    );
    stream.write_all(handshake.as_bytes())?;
    stream.flush()?;
    // Дальше сокет живёт в блокирующем режиме: закрытие клиента — это ошибка
    // чтения, по ней поток и завершается.
    stream.set_read_timeout(None)?;
    stream.set_nodelay(true).ok();

    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let (sender, receiver) = channel::<Out>();
    if let Ok(mut clients) = state.clients.lock() {
        clients.push(Client { id, sender });
    }
    // Приветствие как у прежнего моста: клиент по нему понимает, что релей жив.
    state.broadcast(0, json!({ "t": "bridge", "sender": "bridge", "status": "ready" }).to_string());

    let writer_stream = stream.try_clone();
    let writer = writer_stream
        .ok()
        .and_then(|mut socket| thread::Builder::new().name("overlay-ws-writer".into()).spawn(move || {
            for message in receiver {
                let sent = match message {
                    Out::Text(text) => write_text(&mut socket, &text),
                    Out::Pong(payload) => write_frame(&mut socket, 0x0A, &payload),
                };
                if sent.is_err() {
                    break;
                }
            }
        }).ok());

    loop {
        match read_frame(&mut stream) {
            Ok((opcode, payload)) => match opcode {
                0x1 => {
                    if let Ok(text) = String::from_utf8(payload) {
                        state.broadcast(id, text);
                    }
                }
                0x9 => {
                    if let Ok(clients) = state.clients.lock() {
                        if let Some(client) = clients.iter().find(|client| client.id == id) {
                            let _ = client.sender.send(Out::Pong(payload));
                        }
                    }
                }
                0x8 => break,
                _ => {}
            },
            Err(_) => break,
        }
    }

    if let Ok(mut clients) = state.clients.lock() {
        clients.retain(|client| client.id != id);
    }
    if let Some(writer) = writer {
        let _ = writer.join();
    }
    Ok(())
}

fn write_text(stream: &mut TcpStream, text: &str) -> io::Result<()> {
    write_frame(stream, 0x1, text.as_bytes())
}

fn write_frame(stream: &mut TcpStream, opcode: u8, payload: &[u8]) -> io::Result<()> {
    let mut frame = Vec::with_capacity(payload.len() + 10);
    frame.push(0x80 | (opcode & 0x0f));
    if payload.len() < 126 {
        frame.push(payload.len() as u8);
    } else if payload.len() <= u16::MAX as usize {
        frame.push(126);
        frame.extend_from_slice(&(payload.len() as u16).to_be_bytes());
    } else {
        frame.push(127);
        frame.extend_from_slice(&(payload.len() as u64).to_be_bytes());
    }
    frame.extend_from_slice(payload);
    stream.write_all(&frame)?;
    stream.flush()
}

fn read_frame(stream: &mut TcpStream) -> io::Result<(u8, Vec<u8>)> {
    let mut head = [0u8; 2];
    stream.read_exact(&mut head)?;
    let opcode = head[0] & 0x0f;
    let masked = head[1] & 0x80 != 0;
    let mut length = (head[1] & 0x7f) as usize;
    if length == 126 {
        let mut extended = [0u8; 2];
        stream.read_exact(&mut extended)?;
        length = u16::from_be_bytes(extended) as usize;
    } else if length == 127 {
        let mut extended = [0u8; 8];
        stream.read_exact(&mut extended)?;
        length = u64::from_be_bytes(extended) as usize;
    }
    if length > MAX_PAYLOAD {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "слишком длинный кадр"));
    }
    let mut mask = [0u8; 4];
    if masked {
        stream.read_exact(&mut mask)?;
    }
    let mut payload = vec![0u8; length];
    if length > 0 {
        stream.read_exact(&mut payload)?;
    }
    if masked {
        for (index, byte) in payload.iter_mut().enumerate() {
            *byte ^= mask[index % 4];
        }
    }
    Ok((opcode, payload))
}

// ── мини-SHA1 и base64 для рукопожатия ─────────────────────────────────────
// Полноценные библиотеки здесь не нужны: считается один хеш на подключение.

fn sha1(data: &[u8]) -> [u8; 20] {
    let mut h: [u32; 5] = [0x6745_2301, 0xEFCD_AB89, 0x98BA_DCFE, 0x1032_5476, 0xC3D2_E1F0];
    let mut message = data.to_vec();
    let bit_len = (data.len() as u64).wrapping_mul(8);
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bit_len.to_be_bytes());

    for block in message.chunks_exact(64) {
        let mut w = [0u32; 80];
        for index in 0..16 {
            w[index] = u32::from_be_bytes([
                block[index * 4],
                block[index * 4 + 1],
                block[index * 4 + 2],
                block[index * 4 + 3],
            ]);
        }
        for index in 16..80 {
            let value = w[index - 3] ^ w[index - 8] ^ w[index - 14] ^ w[index - 16];
            w[index] = value.rotate_left(1);
        }
        let [mut a, mut b, mut c, mut d, mut e] = h;
        for (index, word) in w.iter().enumerate() {
            let (f, k) = match index {
                0..=19 => ((b & c) | ((!b) & d), 0x5A82_7999u32),
                20..=39 => (b ^ c ^ d, 0x6ED9_EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1B_BCDC),
                _ => (b ^ c ^ d, 0xCA62_C1D6),
            };
            let temp = a.rotate_left(5).wrapping_add(f).wrapping_add(e).wrapping_add(k).wrapping_add(*word);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp;
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
    }

    let mut digest = [0u8; 20];
    for (index, value) in h.iter().enumerate() {
        digest[index * 4..index * 4 + 4].copy_from_slice(&value.to_be_bytes());
    }
    digest
}

fn base64(data: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let first = chunk[0] as u32;
        let second = *chunk.get(1).unwrap_or(&0) as u32;
        let third = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (first << 16) | (second << 8) | third;
        out.push(ALPHABET[((triple >> 18) & 63) as usize] as char);
        out.push(ALPHABET[((triple >> 12) & 63) as usize] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[((triple >> 6) & 63) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[(triple & 63) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

// ── команды для фронтенда ──────────────────────────────────────────────────

/// Адрес страницы оверлея (`null`, если сервер не поднялся).
#[tauri::command]
pub fn overlay_server_url(state: State<'_, Arc<OverlayServer>>) -> Option<String> {
    let server = state.inner();
    if server.running.load(Ordering::SeqCst) && !server.url.is_empty() {
        Some(server.url.clone())
    } else {
        None
    }
}

/// Подробности для диалога оверлея: жив ли сервер, где веб-сборка, сколько клиентов.
#[tauri::command]
pub fn overlay_server_status(state: State<'_, Arc<OverlayServer>>) -> Value {
    state.inner().status()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handshake_matches_rfc_vector() {
        let accept = base64(&sha1(format!("dGhlIHNhbXBsZSBub25jZQ=={WS_GUID}").as_bytes()));
        assert_eq!(accept, "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    }

    #[test]
    fn base64_pads_correctly() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
    }

    #[test]
    fn sha1_known_vectors() {
        let abc = sha1(b"abc");
        assert_eq!(
            base64(&abc),
            "qZk+NkcGgWq6PiVxeFDCbJzQ2J0="
        );
        assert_eq!(base64(&sha1(b"")), "2jmj7l5rSw0yVb/vlWAYkK/YBwk=");
    }
}
