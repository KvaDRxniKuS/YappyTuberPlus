use crate::model::{
    BaseUpdate, Frame, InputValues, MediaCue, NodeKey, ObjectKind, Param, RigPreset, Vec2,
};
use crate::parser::{
    parse_script, AssignTarget, BinaryOp, EventKind, EventSource, Expr, Statement, UnaryOp,
};
use serde::Deserialize;
use serde_json::{json, Value as JsonValue};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::f64::consts::{E, PI};
use std::sync::Arc;

#[derive(Debug, Clone)]
enum Value {
    Number(f64),
    /// Строка: литерал, текст объекта или результат строковой функции.
    /// Числовые параметры её не принимают — она живёт в `text`.
    Text(String),
    Vector(Vec2),
    Object(String),
    Signals,
}

/// Условие, по которому срабатывает готовый блок события.
#[derive(Debug, Clone)]
enum CompiledTrigger {
    /// `on start` — первый кадр после запуска или остановки.
    Start,
    /// Вход модуля: значение берётся из `inputs.values`.
    Input { source: String, kind: EventKind },
}

/// Запись текста: `text = …` в своём скрипте или `label.text = …` в чужом.
///
/// Текст не число, поэтому он не попадает в общий кэш параметров: у него своя
/// пара «база + переопределение» (`text_base` и `texts`).
#[derive(Debug, Clone)]
struct TextWrite {
    /// Чей скрипт пишет: в этом контексте считаются имена внутри выражения.
    owner: Option<String>,
    /// Кому достаётся текст.
    target: String,
    expr: Arc<Expr>,
}

/// Блок события, готовый к исполнению: условие, владелец и цели тела.
#[derive(Debug, Clone)]
struct CompiledEvent {
    trigger: CompiledTrigger,
    /// Объект, в скрипте которого записан блок; `None` — глобальные переменные.
    owner: Option<String>,
    /// Что присвоить при срабатывании: узел и выражение.
    body: Vec<(NodeKey, Arc<Expr>)>,
    /// Записи `text = …` из тела: переопределяют текст до остановки.
    text_body: Vec<TextWrite>,
    /// Команды (`play()`, `seek(…)`, `text(…)`): выполняются после присваиваний.
    actions: Vec<Arc<Expr>>,
}

/// Команды, которые понимает тело блока события. Всё остальное — формулы.
const ACTIONS: [&str; 8] = [
    "play", "resume", "pause", "stop", "seek", "rate", "volume", "text",
];

/// Состояние воспроизведения медиа-объекта между кадрами.
///
/// Команды меняют именно его, а параметры `play`, `speed` и `volume` читают
/// отсюда, пока скрипт не задал их формулой: `volume = mic.loudness` важнее
/// команды, потому что формула считается каждый кадр.
#[derive(Debug, Clone)]
struct Playback {
    playing: bool,
    speed: f64,
    volume: f64,
}

impl Default for Playback {
    fn default() -> Self {
        Self {
            playing: false,
            speed: 1.0,
            volume: 1.0,
        }
    }
}

/// Объект, которым управляет команда: `play("дождь")` → `Some("дождь")`.
fn action_object(call: &Expr) -> Option<&str> {
    match call {
        Expr::Call { args, .. } => match args.first() {
            Some(Expr::Text(name)) => Some(name.as_str()),
            _ => None,
        },
        _ => None,
    }
}

/// Проверка команды на этапе сборки: имя, объект и арность.
///
/// Ошибки не ломают сцену — они попадают в диагностику кадра, как и ошибки
/// присваиваний, а сама команда просто не выполняется.
fn check_action(
    call: &Arc<Expr>,
    owner: Option<&str>,
    preset: &RigPreset,
    object_indices: &HashMap<String, usize>,
    diagnostics: &mut BTreeSet<String>,
) -> bool {
    let Expr::Call { name, args, .. } = call.as_ref() else {
        return false;
    };
    let label = owner.unwrap_or("глобальные");
    if !ACTIONS.contains(&name.as_str()) {
        diagnostics.insert(format!(
            "{}: неизвестная команда '{}'; ожидалось play, resume, pause, stop, seek, rate, volume или text",
            label, name
        ));
        return false;
    }
    // У `text(…)` строка — это не адресат, а содержимое. Поэтому адресатом
    // служит владелец блока, а id объекта пишется первым аргументом:
    // `text("label", "привет")`. Аргумент-содержимое — любое выражение:
    // `text(mic.db)` покажет число, `text("x" + "y")` — склейку.
    if name == "text" {
        if args.is_empty() || args.len() > 2 {
            diagnostics.insert(format!(
                "{}: text ждёт текст: text(\"привет\"), text(mic.db) или text(\"id\", \"привет\")",
                label
            ));
            return false;
        }
        let target = if args.len() == 2 {
            match &args[0] {
                Expr::Text(id) => id.clone(),
                _ => {
                    diagnostics.insert(format!(
                        "{}: первым аргументом text(…) идёт id объекта строкой",
                        label
                    ));
                    return false;
                }
            }
        } else {
            match owner {
                Some(id) => id.to_string(),
                None => {
                    diagnostics.insert(
                        "глобальные: команде 'text' нужен объект: text(\"id_объекта\", …)".into(),
                    );
                    return false;
                }
            }
        };
        let Some(index) = object_indices.get(&target).copied() else {
            diagnostics.insert(format!(
                "{}: команда 'text' ссылается на неизвестный объект '{}'",
                label, target
            ));
            return false;
        };
        if preset.objects[index].kind != ObjectKind::Text {
            diagnostics.insert(format!(
                "{}: text(…) пишет только в текстовый объект",
                label
            ));
            return false;
        }
        return true;
    }
    // Медиа-команды адресуют объект строкой: `play("дождь")`, `seek("дождь", 2)`.
    let explicit = action_object(call).is_some();
    let target = if explicit {
        match &args[0] {
            Expr::Text(id) => {
                if !object_indices.contains_key(id) {
                    diagnostics.insert(format!(
                        "{}: команда '{}' ссылается на неизвестный объект '{}'",
                        label, name, id
                    ));
                    return false;
                }
                id.as_str()
            }
            _ => return false,
        }
    } else {
        match owner {
            Some(id) => id,
            None => {
                diagnostics.insert(format!(
                    "глобальные: команде '{}' нужен объект: {}(\"id_объекта\", …)",
                    name, name
                ));
                return false;
            }
        }
    };
    let kind = object_indices
        .get(target)
        .map(|index| preset.objects[*index].kind);
    if kind != Some(ObjectKind::Media) {
        diagnostics.insert(format!(
            "{}: '{}' управляет только медиа-объектом",
            label, name
        ));
        return false;
    }
    let numbers = if explicit {
        args.len().saturating_sub(1)
    } else {
        args.len()
    };
    let needs_argument = matches!(name.as_str(), "seek" | "rate" | "volume");
    if needs_argument && numbers == 0 {
        diagnostics.insert(format!("{}: '{}' ждёт число в скобках", label, name));
        return false;
    }
    if numbers > 1 {
        diagnostics.insert(format!("{}: у '{}' только один числовой аргумент", label, name));
        return false;
    }
    true
}

/// Состояние одного блока: прошлое значение, начало удержания и защёлка.
#[derive(Debug, Clone)]
struct EventState {
    last: f64,
    since: f64,
    fired: bool,
    /// Условие `hold`/`relax` уже выполняется (нужно, чтобы поймать начало).
    active: bool,
    /// Кадр, на котором условие выполнилось: `hold(0)` ждёт следующий кадр,
    /// поэтому он и не совпадает по поведению с `down`.
    armed: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct StateKey {
    node: NodeKey,
    call_id: u32,
}

#[derive(Debug, Clone)]
enum RuntimeState {
    Smooth(f64),
    Spring {
        value: f64,
        velocity: f64,
    },
    Blink {
        next: f64,
        until: f64,
        seed: f64,
        index: u64,
    },
}

pub struct Rig {
    preset: RigPreset,
    expressions: HashMap<NodeKey, Arc<Expr>>,
    object_indices: HashMap<String, usize>,
    global_names: Vec<String>,
    previous: Frame,
    cache: HashMap<NodeKey, f64>,
    visiting: Vec<NodeKey>,
    cycle_nodes: BTreeSet<NodeKey>,
    diagnostics: BTreeSet<String>,
    states: HashMap<StateKey, RuntimeState>,
    /// Блоки `on …` из глобального скрипта и скриптов объектов.
    events: Vec<CompiledEvent>,
    event_state: HashMap<usize, EventState>,
    /// Записи чужим объектам из обычных присваиваний: применяются последними.
    writes: Vec<(NodeKey, Arc<Expr>)>,
    /// Состояние медиа по id объекта: команды и параметры `play/speed/volume`.
    playback: HashMap<String, Playback>,
    /// Последняя команда каждому медиа-объекту: уходит в кадр.
    media: BTreeMap<String, MediaCue>,
    /// Счётчик команд: по нему редактор понимает, что команда новая.
    media_seq: u64,
    /// Базовый текст из скрипта: `text = "привет"` на верхнем уровне объекта.
    /// Считается каждый кадр, поэтому годится и формула: `text = text(mic.db)`.
    text_base: Vec<TextWrite>,
    /// Значение базового текста в этом кадре: его видят редактор и оверлей.
    base_texts: BTreeMap<String, String>,
    /// Переопределение из событий (`text = "пока"` в блоке): живёт до остановки,
    /// после неё снова виден базовый текст.
    texts: BTreeMap<String, String>,
    /// Первый кадр после запуска/остановки: для `on start`.
    started: bool,
    /// Ошибки разбора скриптов: сцена работает, а редактор показывает место ошибки.
    compile_diagnostics: BTreeSet<String>,
    /// Переменные, которые существуют только потому, что их меняют события:
    /// между срабатываниями они держат значение прошлого кадра.
    persistent_globals: HashSet<String>,
    inputs: InputValues,
    now: f64,
    time: f64,
    dt: f64,
    seq: u64,
    last_now: Option<f64>,
}

impl Rig {
    pub fn new(preset: RigPreset) -> Result<Self, String> {
        if preset.objects.len() > 256 {
            return Err("пресет содержит больше 256 объектов".into());
        }
        let mut object_indices = HashMap::new();
        for (index, object) in preset.objects.iter().enumerate() {
            if object.id.is_empty()
                || !object
                    .id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_')
            {
                return Err(format!(
                    "некорректный ID объекта '{}': допустимы ASCII a-z, 0-9, _",
                    object.id
                ));
            }
            if object_indices.insert(object.id.clone(), index).is_some() {
                return Err(format!("повторяющийся ID объекта '{}'", object.id));
            }
        }
        for object in &preset.objects {
            if let Some(parent) = &object.parent_id {
                if !object_indices.contains_key(parent) {
                    return Err(format!(
                        "объект '{}' ссылается на несуществующего родителя '{}'",
                        object.id, parent
                    ));
                }
                if parent == &object.id {
                    return Err(format!(
                        "объект '{}' не может быть родителем самого себя",
                        object.id
                    ));
                }
            }
        }
        for object in &preset.objects {
            let mut seen = HashSet::new();
            let mut current = Some(object.id.clone());
            while let Some(id) = current {
                if !seen.insert(id.clone()) {
                    return Err(format!("цикл родителей через объект '{}'", id));
                }
                let index = object_indices[&id];
                current = preset.objects[index].parent_id.clone();
            }
        }

        let mut expressions = HashMap::new();
        let mut global_names = Vec::new();
        let mut events: Vec<CompiledEvent> = Vec::new();
        let mut writes: Vec<(NodeKey, Arc<Expr>)> = Vec::new();
        // Текстовые записи: база считается каждый кадр, тело события — при срабатывании.
        let mut text_base: Vec<TextWrite> = Vec::new();
        let mut persistent_globals: HashSet<String> = HashSet::new();
        let mut compile_diagnostics: BTreeSet<String> = BTreeSet::new();
        // Именованные события объявляются только в глобальном скрипте: так у них
        // одно имя на всю сцену, и любой объект может на него подписаться.
        let mut triggers: HashMap<String, (String, EventKind)> = HashMap::new();

        match parse_script(&preset.globals) {
            Ok(script) => {
                for decl in &script.triggers {
                    triggers.insert(decl.name.clone(), (decl.source.clone(), decl.kind.clone()));
                }
                for (target, expr) in &script.assignments {
                    match target {
                        AssignTarget::Local(name) => {
                            // У глобального скрипта нет своего объекта, поэтому
                            // `text = …` здесь — не текст, а переменная с таким именем.
                            if name == "text" {
                                compile_diagnostics.insert(
                                    "глобальные: текст задаётся у объекта — label.text = \"…\""
                                        .into(),
                                );
                                continue;
                            }
                            global_names.push(name.clone());
                            expressions.insert(NodeKey::Global(name.clone()), expr.clone());
                        }
                        AssignTarget::Foreign { object, param } => {
                            if param == "text" {
                                match text_target(object, &object_indices, &preset) {
                                    Ok(()) => text_base.push(TextWrite {
                                        owner: None,
                                        target: object.clone(),
                                        expr: expr.clone(),
                                    }),
                                    Err(message) => {
                                        compile_diagnostics.insert(format!("глобальные: {}", message));
                                    }
                                }
                                continue;
                            }
                            match foreign_key(object, param, &object_indices, &preset) {
                                Ok(key) => writes.push((key, expr.clone())),
                                Err(message) => {
                                    compile_diagnostics.insert(format!("глобальные: {}", message));
                                }
                            }
                        }
                    }
                }
                for block in &script.events {
                    let trigger = match resolve_trigger(&block.source, &triggers) {
                        Ok(trigger) => trigger,
                        Err(message) => {
                            compile_diagnostics.insert(format!("глобальные: {}", message));
                            continue;
                        }
                    };
                    let mut body = Vec::new();
                    let mut actions = Vec::new();
                    let mut text_body: Vec<TextWrite> = Vec::new();
                    for statement in &block.body {
                        let (target, expr) = match statement {
                            Statement::Assign(target, expr) => (target, expr),
                            Statement::Call(call) => {
                                if check_action(
                                    call,
                                    None,
                                    &preset,
                                    &object_indices,
                                    &mut compile_diagnostics,
                                ) {
                                    actions.push(call.clone());
                                }
                                continue;
                            }
                        };
                        if let AssignTarget::Local(name) = target {
                            if name == "text" {
                                compile_diagnostics.insert(
                                    "глобальные: текст задаётся у объекта — label.text = \"…\""
                                        .into(),
                                );
                                continue;
                            }
                        }
                        if let AssignTarget::Foreign { object, param } = target {
                            if param == "text" {
                                match text_target(object, &object_indices, &preset) {
                                    Ok(()) => text_body.push(TextWrite {
                                        owner: None,
                                        target: object.clone(),
                                        expr: expr.clone(),
                                    }),
                                    Err(message) => {
                                        compile_diagnostics.insert(format!("глобальные: {}", message));
                                    }
                                }
                                continue;
                            }
                        }
                        let key = match target {
                            AssignTarget::Local(name) => {
                                if !global_names.iter().any(|existing| existing == name) {
                                    global_names.push(name.clone());
                                }
                                if !expressions.contains_key(&NodeKey::Global(name.clone())) {
                                    persistent_globals.insert(name.clone());
                                }
                                NodeKey::Global(name.clone())
                            }
                            AssignTarget::Foreign { object, param } => {
                                match foreign_key(object, param, &object_indices, &preset) {
                                    Ok(key) => key,
                                    Err(message) => {
                                        compile_diagnostics.insert(format!("глобальные: {}", message));
                                        continue;
                                    }
                                }
                            }
                        };
                        body.push((key, expr.clone()));
                    }
                    events.push(CompiledEvent {
                        trigger,
                        owner: None,
                        body,
                        text_body,
                        actions,
                    });
                }
            }
            Err(error) => {
                compile_diagnostics.insert(format!("глобальные: {}", error));
            }
        }
        global_names.sort();

        for object in &preset.objects {
            let script = match parse_script(&object.script) {
                Ok(script) => script,
                Err(error) => {
                    compile_diagnostics.insert(format!("{}: {}", object.id, error));
                    continue;
                }
            };
            if !script.triggers.is_empty() {
                compile_diagnostics.insert(format!(
                    "{}: 'trigger' объявляется только в глобальном скрипте",
                    object.id
                ));
            }
            for (target, expr) in &script.assignments {
                match target {
                    AssignTarget::Local(name) => {
                        // `text` — строковый параметр: у него своя запись, а не
                        // числовой кэш. База считается каждый кадр.
                        if name == "text" {
                            if object.kind != ObjectKind::Text {
                                compile_diagnostics.insert(format!(
                                    "{}: 'text' есть только у текстового объекта",
                                    object.id
                                ));
                            } else {
                                text_base.push(TextWrite {
                                    owner: Some(object.id.clone()),
                                    target: object.id.clone(),
                                    expr: expr.clone(),
                                });
                            }
                            continue;
                        }
                        match Param::parse(name) {
                            Some(param) => {
                                if param.media_only() && object.kind != ObjectKind::Media {
                                    compile_diagnostics.insert(format!(
                                        "{}: параметр '{}' есть только у медиа-объекта",
                                        object.id, name
                                    ));
                                } else {
                                    expressions.insert(
                                        NodeKey::Param(object.id.clone(), param),
                                        expr.clone(),
                                    );
                                }
                            }
                            None => {
                                compile_diagnostics.insert(format!(
                                    "{}: нельзя присвоить неизвестный параметр '{}'",
                                    object.id, name
                                ));
                            }
                        }
                    }
                    AssignTarget::Foreign { object: other, param } => {
                        if param == "text" {
                            match text_target(other, &object_indices, &preset) {
                                Ok(()) => text_base.push(TextWrite {
                                    owner: Some(object.id.clone()),
                                    target: other.clone(),
                                    expr: expr.clone(),
                                }),
                                Err(message) => {
                                    compile_diagnostics.insert(format!("{}: {}", object.id, message));
                                }
                            }
                            continue;
                        }
                        match foreign_key(other, param, &object_indices, &preset) {
                            Ok(key) => writes.push((key, expr.clone())),
                            Err(message) => {
                                compile_diagnostics.insert(format!("{}: {}", object.id, message));
                            }
                        }
                    }
                }
            }
            for block in &script.events {
                let trigger = match resolve_trigger(&block.source, &triggers) {
                    Ok(trigger) => trigger,
                    Err(message) => {
                        compile_diagnostics.insert(format!("{}: {}", object.id, message));
                        continue;
                    }
                };
                let mut body = Vec::new();
                let mut actions = Vec::new();
                let mut text_body: Vec<TextWrite> = Vec::new();
                for statement in &block.body {
                    let (target, expr) = match statement {
                        Statement::Assign(target, expr) => (target, expr),
                        Statement::Call(call) => {
                            if check_action(
                                call,
                                Some(object.id.as_str()),
                                &preset,
                                &object_indices,
                                &mut compile_diagnostics,
                            ) {
                                actions.push(call.clone());
                            }
                            continue;
                        }
                    };
                    if let AssignTarget::Local(name) = target {
                        if name == "text" {
                            if object.kind != ObjectKind::Text {
                                compile_diagnostics.insert(format!(
                                    "{}: 'text' есть только у текстового объекта",
                                    object.id
                                ));
                            } else {
                                text_body.push(TextWrite {
                                    owner: Some(object.id.clone()),
                                    target: object.id.clone(),
                                    expr: expr.clone(),
                                });
                            }
                            continue;
                        }
                    }
                    if let AssignTarget::Foreign { object: other, param } = target {
                        if param == "text" {
                            match text_target(other, &object_indices, &preset) {
                                Ok(()) => text_body.push(TextWrite {
                                    owner: Some(object.id.clone()),
                                    target: other.clone(),
                                    expr: expr.clone(),
                                }),
                                Err(message) => {
                                    compile_diagnostics.insert(format!("{}: {}", object.id, message));
                                }
                            }
                            continue;
                        }
                    }
                    let key = match target {
                        AssignTarget::Local(name) => match Param::parse(name) {
                            Some(param) => {
                                if param.media_only() && object.kind != ObjectKind::Media {
                                    compile_diagnostics.insert(format!(
                                        "{}: параметр '{}' есть только у медиа-объекта",
                                        object.id, name
                                    ));
                                    continue;
                                }
                                NodeKey::Param(object.id.clone(), param)
                            }
                            None => {
                                compile_diagnostics.insert(format!(
                                    "{}: в блоке события нельзя присвоить '{}'",
                                    object.id, name
                                ));
                                continue;
                            }
                        },
                        AssignTarget::Foreign { object: other, param } => {
                            match foreign_key(other, param, &object_indices, &preset) {
                                Ok(key) => key,
                                Err(message) => {
                                    compile_diagnostics.insert(format!("{}: {}", object.id, message));
                                    continue;
                                }
                            }
                        }
                    };
                    body.push((key, expr.clone()));
                }
                events.push(CompiledEvent {
                    trigger,
                    owner: Some(object.id.clone()),
                    body,
                    text_body,
                    actions,
                });
            }
        }

        let mut previous = Frame::default();
        let mut media = BTreeMap::new();
        let mut playback = HashMap::new();
        for object in &preset.objects {
            let defaults = object.media.clone().unwrap_or_default();
            if object.kind == ObjectKind::Media {
                playback.insert(
                    object.id.clone(),
                    Playback {
                        playing: defaults.autoplay,
                        speed: defaults.speed,
                        volume: defaults.volume,
                    },
                );
            }
            let mut values = BTreeMap::new();
            for param in Param::ALL {
                let value = match param {
                    Param::SizeX | Param::SizeY | Param::Opacity => 1.0,
                    Param::Visible => object.base.visible,
                    Param::Layer => object.base.layer,
                    Param::Play => {
                        if defaults.autoplay {
                            1.0
                        } else {
                            0.0
                        }
                    }
                    Param::Speed => defaults.speed,
                    Param::Volume => defaults.volume,
                    _ => 0.0,
                };
                values.insert(param.as_str().to_string(), value);
            }
            previous.objects.insert(object.id.clone(), values);
            // Медиа-объект без команд всё равно присутствует в кадре: так
            // редактор видит «команд нет» и не путает это с новым кадром.
            if object.kind == ObjectKind::Media {
                media.insert(object.id.clone(), MediaCue::idle());
            }
        }

        Ok(Self {
            preset,
            expressions,
            object_indices,
            global_names,
            previous,
            cache: HashMap::new(),
            visiting: Vec::new(),
            cycle_nodes: BTreeSet::new(),
            diagnostics: BTreeSet::new(),
            states: HashMap::new(),
            events,
            event_state: HashMap::new(),
            writes,
            playback,
            media,
            media_seq: 0,
            text_base,
            base_texts: BTreeMap::new(),
            texts: BTreeMap::new(),
            started: false,
            compile_diagnostics,
            persistent_globals,
            inputs: InputValues::default(),
            now: 0.0,
            time: 0.0,
            dt: 0.0,
            seq: 0,
            last_now: None,
        })
    }

    pub fn update_base(&mut self, updates: &[BaseUpdate]) {
        for update in updates {
            if let Some(index) = self.object_indices.get(&update.id).copied() {
                self.preset.objects[index].base = update.base.clone();
            }
        }
    }

    pub fn tick(
        &mut self,
        now: f64,
        inputs: InputValues,
        paused: bool,
        reset_clock: bool,
        step_dt: Option<f64>,
    ) -> Frame {
        self.now = if now.is_finite() { now } else { self.now };
        // «Стоп» и перезапуск обнуляют события и переопределения текста ещё до
        // стоп-кадра: следующее нажатие снова первое, а текст — базовый.
        if reset_clock {
            self.last_now = Some(self.now);
            self.event_state.clear();
            self.texts.clear();
            self.started = false;
        }
        if paused && step_dt.is_none() {
            self.last_now = Some(self.now);
            self.inputs = inputs;
            self.cache.clear();
            self.visiting.clear();
            self.diagnostics.clear();
            let mut frame = self.previous.clone();
            frame.dt = 0.0;
            // Стоп-кадр считает базу текста: `text = "привет"` видно сразу после
            // «Стопа», а не только после «Продолжить». Переопределения из событий
            // здесь уже сняты (reset_clock), поэтому в кадре именно база.
            frame.texts = self.texts_now();
            return frame;
        }

        let actual_dt = if let Some(step) = step_dt {
            step.max(0.0)
        } else if let Some(last) = self.last_now {
            (self.now - last).max(0.0)
        } else {
            0.0
        };
        self.last_now = Some(self.now);
        self.dt = if actual_dt.is_finite() {
            actual_dt
        } else {
            0.0
        };
        self.time += self.dt;
        self.seq += 1;
        self.inputs = inputs;
        self.cache.clear();
        self.visiting.clear();
        self.cycle_nodes.clear();
        self.diagnostics.clear();
        // Переопределения и события уже обнулены выше, до стоп-кадра.
        self.fire_events();

        // Записи чужим объектам идут сразу после событий: для всех остальных
        // формул этого кадра параметр уже «задан снаружи», поэтому собственная
        // формула объекта его не пересчитывает.
        let writes = self.writes.clone();
        for (key, expression) in writes {
            let context = match &key {
                NodeKey::Global(_) => NodeKey::Global(String::new()),
                NodeKey::Param(id, _) => NodeKey::Param(id.clone(), Param::X),
            };
            let mut value = self.numeric(&expression, &context);
            if matches!(&key, NodeKey::Param(_, Param::Visible)) {
                value = value.round().clamp(0.0, 1.0);
            }
            self.cache.insert(key, value);
        }

        let global_names = self.global_names.clone();
        for name in &global_names {
            self.eval_node(&NodeKey::Global(name.clone()));
        }
        let ids: Vec<String> = self.preset.objects.iter().map(|o| o.id.clone()).collect();
        for id in &ids {
            for param in Param::ALL {
                self.eval_node(&NodeKey::Param(id.clone(), param));
            }
        }
        let cycle_nodes = self.cycle_nodes.clone();
        for key in cycle_nodes {
            let previous = self.previous_value(&key);
            self.cache.insert(key, previous);
        }

        // База текста считается каждый кадр: `text = text(mic.db)` — обычная
        // формула, поэтому строка меняется вместе со звуком, без событий.
        // Переопределение из события важнее базы: так `text = "пока"` в блоке
        // держится до остановки, а потом снова виден базовый текст.
        let texts = self.texts_now();

        let mut frame = Frame {
            seq: self.seq,
            time: self.time,
            dt: self.dt,
            globals: BTreeMap::new(),
            objects: BTreeMap::new(),
            media: self.media.clone(),
            texts,
            order: Vec::new(),
            diagnostics: self
                .compile_diagnostics
                .iter()
                .chain(self.diagnostics.iter())
                .cloned()
                .collect(),
        };
        for name in global_names {
            let key = NodeKey::Global(name.clone());
            frame
                .globals
                .insert(name, self.cache.get(&key).copied().unwrap_or(0.0));
        }
        for id in ids {
            let mut values = BTreeMap::new();
            for param in Param::ALL {
                let key = NodeKey::Param(id.clone(), param);
                values.insert(
                    param.as_str().to_string(),
                    self.cache.get(&key).copied().unwrap_or(0.0),
                );
            }
            frame.objects.insert(id, values);
        }
        let mut draw_order: Vec<(f64, usize, String)> = self
            .preset
            .objects
            .iter()
            .enumerate()
            .filter(|(_, object)| object.kind.drawable())
            .map(|(index, object)| {
                let layer = frame
                    .objects
                    .get(&object.id)
                    .and_then(|values| values.get("layer"))
                    .copied()
                    .unwrap_or(object.base.layer);
                (layer, index, object.id.clone())
            })
            .collect();
        draw_order.sort_by(|a, b| {
            a.0.partial_cmp(&b.0)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(a.1.cmp(&b.1))
        });
        frame.order = draw_order.into_iter().map(|(_, _, id)| id).collect();
        self.previous = frame.clone();
        frame
    }

    /// Считает условия событий и применяет тела сработавших блоков.
    ///
    /// Значения попадают в кэш кадра до обычного вычисления, поэтому на этом
    /// кадре побеждает событие, а на следующем — обычные формулы или прошлое
    /// значение переменной.
    fn fire_events(&mut self) {
        let now = self.time;
        let seq = self.seq;
        let first_frame = !self.started;
        for index in 0..self.events.len() {
            let (trigger, owner, body, text_body, actions) = {
                let event = &self.events[index];
                (
                    event.trigger.clone(),
                    event.owner.clone(),
                    event.body.clone(),
                    event.text_body.clone(),
                    event.actions.clone(),
                )
            };
            let fired = match &trigger {
                // `on start` — первый кадр после запуска, остановки или перезапуска.
                CompiledTrigger::Start => first_frame,
                CompiledTrigger::Input { source, kind } => {
                    let value = self.inputs.values.get(source).copied().unwrap_or(0.0);
                    let high = value > 0.5;
                    // `relax` — то же удержание, только условие обратное.
                    let active = if matches!(kind, EventKind::Relax(_)) {
                        !high
                    } else {
                        high
                    };
                    // Первое наблюдение запоминает текущее значение: иначе `change`
                    // срабатывал бы на старте сцены, а `down` — на уже зажатой клавише.
                    let state = self.event_state.entry(index).or_insert(EventState {
                        last: value,
                        since: 0.0,
                        fired: false,
                        active: false,
                        armed: 0,
                    });
                    let fired = match kind {
                        EventKind::Down => state.last <= 0.5 && high,
                        EventKind::Up => state.last > 0.5 && !high,
                        EventKind::Change => (value - state.last).abs() > 1e-9,
                        // Удержание срабатывает не в кадре, когда условие выполнилось,
                        // а следующим: так даже `hold(0)` и `relax(0)` отличаются от
                        // `down`/`up` и дают «на кадр позже».
                        EventKind::Hold(seconds) | EventKind::Relax(seconds) => {
                            if !active {
                                state.fired = false;
                                state.active = false;
                                false
                            } else {
                                if !state.active {
                                    state.active = true;
                                    state.since = now;
                                    state.armed = seq;
                                    state.fired = false;
                                }
                                if !state.fired && seq > state.armed && now - state.since >= *seconds {
                                    state.fired = true;
                                    true
                                } else {
                                    false
                                }
                            }
                        }
                    };
                    state.last = value;
                    fired
                }
            };
            if !fired {
                continue;
            }
            let context = match &owner {
                Some(id) => NodeKey::Param(id.clone(), Param::X),
                None => NodeKey::Global(String::new()),
            };
            for (key, expression) in body {
                let mut result = self.numeric(&expression, &context);
                // visible живёт в 0/1, и запись чужому объекту — не исключение.
                if matches!(&key, NodeKey::Param(_, Param::Visible)) {
                    result = result.round().clamp(0.0, 1.0);
                }
                self.cache.insert(key, result);
            }
            // Текст — не число: он не идёт в кэш, а живёт до остановки.
            for write in text_body {
                let write_context = match &write.owner {
                    Some(id) => NodeKey::Param(id.clone(), Param::X),
                    None => NodeKey::Global(String::new()),
                };
                let value = self.text_value(&write.expr, &write_context);
                if value.is_empty() {
                    self.texts.remove(&write.target);
                } else {
                    self.texts.insert(write.target, value);
                }
            }
            for action in actions {
                self.run_action(&action, &owner, &context);
            }
        }
        self.started = true;
    }

    /// Выполняет команду из тела события.
    ///
    /// Команда меняет состояние воспроизведения (или текст) и попадает в кадр
    /// как «билет» с растущим номером: редактор выполняет её ровно один раз,
    /// даже если кадр повторяется. Формула параметра важнее команды — она
    /// считается каждый кадр и перебивает одноразовое действие.
    fn run_action(&mut self, call: &Expr, owner: &Option<String>, context: &NodeKey) {
        let Expr::Call { name, args, .. } = call else {
            return;
        };
        // `text("привет")` — строка это содержимое, а адресат — владелец блока;
        // `text("id", "привет")` — адресат задан первым аргументом. Содержимое
        // может быть любым выражением: `text(mic.db)` покажет число.
        let explicit = if name == "text" {
            args.len() >= 2 && matches!(args.first(), Some(Expr::Text(_)))
        } else {
            matches!(args.first(), Some(Expr::Text(_)))
        };
        if name == "text" {
            let target = if explicit {
                match &args[0] {
                    Expr::Text(id) => id.to_string(),
                    _ => return,
                }
            } else {
                match owner {
                    Some(id) => id.to_string(),
                    None => return,
                }
            };
            let content = if explicit { args.get(1) } else { args.first() };
            if let Some(expression) = content {
                let value = self.text_value(expression, context);
                // Пустая строка — «вернись к базовому тексту или шаблону».
                if value.is_empty() {
                    self.texts.remove(&target);
                } else {
                    self.texts.insert(target, value);
                }
            }
            return;
        }
        let target = if explicit {
            match &args[0] {
                Expr::Text(id) => id.to_string(),
                _ => return,
            }
        } else {
            match owner {
                Some(id) => id.to_string(),
                None => return,
            }
        };
        let Some(index) = self.object_indices.get(&target).copied() else {
            return;
        };
        if self.preset.objects[index].kind != ObjectKind::Media {
            return;
        }
        let rest = if explicit { &args[1..] } else { &args[..] };
        let argument = rest
            .first()
            .map(|expr| self.numeric(expr, context))
            .unwrap_or(0.0);
        let cue = match name.as_str() {
            "play" => Some(("play", 0.0)),
            "resume" => Some(("resume", 0.0)),
            "pause" => Some(("pause", 0.0)),
            "stop" => Some(("stop", 0.0)),
            "seek" => Some(("seek", argument.max(0.0))),
            _ => None,
        };
        let (playing, speed, volume) = {
            let state = self.playback.entry(target.clone()).or_default();
            match name.as_str() {
                "play" | "resume" => state.playing = true,
                "pause" | "stop" => state.playing = false,
                "rate" => state.speed = argument.clamp(0.05, 8.0),
                "volume" => state.volume = argument.clamp(0.0, 4.0),
                _ => {}
            }
            (state.playing, state.speed, state.volume)
        };
        if let Some((action, value)) = cue {
            self.media_seq += 1;
            self.media.insert(
                target.clone(),
                MediaCue {
                    cue: self.media_seq,
                    action: action.to_string(),
                    arg: value,
                },
            );
        }
        self.cache.insert(
            NodeKey::Param(target.clone(), Param::Play),
            if playing { 1.0 } else { 0.0 },
        );
        self.cache
            .insert(NodeKey::Param(target.clone(), Param::Speed), speed);
        self.cache.insert(NodeKey::Param(target, Param::Volume), volume);
    }

    fn eval_node(&mut self, key: &NodeKey) -> f64 {
        if let Some(value) = self.cache.get(key) {
            return *value;
        }
        if let Some(position) = self.visiting.iter().position(|item| item == key) {
            let cycle: Vec<NodeKey> = self.visiting[position..].to_vec();
            for node in &cycle {
                self.cycle_nodes.insert(node.clone());
            }
            self.cycle_nodes.insert(key.clone());
            self.diagnostics.insert(format!(
                "цикл зависимости: {}; использовано значение прошлого кадра",
                key_name(key)
            ));
            return self.previous_value(key);
        }

        // Переменная, которую меняют только события, живёт между кадрами.
        if let NodeKey::Global(name) = key {
            if !self.expressions.contains_key(key) && self.persistent_globals.contains(name) {
                let value = self.previous_value(key);
                self.cache.insert(key.clone(), value);
                return value;
            }
        }

        self.visiting.push(key.clone());
        let expression = self.expressions.get(key).cloned();
        let value = if let Some(expression) = expression {
            let evaluated = self.eval_expr(&expression, key);
            match evaluated {
                Value::Number(value) => value,
                _ => {
                    self.diagnostics.insert(format!(
                        "{}: числовому параметру присвоен нечисловой результат",
                        key_name(key)
                    ));
                    self.previous_value(key)
                }
            }
        } else {
            match key {
                NodeKey::Global(name) => {
                    self.diagnostics
                        .insert(format!("неизвестная глобальная переменная '{}'", name));
                    0.0
                }
                NodeKey::Param(id, param) => self.default_param(id, *param),
            }
        };
        self.visiting.pop();

        let mut value = if value.is_finite() {
            value
        } else {
            self.diagnostics.insert(format!(
                "{}: NaN/Infinity заменены последним валидным значением",
                key_name(key)
            ));
            self.previous_value(key)
        };
        if let NodeKey::Param(_, Param::Visible) = key {
            if value.fract().abs() > 1e-9 {
                self.diagnostics
                    .insert(format!("{}: дробное visible округлено", key_name(key)));
            }
            value = value.round().clamp(0.0, 1.0);
        }
        self.cache.insert(key.clone(), value);
        value
    }

    fn default_param(&mut self, id: &str, param: Param) -> f64 {
        let Some(index) = self.object_indices.get(id).copied() else {
            return 0.0;
        };
        // Параметры воспроизведения не наследуются от родителя: у каждого медиа
        // своя громкость и скорость, иначе дочерний звук звучал бы вдвое тише.
        if param.media_only() {
            let state = self.playback.entry(id.to_string()).or_default();
            return match param {
                Param::Play => {
                    if state.playing {
                        1.0
                    } else {
                        0.0
                    }
                }
                Param::Speed => state.speed,
                _ => state.volume,
            };
        }
        let parent_id = self.preset.objects[index].parent_id.clone();
        let Some(parent) = parent_id else {
            return match param {
                Param::SizeX | Param::SizeY | Param::Opacity => 1.0,
                Param::Visible => self.preset.objects[index].base.visible,
                Param::Layer => self.preset.objects[index].base.layer,
                _ => 0.0,
            };
        };
        if matches!(param, Param::X | Param::Y) {
            let inherited = self.eval_node(&NodeKey::Param(parent.clone(), param));
            let offset = self.offset_for(id);
            let followed = self.follow_vector(offset, &parent);
            return inherited
                + if param == Param::X {
                    followed.x
                } else {
                    followed.y
                };
        }
        self.eval_node(&NodeKey::Param(parent, param))
    }

    fn previous_value(&self, key: &NodeKey) -> f64 {
        match key {
            NodeKey::Global(name) => self.previous.globals.get(name).copied().unwrap_or(0.0),
            NodeKey::Param(id, param) => self
                .previous
                .objects
                .get(id)
                .and_then(|values| values.get(param.as_str()))
                .copied()
                .unwrap_or(match param {
                    Param::SizeX | Param::SizeY | Param::Opacity => 1.0,
                    Param::Speed | Param::Volume => 1.0,
                    _ => 0.0,
                }),
        }
    }

    fn object_parent(&self, id: &str) -> Option<String> {
        self.object_indices
            .get(id)
            .and_then(|index| self.preset.objects[*index].parent_id.clone())
    }

    fn offset_for(&self, id: &str) -> Vec2 {
        let Some(index) = self.object_indices.get(id).copied() else {
            return Vec2::default();
        };
        let object = &self.preset.objects[index];
        if let Some(parent) = &object.parent_id {
            if let Some(parent_index) = self.object_indices.get(parent).copied() {
                let parent_base = &self.preset.objects[parent_index].base;
                return Vec2 {
                    x: object.base.x - parent_base.x,
                    y: object.base.y - parent_base.y,
                };
            }
        }
        Vec2::default()
    }

    fn follow_vector(&mut self, vector: Vec2, parent: &str) -> Vec2 {
        let sx = self.eval_node(&NodeKey::Param(parent.to_string(), Param::SizeX));
        let sy = self.eval_node(&NodeKey::Param(parent.to_string(), Param::SizeY));
        let rotation = self.eval_node(&NodeKey::Param(parent.to_string(), Param::Rotation));
        let scaled = Vec2 {
            x: vector.x * sx,
            y: vector.y * sy,
        };
        let rotated = rotate_vector(scaled, rotation);
        Vec2 {
            x: rotated.x - vector.x,
            y: rotated.y - vector.y,
        }
    }

    fn eval_expr(&mut self, expr: &Expr, context: &NodeKey) -> Value {
        match expr {
            Expr::Number(value) => Value::Number(*value),
            // Строка — полноценное значение: текст объекта и аргументы команд.
            // В числовой формуле она даёт диагностику уже на приведении к числу.
            Expr::Text(value) => Value::Text(value.clone()),
            Expr::Name(name) => self.eval_name(name, context),
            Expr::Unary { op, expr } => {
                let value = self.numeric(expr, context);
                Value::Number(match op {
                    UnaryOp::Neg => -value,
                    UnaryOp::Pos => value,
                    UnaryOp::Not => bool_number(value == 0.0),
                })
            }
            Expr::Ternary { condition, yes, no } => {
                if self.numeric(condition, context) != 0.0 {
                    self.eval_expr(yes, context)
                } else {
                    self.eval_expr(no, context)
                }
            }
            Expr::Binary {
                op: BinaryOp::And,
                left,
                right,
            } => {
                let left_value = self.numeric(left, context);
                Value::Number(if left_value == 0.0 {
                    0.0
                } else {
                    bool_number(self.numeric(right, context) != 0.0)
                })
            }
            Expr::Binary {
                op: BinaryOp::Or,
                left,
                right,
            } => {
                let left_value = self.numeric(left, context);
                Value::Number(if left_value != 0.0 {
                    1.0
                } else {
                    bool_number(self.numeric(right, context) != 0.0)
                })
            }
            Expr::Binary { op, left, right } => {
                let left_value = self.eval_expr(left, context);
                let right_value = self.eval_expr(right, context);
                // `+` со строкой — склейка: `"db " + text(mic.db)`. Числа
                // превращаются в текст, поэтому строка и число складываются.
                if matches!(op, BinaryOp::Add)
                    && (matches!(left_value, Value::Text(_))
                        || matches!(right_value, Value::Text(_)))
                {
                    let left_text = self.as_text(left_value);
                    let right_text = self.as_text(right_value);
                    return Value::Text(left_text + right_text.as_str());
                }
                // Строки сравниваются как текст, а не как ноль.
                if matches!(op, BinaryOp::Eq | BinaryOp::NotEq)
                    && (matches!(left_value, Value::Text(_))
                        || matches!(right_value, Value::Text(_)))
                {
                    let equal = self.as_text(left_value) == self.as_text(right_value);
                    return Value::Number(bool_number(if matches!(op, BinaryOp::Eq) {
                        equal
                    } else {
                        !equal
                    }));
                }
                let a = self.as_number(left_value);
                let b = self.as_number(right_value);
                Value::Number(match op {
                    BinaryOp::Add => a + b,
                    BinaryOp::Sub => a - b,
                    BinaryOp::Mul => a * b,
                    BinaryOp::Div => a / b,
                    BinaryOp::Mod => a % b,
                    BinaryOp::Pow => a.powf(b),
                    BinaryOp::Less => bool_number(a < b),
                    BinaryOp::LessEq => bool_number(a <= b),
                    BinaryOp::Greater => bool_number(a > b),
                    BinaryOp::GreaterEq => bool_number(a >= b),
                    BinaryOp::Eq => bool_number((a - b).abs() <= f64::EPSILON),
                    BinaryOp::NotEq => bool_number((a - b).abs() > f64::EPSILON),
                    BinaryOp::And | BinaryOp::Or => unreachable!(),
                })
            }
            Expr::Member { expr, name } => {
                // Входы модулей адресуются как `<модуль>.<вход>`: если такого
                // ключа нет, работает обычный доступ к полям (.x/.y, параметры).
                if let Expr::Name(base) = expr.as_ref() {
                    let key = format!("{}.{}", base, name);
                    if let Some(value) = self.inputs.values.get(&key) {
                        return Value::Number(*value);
                    }
                    // `state.имя` — значение прошлого кадра. Считает его ядро, а не
                    // редактор: глобальная переменная, параметр своего объекта или
                    // чужой объект (он и так читается целиком).
                    if base == "state" {
                        if let NodeKey::Param(id, _) = context {
                            if let Some(param) = Param::parse(name) {
                                let own = NodeKey::Param(id.clone(), param);
                                return Value::Number(self.previous_value(&own));
                            }
                        }
                        let global = NodeKey::Global(name.to_string());
                        if self.expressions.contains_key(&global)
                            || self.persistent_globals.contains(name)
                        {
                            return Value::Number(self.previous_value(&global));
                        }
                        if self.object_indices.contains_key(name) {
                            return Value::Object(name.to_string());
                        }
                        return self
                            .error_value(format!("state.{}: неизвестное имя; использован 0", name));
                    }
                }
                let target = self.eval_expr(expr, context);
                match target {
                    Value::Vector(vector) => match name.as_str() {
                        "x" => Value::Number(vector.x),
                        "y" => Value::Number(vector.y),
                        _ => self.error_value(format!("у вектора нет поля '{}'", name)),
                    },
                    Value::Object(id) => {
                        // `объект.parent` — ступень вверх по иерархии: так читается
                        // параметр родителя названного объекта, например
                        // `рот.parent.size_x` (рот и его родитель — любые в сцене).
                        if name == "parent" {
                            return match self.object_parent(&id) {
                                Some(parent) => Value::Object(parent),
                                None => {
                                    self.error_value(format!("у объекта '{}' нет родителя", id))
                                }
                            };
                        }
                        if let Some(param) = Param::parse(name) {
                            Value::Number(self.eval_node(&NodeKey::Param(id, param)))
                        } else {
                            self.error_value(format!(
                                "у объекта нет числового параметра '{}'",
                                name
                            ))
                        }
                    }
                    Value::Signals => {
                        Value::Number(self.inputs.signals.get(name).copied().unwrap_or(0.0))
                    }
                    Value::Number(_) => {
                        self.error_value("доступ '.x/.y' или '.параметр' применён к числу".into())
                    }
                    Value::Text(_) => {
                        self.error_value("доступ '.поле' применён к тексту".into())
                    }
                }
            }
            Expr::Call { id, name, args } => self.eval_call(*id, name, args, context),
        }
    }

    fn eval_name(&mut self, name: &str, context: &NodeKey) -> Value {
        match name {
            "pi" => return Value::Number(PI),
            "e" => return Value::Number(E),
            "time" => return Value::Number(self.time),
            "dt" => return Value::Number(self.dt),
            "canvasWidth" => return Value::Number(self.preset.canvas.width),
            "canvasHeight" => return Value::Number(self.preset.canvas.height),
            "signal" => return Value::Signals,
            _ => {}
        }
        if let NodeKey::Param(id, param) = context {
            if name == "parent" {
                return if let Some(parent) = self.object_parent(id) {
                    Value::Object(parent)
                } else {
                    self.error_value(format!("{}: parent недоступен без родителя", id))
                };
            }
            if name == "inherit" {
                return if let Some(parent) = self.object_parent(id) {
                    Value::Number(self.eval_node(&NodeKey::Param(parent, *param)))
                } else {
                    self.error_value(format!("{}: inherit недоступен без родителя", id))
                };
            }
            if name == "offset" {
                return if self.object_parent(id).is_some() {
                    Value::Vector(self.offset_for(id))
                } else {
                    self.error_value(format!("{}: offset недоступен без родителя", id))
                };
            }
            if name == "width" || name == "height" {
                let value = self
                    .object_indices
                    .get(id)
                    .map(|index| {
                        if name == "width" {
                            self.preset.objects[*index].width
                        } else {
                            self.preset.objects[*index].height
                        }
                    })
                    .unwrap_or(0.0);
                return Value::Number(value);
            }
            if name == "text" {
                return Value::Text(self.text_of(id));
            }
            if let Some(own) = Param::parse(name) {
                return Value::Number(self.eval_node(&NodeKey::Param(id.clone(), own)));
            }
        }
        let global_key = NodeKey::Global(name.to_string());
        // Переменная, которую меняют только события, тоже известна по имени —
        // иначе формулы видели бы «неизвестное имя» и читали ноль.
        if self.expressions.contains_key(&global_key) || self.persistent_globals.contains(name) {
            return Value::Number(self.eval_node(&global_key));
        }
        // Именованные числа из модулей (состояния enum): их сравнение в скрипте
        // выглядит как `manual.value == walk`. Константа не переменная — её
        // нельзя присвоить, поэтому проверка идёт после глобальных выражений.
        if let Some(value) = self.preset.constants.get(name) {
            return Value::Number(*value);
        }
        if self.object_indices.contains_key(name) {
            if matches!(context, NodeKey::Global(_)) {
                return self.error_value(format!(
                    "глобальные переменные не видят объект '{}'; использован 0",
                    name
                ));
            }
            return Value::Object(name.to_string());
        }
        self.error_value(format!("неизвестное имя '{}'; использован 0", name))
    }

    fn error_value(&mut self, message: String) -> Value {
        self.diagnostics.insert(message);
        Value::Number(0.0)
    }

    fn numeric(&mut self, expr: &Expr, context: &NodeKey) -> f64 {
        let value = self.eval_expr(expr, context);
        self.as_number(value)
    }

    /// Приведение значения к числу: строка с числом годится, остальное — 0.
    fn as_number(&mut self, value: Value) -> f64 {
        match value {
            Value::Number(value) => value,
            Value::Text(text) => match text.trim().parse::<f64>() {
                Ok(parsed) if parsed.is_finite() => parsed,
                _ => {
                    self.diagnostics.insert(format!(
                        "ожидалось число, получена строка \"{}\"; использован 0",
                        text
                    ));
                    0.0
                }
            },
            _ => {
                self.diagnostics
                    .insert("ожидалось число, получен вектор или объект; использован 0".into());
                0.0
            }
        }
    }

    /// Приведение значения к тексту: число форматируется без хвостовых нулей.
    fn as_text(&mut self, value: Value) -> String {
        match value {
            Value::Text(text) => text,
            Value::Number(number) => number_to_text(number),
            _ => {
                self.diagnostics
                    .insert("ожидался текст, получен вектор или объект; использована пустая строка".into());
                String::new()
            }
        }
    }

    /// Текущий текст объекта: переопределение из события важнее базы.
    fn text_of(&self, id: &str) -> String {
        self.texts
            .get(id)
            .or_else(|| self.base_texts.get(id))
            .cloned()
            .unwrap_or_default()
    }

    /// Пересчитывает базу текста из скриптов объектов (`text = …`).
    ///
    /// База — формула: считается и в обычном кадре, и в стоп-кадре, поэтому
    /// после «Стопа» видно `text = "привет"`, а не текст из последнего события.
    fn refresh_base_texts(&mut self) {
        let writes = self.text_base.clone();
        let mut base_texts: BTreeMap<String, String> = BTreeMap::new();
        for write in writes {
            let context = match &write.owner {
                Some(id) => NodeKey::Param(id.clone(), Param::X),
                None => NodeKey::Global(String::new()),
            };
            let value = self.text_value(&write.expr, &context);
            if value.is_empty() {
                base_texts.remove(&write.target);
            } else {
                base_texts.insert(write.target, value);
            }
        }
        self.base_texts = base_texts;
    }

    /// Итоговый текст кадра: база из скрипта плюс переопределение из событий.
    fn texts_now(&mut self) -> BTreeMap<String, String> {
        self.refresh_base_texts();
        let mut texts = self.base_texts.clone();
        for (id, value) in &self.texts {
            texts.insert(id.clone(), value.clone());
        }
        texts
    }

    /// Значение для `text`: строка как есть, число — в текст, остальное — диагностика.
    fn text_value(&mut self, expr: &Expr, context: &NodeKey) -> String {
        let value = self.eval_expr(expr, context);
        self.as_text(value)
    }

    fn vector(&mut self, expr: &Expr, context: &NodeKey) -> Vec2 {
        match self.eval_expr(expr, context) {
            Value::Vector(value) => value,
            _ => {
                self.diagnostics
                    .insert("ожидался vec(x, y); использован нулевой вектор".into());
                Vec2::default()
            }
        }
    }

    fn numbers(&mut self, args: &[Expr], context: &NodeKey) -> Vec<f64> {
        args.iter().map(|arg| self.numeric(arg, context)).collect()
    }

    fn arity(&mut self, name: &str, actual: usize, expected: usize) -> bool {
        if actual == expected {
            true
        } else {
            self.diagnostics.insert(format!(
                "{} ожидает {} аргумент(а), получено {}",
                name, expected, actual
            ));
            false
        }
    }

    fn eval_call(&mut self, call_id: u32, name: &str, args: &[Expr], context: &NodeKey) -> Value {
        match name {
            // Строковые функции: текст — такое же значение, как число.
            "text" | "str" => {
                if !self.arity(name, args.len(), 1) {
                    return Value::Text(String::new());
                }
                let value = self.eval_expr(&args[0], context);
                Value::Text(self.as_text(value))
            }
            "upper" | "lower" => {
                if !self.arity(name, args.len(), 1) {
                    return Value::Text(String::new());
                }
                let value = self.eval_expr(&args[0], context);
                let text = self.as_text(value);
                Value::Text(if name == "upper" {
                    text.to_uppercase()
                } else {
                    text.to_lowercase()
                })
            }
            "len" => {
                if !self.arity(name, args.len(), 1) {
                    return Value::Number(0.0);
                }
                let value = self.eval_expr(&args[0], context);
                Value::Number(self.as_text(value).chars().count() as f64)
            }
            "fixed" => {
                if !self.arity(name, args.len(), 2) {
                    return Value::Text(String::new());
                }
                let number = self.numeric(&args[0], context);
                // Больше шести знаков после запятой тексту не нужно.
                let digits = self.numeric(&args[1], context).clamp(0.0, 6.0) as usize;
                Value::Text(format!("{:.1$}", number, digits))
            }
            "vec" => {
                if !self.arity(name, args.len(), 2) {
                    return Value::Vector(Vec2::default());
                }
                let values = self.numbers(args, context);
                Value::Vector(Vec2 {
                    x: values[0],
                    y: values[1],
                })
            }
            "vadd" | "vsub" => {
                if !self.arity(name, args.len(), 2) {
                    return Value::Vector(Vec2::default());
                }
                let a = self.vector(&args[0], context);
                let b = self.vector(&args[1], context);
                Value::Vector(if name == "vadd" {
                    Vec2 {
                        x: a.x + b.x,
                        y: a.y + b.y,
                    }
                } else {
                    Vec2 {
                        x: a.x - b.x,
                        y: a.y - b.y,
                    }
                })
            }
            "vmul" => {
                if !self.arity(name, args.len(), 2) {
                    return Value::Vector(Vec2::default());
                }
                let vector = self.vector(&args[0], context);
                let scalar = self.numeric(&args[1], context);
                Value::Vector(Vec2 {
                    x: vector.x * scalar,
                    y: vector.y * scalar,
                })
            }
            "vscale" => {
                if !self.arity(name, args.len(), 3) {
                    return Value::Vector(Vec2::default());
                }
                let vector = self.vector(&args[0], context);
                let sx = self.numeric(&args[1], context);
                let sy = self.numeric(&args[2], context);
                Value::Vector(Vec2 {
                    x: vector.x * sx,
                    y: vector.y * sy,
                })
            }
            "vlen" | "vnorm" => {
                if !self.arity(name, args.len(), 1) {
                    return Value::Number(0.0);
                }
                let vector = self.vector(&args[0], context);
                let length = (vector.x * vector.x + vector.y * vector.y).sqrt();
                if name == "vlen" {
                    Value::Number(length)
                } else if length <= 1e-12 {
                    Value::Vector(Vec2::default())
                } else {
                    Value::Vector(Vec2 {
                        x: vector.x / length,
                        y: vector.y / length,
                    })
                }
            }
            "vdot" | "vangle" => {
                if !self.arity(name, args.len(), 2) {
                    return Value::Number(0.0);
                }
                let a = self.vector(&args[0], context);
                let b = self.vector(&args[1], context);
                if name == "vdot" {
                    return Value::Number(a.x * b.x + a.y * b.y);
                }
                let denominator = (a.x * a.x + a.y * a.y).sqrt() * (b.x * b.x + b.y * b.y).sqrt();
                if denominator <= 1e-12 {
                    Value::Number(0.0)
                } else {
                    Value::Number(
                        ((a.x * b.x + a.y * b.y) / denominator)
                            .clamp(-1.0, 1.0)
                            .acos()
                            .to_degrees(),
                    )
                }
            }
            "rotate" | "orbit" => {
                if !self.arity(name, args.len(), 2) {
                    return Value::Vector(Vec2::default());
                }
                let vector = self.vector(&args[0], context);
                let angle = self.numeric(&args[1], context);
                let rotated = rotate_vector(vector, angle);
                Value::Vector(if name == "orbit" {
                    Vec2 {
                        x: rotated.x - vector.x,
                        y: rotated.y - vector.y,
                    }
                } else {
                    rotated
                })
            }
            "follow" => {
                if !self.arity(name, args.len(), 2) {
                    return Value::Vector(Vec2::default());
                }
                let vector = self.vector(&args[0], context);
                let parent = match self.eval_expr(&args[1], context) {
                    Value::Object(id) => id,
                    _ => {
                        self.diagnostics.insert(
                            "follow(v, parent): второй аргумент должен быть parent или объектом"
                                .into(),
                        );
                        return Value::Vector(Vec2::default());
                    }
                };
                Value::Vector(self.follow_vector(vector, &parent))
            }
            "pxv" | "uvv" => {
                if !self.arity(name, args.len(), 2) {
                    return Value::Vector(Vec2::default());
                }
                let vector = self.vector(&args[0], context);
                let size = self.vector(&args[1], context);
                Value::Vector(if name == "pxv" {
                    Vec2 {
                        x: vector.x * size.x,
                        y: vector.y * size.y,
                    }
                } else {
                    Vec2 {
                        x: safe_div(vector.x, size.x),
                        y: safe_div(vector.y, size.y),
                    }
                })
            }
            "smooth" => {
                if !self.arity(name, args.len(), 2) {
                    return Value::Number(0.0);
                }
                let target = self.numeric(&args[0], context);
                let halflife = self.numeric(&args[1], context).max(0.001) / 1000.0;
                let key = StateKey {
                    node: context.clone(),
                    call_id,
                };
                let previous = match self.states.get(&key) {
                    Some(RuntimeState::Smooth(value)) => *value,
                    _ => target,
                };
                let factor = 0.5f64.powf(self.dt.min(0.05) / halflife);
                let value = target + (previous - target) * factor;
                self.states.insert(key, RuntimeState::Smooth(value));
                Value::Number(value)
            }
            "spring" => {
                if !self.arity(name, args.len(), 3) {
                    return Value::Number(0.0);
                }
                let target = self.numeric(&args[0], context);
                let frequency = self.numeric(&args[1], context).max(0.0);
                let damping = self.numeric(&args[2], context).clamp(0.0, 1.0);
                let key = StateKey {
                    node: context.clone(),
                    call_id,
                };
                let (mut value, mut velocity) = match self.states.get(&key) {
                    Some(RuntimeState::Spring { value, velocity }) => (*value, *velocity),
                    _ => (target, 0.0),
                };
                let omega = 2.0 * PI * frequency;
                let steps = 8;
                let step = self.dt.min(0.05) / steps as f64;
                for _ in 0..steps {
                    let acceleration =
                        omega * omega * (target - value) - 2.0 * damping * omega * velocity;
                    velocity += acceleration * step;
                    value += velocity * step;
                }
                self.states
                    .insert(key, RuntimeState::Spring { value, velocity });
                Value::Number(value)
            }
            "autoblink" => {
                if !self.arity(name, args.len(), 2) && args.len() != 3 {
                    return Value::Number(0.0);
                }
                let min_ms = self.numeric(&args[0], context).max(50.0);
                let max_ms = self.numeric(&args[1], context).max(min_ms);
                let default_seed = stable_seed(context, call_id);
                let seed = if args.len() == 3 {
                    self.numeric(&args[2], context)
                } else {
                    default_seed
                };
                let key = StateKey {
                    node: context.clone(),
                    call_id,
                };
                let mut state =
                    self.states
                        .get(&key)
                        .cloned()
                        .unwrap_or_else(|| RuntimeState::Blink {
                            next: self.time,
                            until: -1.0,
                            seed,
                            index: 0,
                        });
                let RuntimeState::Blink {
                    next,
                    until,
                    seed: stored_seed,
                    index,
                } = &mut state
                else {
                    unreachable!()
                };
                if *next == self.time && *until < 0.0 {
                    *next =
                        self.time + random_interval(*stored_seed, *index, min_ms, max_ms) / 1000.0;
                }
                let result = if self.time >= *next && self.time < *until {
                    1.0
                } else if self.time >= *next {
                    if *until > 0.0 && self.time >= *until {
                        *index += 1;
                        *next = self.time
                            + random_interval(*stored_seed, *index, min_ms, max_ms) / 1000.0;
                        *until = -1.0;
                        0.0
                    } else {
                        *until = self.time + 0.12;
                        1.0
                    }
                } else {
                    0.0
                };
                self.states.insert(key, state);
                Value::Number(result)
            }
            "noise" => {
                if !self.arity(name, args.len(), 2) {
                    return Value::Number(0.0);
                }
                let seed = self.numeric(&args[0], context);
                let frequency = self.numeric(&args[1], context);
                Value::Number(value_noise(seed, self.time, frequency))
            }
            "shake" => {
                if args.len() < 2 || args.len() > 3 {
                    self.diagnostics
                        .insert("shake ожидает 2 или 3 аргумента".into());
                    return Value::Number(0.0);
                }
                let amplitude = self.numeric(&args[0], context);
                let frequency = self.numeric(&args[1], context);
                let seed = if args.len() == 3 {
                    self.numeric(&args[2], context)
                } else {
                    stable_seed(context, call_id)
                };
                Value::Number(value_noise(seed, self.time, frequency) * amplitude)
            }
            "random" => {
                if !self.arity(name, args.len(), 2) {
                    return Value::Number(0.0);
                }
                let min = self.numeric(&args[0], context);
                let max = self.numeric(&args[1], context);
                let random = hash_unit(
                    (stable_seed(context, call_id).to_bits())
                        ^ self.seq.wrapping_mul(0x9E3779B97F4A7C15),
                );
                Value::Number(min + (max - min) * random)
            }
            "rnd" => {
                if !self.arity(name, args.len(), 3) {
                    return Value::Number(0.0);
                }
                let seed = self.numeric(&args[0], context);
                let min = self.numeric(&args[1], context);
                let max = self.numeric(&args[2], context);
                Value::Number(min + (max - min) * hash_unit(seed.to_bits()))
            }
            _ => self.eval_numeric_function(name, args, context),
        }
    }

    fn eval_numeric_function(&mut self, name: &str, args: &[Expr], context: &NodeKey) -> Value {
        if name == "min" || name == "max" {
            if args.is_empty() {
                self.diagnostics
                    .insert(format!("{} ожидает хотя бы один аргумент", name));
                return Value::Number(0.0);
            }
            let values = self.numbers(args, context);
            return Value::Number(
                values
                    .into_iter()
                    .reduce(|a, b| if name == "min" { a.min(b) } else { a.max(b) })
                    .unwrap_or(0.0),
            );
        }
        if name == "is" {
            // `is(x, a, b, …)` — «x равно любому из»: так сравнивают состояния
            // enum, не собирая длинную цепочку `||`.
            if args.len() < 2 {
                self.diagnostics
                    .insert("is ожидает хотя бы два аргумента: is(x, a, …)".into());
                return Value::Number(0.0);
            }
            let values = self.numbers(args, context);
            let hit = values[1..]
                .iter()
                .any(|value| (value - values[0]).abs() <= 1e-9);
            return Value::Number(if hit { 1.0 } else { 0.0 });
        }
        let expected = match name {
            "abs" | "sign" | "round" | "floor" | "ceil" | "sqrt" | "exp" | "log" | "sin"
            | "cos" | "tan" | "sind" | "cosd" | "tand" | "deg" | "rad" => 1,
            "pow" | "atan2" | "mod" | "px" | "uv" => 2,
            "limit" | "lerp" | "smoothstep" | "near" | "between" => 3,
            "clamp" => 4,
            _ => {
                return self.error_value(format!("неизвестная функция '{}'; использован 0", name));
            }
        };
        if !self.arity(name, args.len(), expected) {
            return Value::Number(0.0);
        }
        let v = self.numbers(args, context);
        let result = match name {
            "abs" => v[0].abs(),
            "sign" => {
                if v[0] > 0.0 {
                    1.0
                } else if v[0] < 0.0 {
                    -1.0
                } else {
                    0.0
                }
            }
            "round" => (v[0] + 0.5).floor(),
            "floor" => v[0].floor(),
            "ceil" => v[0].ceil(),
            "sqrt" => v[0].sqrt(),
            "exp" => v[0].exp(),
            "log" => v[0].ln(),
            "sin" => v[0].sin(),
            "cos" => v[0].cos(),
            "tan" => v[0].tan(),
            "sind" => v[0].to_radians().sin(),
            "cosd" => v[0].to_radians().cos(),
            "tand" => v[0].to_radians().tan(),
            "deg" => v[0].to_degrees(),
            "rad" => v[0].to_radians(),
            "pow" => v[0].powf(v[1]),
            "atan2" => v[0].atan2(v[1]),
            "mod" => v[0] % v[1],
            "px" => v[0] * v[1],
            "uv" => safe_div(v[0], v[1]),
            "limit" => v[0].clamp(v[1].min(v[2]), v[1].max(v[2])),
            "clamp" => v[1] + (v[0] - v[1]).clamp(v[2].min(v[3]), v[2].max(v[3])),
            "lerp" => v[0] + (v[1] - v[0]) * v[2],
            // Сравнения возвращают 0/1, поэтому их можно ставить в формулы и
            // умножать на амплитуду.
            "near" => {
                if (v[0] - v[1]).abs() <= v[2].abs() {
                    1.0
                } else {
                    0.0
                }
            }
            "between" => {
                let lo = v[1].min(v[2]);
                let hi = v[1].max(v[2]);
                if v[0] >= lo && v[0] <= hi {
                    1.0
                } else {
                    0.0
                }
            }
            "smoothstep" => {
                let t = ((v[2] - v[0]) / (v[1] - v[0])).clamp(0.0, 1.0);
                t * t * (3.0 - 2.0 * t)
            }
            _ => 0.0,
        };
        Value::Number(result)
    }
}

/// Проверяет, что у объекта есть текст: `text` — параметр только текстового объекта.
fn text_target(
    object: &str,
    indices: &HashMap<String, usize>,
    preset: &RigPreset,
) -> Result<(), String> {
    let Some(index) = indices.get(object).copied() else {
        return Err(format!("объекта '{}' нет в сцене", object));
    };
    if preset.objects[index].kind != ObjectKind::Text {
        return Err(format!(
            "'{}' — не текстовый объект: параметр 'text' есть только у текста",
            object
        ));
    }
    Ok(())
}

/// Ключ узла для записи чужому объекту: `head.rotation` → `Param("head", Rotation)`.
fn foreign_key(
    object: &str,
    param: &str,
    indices: &HashMap<String, usize>,
    preset: &RigPreset,
) -> Result<NodeKey, String> {
    let Some(index) = indices.get(object).copied() else {
        return Err(format!("объекта '{}' нет в сцене", object));
    };
    let parsed = Param::parse(param)
        .ok_or_else(|| format!("у объекта '{}' нет параметра '{}'", object, param))?;
    if parsed.media_only() && preset.objects[index].kind != ObjectKind::Media {
        return Err(format!(
            "параметр '{}' есть только у медиа-объекта, а '{}' — не медиа",
            param, object
        ));
    }
    Ok(NodeKey::Param(object.to_string(), parsed))
}

/// Условие блока: встроенный `start`, объявленное имя `trigger` или прямой вход.
fn resolve_trigger(
    source: &EventSource,
    triggers: &HashMap<String, (String, EventKind)>,
) -> Result<CompiledTrigger, String> {
    Ok(match source {
        EventSource::Start => CompiledTrigger::Start,
        EventSource::Input { source, kind } => CompiledTrigger::Input {
            source: source.clone(),
            kind: kind.clone(),
        },
        EventSource::Named(name) => match triggers.get(name) {
            Some((input, kind)) => CompiledTrigger::Input {
                source: input.clone(),
                kind: kind.clone(),
            },
            None => {
                let mut known: Vec<&str> = triggers.keys().map(String::as_str).collect();
                known.sort();
                let list = if known.is_empty() {
                    "объявленных имён нет".to_string()
                } else {
                    known.join(", ")
                };
                return Err(format!(
                    "неизвестное событие '{}'; объявите 'trigger {} = модуль.вход.тип' ({})",
                    name, name, list
                ));
            }
        },
    })
}

fn key_name(key: &NodeKey) -> String {
    match key {
        NodeKey::Global(name) => format!("global.{}", name),
        NodeKey::Param(id, param) => format!("{}.{}", id, param.as_str()),
    }
}

fn bool_number(value: bool) -> f64 {
    if value {
        1.0
    } else {
        0.0
    }
}

/// Число → текст для `text = …` и `text(…)`: целые без «.0», дробные — до двух
/// знаков без хвостовых нулей. Так `text = mic.db` читается как «0.42».
fn number_to_text(value: f64) -> String {
    if !value.is_finite() {
        return "0".into();
    }
    if value.abs() < 1e15 && (value - value.round()).abs() < 1e-9 {
        return format!("{}", value.round() as i64);
    }
    let text = format!("{:.2}", value);
    text.trim_end_matches('0').trim_end_matches('.').to_string()
}
fn safe_div(a: f64, b: f64) -> f64 {
    if b.abs() <= 1e-12 {
        0.0
    } else {
        a / b
    }
}
fn rotate_vector(vector: Vec2, degrees: f64) -> Vec2 {
    let angle = degrees.to_radians();
    let (sin, cos) = angle.sin_cos();
    Vec2 {
        x: vector.x * cos - vector.y * sin,
        y: vector.x * sin + vector.y * cos,
    }
}

fn hash_unit(mut value: u64) -> f64 {
    value ^= value >> 30;
    value = value.wrapping_mul(0xBF58476D1CE4E5B9);
    value ^= value >> 27;
    value = value.wrapping_mul(0x94D049BB133111EB);
    value ^= value >> 31;
    (value >> 11) as f64 / ((1u64 << 53) as f64)
}

fn stable_seed(node: &NodeKey, call_id: u32) -> f64 {
    let text = format!("{}:{}", key_name(node), call_id);
    let mut hash = 0xcbf29ce484222325u64;
    for byte in text.bytes() {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    (hash & ((1u64 << 53) - 1)) as f64
}

fn value_noise(seed: f64, time: f64, frequency: f64) -> f64 {
    let position = time * frequency;
    let index = position.floor();
    let fraction = position - index;
    let t = fraction * fraction * (3.0 - 2.0 * fraction);
    let a = hash_unit(seed.to_bits() ^ (index as i64 as u64)) * 2.0 - 1.0;
    let b = hash_unit(seed.to_bits() ^ ((index as i64 + 1) as u64)) * 2.0 - 1.0;
    a + (b - a) * t
}

fn random_interval(seed: f64, index: u64, min_ms: f64, max_ms: f64) -> f64 {
    min_ms + (max_ms - min_ms) * hash_unit(seed.to_bits() ^ index.wrapping_mul(0x9E3779B97F4A7C15))
}

#[derive(Default)]
pub struct RuntimeStore {
    rigs: HashMap<u32, Rig>,
    next_handle: u32,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum Request {
    Create {
        config: RigPreset,
    },
    Validate {
        config: RigPreset,
    },
    /// Разбор одного скрипта: редактор подсвечивает место ошибки.
    Check {
        source: String,
    },
    Tick {
        handle: u32,
        #[serde(default)]
        now: f64,
        #[serde(default)]
        inputs: InputValues,
        #[serde(default)]
        paused: bool,
        #[serde(default, rename = "resetClock")]
        reset_clock: bool,
        #[serde(default, rename = "stepDt")]
        step_dt: Option<f64>,
    },
    UpdateBase {
        handle: u32,
        bases: Vec<BaseUpdate>,
    },
    Dispose {
        handle: u32,
    },
}

impl RuntimeStore {
    pub fn call_json(&mut self, source: &str) -> String {
        let response = match serde_json::from_str::<Request>(source) {
            Ok(request) => self.call(request),
            Err(error) => json!({"ok": false, "error": format!("некорректный запрос: {}", error)}),
        };
        serde_json::to_string(&response)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"serialization error\"}".into())
    }

    fn call(&mut self, request: Request) -> JsonValue {
        match request {
            Request::Create { config } => match Rig::new(config) {
                Ok(rig) => {
                    if self.next_handle == 0 {
                        self.next_handle = 1;
                    }
                    let handle = self.next_handle;
                    self.next_handle = self.next_handle.wrapping_add(1).max(1);
                    self.rigs.insert(handle, rig);
                    json!({"ok": true, "handle": handle})
                }
                Err(error) => json!({"ok": false, "error": error}),
            },
            Request::Validate { config } => match Rig::new(config) {
                Ok(_) => json!({"ok": true, "diagnostics": []}),
                Err(error) => json!({"ok": false, "error": error}),
            },
            Request::Check { source } => match parse_script(&source) {
                Ok(_) => json!({"ok": true, "scriptError": JsonValue::Null}),
                Err(error) => json!({
                    "ok": true,
                    "scriptError": {
                        "line": error.line,
                        "column": error.column,
                        "length": error.length,
                        "message": error.message,
                    },
                }),
            },
            Request::Tick {
                handle,
                now,
                inputs,
                paused,
                reset_clock,
                step_dt,
            } => {
                if let Some(rig) = self.rigs.get_mut(&handle) {
                    let frame = rig.tick(now, inputs, paused, reset_clock, step_dt);
                    json!({"ok": true, "frame": frame})
                } else {
                    json!({"ok": false, "error": "движок не найден или уже удалён"})
                }
            }
            Request::UpdateBase { handle, bases } => {
                if let Some(rig) = self.rigs.get_mut(&handle) {
                    rig.update_base(&bases);
                    json!({"ok": true})
                } else {
                    json!({"ok": false, "error": "движок не найден"})
                }
            }
            Request::Dispose { handle } => {
                self.rigs.remove(&handle);
                json!({"ok": true})
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{BasePose, CanvasConfig, RigObject};

    fn object(id: &str, parent: Option<&str>, script: &str) -> RigObject {
        RigObject {
            id: id.into(),
            name: id.into(),
            kind: ObjectKind::Sprite,
            image: None,
            parent_id: parent.map(str::to_string),
            pivot: Vec2::default(),
            base: BasePose::default(),
            script: script.into(),
            width: 100.0,
            height: 100.0,
            media: None,
        }
    }

    fn preset(objects: Vec<RigObject>, globals: &str) -> RigPreset {
        RigPreset {
            canvas: CanvasConfig {
                width: 1000.0,
                height: 600.0,
            },
            objects,
            globals: globals.into(),
            constants: BTreeMap::new(),
        }
    }

    fn tick(rig: &mut Rig, time: f64) -> Frame {
        rig.tick(time, InputValues::default(), false, false, None)
    }

    #[test]
    fn constants_from_modules_read_as_numbers() {
        // Состояния enum приходят из модулей константами: сравнение в скрипте
        // пишется по имени состояния, а не по номеру.
        let mut preset = preset(
            vec![object("a", None, "x = manual.value == walk ? 10 : 0\ny = is(manual.value, idle, walk) ? 5 : 0")],
            "",
        );
        preset.constants.insert("idle".into(), 0.0);
        preset.constants.insert("walk".into(), 1.0);
        let mut rig = Rig::new(preset).unwrap();
        let mut inputs = InputValues::default();
        inputs.values.insert("manual.value".into(), 1.0);
        let frame = rig.tick(0.0, inputs, false, false, None);
        let values = frame.objects.get("a").unwrap();
        assert_eq!(values["x"], 10.0);
        assert_eq!(values["y"], 5.0);
        assert!(frame.diagnostics.is_empty(), "диагностика: {:?}", frame.diagnostics);
    }

    #[test]
    fn media_commands_reach_the_frame_once() {
        let mut media = object("rain", None, "on start { play() }");
        media.kind = ObjectKind::Media;
        let mut rig = Rig::new(preset(vec![media], "")).unwrap();
        let frame = tick(&mut rig, 0.0);
        let cue = frame.media.get("rain").unwrap().clone();
        assert_eq!(cue.action, "play");
        assert!(cue.cue > 0);
        assert_eq!(frame.objects["rain"]["play"], 1.0);
        let next = tick(&mut rig, 0.016);
        assert_eq!(next.media["rain"].cue, cue.cue);
        assert_eq!(next.objects["rain"]["play"], 1.0);
    }

    #[test]
    fn text_command_sets_object_text() {
        let mut label = object("label", None, "on start { text(\"привет\") }");
        label.kind = ObjectKind::Text;
        let mut rig = Rig::new(preset(vec![label], "")).unwrap();
        let frame = tick(&mut rig, 0.0);
        assert_eq!(frame.texts["label"], "привет");
    }

    #[test]
    fn text_variable_is_base_and_event_override_resets() {
        // База в скрипте объекта видна без событий, а запись в блоке события
        // держится до остановки: после неё снова база.
        let mut label = object(
            "label",
            None,
            "text = \"привет\"\non mic.db.change { text = \"пока\" }",
        );
        label.kind = ObjectKind::Text;
        let mut rig = Rig::new(preset(vec![label], "")).unwrap();
        let mut inputs = InputValues::default();
        inputs.values.insert("mic.db".into(), 0.2);
        let first = rig.tick(0.0, inputs.clone(), false, false, None);
        assert_eq!(first.texts["label"], "привет");

        let mut louder = inputs.clone();
        louder.values.insert("mic.db".into(), 0.6);
        let changed = rig.tick(0.1, louder.clone(), false, false, None);
        assert_eq!(changed.texts["label"], "пока");

        // reset_clock — это «Стоп»: переопределение снимается.
        let stopped = rig.tick(0.2, louder, false, true, None);
        assert_eq!(stopped.texts["label"], "привет");

        // Стоп-кадр (пауза + reset_clock) тоже считает базу: после «Стопа»
        // видно `text = "привет"`, а не текст из события и не шаблон.
        let mut paused_inputs = InputValues::default();
        paused_inputs.values.insert("mic.db".into(), 0.1);
        rig.tick(0.3, paused_inputs.clone(), false, false, None);
        let stop_frame = rig.tick(0.4, paused_inputs, true, true, None);
        assert_eq!(stop_frame.texts["label"], "привет");
        assert_eq!(stop_frame.dt, 0.0);
    }

    #[test]
    fn text_converts_numbers_and_joins_strings() {
        let mut raw = object("raw", None, "text = text(mic.db)");
        raw.kind = ObjectKind::Text;
        let mut joined = object(
            "joined",
            None,
            "text = \"db \" + fixed(mic.db, 1) + \" / \" + upper(\"ok\")",
        );
        joined.kind = ObjectKind::Text;
        let mut choice = object(
            "choice",
            None,
            "text = text(mic.db) == \"0.42\" ? \"точное\" : \"другое\"",
        );
        choice.kind = ObjectKind::Text;
        let mut rig = Rig::new(preset(vec![raw, joined, choice], "")).unwrap();
        let mut inputs = InputValues::default();
        inputs.values.insert("mic.db".into(), 0.42);
        let frame = rig.tick(0.0, inputs, false, false, None);
        assert_eq!(frame.texts["raw"], "0.42");
        assert_eq!(frame.texts["joined"], "db 0.4 / OK");
        assert_eq!(frame.texts["choice"], "точное");
        assert!(frame.diagnostics.is_empty(), "диагностика: {:?}", frame.diagnostics);
    }

    #[test]
    fn text_command_accepts_expressions_and_foreign_writes() {
        // Команда понимает любое выражение, а чужой текст пишется через точку.
        let mut label = object("label", None, "on start { text(mic.db) }");
        label.kind = ObjectKind::Text;
        let mut marker = object("marker", None, "");
        marker.kind = ObjectKind::Text;
        let mut rig = Rig::new(preset(
            vec![label, marker],
            "on mic.db.change { marker.text = \"глоб\" + text(mic.db) }",
        ))
        .unwrap();
        let mut inputs = InputValues::default();
        inputs.values.insert("mic.db".into(), 0.5);
        let first = rig.tick(0.0, inputs.clone(), false, false, None);
        assert_eq!(first.texts["label"], "0.5");
        // Событие `change` на первом кадре не срабатывает: предыдущего значения нет.
        assert_eq!(first.texts.get("marker").cloned().unwrap_or_default(), "");

        let mut louder = inputs;
        louder.values.insert("mic.db".into(), 0.75);
        let changed = rig.tick(0.1, louder, false, false, None);
        assert_eq!(changed.texts["marker"], "глоб0.75");
        assert!(changed.diagnostics.is_empty(), "диагностика: {:?}", changed.diagnostics);
    }

    #[test]
    fn text_is_only_for_text_objects() {
        let mut rig = Rig::new(preset(vec![object("a", None, "text = \"x\"")], "")).unwrap();
        let frame = tick(&mut rig, 0.0);
        assert!(frame
            .diagnostics
            .iter()
            .any(|line| line.contains("только у текстового объекта")));
    }

    #[test]
    fn media_params_are_rejected_on_sprites() {
        let mut rig = Rig::new(preset(
            vec![object("a", None, "volume = 0.5")],
            "",
        ))
        .unwrap();
        let frame = tick(&mut rig, 0.0);
        assert!(frame
            .diagnostics
            .iter()
            .any(|line| line.contains("только у медиа-объекта")));
    }

    #[test]
    fn comparison_helpers_return_flags() {
        // Сравнения — обычные числа 0/1; удобнее всего проверять их на
        // глобальных переменных, где имя не обязано быть параметром.
        let mut rig = Rig::new(preset(
            vec![],
            "near_ok = near(0.5, 0.52, 0.05)\nnear_no = near(0.5, 0.9, 0.05)\n\ninside = between(3, 1, 5)\noutside = between(9, 1, 5)\nany = is(2, 1, 2, 3)",
        ))
        .unwrap();
        let frame = tick(&mut rig, 0.0);
        assert_eq!(frame.globals["near_ok"], 1.0);
        assert_eq!(frame.globals["near_no"], 0.0);
        assert_eq!(frame.globals["inside"], 1.0);
        assert_eq!(frame.globals["outside"], 0.0);
        assert_eq!(frame.globals["any"], 1.0);
    }

    #[test]
    fn arithmetic_and_ternary_work() {
        let mut rig = Rig::new(preset(
            vec![object("a", None, "x = 2 ^ 3 ^ 2\ny = x > 100 ? 4 : 1")],
            "",
        ))
        .unwrap();
        let frame = tick(&mut rig, 0.0);
        assert_eq!(frame.objects["a"]["x"], 512.0);
        assert_eq!(frame.objects["a"]["y"], 4.0);
    }

    #[test]
    fn clamp_is_relative_to_reference() {
        let mut rig = Rig::new(preset(
            vec![object(
                "a",
                None,
                "x = clamp(15, 10, -2, 3)\ny = limit(15, 0, 12)",
            )],
            "",
        ))
        .unwrap();
        let frame = tick(&mut rig, 0.0);
        assert_eq!(frame.objects["a"]["x"], 13.0);
        assert_eq!(frame.objects["a"]["y"], 12.0);
    }

    #[test]
    fn child_follows_parent_rotation() {
        let mut parent = object("parent", None, "rotation = 90");
        parent.base.x = 100.0;
        parent.base.y = 100.0;
        let mut child = object("child", Some("parent"), "");
        child.base.x = 200.0;
        child.base.y = 100.0;
        let mut rig = Rig::new(preset(vec![parent, child], "")).unwrap();
        let frame = tick(&mut rig, 0.0);
        // offset (100, 0) rotated by 90° becomes (0, 100);
        // follow returns the additional displacement (-100, 100).
        assert!((frame.objects["child"]["x"] + 100.0).abs() < 1e-8);
        assert!((frame.objects["child"]["y"] - 100.0).abs() < 1e-8);
    }

    #[test]
    fn globals_topological_order_works() {
        let mut rig = Rig::new(preset(
            vec![object("a", None, "x = b * 2")],
            "b = a + 1\na = 4",
        ))
        .unwrap();
        let frame = tick(&mut rig, 0.0);
        assert_eq!(frame.globals["b"], 5.0);
        assert_eq!(frame.objects["a"]["x"], 10.0);
    }

    #[test]
    fn cycles_fall_back_to_previous_frame() {
        let mut rig =
            Rig::new(preset(vec![object("a", None, "x = y + 1\ny = x + 1")], "")).unwrap();
        let first = tick(&mut rig, 0.0);
        assert!(first
            .diagnostics
            .iter()
            .any(|message| message.contains("цикл")));
        assert_eq!(first.objects["a"]["x"], 0.0);
        assert_eq!(first.objects["a"]["y"], 0.0);
    }

    #[test]
    fn fractional_visible_is_rounded() {
        let mut rig = Rig::new(preset(vec![object("a", None, "visible = 0.6")], "")).unwrap();
        let frame = tick(&mut rig, 0.0);
        assert_eq!(frame.objects["a"]["visible"], 1.0);
        assert!(!frame.diagnostics.is_empty());
    }

    #[test]
    fn module_inputs_are_dotted_and_dynamic() {
        let mut rig = Rig::new(preset(
            vec![object("a", None, "x = mic.talking * 2\ny = viseme.a")],
            "",
        ))
        .unwrap();
        let mut inputs = InputValues::default();
        inputs.values.insert("mic.talking".into(), 1.0);
        inputs.values.insert("viseme.a".into(), 0.25);
        let frame = rig.tick(0.0, inputs, false, false, None);
        assert_eq!(frame.objects["a"]["x"], 2.0);
        assert_eq!(frame.objects["a"]["y"], 0.25);
        assert!(frame.diagnostics.is_empty());
    }

    #[test]
    fn missing_module_input_is_reported() {
        let mut rig = Rig::new(preset(vec![object("a", None, "x = mic.unknown")], "")).unwrap();
        let frame = tick(&mut rig, 0.0);
        assert_eq!(frame.objects["a"]["x"], 0.0);
        assert!(frame
            .diagnostics
            .iter()
            .any(|message| message.contains("неизвестное имя")));
    }

    fn tick_with(rig: &mut Rig, time: f64, values: &[(&str, f64)]) -> Frame {
        let mut inputs = InputValues::default();
        for (key, value) in values {
            inputs.values.insert((*key).to_string(), *value);
        }
        rig.tick(time, inputs, false, false, None)
    }

    #[test]
    fn event_block_toggles_variable() {
        let mut rig = Rig::new(preset(
            vec![object("o", None, "visible = a")],
            "on event.mouse.left.down {\n  a = !a\n}",
        ))
        .unwrap();
        let idle = tick_with(&mut rig, 0.0, &[("mouse.left", 0.0)]);
        assert_eq!(idle.globals["a"], 0.0);
        // Нажатие переключает переменную, объект читает её в том же кадре.
        let press = tick_with(&mut rig, 0.033, &[("mouse.left", 1.0)]);
        assert_eq!(press.globals["a"], 1.0);
        assert_eq!(press.objects["o"]["visible"], 1.0);
        // Удержание не повторяет событие, отпускание — тоже.
        let hold = tick_with(&mut rig, 0.066, &[("mouse.left", 1.0)]);
        assert_eq!(hold.globals["a"], 1.0);
        let release = tick_with(&mut rig, 0.099, &[("mouse.left", 0.0)]);
        assert_eq!(release.globals["a"], 1.0);
        // Второе нажатие переключает обратно.
        let again = tick_with(&mut rig, 0.132, &[("mouse.left", 1.0)]);
        assert_eq!(again.globals["a"], 0.0);
    }

    #[test]
    fn event_hold_fires_once_after_delay() {
        let mut rig = Rig::new(preset(
            vec![object("o", None, "x = a")],
            "on event.mic.talking.hold(0.5) {\n  a = a + 1\n}",
        ))
        .unwrap();
        tick_with(&mut rig, 0.0, &[("mic.talking", 1.0)]);
        let early = tick_with(&mut rig, 0.2, &[("mic.talking", 1.0)]);
        assert_eq!(early.objects["o"]["x"], 0.0);
        let fired = tick_with(&mut rig, 0.6, &[("mic.talking", 1.0)]);
        assert_eq!(fired.objects["o"]["x"], 1.0);
        // Держим дальше — блок не повторяется.
        let later = tick_with(&mut rig, 1.4, &[("mic.talking", 1.0)]);
        assert_eq!(later.objects["o"]["x"], 1.0);
    }

    #[test]
    fn event_hold_zero_waits_next_frame() {
        let mut rig = Rig::new(preset(
            vec![object("o", None, "x = held\ny = pressed")],
            "on event.mic.talking.hold(0) {\n  held = held + 1\n}\non event.mic.talking.down {\n  pressed = pressed + 1\n}",
        ))
        .unwrap();
        tick_with(&mut rig, 0.0, &[("mic.talking", 0.0)]);
        // Фронт: `down` срабатывает сразу, `hold(0)` — только следующим кадром.
        let press = tick_with(&mut rig, 0.033, &[("mic.talking", 1.0)]);
        assert_eq!(press.objects["o"]["y"], 1.0);
        assert_eq!(press.objects["o"]["x"], 0.0);
        let next = tick_with(&mut rig, 0.066, &[("mic.talking", 1.0)]);
        assert_eq!(next.objects["o"]["x"], 1.0);
        // Отпускание снимает удержание, следующее нажатие снова срабатывает.
        tick_with(&mut rig, 0.099, &[("mic.talking", 0.0)]);
        let again = tick_with(&mut rig, 0.132, &[("mic.talking", 1.0)]);
        assert_eq!(again.objects["o"]["x"], 1.0);
        let again_next = tick_with(&mut rig, 0.165, &[("mic.talking", 1.0)]);
        assert_eq!(again_next.objects["o"]["x"], 2.0);
    }

    #[test]
    fn event_variable_is_readable_by_formula() {
        // Переменную меняет только событие — формула объекта обязана её видеть.
        let mut rig = Rig::new(preset(
            vec![object("o", None, "x = counter")],
            "on event.mic.talking.down {\n  counter = counter + 5\n}",
        ))
        .unwrap();
        let idle = tick_with(&mut rig, 0.0, &[("mic.talking", 0.0)]);
        assert_eq!(idle.objects["o"]["x"], 0.0);
        let press = tick_with(&mut rig, 0.033, &[("mic.talking", 1.0)]);
        assert_eq!(press.objects["o"]["x"], 5.0);
        assert!(!press.diagnostics.iter().any(|message| message.contains("неизвестное имя")));
    }

    #[test]
    fn event_body_reads_previous_frame_via_state() {
        let mut rig = Rig::new(preset(
            vec![object("o", None, "x = a")],
            "on event.mouse.left.down {\n  a = state.a + 1\n}",
        ))
        .unwrap();
        let idle = tick_with(&mut rig, 0.0, &[("mouse.left", 0.0)]);
        assert_eq!(idle.objects["o"]["x"], 0.0);
        let first = tick_with(&mut rig, 0.033, &[("mouse.left", 1.0)]);
        assert_eq!(first.objects["o"]["x"], 1.0);
        let release = tick_with(&mut rig, 0.066, &[("mouse.left", 0.0)]);
        let second = tick_with(&mut rig, 0.099, &[("mouse.left", 1.0)]);
        assert_eq!(second.objects["o"]["x"], 2.0);
        assert_eq!(release.objects["o"]["x"], 1.0);
    }

    #[test]
    fn start_block_runs_once_per_launch() {
        let mut rig = Rig::new(preset(
            vec![object("o", None, "x = boot")],
            "on start {\n  boot = boot + 1\n}",
        ))
        .unwrap();
        let first = tick_with(&mut rig, 0.0, &[]);
        assert_eq!(first.objects["o"]["x"], 1.0);
        let second = tick_with(&mut rig, 0.033, &[]);
        assert_eq!(second.objects["o"]["x"], 1.0);
        // Стоп и перезапуск снова делают кадр первым.
        let reset = rig.tick(0.066, InputValues::default(), false, true, None);
        assert_eq!(reset.objects["o"]["x"], 2.0);
    }

    #[test]
    fn named_trigger_is_shared_between_scripts() {
        let mut rig = Rig::new(preset(
            vec![object("o", None, "x = counter")],
            "trigger kick = mouse.left.down\non kick {\n  counter = counter + 1\n}",
        ))
        .unwrap();
        tick_with(&mut rig, 0.0, &[("mouse.left", 0.0)]);
        let press = tick_with(&mut rig, 0.033, &[("mouse.left", 1.0)]);
        assert_eq!(press.objects["o"]["x"], 1.0);
        let held = tick_with(&mut rig, 0.066, &[("mouse.left", 1.0)]);
        assert_eq!(held.objects["o"]["x"], 1.0);
        tick_with(&mut rig, 0.099, &[("mouse.left", 0.0)]);
        let again = tick_with(&mut rig, 0.132, &[("mouse.left", 1.0)]);
        assert_eq!(again.objects["o"]["x"], 2.0);
    }

    #[test]
    fn foreign_write_overrides_formula_and_is_readable() {
        let mut rig = Rig::new(preset(
            vec![
                object("head", None, "x = 5"),
                object("eye", None, "y = head.x"),
            ],
            "head.x = 42",
        ))
        .unwrap();
        let frame = tick_with(&mut rig, 0.0, &[]);
        assert_eq!(frame.objects["head"]["x"], 42.0);
        assert_eq!(frame.objects["eye"]["y"], 42.0);
        assert!(frame.diagnostics.is_empty());
    }

    #[test]
    fn unknown_names_report_diagnostics_without_killing_the_scene() {
        let mut rig = Rig::new(preset(
            vec![object("o", None, "x = a")],
            "on kick {\n  a = 1\n}\nbogus.x = 1",
        ))
        .unwrap();
        let frame = tick_with(&mut rig, 0.0, &[]);
        assert!(frame
            .diagnostics
            .iter()
            .any(|message| message.contains("неизвестное событие 'kick'")));
        assert!(frame
            .diagnostics
            .iter()
            .any(|message| message.contains("объекта 'bogus' нет в сцене")));
        assert_eq!(frame.objects["o"]["x"], 0.0);
    }

    #[test]
    fn event_in_object_script_changes_param() {
        let mut rig = Rig::new(preset(
            vec![object(
                "o",
                None,
                "x = 0\non event.mouse.right.up {\n  x = x + 10\n}",
            )],
            "",
        ))
        .unwrap();
        tick_with(&mut rig, 0.0, &[("mouse.right", 1.0)]);
        let release = tick_with(&mut rig, 0.033, &[("mouse.right", 0.0)]);
        assert_eq!(release.objects["o"]["x"], 10.0);
        // Обычная формула побеждает на следующем кадре: событие живёт кадр.
        let next = tick_with(&mut rig, 0.066, &[("mouse.right", 0.0)]);
        assert_eq!(next.objects["o"]["x"], 0.0);
    }

    #[test]
    fn event_change_fires_on_any_delta() {
        let mut rig = Rig::new(preset(
            vec![object("o", None, "x = a")],
            "on event.mouse.x.change {\n  a = a + 1\n}",
        ))
        .unwrap();
        tick_with(&mut rig, 0.0, &[("mouse.x", 0.1)]);
        let first = tick_with(&mut rig, 0.033, &[("mouse.x", 0.4)]);
        assert_eq!(first.objects["o"]["x"], 1.0);
        let same = tick_with(&mut rig, 0.066, &[("mouse.x", 0.4)]);
        assert_eq!(same.objects["o"]["x"], 1.0);
    }

    #[test]
    fn invalid_json_does_not_panic() {
        let mut store = RuntimeStore::default();
        let result = store.call_json("not json");
        assert!(result.contains("\"ok\":false"));
    }
}
