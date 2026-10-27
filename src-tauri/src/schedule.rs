//! Планировщик кадров внутри приложения.
//!
//! Раньше кадры продвигало видимое окно редактора: цикл шёл на
//! `requestAnimationFrame`, поэтому свёрнутое окно или скрытая вкладка
//! останавливали поток, и оверлей замирал. Здесь кадры считает отдельный поток
//! Rust: он живёт столько же, сколько приложение, и не зависит от того, видно
//! ли окно.
//!
//! Входы (микрофон, клавиатура, мышь, события) по-прежнему приходят из
//! фронтенда — нативный аудиозахват это следующий шаг. Фронтенд просто
//! складывает свежий словарь входов сюда, а поток берёт последний.
//!
//! Каждый кадр уходит в окна событием `rig://frame` с тем же JSON, что вернул
//! `RuntimeStore::call_json`: `{"ok":true,"frame":{…}}` или `{"ok":false,…}`.
//! Фронтенд готовит кадр (`prepareFrame`) и раздаёт его оверлеям, поэтому
//! правило «один активный драйвер» (DESIGN §13.3) сохраняется.

use rig_core::RuntimeStore;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

/// Событие с готовым кадром. Полезная нагрузка — строка JSON.
pub const FRAME_EVENT: &str = "rig://frame";

/// Пределы частоты: `limited` берёт частоту из пресета. Фронтенд присылает
/// `limited: true` всегда: в режиме «Экран» он подставляет измеренную частоту
/// монитора. Значение ниже — только запасной путь для старого фронтенда.
const UNLIMITED_FPS: f64 = 120.0;
const MIN_INTERVAL: Duration = Duration::from_millis(2);

struct Inner {
    handle: Option<u32>,
    inputs: Value,
    paused: bool,
    reset_clock: bool,
    interval: Duration,
}

/// Общее состояние движка: его видят и команды, и поток планировщика.
pub struct Shared {
    pub store: Arc<Mutex<RuntimeStore>>,
    inner: Mutex<Inner>,
    running: AtomicBool,
    ticks: AtomicU64,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl Shared {
    pub fn new() -> Self {
        Self {
            store: Arc::new(Mutex::new(RuntimeStore::default())),
            inner: Mutex::new(Inner {
                handle: None,
                inputs: json!({ "values": {}, "signals": {} }),
                paused: false,
                reset_clock: true,
                interval: Duration::from_millis(16),
            }),
            running: AtomicBool::new(false),
            ticks: AtomicU64::new(0),
            thread: Mutex::new(None),
        }
    }

    pub fn running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    pub fn ticks(&self) -> u64 {
        self.ticks.load(Ordering::Relaxed)
    }

    fn interval_for(limited: bool, fps_limit: f64) -> Duration {
        let fps = if limited && fps_limit.is_finite() && fps_limit > 0.0 {
            fps_limit.clamp(1.0, 480.0)
        } else {
            UNLIMITED_FPS
        };
        let millis = 1000.0 / fps;
        let interval = Duration::from_secs_f64(millis / 1000.0);
        if interval < MIN_INTERVAL { MIN_INTERVAL } else { interval }
    }
}

impl Default for Shared {
    fn default() -> Self {
        Self::new()
    }
}

/// Запуск (или перенастройка) планировщика на существующий движок.
///
/// Вызывается из фронтенда после `create`. Повторный вызов просто обновляет
/// ручку, входы и частоту — поток при этом не перезапускается.
#[tauri::command]
pub fn rig_schedule_start(
    app: AppHandle,
    state: State<'_, Arc<Shared>>,
    handle: u32,
    inputs: Value,
    limited: bool,
    fps_limit: f64,
    paused: Option<bool>,
) -> Result<Value, String> {
    let shared = state.inner().clone();
    {
        let mut inner = shared.inner.lock().map_err(|_| "планировщик занят".to_string())?;
        inner.handle = Some(handle);
        inner.inputs = inputs;
        // Паузу задаёт окно, и только оно. Раньше запуск всегда снимал её: после
        // «Стопа» движок пересоздаётся, планировщик поднимался заново и мог
        // остаться работать при стоящем интерфейсе — окно разбирало кадры,
        // которые само же и отбрасывало, и жгло процессор впустую.
        inner.paused = paused.unwrap_or(inner.paused);
        inner.reset_clock = true;
        inner.interval = Shared::interval_for(limited, fps_limit);
    }
    shared.ticks.store(0, Ordering::Relaxed);

    let already = shared.running.swap(true, Ordering::SeqCst);
    if !already {
        let app_handle = app.clone();
        let worker = shared.clone();
        let join = thread::Builder::new()
            .name("rig-schedule".into())
            .spawn(move || run(app_handle, worker))
            .map_err(|error| format!("не удалось запустить поток кадров: {error}"))?;
        let mut slot = shared.thread.lock().map_err(|_| "планировщик занят".to_string())?;
        *slot = Some(join);
    }
    Ok(json!({ "ok": true, "running": shared.running() }))
}

/// Свежие входы. Фронтенд присылает их пачкой, а поток всегда берёт последние.
#[tauri::command]
pub fn rig_schedule_inputs(state: State<'_, Arc<Shared>>, inputs: Value) -> Result<(), String> {
    let shared = state.inner().clone();
    let mut inner = shared.inner.lock().map_err(|_| "планировщик занят".to_string())?;
    inner.inputs = inputs;
    Ok(())
}

/// Пауза и продолжение. На паузе поток не считает кадры вовсе.
#[tauri::command]
pub fn rig_schedule_pause(state: State<'_, Arc<Shared>>, paused: bool) -> Result<(), String> {
    let shared = state.inner().clone();
    let mut inner = shared.inner.lock().map_err(|_| "планировщик занят".to_string())?;
    if inner.paused != paused {
        inner.paused = paused;
        // После паузы время начинается заново: иначе `dt` был бы размером паузы.
        inner.reset_clock = true;
    }
    Ok(())
}

/// Сброс таймлайна без пересоздания движка (кнопка «В начало»).
#[tauri::command]
pub fn rig_schedule_reset_clock(state: State<'_, Arc<Shared>>) -> Result<(), String> {
    let shared = state.inner().clone();
    let mut inner = shared.inner.lock().map_err(|_| "планировщик занят".to_string())?;
    inner.reset_clock = true;
    Ok(())
}

/// Остановка: поток завершается, кадры больше не приходят.
///
/// Ручка обязательна: при смене структуры окно успевает создать новый движок,
/// пока летит остановка старого, и «остановить всё» погасило бы новый поток.
#[tauri::command]
pub fn rig_schedule_stop(state: State<'_, Arc<Shared>>, handle: u32) -> Result<(), String> {
    let shared = state.inner().clone();
    {
        let inner = shared.inner.lock().map_err(|_| "планировщик занят".to_string())?;
        if inner.handle != Some(handle) {
            return Ok(());
        }
    }
    shared.running.store(false, Ordering::SeqCst);
    {
        let mut inner = shared.inner.lock().map_err(|_| "планировщик занят".to_string())?;
        inner.handle = None;
    }
    let join = shared.thread.lock().map_err(|_| "планировщик занят".to_string())?.take();
    if let Some(join) = join {
        let _ = join.join();
    }
    Ok(())
}

/// Состояние для строки статуса и диалога оверлея.
#[tauri::command]
pub fn rig_schedule_status(state: State<'_, Arc<Shared>>) -> Value {
    let shared = state.inner();
    json!({ "running": shared.running(), "ticks": shared.ticks() })
}

fn run(app: AppHandle, shared: Arc<Shared>) {
    let started = Instant::now();
    let mut next_due = Instant::now();
    while shared.running.load(Ordering::SeqCst) {
        let (handle, paused, reset_clock, interval, inputs) = {
            let mut inner = match shared.inner.lock() {
                Ok(value) => value,
                Err(_) => break,
            };
            let reset = inner.reset_clock;
            inner.reset_clock = false;
            (inner.handle, inner.paused, reset, inner.interval, inner.inputs.clone())
        };

        let Some(handle) = handle else {
            thread::sleep(Duration::from_millis(10));
            continue;
        };
        if paused {
            // В паузе поток только проверяет флаг: редких пробуждений хватает,
            // а частые грели бы процессор при неподвижном риге.
            next_due = Instant::now();
            thread::sleep(Duration::from_millis(25));
            continue;
        }

        let request = json!({
            "op": "tick",
            "handle": handle,
            "now": started.elapsed().as_secs_f64(),
            "inputs": inputs,
            "paused": false,
            "resetClock": reset_clock,
        });
        let response = {
            let mut store = match shared.store.lock() {
                Ok(value) => value,
                Err(_) => break,
            };
            store.call_json(&request.to_string())
        };
        let ok = response.contains("\"ok\":true");
        if ok {
            shared.ticks.fetch_add(1, Ordering::Relaxed);
        }
        let _ = app.emit(FRAME_EVENT, response);
        if !ok {
            // Ошибку тоже отдали во фронтенд, но крутиться в ней не будем.
            thread::sleep(Duration::from_millis(50));
            next_due = Instant::now();
            continue;
        }

        next_due += interval;
        let now = Instant::now();
        if next_due > now {
            thread::sleep(next_due - now);
        } else if now.duration_since(next_due) > interval * 4 {
            // Отстали (система спала, окно тянуло поток) — не догоняем пачкой.
            next_due = now;
        }
    }
    shared.running.store(false, Ordering::SeqCst);
}
