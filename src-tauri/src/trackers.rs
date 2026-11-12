//! Трекер лица напрямую с телефона.
//!
//! Зачем отдельный приёмник: приложения трекинга умеют отдавать данные без
//! посредника (VBridger, VMC, VTube Studio API). iFacialMocap и Facemotion3D
//! ждут строку-пароль на порт 49983 и после неё льют текст на порт 49983
//! компьютера; VTube Studio ждёт JSON-запрос на 21412 и льёт JSON на порты из
//! запроса. Отсюда две обязанности: вовремя попросить поток и не потерять кадры.
//!
//! Разбор кадров живёт во фронтенде (`src/modules/tracker.ts`): там же каталог
//! полей, поэтому таблица отображения и приёмник не расходятся. Rust приносит
//! **сырой текст** — ровно как с OSC, — а ошибки формата видны в журнале модуля.
//!
//! Рукопожатие повторяется: у iFacialMocap раз в две секунды, у VTube Studio
//! пять раз в секунду с `time: 1` (поток гаснет сам, если окно закрылось).

use serde::Deserialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tokio::net::UdpSocket;

use crate::sources::{emit_state, emit_text, SourceConfig};

/// Строка-пароль iFacialMocap и Facemotion3D.
const IFM_HELLO: &str = "iFacialMocap_sahuasouryya9218sauhuiayeta91555dy3719";
/// Широковещательный адрес: телефон отвечает сам, без ввода IP.
const BROADCAST: &str = "255.255.255.255";
/// Как часто проверяем флаг остановки и пора ли повторить рукопожатие.
const TICK: Duration = Duration::from_millis(40);
/// Пауза между запросами к VTube Studio: при `time: 1` поток не прерывается.
const VTS_PERIOD: Duration = Duration::from_millis(200);
/// Пауза между «приветами» iFacialMocap: приложение начинает стрим с первого.
const IFM_PERIOD: Duration = Duration::from_secs(2);

/// Транспорты-трекеры: по ним движок источников выбирает этот приёмник.
pub const TRACKER_TRANSPORTS: [&str; 3] = ["ifacialmocap", "vtuberstudio", "facemotion3d"];

pub fn is_tracker(transport: &str) -> bool {
    TRACKER_TRANSPORTS.contains(&transport)
}

/// Порт приложения по умолчанию: он же порт приёма у iFacialMocap.
pub fn default_port(transport: &str) -> u16 {
    if transport == "vtuberstudio" {
        21_412
    } else {
        49_983
    }
}

/// Рукопожатие: им приёмник просит поток и называет свой порт.
///
/// Та же строка собирается в `src/modules/tracker.ts` (`helloFor`): одна для
/// приёма, другая для проверок и подсказок в панели.
fn hello_for(transport: &str, listen_port: u16) -> String {
    match transport {
        "vtuberstudio" => format!(
            "{{\"messageType\":\"iOSTrackingDataRequest\",\"time\":1,\"sentBy\":\"YappyTuberPlus\",\"ports\":[{listen_port}]}}"
        ),
        "facemotion3d" => format!("{IFM_HELLO}|sendDataVersion=v2"),
        _ => IFM_HELLO.to_string(),
    }
}

/// Приёмник трекера: слушает порт, просит поток и отдаёт кадры в окно.
pub async fn tracker_loop(app: AppHandle, config: SourceConfig, stop: Arc<AtomicBool>) {
    let name = config.name.trim().to_string();
    let transport = config.transport.trim().to_ascii_lowercase();
    let app_port = config.port.unwrap_or_else(|| default_port(&transport));
    let listen_port = config
        .listen_port
        .unwrap_or_else(|| default_port(&transport));
    let explicit = config.host.clone().unwrap_or_default().trim().to_string();
    let hello = hello_for(&transport, listen_port);
    let period = if transport == "vtuberstudio" {
        VTS_PERIOD
    } else {
        IFM_PERIOD
    };

    emit_state(&app, &name, "connecting", None);
    // Правка адреса или порта в панели перезапускает источник: прежний цикл
    // останавливается по флагу, но сокет закрывается не мгновенно. Несколько
    // попыток избавляют от ложного «порт занят» прямо во время набора IP.
    let mut bound: Option<UdpSocket> = None;
    for attempt in 0..20 {
        if stop.load(Ordering::SeqCst) {
            return;
        }
        match UdpSocket::bind(("0.0.0.0", listen_port)).await {
            Ok(socket) => {
                bound = Some(socket);
                break;
            }
            Err(error) => {
                if attempt == 19 {
                    emit_state(
                        &app,
                        &name,
                        "error",
                        Some(format!(
                            "порт {listen_port} занят: {error}; закройте программу, которая его держит"
                        )),
                    );
                } else {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
        }
    }
    let Some(socket) = bound else { return };
    // Широковещание нужно, пока адрес телефона неизвестен: иначе пришлось бы
    // вписывать IP руками ещё до первого кадра.
    let _ = socket.set_broadcast(true);
    emit_state(
        &app,
        &name,
        "live",
        Some(format!("слушаю порт {listen_port}")),
    );

    let mut buffer = vec![0u8; 65_535];
    // Адрес последнего отправителя: после первого кадра «привет» идёт уже ему,
    // а не в пустоту широковещания.
    let mut sender: Option<String> = None;
    let mut announced: Option<String> = None;
    let mut next_hello = Instant::now();

    while !stop.load(Ordering::SeqCst) {
        if Instant::now() >= next_hello {
            let target = match sender.as_deref() {
                Some(ip) if explicit.is_empty() => ip.to_string(),
                _ if explicit.is_empty() => BROADCAST.to_string(),
                _ => explicit.clone(),
            };
            // Отказ широковещания — не повод падать: в сети бывает запрет.
            if let Err(error) = socket.send_to(hello.as_bytes(), (target.as_str(), app_port)).await {
                eprintln!("tracker hello {target}:{app_port}: {error}");
            }
            next_hello = Instant::now() + period;
        }
        match tokio::time::timeout(TICK, socket.recv_from(&mut buffer)).await {
            Ok(Ok((size, from))) => {
                let text = String::from_utf8_lossy(&buffer[..size]).to_string();
                if text.trim().is_empty() {
                    continue;
                }
                let ip = from.ip().to_string();
                // Первый кадр с нового адреса показываем в карточке: так видно,
                // что телефон найден, даже если таблица отображения пуста.
                if announced.as_deref() != Some(ip.as_str()) {
                    announced = Some(ip.clone());
                    emit_state(&app, &name, "live", Some(format!("телефон {ip}")));
                }
                sender = Some(ip);
                emit_text(&app, &name, text);
            }
            Ok(Err(error)) => {
                emit_state(&app, &name, "error", Some(format!("сокет: {error}")));
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
            // Тишина — норма: приложение шлёт только пока его просят.
            Err(_) => {}
        }
    }
}

/// Поиск телефона: широковещательное рукопожатие и сбор адресов, кто ответил.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverConfig {
    pub transport: String,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[tauri::command]
pub async fn tracker_discover(config: DiscoverConfig) -> Result<Vec<String>, String> {
    let transport = config.transport.trim().to_ascii_lowercase();
    if !is_tracker(&transport) {
        return Err(format!("«{transport}» — не трекер лица"));
    }
    let app_port = config.port.unwrap_or_else(|| default_port(&transport));
    let limit = Duration::from_millis(config.timeout_ms.unwrap_or(2_500).clamp(400, 6_000));
    // У iFacialMocap адрес приёма фиксирован (49983): иначе ответ уйдёт мимо.
    // У VTube Studio порт называет сам клиент, поэтому берём свободный.
    let listen_port = if transport == "vtuberstudio" { 0 } else { app_port };
    let socket = UdpSocket::bind(("0.0.0.0", listen_port)).await.map_err(|error| {
        format!(
            "порт {listen_port} занят: {error}. Модуль уже слушает — адрес телефона виден в строке «Отправитель»"
        )
    })?;
    socket
        .set_broadcast(true)
        .map_err(|error| format!("широковещание недоступно: {error}"))?;
    let actual = socket
        .local_addr()
        .map_err(|error| format!("адрес сокета: {error}"))?
        .port();
    let hello = hello_for(&transport, actual);

    let started = Instant::now();
    let mut found: Vec<String> = Vec::new();
    let mut buffer = vec![0u8; 4_096];
    let mut next_hello = Instant::now();
    while started.elapsed() < limit {
        if Instant::now() >= next_hello {
            let _ = socket.send_to(hello.as_bytes(), (BROADCAST, app_port)).await;
            next_hello = Instant::now() + Duration::from_millis(300);
        }
        if let Ok(Ok((_size, from))) =
            tokio::time::timeout(Duration::from_millis(80), socket.recv_from(&mut buffer)).await
        {
            let ip = from.ip().to_string();
            if !found.contains(&ip) {
                found.push(ip);
            }
            if found.len() >= 8 {
                break;
            }
        }
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transports_and_ports() {
        assert!(is_tracker("ifacialmocap"));
        assert!(is_tracker("vtuberstudio"));
        assert!(!is_tracker("osc"));
        assert_eq!(default_port("vtuberstudio"), 21_412);
        assert_eq!(default_port("ifacialmocap"), 49_983);
        assert_eq!(default_port("facemotion3d"), 49_983);
    }

    #[test]
    fn hello_shapes() {
        assert_eq!(hello_for("ifacialmocap", 49_983), IFM_HELLO);
        assert_eq!(
            hello_for("facemotion3d", 49_983),
            format!("{IFM_HELLO}|sendDataVersion=v2")
        );
        // VTube Studio: свой порт приёма внутри запроса и время в секундах.
        let hello = hello_for("vtuberstudio", 21_412);
        assert!(hello.contains("\"messageType\":\"iOSTrackingDataRequest\""));
        assert!(hello.contains("\"ports\":[21412]"));
        assert!(hello.contains("\"time\":1"));
    }
}
