//! Внешние источники на стороне Rust: HTTP-опрос, SSE и OSC по UDP.
//!
//! Зачем это в Rust, а не в окне: `fetch` из WebView упирается в CORS, а сокеты
//! UDP из вебвью недоступны вовсе. Здесь же запросы идут мимо браузерных правил
//! и не зависят от того, какое окно в фокусе. WebSocket остаётся в вебвью — он
//! работает одинаково в браузере и в приложении.
//!
//! Разделение обязанностей простое: Rust приносит **сырой текст**, а таблицу
//! отображения (поле JSON → вход) применяет фронтенд. Поэтому правила живут в
//! одном месте, и пресет одинаково работает с любым транспортом.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

/// Событие в окно: состояние источника и его пакеты.
pub const SOURCE_EVENT: &str = "yappy://source";
/// Ответ HTTP дольше этого считаем зависшим: лучше «нет связи», чем вечный `await`.
const HTTP_TIMEOUT: Duration = Duration::from_secs(10);
/// Пауза перед переподключением SSE.
const SSE_RETRY: Duration = Duration::from_secs(2);
/// Как часто проверяем флаг остановки во время ожидания.
const STOP_POLL: Duration = Duration::from_millis(100);

/// Описание источника из окна. Таблицы отображения здесь нет: Rust её не знает.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceConfig {
    pub name: String,
    pub transport: String,
    pub url: String,
    #[serde(default)]
    pub interval_ms: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SourceEvent {
    /// `state`: `connecting` / `live` / `error`.
    State {
        name: String,
        state: String,
        message: Option<String>,
    },
    /// Сырой текст пакета: JSON от источника или OSC, собранный в объект.
    Text { name: String, text: String },
}

/// Запущенные источники: имя → флаг остановки. Задачу не убиваем силой —
/// просим закончить, чтобы не оставить сокет открытым.
#[derive(Default)]
pub struct Sources {
    running: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

fn stop_one(sources: &Sources, name: &str) {
    if let Ok(mut map) = sources.running.lock() {
        if let Some(flag) = map.remove(name) {
            flag.store(true, Ordering::SeqCst);
        }
    }
}

fn emit_state(app: &AppHandle, name: &str, state: &str, message: Option<String>) {
    let payload = SourceEvent::State {
        name: name.to_string(),
        state: state.to_string(),
        message,
    };
    if let Err(error) = app.emit(SOURCE_EVENT, payload) {
        eprintln!("source emit failed: {error}");
    }
}

fn emit_text(app: &AppHandle, name: &str, text: String) {
    let payload = SourceEvent::Text {
        name: name.to_string(),
        text,
    };
    if let Err(error) = app.emit(SOURCE_EVENT, payload) {
        eprintln!("source emit failed: {error}");
    }
}

/// Запускает источник. Повторный запуск с тем же именем сначала останавливает
/// прежний: правка адреса в панели не должна оставлять два соединения.
#[tauri::command]
pub fn source_start(
    app: AppHandle,
    state: State<'_, Sources>,
    config: SourceConfig,
) -> Result<(), String> {
    let name = config.name.trim().to_string();
    if name.is_empty() {
        return Err("у источника нет имени модуля".into());
    }
    stop_one(state.inner(), &name);
    let flag = Arc::new(AtomicBool::new(false));
    let transport = config.transport.trim().to_ascii_lowercase();

    match transport.as_str() {
        "http" => {
            let app = app.clone();
            let flag = flag.clone();
            let task = config.clone();
            tauri::async_runtime::spawn(async move { http_loop(app, task, flag).await });
        }
        "sse" => {
            let app = app.clone();
            let flag = flag.clone();
            let task = config.clone();
            tauri::async_runtime::spawn(async move { sse_loop(app, task, flag).await });
        }
        "osc" => {
            let app = app.clone();
            let flag = flag.clone();
            let task = config.clone();
            tauri::async_runtime::spawn(async move { osc_loop(app, task, flag).await });
        }
        "ws" => {
            return Err("WebSocket работает в окне и не требует Rust".into());
        }
        other => {
            return Err(format!("транспорт «{other}» пока не поддержан"));
        }
    }

    state
        .running
        .lock()
        .map_err(|_| "список источников заблокирован".to_string())?
        .insert(name, flag);
    Ok(())
}

/// Останавливает один источник: сокет закрывается, окно перестаёт получать пакеты.
#[tauri::command]
pub fn source_stop(state: State<'_, Sources>, name: String) -> Result<(), String> {
    stop_one(state.inner(), &name);
    Ok(())
}

/// Останавливает всё: вызывается при закрытии окна и при выключении всех модулей.
#[tauri::command]
pub fn source_stop_all(state: State<'_, Sources>) -> Result<(), String> {
    if let Ok(mut map) = state.running.lock() {
        for (_, flag) in map.drain() {
            flag.store(true, Ordering::SeqCst);
        }
    }
    Ok(())
}

fn web_url(url: &str) -> Result<&str, String> {
    if url.starts_with("http://") || url.starts_with("https://") {
        return Ok(url);
    }
    Err("адрес должен начинаться с http:// или https://".into())
}

fn describe(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "источник не ответил вовремя".into()
    } else if error.is_connect() {
        "нет соединения с источником".into()
    } else {
        error.to_string()
    }
}

/// Спит `duration`, но просыпается, если источник остановили.
async fn idle(stop: &AtomicBool, duration: Duration) {
    let deadline = tokio::time::Instant::now() + duration;
    while !stop.load(Ordering::SeqCst) {
        let now = tokio::time::Instant::now();
        if now >= deadline {
            return;
        }
        let left = deadline - now;
        tokio::time::sleep(left.min(STOP_POLL)).await;
    }
}

async fn http_loop(app: AppHandle, config: SourceConfig, stop: Arc<AtomicBool>) {
    let name = config.name.trim().to_string();
    let url = match web_url(config.url.trim()) {
        Ok(url) => url.trim().to_string(),
        Err(message) => {
            emit_state(&app, &name, "error", Some(message));
            return;
        }
    };
    emit_state(&app, &name, "connecting", None);
    let interval = Duration::from_millis(config.interval_ms.unwrap_or(1000).clamp(100, 600_000));
    let client = match reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .connect_timeout(Duration::from_secs(5))
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            emit_state(&app, &name, "error", Some(format!("клиент не создан: {error}")));
            return;
        }
    };
    let mut live = false;
    while !stop.load(Ordering::SeqCst) {
        match client.get(url.as_str()).send().await {
            Ok(response) => {
                let status = response.status();
                if !status.is_success() {
                    // Ошибка источника — это состояние, а не повод молчать.
                    emit_state(&app, &name, "error", Some(format!("ответ {status}")));
                } else {
                    // Байты, а не `text()`: не гадаем про кодировку, а битое
                    // заменяем безопасно — значение важнее строгости.
                    match response.bytes().await {
                        Ok(bytes) => {
                            if !live {
                                emit_state(&app, &name, "live", None);
                                live = true;
                            }
                            emit_text(&app, &name, String::from_utf8_lossy(&bytes).into_owned());
                        }
                        Err(error) => {
                            emit_state(&app, &name, "error", Some(format!("чтение ответа: {error}")))
                        }
                    }
                }
            }
            Err(error) => emit_state(&app, &name, "error", Some(describe(&error))),
        }
        idle(&stop, interval).await;
    }
}

async fn sse_loop(app: AppHandle, config: SourceConfig, stop: Arc<AtomicBool>) {
    let name = config.name.trim().to_string();
    let url = match web_url(config.url.trim()) {
        Ok(url) => url.trim().to_string(),
        Err(message) => {
            emit_state(&app, &name, "error", Some(message));
            return;
        }
    };
    // У потока нет общего таймаута: он живёт часами. Ограничиваем только соединение.
    let client = match reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            emit_state(&app, &name, "error", Some(format!("клиент не создан: {error}")));
            return;
        }
    };
    while !stop.load(Ordering::SeqCst) {
        emit_state(&app, &name, "connecting", None);
        let request = client
            .get(url.as_str())
            .header(reqwest::header::ACCEPT, "text/event-stream");
        match request.send().await {
            Ok(mut response) => {
                let status = response.status();
                if !status.is_success() {
                    emit_state(&app, &name, "error", Some(format!("ответ {status}")));
                } else {
                    emit_state(&app, &name, "live", None);
                    let mut buffer = String::new();
                    let mut data = String::new();
                    while !stop.load(Ordering::SeqCst) {
                        match response.chunk().await {
                            Ok(Some(chunk)) => {
                                buffer.push_str(&String::from_utf8_lossy(&chunk));
                                while let Some(position) = buffer.find('\n') {
                                    let line = buffer[..position].trim_end_matches('\r').to_string();
                                    buffer.drain(..=position);
                                    if line.is_empty() {
                                        // Пустая строка — конец события, ровно как в SSE.
                                        if !data.is_empty() {
                                            emit_text(&app, &name, std::mem::take(&mut data));
                                        }
                                    } else if let Some(rest) = line.strip_prefix("data:") {
                                        if !data.is_empty() {
                                            data.push('\n');
                                        }
                                        data.push_str(rest.trim_start());
                                    }
                                }
                            }
                            Ok(None) => break,
                            Err(error) => {
                                emit_state(&app, &name, "error", Some(format!("поток прерван: {error}")));
                                break;
                            }
                        }
                    }
                }
            }
            Err(error) => emit_state(&app, &name, "error", Some(describe(&error))),
        }
        idle(&stop, SSE_RETRY).await;
    }
}

/// Порт из `udp://0.0.0.0:9000`, `osc://:9000` или просто `9000`.
fn osc_port(url: &str) -> Option<u16> {
    let trimmed = url.trim();
    let rest = trimmed.split("://").nth(1).unwrap_or(trimmed);
    let host = rest.split('/').next().unwrap_or(rest);
    let port = host.rsplit(':').next()?;
    port.parse::<u16>().ok()
}

async fn osc_loop(app: AppHandle, config: SourceConfig, stop: Arc<AtomicBool>) {
    let name = config.name.trim().to_string();
    let Some(port) = osc_port(&config.url) else {
        emit_state(
            &app,
            &name,
            "error",
            Some("укажите порт: udp://0.0.0.0:9000".into()),
        );
        return;
    };
    emit_state(&app, &name, "connecting", None);
    let socket = match tokio::net::UdpSocket::bind(("0.0.0.0", port)).await {
        Ok(socket) => socket,
        Err(error) => {
            emit_state(&app, &name, "error", Some(format!("порт {port} занят: {error}")));
            return;
        }
    };
    emit_state(&app, &name, "live", None);
    let mut buffer = vec![0u8; 65_535];
    while !stop.load(Ordering::SeqCst) {
        match tokio::time::timeout(STOP_POLL, socket.recv_from(&mut buffer)).await {
            Ok(Ok((size, _from))) => {
                let mut values = Map::new();
                collect_osc(&buffer[..size], &mut values);
                if values.is_empty() {
                    continue;
                }
                emit_text(&app, &name, Value::Object(values).to_string());
            }
            Ok(Err(error)) => {
                emit_state(&app, &name, "error", Some(format!("сокет: {error}")));
                idle(&stop, Duration::from_millis(500)).await;
            }
            // Тишина в эфире — это норма: OSC шлёт только изменения.
            Err(_) => {}
        }
    }
}

/// Разбирает OSC-пакет: сообщение целиком или бандл с вложенными сообщениями.
///
/// Наружу отдаётся `{ "/avatar/parameters/HR": 72 }`: адрес OSC становится
/// ключом, поэтому в таблице отображения пишется `$["/avatar/parameters/HR"]`.
fn collect_osc(packet: &[u8], out: &mut Map<String, Value>) {
    if packet.starts_with(b"#bundle") {
        let mut index = 16; // "#bundle\0" и 8 байт тайм-тега
        while index + 4 <= packet.len() {
            let size = u32::from_be_bytes([
                packet[index],
                packet[index + 1],
                packet[index + 2],
                packet[index + 3],
            ]) as usize;
            index += 4;
            if index + size > packet.len() {
                break;
            }
            collect_osc(&packet[index..index + size], out);
            index += size;
        }
        return;
    }
    let Some((address, after_address)) = read_osc_string(packet, 0) else {
        return;
    };
    if !address.starts_with('/') {
        return;
    }
    let Some((tags, mut index)) = read_osc_string(packet, after_address) else {
        return;
    };
    let mut numbers: Vec<Value> = Vec::new();
    for tag in tags.trim_start_matches(',').chars() {
        match tag {
            'i' => {
                if index + 4 > packet.len() {
                    break;
                }
                let value = i32::from_be_bytes([
                    packet[index],
                    packet[index + 1],
                    packet[index + 2],
                    packet[index + 3],
                ]);
                numbers.push(Value::from(value as f64));
                index += 4;
            }
            'f' => {
                if index + 4 > packet.len() {
                    break;
                }
                let value = f32::from_be_bytes([
                    packet[index],
                    packet[index + 1],
                    packet[index + 2],
                    packet[index + 3],
                ]);
                numbers.push(Value::from(value as f64));
                index += 4;
            }
            'd' => {
                if index + 8 > packet.len() {
                    break;
                }
                let mut bytes = [0u8; 8];
                bytes.copy_from_slice(&packet[index..index + 8]);
                numbers.push(Value::from(f64::from_be_bytes(bytes)));
                index += 8;
            }
            'h' => {
                if index + 8 > packet.len() {
                    break;
                }
                let mut bytes = [0u8; 8];
                bytes.copy_from_slice(&packet[index..index + 8]);
                numbers.push(Value::from(i64::from_be_bytes(bytes) as f64));
                index += 8;
            }
            // В OSC истина и ложь кодируются самим тегом, без байтов значения.
            'T' => numbers.push(Value::from(1.0)),
            'F' => numbers.push(Value::from(0.0)),
            's' | 'S' => match read_osc_string(packet, index) {
                Some((_, next)) => index = next,
                None => break,
            },
            // Неизвестный тег: остаток пакета прочитать нельзя, но взятое уже наше.
            _ => break,
        }
    }
    if numbers.is_empty() {
        return;
    }
    let value = if numbers.len() == 1 {
        numbers.remove(0)
    } else {
        Value::Array(numbers)
    };
    out.insert(address, value);
}

/// Строка OSC: текст до нуля, выровненный по 4 байта.
fn read_osc_string(packet: &[u8], start: usize) -> Option<(String, usize)> {
    if start >= packet.len() {
        return None;
    }
    let end = packet[start..].iter().position(|byte| *byte == 0)? + start;
    let text = String::from_utf8_lossy(&packet[start..end]).into_owned();
    let next = ((end + 1 + 3) & !3).min(packet.len());
    Some((text, next))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn osc_string(text: &str) -> Vec<u8> {
        let mut bytes = text.as_bytes().to_vec();
        bytes.push(0);
        while bytes.len() % 4 != 0 {
            bytes.push(0);
        }
        bytes
    }

    #[test]
    fn port_from_urls() {
        assert_eq!(osc_port("udp://0.0.0.0:9000"), Some(9000));
        assert_eq!(osc_port("osc://127.0.0.1:9001/params"), Some(9001));
        assert_eq!(osc_port("9002"), Some(9002));
        assert_eq!(osc_port("udp://0.0.0.0"), None);
    }

    #[test]
    fn osc_message_with_float() {
        let mut packet = osc_string("/avatar/parameters/HR");
        packet.extend(osc_string(",f"));
        packet.extend(72.5f32.to_be_bytes());
        let mut out = Map::new();
        collect_osc(&packet, &mut out);
        assert_eq!(out.get("/avatar/parameters/HR").and_then(Value::as_f64), Some(72.5));
    }

    #[test]
    fn osc_message_with_int_and_flag() {
        let mut packet = osc_string("/cheer");
        packet.extend(osc_string(",iT"));
        packet.extend(500i32.to_be_bytes());
        let mut out = Map::new();
        collect_osc(&packet, &mut out);
        let value = out.get("/cheer").expect("адрес разобран");
        assert_eq!(value[0].as_f64(), Some(500.0));
        assert_eq!(value[1].as_f64(), Some(1.0));
    }

    #[test]
    fn osc_bundle_is_unpacked() {
        let mut message = osc_string("/hr");
        message.extend(osc_string(",i"));
        message.extend(72i32.to_be_bytes());

        let mut bundle = b"#bundle\0".to_vec();
        bundle.extend([0u8; 8]);
        bundle.extend((message.len() as u32).to_be_bytes());
        bundle.extend(&message);

        let mut out = Map::new();
        collect_osc(&bundle, &mut out);
        assert_eq!(out.get("/hr").and_then(Value::as_f64), Some(72.0));
    }

    #[test]
    fn text_is_not_a_value() {
        let mut packet = osc_string("/name");
        packet.extend(osc_string(",s"));
        packet.extend(osc_string("зритель"));
        let mut out = Map::new();
        collect_osc(&packet, &mut out);
        assert!(out.is_empty());
    }
}
