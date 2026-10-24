//! Глобальные клавиатура и мышь для модулей `keyboard` / `key` / `mouse`.
//!
//! Слушаем ввод системным хуком (`rdev`): он только читает события, ничего не
//! перехватывает, поэтому клавиши продолжают работать в других окнах. События
//! уходят в редактор как `yappy://pointer`, а значения считает фронтенд — там же,
//! где браузерный режим, чтобы поведение совпадало.

use serde::Serialize;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

pub const POINTER_EVENT: &str = "yappy://pointer";
/// Не чаще 50 событий в секунду: столько движения мыши хватает для анимации.
const MOVE_INTERVAL: Duration = Duration::from_millis(20);

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PointerEvent {
    Key { code: String, down: bool },
    Button { button: &'static str, down: bool },
    Move { x: f64, y: f64 },
    Wheel { dx: f64, dy: f64 },
}

/// Запускает фоновый поток хука. Ошибку установки хука пишем в stderr: без него
/// модули клавиатуры просто не получат значений, приложение остаётся живым.
pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last_move = Instant::now() - MOVE_INTERVAL;
        let result = rdev::listen(move |event| {
            let Some(payload) = convert(&event) else { return };
            if let PointerEvent::Move { .. } = payload {
                if last_move.elapsed() < MOVE_INTERVAL {
                    return;
                }
                last_move = Instant::now();
            }
            if let Err(error) = app.emit(POINTER_EVENT, payload) {
                eprintln!("pointer emit failed: {error}");
            }
        });
        if let Err(error) = result {
            eprintln!("global pointer hook failed: {error:?}");
        }
    });
}

fn convert(event: &rdev::Event) -> Option<PointerEvent> {
    match &event.event_type {
        rdev::EventType::KeyPress(key) => Some(PointerEvent::Key { code: key_code(key), down: true }),
        rdev::EventType::KeyRelease(key) => Some(PointerEvent::Key { code: key_code(key), down: false }),
        rdev::EventType::ButtonPress(button) => Some(PointerEvent::Button { button: button_name(button), down: true }),
        rdev::EventType::ButtonRelease(button) => Some(PointerEvent::Button { button: button_name(button), down: false }),
        rdev::EventType::MouseMove { x, y } => Some(PointerEvent::Move { x: *x, y: *y }),
        rdev::EventType::Wheel { delta_x, delta_y } => Some(PointerEvent::Wheel {
            dx: *delta_x as f64,
            dy: *delta_y as f64,
        }),
    }
}

fn button_name(button: &rdev::Button) -> &'static str {
    match button {
        rdev::Button::Left => "left",
        rdev::Button::Right => "right",
        _ => "other",
    }
}

/// Имя клавиши в терминах `event.code`: одно и то же в браузере и в нативном
/// окне, поэтому модули не зависят от источника событий.
fn key_code(key: &rdev::Key) -> String {
    use rdev::Key;
    let code = match key {
        Key::Alt => "AltLeft",
        Key::AltGr => "AltRight",
        Key::Backspace => "Backspace",
        Key::CapsLock => "CapsLock",
        Key::ControlLeft => "ControlLeft",
        Key::ControlRight => "ControlRight",
        Key::Delete => "Delete",
        Key::DownArrow => "ArrowDown",
        Key::End => "End",
        Key::Escape => "Escape",
        Key::Home => "Home",
        Key::LeftArrow => "ArrowLeft",
        Key::MetaLeft => "MetaLeft",
        Key::MetaRight => "MetaRight",
        Key::PageDown => "PageDown",
        Key::PageUp => "PageUp",
        Key::Return => "Enter",
        Key::RightArrow => "ArrowRight",
        Key::ShiftLeft => "ShiftLeft",
        Key::ShiftRight => "ShiftRight",
        Key::Space => "Space",
        Key::Tab => "Tab",
        Key::UpArrow => "ArrowUp",
        Key::PrintScreen => "PrintScreen",
        Key::ScrollLock => "ScrollLock",
        Key::Pause => "Pause",
        Key::NumLock => "NumLock",
        Key::BackQuote => "Backquote",
        Key::Num1 => "Digit1",
        Key::Num2 => "Digit2",
        Key::Num3 => "Digit3",
        Key::Num4 => "Digit4",
        Key::Num5 => "Digit5",
        Key::Num6 => "Digit6",
        Key::Num7 => "Digit7",
        Key::Num8 => "Digit8",
        Key::Num9 => "Digit9",
        Key::Num0 => "Digit0",
        Key::Minus => "Minus",
        Key::Equal => "Equal",
        Key::KeyQ => "KeyQ",
        Key::KeyW => "KeyW",
        Key::KeyE => "KeyE",
        Key::KeyR => "KeyR",
        Key::KeyT => "KeyT",
        Key::KeyY => "KeyY",
        Key::KeyU => "KeyU",
        Key::KeyI => "KeyI",
        Key::KeyO => "KeyO",
        Key::KeyP => "KeyP",
        Key::LeftBracket => "BracketLeft",
        Key::RightBracket => "BracketRight",
        Key::KeyA => "KeyA",
        Key::KeyS => "KeyS",
        Key::KeyD => "KeyD",
        Key::KeyF => "KeyF",
        Key::KeyG => "KeyG",
        Key::KeyH => "KeyH",
        Key::KeyJ => "KeyJ",
        Key::KeyK => "KeyK",
        Key::KeyL => "KeyL",
        Key::SemiColon => "Semicolon",
        Key::Quote => "Quote",
        Key::BackSlash => "Backslash",
        Key::IntlBackslash => "IntlBackslash",
        Key::KeyZ => "KeyZ",
        Key::KeyX => "KeyX",
        Key::KeyC => "KeyC",
        Key::KeyV => "KeyV",
        Key::KeyB => "KeyB",
        Key::KeyN => "KeyN",
        Key::KeyM => "KeyM",
        Key::Comma => "Comma",
        Key::Dot => "Period",
        Key::Slash => "Slash",
        Key::Insert => "Insert",
        Key::F1 => "F1",
        Key::F2 => "F2",
        Key::F3 => "F3",
        Key::F4 => "F4",
        Key::F5 => "F5",
        Key::F6 => "F6",
        Key::F7 => "F7",
        Key::F8 => "F8",
        Key::F9 => "F9",
        Key::F10 => "F10",
        Key::F11 => "F11",
        Key::F12 => "F12",
        Key::KpReturn => "NumpadEnter",
        Key::KpMinus => "NumpadSubtract",
        Key::KpPlus => "NumpadAdd",
        Key::KpMultiply => "NumpadMultiply",
        Key::KpDivide => "NumpadDivide",
        Key::Kp0 => "Numpad0",
        Key::Kp1 => "Numpad1",
        Key::Kp2 => "Numpad2",
        Key::Kp3 => "Numpad3",
        Key::Kp4 => "Numpad4",
        Key::Kp5 => "Numpad5",
        Key::Kp6 => "Numpad6",
        Key::Kp7 => "Numpad7",
        Key::Kp8 => "Numpad8",
        Key::Kp9 => "Numpad9",
        Key::KpDelete => "NumpadDecimal",
        other => return format!("{other:?}"),
    };
    code.to_string()
}
