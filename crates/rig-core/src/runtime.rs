use crate::model::{
    BaseUpdate, Frame, InputText, InputValues, MediaCue, NodeKey, ObjectKind, Param, RigPreset,
    TextLine, Vec2,
};
use crate::parser::{
    parse_script, AssignTarget, BinaryOp, EventSource, Expr, Statement, UnaryOp,
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

/// Откуда берётся блок `on …` после сборки.
#[derive(Debug, Clone)]
enum CompiledSource {
    /// `on start` — первый кадр после запуска или остановки.
    Start,
    /// Своё событие: индекс в `definitions`.
    Named(usize),
}

/// Объявленное событие после сборки: условие и его переменные.
///
/// Переменные хранятся выражениями: в условии они считаются каждый кадр
/// (живой алиас), а в обработчике подставляются снимком на момент срабатывания.
#[derive(Debug, Clone)]
struct CompiledDefinition {
    name: String,
    /// Объект, в скрипте которого объявлено событие; `None` — глобальный скрипт.
    scope: Option<String>,
    params: Vec<(String, Arc<Expr>)>,
    /// Пауза повторного срабатывания, мс.
    cooldown_ms: f64,
    condition: Arc<Expr>,
    /// Строка объявления: на неё ссылается диагностика повторного имени.
    line: usize,
}

/// Состояние объявления между кадрами.
#[derive(Debug, Clone, Default)]
struct DefinitionState {
    /// Момент, с которого условие истинно; `None` — сейчас ложно (событие взведено).
    since: Option<f64>,
    /// Момент последнего срабатывания в текущем «взведении».
    last: Option<f64>,
}

/// `call имя(аргументы)` после сборки: индекс события и готовые аргументы.
#[derive(Debug, Clone)]
struct CompiledCall {
    target: usize,
    name: String,
    args: Vec<Arc<Expr>>,
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
    source: CompiledSource,
    /// Строка заголовка `on …`: её называет ошибка повторной подписки.
    line: usize,
    /// Объект, в скрипте которого записан блок; `None` — глобальные переменные.
    owner: Option<String>,
    /// Что присвоить при срабатывании: узел и выражение.
    body: Vec<(NodeKey, Arc<Expr>)>,
    /// Записи `text = …` из тела: переопределяют текст до остановки.
    text_body: Vec<TextWrite>,
    /// Команды (`play()`, `seek(…)`, `text(…)`): выполняются после присваиваний.
    actions: Vec<Arc<Expr>>,
    /// Вызовы своих событий (`call имя(…)`): идут последними, как команды.
    emits: Vec<CompiledCall>,
}

/// Предел вложенности `call`: защита от цепочки, которую не поймала сборка.
const MAX_CALL_DEPTH: usize = 8;

/// Сколько отметок активности держим на один вход.
const EDGE_MARK_LIMIT: usize = 400;

/// Сколько живёт отметка, выведенная ядром, в секундах: окна читают секунды.
const EDGE_MARK_TTL: f64 = 120.0;

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
    /// Объявления событий: глобальные, затем локальные в порядке объектов.
    definitions: Vec<CompiledDefinition>,
    /// Состояние каждого объявления: с какого момента истинно, когда сработало.
    definition_state: Vec<DefinitionState>,
    /// Состояние узлов `in`: момент, с которого условие истинно.
    ///
    /// Ключ — адрес подвыражения: оно создаётся при разборе один раз и живёт
    /// столько же, сколько сцена, поэтому адрес годится как идентификатор.
    in_state: HashMap<usize, f64>,
    /// Блоки `on …` из глобального скрипта и скриптов объектов.
    events: Vec<CompiledEvent>,
    /// Значения входов в прошлом кадре: по ним считаются `.up/.down/.change`.
    previous_inputs: BTreeMap<String, f64>,
    /// Отметки активности, выведенные из самих значений входов: (время, вес).
    ///
    /// Внешний источник знает вес события — биты, стоимость награды, — а клавиша
    /// или кнопка мыши нет. Для них событие входа одно: значение поднялось с
    /// нуля, вес 1. Так `count/sum/avg` работают у любого входа, а не только у
    /// тех, кто присылает готовые отметки.
    edge_marks: HashMap<String, Vec<(f64, f64)>>,
    /// Переменные события, видимые в текущем вычислении.
    bindings: BTreeMap<String, Value>,
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
        // Объявления событий: глобальные видны всем, локальные — своему объекту.
        let mut definitions: Vec<CompiledDefinition> = Vec::new();
        let mut global_defs: HashMap<String, usize> = HashMap::new();

        match parse_script(&preset.globals) {
            Ok(script) => {
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
                for decl in &script.definitions {
                    register_definition(
                        &mut definitions,
                        &mut global_defs,
                        decl,
                        None,
                        &mut compile_diagnostics,
                    );
                }
                let empty_locals: HashMap<String, usize> = HashMap::new();
                for block in &script.events {
                    let source = match resolve_source(
                        &block.source,
                        &empty_locals,
                        &global_defs,
                        &definitions,
                    ) {
                        Ok(source) => source,
                        Err(message) => {
                            compile_diagnostics.insert(format!("глобальные: {}", message));
                            continue;
                        }
                    };
                    let mut body = Vec::new();
                    let mut actions = Vec::new();
                    let mut emits = Vec::new();
                    let mut text_body: Vec<TextWrite> = Vec::new();
                    for statement in &block.body {
                        let (target, expr) = match statement {
                            Statement::Emit { name, args, line } => {
                                match resolve_call(
                                    name,
                                    &empty_locals,
                                    &global_defs,
                                    &definitions,
                                ) {
                                    Ok(target) => emits.push(CompiledCall {
                                        target,
                                        name: name.clone(),
                                        args: args.clone(),
                                    }),
                                    Err(message) => {
                                        compile_diagnostics.insert(format!(
                                            "глобальные (строка {}): {}",
                                            line, message
                                        ));
                                    }
                                }
                                continue;
                            }
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
                        source,
                        line: block.line,
                        owner: None,
                        body,
                        text_body,
                        actions,
                        emits,
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
            // Локальные объявления: имя занято глобальным событием — ошибка,
            // иначе `on` в объекте означал бы два разных события с одним именем.
            let mut local_defs: HashMap<String, usize> = HashMap::new();
            for decl in &script.definitions {
                if let Some(global_index) = global_defs.get(&decl.name).copied() {
                    compile_diagnostics.insert(format!(
                        "{} (строка {}): событие '{}' уже объявлено глобально в строке {} — имя занято",
                        object.id, decl.line, decl.name, definitions[global_index].line
                    ));
                    continue;
                }
                register_definition(
                    &mut definitions,
                    &mut local_defs,
                    decl,
                    Some(object.id.as_str()),
                    &mut compile_diagnostics,
                );
            }
            for block in &script.events {
                let source = match resolve_source(
                    &block.source,
                    &local_defs,
                    &global_defs,
                    &definitions,
                ) {
                    Ok(source) => source,
                    Err(message) => {
                        compile_diagnostics.insert(format!("{}: {}", object.id, message));
                        continue;
                    }
                };
                let mut body = Vec::new();
                let mut actions = Vec::new();
                let mut emits = Vec::new();
                let mut text_body: Vec<TextWrite> = Vec::new();
                for statement in &block.body {
                    let (target, expr) = match statement {
                        Statement::Emit { name, args, line } => {
                            match resolve_call(
                                name,
                                &local_defs,
                                &global_defs,
                                &definitions,
                            ) {
                                Ok(target) => emits.push(CompiledCall {
                                    target,
                                    name: name.clone(),
                                    args: args.clone(),
                                }),
                                Err(message) => {
                                    compile_diagnostics.insert(format!(
                                        "{} (строка {}): {}",
                                        object.id, line, message
                                    ));
                                }
                            }
                            continue;
                        }
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
                    source,
                    line: block.line,
                    owner: Some(object.id.clone()),
                    body,
                    text_body,
                    actions,
                    emits,
                });
            }
        }

        // Рекурсия `call` — ошибка ещё до первого кадра: бесконечный вызов
        // нельзя «поймать» во время работы, он бы просто подвесил сцену.
        check_recursion(&definitions, &events, &mut compile_diagnostics);
        check_duplicate_handlers(&definitions, &events, &mut compile_diagnostics);
        let definition_state = vec![DefinitionState::default(); definitions.len()];

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
            definitions,
            definition_state,
            in_state: HashMap::new(),
            events,
            previous_inputs: BTreeMap::new(),
            edge_marks: HashMap::new(),
            bindings: BTreeMap::new(),
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
            self.definition_state.iter_mut().for_each(|state| *state = DefinitionState::default());
            self.in_state.clear();
            self.edge_marks.clear();
            self.bindings.clear();
            self.texts.clear();
            self.started = false;
        }
        if paused && step_dt.is_none() {
            self.last_now = Some(self.now);
            self.previous_inputs = inputs.values.clone();
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
        // Прошлый кадр нужен полям `.up/.down/.change`: значения входов
        // сравниваются с тем, что было, а не с нулём.
        self.previous_inputs = std::mem::replace(&mut self.inputs, inputs).values;
        self.record_edge_marks();
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

    /// Отмечает входы, у которых значение поднялось с нуля.
    ///
    /// Это «событие входа» для всего, что приходит от модулей: нажатие клавиши,
    /// клик, моргание, вход в состояние. Внешние источники присылают свои
    /// отметки с весом — они важнее (см. `input_field`), потому что только они
    /// знают, сколько стоил пакет.
    fn record_edge_marks(&mut self) {
        let now = self.time;
        for (key, value) in &self.inputs.values {
            if *value == 0.0 {
                continue;
            }
            // Уже ненулевое — это не новое событие, а то же самое удержание.
            if self.previous_inputs.get(key).copied().unwrap_or(0.0) != 0.0 {
                continue;
            }
            let list = self.edge_marks.entry(key.clone()).or_default();
            list.push((now, 1.0));
            // Сначала возраст: старые окна всё равно никто не спросит.
            while matches!(list.first(), Some((at, _)) if now - at > EDGE_MARK_TTL) {
                list.remove(0);
            }
            while list.len() > EDGE_MARK_LIMIT {
                list.remove(0);
            }
        }
    }

    /// Считает условия событий и применяет тела сработавших блоков.
    ///
    /// Сначала считаются **все** объявления этого кадра, потом выполняются
    /// обработчики: так одно событие не влияет на условие другого в том же кадре.
    /// Значения попадают в кэш кадра до обычного вычисления, поэтому на этом
    /// кадре побеждает событие, а на следующем — обычные формулы или прошлое
    /// значение переменной.
    fn fire_events(&mut self) {
        let first_frame = !self.started;
        // Снимки переменных для сработавших событий: обработчику достаётся
        // значение на момент срабатывания, а не «микрофон уже изменился».
        let mut fired: Vec<Option<BTreeMap<String, Value>>> = Vec::new();
        for index in 0..self.definitions.len() {
            fired.push(self.evaluate_definition(index));
        }
        for index in 0..self.events.len() {
            let should_run = match &self.events[index].source {
                // `on start` — первый кадр после запуска, остановки или перезапуска.
                CompiledSource::Start => first_frame,
                CompiledSource::Named(target) => fired.get(*target).map(Option::is_some).unwrap_or(false),
            };
            if !should_run {
                continue;
            }
            let bindings = match &self.events[index].source {
                CompiledSource::Named(target) => fired[*target].clone().unwrap_or_default(),
                CompiledSource::Start => BTreeMap::new(),
            };
            self.run_handler(index, bindings, 0);
        }
        self.started = true;
    }

    /// Считает условие объявления и решает, срабатывает ли оно в этом кадре.
    ///
    /// Возвращает снимок переменных, если событие сработало: живой алиас
    /// `loud = mic.loudness` считается сейчас, обработчик получает именно это
    /// значение, даже если следующий кадр изменит микрофон.
    fn evaluate_definition(&mut self, index: usize) -> Option<BTreeMap<String, Value>> {
        let (owner, params, cooldown_ms, condition) = {
            let definition = &self.definitions[index];
            (
                definition.scope.clone(),
                definition.params.clone(),
                definition.cooldown_ms,
                definition.condition.clone(),
            )
        };
        let context = match &owner {
            Some(id) => NodeKey::Param(id.clone(), Param::X),
            None => NodeKey::Global(String::new()),
        };
        let bindings = self.collect_bindings(&params, &context);
        let truth = self.with_bindings(&bindings, |rig| {
            rig.numeric(&condition, &context) != 0.0
        });
        let now = self.time;
        let state = &mut self.definition_state[index];
        if !truth {
            // Условие стало ложным — событие взведено: следующий фронт сработает
            // сразу, не дожидаясь паузы прошлого срабатывания.
            state.since = None;
            state.last = None;
            return None;
        }
        if state.since.is_none() {
            state.since = Some(now);
            state.last = None;
        }
        let ready = match state.last {
            // Пауза `cd` отсчитывается от прошлого срабатывания; `0` — каждый кадр.
            Some(last) => now - last >= cooldown_ms.max(0.0),
            None => true,
        };
        if !ready {
            return None;
        }
        state.last = Some(now);
        Some(bindings)
    }

    /// Переменные события в этом кадре: выражения объявления по порядку.
    fn collect_bindings(
        &mut self,
        params: &[(String, Arc<Expr>)],
        context: &NodeKey,
    ) -> BTreeMap<String, Value> {
        self.bind_params(params, &[], context)
    }

    /// Выполняет замыкание с подставленными переменными события.
    ///
    /// Переменные — обычные имена в выражениях, поэтому они подменяют карту
    /// привязок на время вычисления и возвращаются как были: вложенный `call`
    /// не должен терять переменные вызывающего.
    fn with_bindings<T>(
        &mut self,
        bindings: &BTreeMap<String, Value>,
        action: impl FnOnce(&mut Self) -> T,
    ) -> T {
        let saved = std::mem::replace(&mut self.bindings, bindings.clone());
        let result = action(self);
        self.bindings = saved;
        result
    }

    /// Обработчик `on …`: присваивания, текст, команды и вызовы.
    fn run_handler(&mut self, index: usize, bindings: BTreeMap<String, Value>, depth: usize) {
        let (owner, body, text_body, actions, emits) = {
            let event = &self.events[index];
            (
                event.owner.clone(),
                event.body.clone(),
                event.text_body.clone(),
                event.actions.clone(),
                event.emits.clone(),
            )
        };
        let context = match &owner {
            Some(id) => NodeKey::Param(id.clone(), Param::X),
            None => NodeKey::Global(String::new()),
        };
        let saved = std::mem::replace(&mut self.bindings, bindings);
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
        for call in emits {
            self.emit_event(&call, &context, depth);
        }
        self.bindings = saved;
    }

    /// `call имя(аргументы)`: обработчики события выполняются сразу, в этом кадре.
    ///
    /// Пауза игнорируется — это прямая команда, а не «условие сработало».
    /// Аргументы встают на место переменных по порядку; недостающие берутся из
    /// выражений объявления. Глубина ограничена, чтобы ошибка не подвесила сцену.
    fn emit_event(&mut self, call: &CompiledCall, caller: &NodeKey, depth: usize) {
        if depth >= MAX_CALL_DEPTH {
            self.diagnostics.insert(format!(
                "вызов '{}': вложенность больше {} — проверьте call",
                call.name, MAX_CALL_DEPTH
            ));
            return;
        }
        let (owner, params) = {
            let definition = &self.definitions[call.target];
            (definition.scope.clone(), definition.params.clone())
        };
        let context = match &owner {
            Some(id) => NodeKey::Param(id.clone(), Param::X),
            None => NodeKey::Global(String::new()),
        };
        // Аргументы считаются в контексте вызывающего, со своими переменными.
        let mut values = Vec::new();
        for argument in &call.args {
            values.push(self.eval_expr(argument, caller));
        }
        let bindings = self.bind_params(&params, &values, &context);
        let saved = std::mem::replace(&mut self.bindings, bindings);
        for index in 0..self.events.len() {
            let target = match &self.events[index].source {
                CompiledSource::Named(target) => *target,
                CompiledSource::Start => continue,
            };
            if target != call.target {
                continue;
            }
            let snapshot = self.bindings.clone();
            self.run_handler(index, snapshot, depth + 1);
        }
        self.bindings = saved;
    }

    /// Значения переменных: аргумент вызова по порядку, иначе выражение объявления.
    ///
    /// Считаются по очереди и с уже готовыми предыдущими: `db = loud * 2`
    /// в объявлении видит `loud` так же, как в `call`.
    fn bind_params(
        &mut self,
        params: &[(String, Arc<Expr>)],
        values: &[Value],
        context: &NodeKey,
    ) -> BTreeMap<String, Value> {
        let mut bindings = BTreeMap::new();
        for (position, (name, default)) in params.iter().enumerate() {
            let value = match values.get(position) {
                Some(value) => value.clone(),
                None => {
                    let saved = std::mem::replace(&mut self.bindings, bindings.clone());
                    let value = self.eval_expr(default, context);
                    self.bindings = saved;
                    value
                }
            };
            bindings.insert(name.clone(), value);
        }
        bindings
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
            // `<условие> in <мс>`: сколько времени условие истинно подряд.
            Expr::In { expr, ms } => {
                // Ключ — адрес подвыражения: узел создан один раз при разборе,
                // поэтому адрес стабилен всю жизнь сцены.
                let key = expr.as_ref() as *const Expr as usize;
                let value = self.numeric(expr, context);
                if value == 0.0 {
                    self.in_state.remove(&key);
                    return Value::Number(0.0);
                }
                let now = self.time;
                let since = *self.in_state.entry(key).or_insert(now);
                Value::Number(bool_number(now - since >= *ms))
            }
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
                // Поле входа модуля: `twitch.chat.message` — последнее сообщение
                // чата, `twitch.reward.max` — верхняя граница входа.
                if let Expr::Member { expr: root, name: input } = expr.as_ref() {
                    if let Expr::Name(module) = root.as_ref() {
                        if let Some(value) = self.input_field(module, input, name, None, context) {
                            return value;
                        }
                    }
                }
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
            Expr::FieldCall { subject, field, args } => {
                // `twitch.chat.message(-1)`: смещение по истории. Второго
                // аргумента у полей нет — лишние просто не читаются.
                let offset = args.first();
                let (module, input) = subject.split_once('.').unwrap_or((subject.as_str(), ""));
                match self.input_field(module, input, field, offset, context) {
                    Some(value) => value,
                    None => self.error_value(format!(
                        "у входа '{}' нет поля '{}'; есть message, user, min, max, step, label, kind, up, down, change, count, sum, avg",
                        subject, field
                    )),
                }
            }
        }
    }

    /// Поле входа модуля: строка чата, автор или паспорт входа.
    ///
    /// `None` означает «это не поле входа»: тогда вызывающий код работает как
    /// раньше — с векторами, объектами и обычным доступом к параметрам.
    /// Смещение читается по истории: 0 (или пусто) — последнее сообщение,
    /// −1 — предыдущее, −2 — то, что было до него.
    fn input_field(
        &mut self,
        module: &str,
        input: &str,
        field: &str,
        offset: Option<&Expr>,
        context: &NodeKey,
    ) -> Option<Value> {
        // Смещение считается до заимствования истории: `numeric` меняет
        // диагностику и кэш, поэтому занимать `self.inputs` в этот момент нельзя.
        let shift = offset
            .map(|expr| self.numeric(expr, context).round() as i64)
            .unwrap_or(0);
        let key = format!("{}.{}", module, input);
        let known = self.inputs.texts.contains_key(&key)
            || self.inputs.meta.contains_key(&key)
            || self.inputs.values.contains_key(&key)
            || self.inputs.marks.contains_key(&key);
        if !known {
            return None;
        }
        let name = field.to_ascii_lowercase();
        // Направление уровня сигнала: `up` — вырос, `down` — упал, `change` —
        // отличается от прошлого кадра. Это обычные числа 0/1, а не события.
        if matches!(name.as_str(), "up" | "down" | "change") {
            let current = self.inputs.values.get(&key).copied().unwrap_or(0.0);
            // Первого кадра в истории нет: фронта на старте сцены не бывает.
            let delta = match self.previous_inputs.get(&key) {
                Some(previous) => current - previous,
                None => 0.0,
            };
            return Some(Value::Number(match name.as_str() {
                "up" => bool_number(delta > 1e-9),
                "down" => bool_number(delta < -1e-9),
                _ => bool_number(delta.abs() > 1e-9),
            }));
        }
        // Активность за окно: `count(5)`, `sum(5)`, `avg(5)` — окно в секундах.
        if matches!(name.as_str(), "count" | "sum" | "avg") {
            let window_ms = self
                .input_window_seconds(offset, context)
                .map(|seconds| seconds * 1000.0)
                .unwrap_or(0.0)
                .max(0.0);
            let mut count = 0.0;
            let mut total = 0.0;
            // Отметки внешнего источника важнее: только он знает вес события
            // (биты, стоимость награды). Если их нет — считаем подъёмы значения
            // с нуля: клавиши, кнопки мыши, моргание, состояния.
            let provider = self.inputs.marks.get(&key).filter(|list| !list.is_empty());
            match provider {
                Some(marks) => {
                    for mark in marks {
                        if mark.age_ms.is_finite()
                            && mark.age_ms >= 0.0
                            && mark.age_ms <= window_ms
                        {
                            count += 1.0;
                            total += if mark.weight.is_finite() {
                                mark.weight
                            } else {
                                1.0
                            };
                        }
                    }
                }
                None => {
                    let Some(marks) = self.edge_marks.get(&key) else {
                        return None;
                    };
                    for (at, weight) in marks {
                        // Возраст считаем по часам ядра: отметки ставит оно само.
                        let age_ms = (self.time - at) * 1000.0;
                        if age_ms >= 0.0 && age_ms <= window_ms {
                            count += 1.0;
                            total += *weight;
                        }
                    }
                }
            }
            return Some(Value::Number(match name.as_str() {
                "count" => count,
                "sum" => total,
                _ => {
                    if count > 0.0 {
                        total / count
                    } else {
                        0.0
                    }
                }
            }));
        }
        if matches!(name.as_str(), "min" | "max" | "step" | "label" | "kind") {
            let meta = self.inputs.meta.get(&key)?;
            return Some(match name.as_str() {
                "min" => Value::Number(meta.min),
                "max" => Value::Number(meta.max),
                "step" => Value::Number(meta.step),
                "label" => Value::Text(meta.label.clone()),
                _ => Value::Text(meta.kind.clone()),
            });
        }
        if !matches!(name.as_str(), "message" | "text" | "chat" | "user" | "author" | "name") {
            return None;
        }
        // Истории ещё нет: вход известен, но сообщений не было — пустая строка.
        let line = self
            .inputs
            .texts
            .get(&key)
            .and_then(|texts| text_line(texts, shift))
            .unwrap_or_default();
        Some(if matches!(name.as_str(), "user" | "author" | "name") {
            Value::Text(line.author.unwrap_or_default())
        } else {
            Value::Text(line.text)
        })
    }

    /// Окно активности в секундах: `count(5)` → 5.
    ///
    /// Второго аргумента у полей нет, поэтому лишние просто не читаются.
    fn input_window_seconds(&mut self, offset: Option<&Expr>, context: &NodeKey) -> Option<f64> {
        let expr = offset?;
        let value = self.numeric(expr, context);
        Some(if value.is_finite() { value } else { 0.0 })
    }

    fn eval_name(&mut self, name: &str, context: &NodeKey) -> Value {
        // Переменная события важнее объекта и глобальных формул: внутри `on`
        // это снимок на момент срабатывания, в условии — живой алиас.
        if let Some(value) = self.bindings.get(name) {
            return value.clone();
        }
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

/// Имена, которые нельзя занимать переменной события.
///
/// Параметры объекта — это те же переменные, только их читает сам объект:
/// перекрывать их молча нельзя. Встроенные имена тоже заняты ядром.
fn reserved_binding(name: &str) -> bool {
    Param::parse(name).is_some()
        || matches!(
            name,
            "pi" | "e"
                | "time"
                | "dt"
                | "canvasWidth"
                | "canvasHeight"
                | "signal"
                | "parent"
                | "inherit"
                | "offset"
                | "width"
                | "height"
                | "state"
                | "text"
                | "start"
        )
}

/// Добавляет объявление события в общий список и в карту своей области.
fn register_definition(
    definitions: &mut Vec<CompiledDefinition>,
    scope_map: &mut HashMap<String, usize>,
    decl: &crate::parser::EventDecl,
    scope: Option<&str>,
    diagnostics: &mut BTreeSet<String>,
) {
    let label = scope.unwrap_or("глобальные");
    let mut valid = true;
    for (name, _) in &decl.params {
        if reserved_binding(name) {
            diagnostics.insert(format!(
                "{} (строка {}): переменная события '{}' занята — это параметр объекта или встроенное имя",
                label, decl.line, name
            ));
            valid = false;
        }
    }
    if scope_map.contains_key(&decl.name) {
        // Внутри одной области повтор имени ловит ещё парсер, но объект может
        // собрать два скрипта в один список — проверка дешёвая.
        if let Some(previous) = scope_map.get(&decl.name).copied() {
            diagnostics.insert(format!(
                "{} (строка {}): событие '{}' уже объявлено в строке {}",
                label, decl.line, decl.name, definitions[previous].line
            ));
        }
        valid = false;
    }
    if !valid {
        return;
    }
    let index = definitions.len();
    definitions.push(CompiledDefinition {
        name: decl.name.clone(),
        scope: scope.map(str::to_string),
        params: decl.params.clone(),
        cooldown_ms: decl.cooldown_ms,
        condition: decl.condition.clone(),
        line: decl.line,
    });
    scope_map.insert(decl.name.clone(), index);
}

/// Подписка `on имя`: своя область, затем глобальные события.
fn resolve_source(
    source: &EventSource,
    local: &HashMap<String, usize>,
    global: &HashMap<String, usize>,
    definitions: &[CompiledDefinition],
) -> Result<CompiledSource, String> {
    match source {
        EventSource::Start => Ok(CompiledSource::Start),
        EventSource::Named(name) => {
            if let Some(index) = local.get(name).or_else(|| global.get(name)).copied() {
                return Ok(CompiledSource::Named(index));
            }
            // Событие может быть локальным для другого объекта: это не опечатка,
            // а именно невидимость, и подсказка должна быть другой.
            if let Some(index) = definitions
                .iter()
                .position(|entry| entry.name == *name && entry.scope.is_some())
            {
                let owner = definitions[index].scope.clone().unwrap_or_default();
                return Err(format!(
                    "событие '{}' объявлено в скрипте объекта '{}' и здесь не видно",
                    name, owner
                ));
            }
            let mut known: Vec<&str> = global.keys().map(String::as_str).collect();
            known.sort();
            let list = if known.is_empty() {
                "объявленных событий нет".to_string()
            } else {
                known.join(", ")
            };
            Err(format!(
                "событие '{}' не объявлено: напишите 'event {}() {{ условие }}' ({})",
                name, name, list
            ))
        }
    }
}

/// `call имя(…)`: находит объявление в своей области или среди глобальных.
fn resolve_call(
    name: &str,
    local: &HashMap<String, usize>,
    global: &HashMap<String, usize>,
    definitions: &[CompiledDefinition],
) -> Result<usize, String> {
    if let Some(index) = local.get(name).or_else(|| global.get(name)).copied() {
        return Ok(index);
    }
    if let Some(index) = definitions
        .iter()
        .position(|entry| entry.name == name && entry.scope.is_some())
    {
        let owner = definitions[index].scope.clone().unwrap_or_default();
        return Err(format!(
            "вызов '{}': событие объявлено в скрипте объекта '{}' и здесь не видно",
            name, owner
        ));
    }
    Err(format!(
        "вызов '{}': событие не объявлено — напишите 'event {}() {{ условие }}'",
        name, name
    ))
}

/// Один `on` на событие и область: вторая подписка — ошибка с обеими строками.
///
/// Иначе непонятно, в каком порядке выполняются два обработчика одного имени,
/// и `call` запускал бы оба.
fn check_duplicate_handlers(
    definitions: &[CompiledDefinition],
    events: &[CompiledEvent],
    diagnostics: &mut BTreeSet<String>,
) {
    // Ключ — область и подписка: `start` или индекс объявления.
    let mut seen: HashMap<(Option<String>, Option<usize>), usize> = HashMap::new();
    for event in events {
        let key = match &event.source {
            CompiledSource::Start => (event.owner.clone(), None),
            CompiledSource::Named(index) => (event.owner.clone(), Some(*index)),
        };
        if let Some(previous) = seen.get(&key).copied() {
            let label = event.owner.clone().unwrap_or_else(|| "глобальные".into());
            let name = match &event.source {
                CompiledSource::Start => "start".to_string(),
                CompiledSource::Named(index) => definitions[*index].name.clone(),
            };
            diagnostics.insert(format!(
                "{} (строка {}): 'on {}' уже объявлен в строке {} — у события один обработчик",
                label, event.line, name, previous
            ));
            continue;
        }
        seen.insert(key, event.line);
    }
}

/// Ищет рекурсию `call`: цепочка вызовов, возвращающаяся в то же событие.
///
/// Синхронный вызов без ограничения ушёл бы в бесконечность, поэтому это
/// ошибка сборки, а не диагностика кадра.
fn check_recursion(
    definitions: &[CompiledDefinition],
    events: &[CompiledEvent],
    diagnostics: &mut BTreeSet<String>,
) {
    let mut edges: Vec<Vec<usize>> = vec![Vec::new(); definitions.len()];
    for event in events {
        if let CompiledSource::Named(owner) = event.source {
            for call in &event.emits {
                edges[owner].push(call.target);
            }
        }
    }
    // 0 — не посещён, 1 — в стеке, 2 — готов.
    fn walk(
        node: usize,
        edges: &[Vec<usize>],
        colors: &mut [u8],
        stack: &mut Vec<usize>,
        definitions: &[CompiledDefinition],
        diagnostics: &mut BTreeSet<String>,
    ) {
        colors[node] = 1;
        stack.push(node);
        for target in &edges[node] {
            if colors[*target] == 1 {
                let start = stack.iter().position(|entry| entry == target).unwrap_or(0);
                let mut path: Vec<&str> = stack[start..]
                    .iter()
                    .map(|index| definitions[*index].name.as_str())
                    .collect();
                path.push(definitions[*target].name.as_str());
                diagnostics.insert(format!(
                    "рекурсия вызова: {} — событие не может вызывать себя через call",
                    path.join(" → ")
                ));
            } else if colors[*target] == 0 {
                walk(*target, edges, colors, stack, definitions, diagnostics);
            }
        }
        stack.pop();
        colors[node] = 2;
    }
    let mut colors = vec![0u8; definitions.len()];
    let mut stack = Vec::new();
    for node in 0..definitions.len() {
        if colors[node] == 0 {
            walk(
                node,
                &edges,
                &mut colors,
                &mut stack,
                definitions,
                diagnostics,
            );
        }
    }
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

/// Строка истории по смещению: 0 — последняя, −1 — предыдущая.
///
/// `None` — смещение ушло в будущее (истории ещё нет или просят больше, чем
/// записано): вызывающий подставляет пустую строку.
fn text_line(texts: &InputText, shift: i64) -> Option<TextLine> {
    let index = texts.lines.len() as i64 - 1 + shift;
    if index < 0 {
        return Some(TextLine::default());
    }
    texts.lines.get(index as usize).cloned()
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
    use crate::model::{BasePose, CanvasConfig, InputMark, RigObject};

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
            "text = \"привет\"\nevent louder() { mic.db.change }\non louder {\n  text = \"пока\"\n}",
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
            "event louder() { mic.db.change }\non louder {\n  marker.text = \"глоб\" + text(mic.db)\n}",
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

    /// История чата: свежие строки в конце, как приходит из редактора.
    fn chat_inputs(messages: &[(&str, &str)]) -> InputValues {
        let mut inputs = InputValues::default();
        inputs.values.insert("twitch.chat".into(), messages.len() as f64);
        inputs.texts.insert(
            "twitch.chat".into(),
            InputText {
                lines: messages
                    .iter()
                    .map(|(author, text)| TextLine {
                        text: (*text).to_string(),
                        author: Some((*author).to_string()),
                    })
                    .collect(),
            },
        );
        inputs.meta.insert(
            "twitch.chat".into(),
            crate::model::InputMeta {
                label: "Сообщений".into(),
                min: 0.0,
                max: 1_000_000.0,
                step: 1.0,
                kind: "level".into(),
            },
        );
        inputs
    }

    #[test]
    fn chat_text_fields_read_history_by_offset() {
        let mut message = object(
            "message",
            None,
            "text = twitch.chat.message() + \" | \" + twitch.chat.message(-1)",
        );
        message.kind = ObjectKind::Text;
        let mut author = object("author", None, "text = twitch.chat.user(-1)");
        author.kind = ObjectKind::Text;
        // Без скобок — то же самое, что `message()`: последнее сообщение.
        let mut plain = object("plain", None, "text = twitch.chat.message");
        plain.kind = ObjectKind::Text;
        let mut rig = Rig::new(preset(vec![message, author, plain], "")).unwrap();
        let inputs = chat_inputs(&[("ада", "первое"), ("боб", "второе")]);
        let frame = rig.tick(0.0, inputs, false, false, None);
        assert_eq!(frame.texts["plain"], "второе");
        assert_eq!(frame.texts["message"], "второе | первое");
        assert_eq!(frame.texts["author"], "ада");
        assert!(frame.diagnostics.is_empty(), "диагностика: {:?}", frame.diagnostics);
    }

    #[test]
    fn chat_text_survives_empty_history_and_far_offsets() {
        let mut label = object("label", None, "text = twitch.chat.message(-5)");
        label.kind = ObjectKind::Text;
        let mut rig = Rig::new(preset(vec![label], "")).unwrap();
        // Сообщений ещё не было: пустая строка, но не ошибка.
        let empty = rig.tick(0.0, InputValues::default(), false, false, None);
        assert_eq!(empty.texts.get("label").cloned().unwrap_or_default(), "");
        assert!(empty.diagnostics.is_empty(), "диагностика: {:?}", empty.diagnostics);
        let frame = rig.tick(0.1, chat_inputs(&[("ада", "одно")]), false, false, None);
        // Смещение глубже истории — пустая строка, а не падение.
        assert_eq!(frame.texts.get("label").cloned().unwrap_or_default(), "");
    }

    #[test]
    fn input_meta_is_readable_from_the_script() {
        // Доля от верхней границы входа: раньше пределы знал только редактор.
        let mut share = object(
            "share",
            None,
            "text = twitch.chat.label + \": \" + text(twitch.chat) + \" / \" + text(twitch.chat.max)",
        );
        share.kind = ObjectKind::Text;
        let mut rig = Rig::new(preset(vec![share], "")).unwrap();
        let mut inputs = chat_inputs(&[("ада", "привет")]);
        inputs.values.insert("twitch.chat".into(), 3.0);
        let frame = rig.tick(0.0, inputs, false, false, None);
        assert_eq!(frame.texts["share"], "Сообщений: 3 / 1000000");
        assert!(frame.diagnostics.is_empty(), "диагностика: {:?}", frame.diagnostics);
    }

    #[test]
    fn unknown_input_field_is_reported() {
        let mut label = object("label", None, "text = twitch.chat.нет_такого(-1)");
        label.kind = ObjectKind::Text;
        let mut rig = Rig::new(preset(vec![label], "")).unwrap();
        let frame = rig.tick(0.0, chat_inputs(&[("ада", "привет")]), false, false, None);
        assert!(
            frame
                .diagnostics
                .iter()
                .any(|line| line.contains("нет поля 'нет_такого'")),
            "диагностика: {:?}",
            frame.diagnostics
        );
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
            "event click() { mouse.left.up }\non click {\n  a = !a\n}",
        ))
        .unwrap();
        let idle = tick_with(&mut rig, 0.0, &[("mouse.left", 0.0)]);
        assert_eq!(idle.globals["a"], 0.0);
        // Нажатие переключает переменную, объект читает её в том же кадре.
        let press = tick_with(&mut rig, 0.033, &[("mouse.left", 1.0)]);
        assert_eq!(press.globals["a"], 1.0);
        assert_eq!(press.objects["o"]["visible"], 1.0);
        // Удержание не повторяет событие: `.up` истинно только на росте.
        let hold = tick_with(&mut rig, 0.066, &[("mouse.left", 1.0)]);
        assert_eq!(hold.globals["a"], 1.0);
        let release = tick_with(&mut rig, 0.099, &[("mouse.left", 0.0)]);
        assert_eq!(release.globals["a"], 1.0);
        // Второе нажатие переключает обратно.
        let again = tick_with(&mut rig, 0.132, &[("mouse.left", 1.0)]);
        assert_eq!(again.globals["a"], 0.0);
    }

    #[test]
    fn duration_operator_delays_firing() {
        let mut rig = Rig::new(preset(
            vec![object("o", None, "x = ticks")],
            "event speak() { mic.talking > 0.5 in 300 }\non speak {\n  ticks = ticks + 1\n}",
        ))
        .unwrap();
        let first = tick_with(&mut rig, 0.0, &[("mic.talking", 1.0)]);
        assert_eq!(first.objects["o"]["x"], 0.0);
        let early = tick_with(&mut rig, 200.0, &[("mic.talking", 1.0)]);
        assert_eq!(early.objects["o"]["x"], 0.0);
        // Ровно 300 мс удержания — срабатывание.
        let fired = tick_with(&mut rig, 300.0, &[("mic.talking", 1.0)]);
        assert_eq!(fired.objects["o"]["x"], 1.0);
        // Паузы нет (`cd 0`) — дальше событие срабатывает каждый кадр.
        let later = tick_with(&mut rig, 400.0, &[("mic.talking", 1.0)]);
        assert_eq!(later.objects["o"]["x"], 2.0);
        // Условие стало ложным — `in` начинается заново.
        tick_with(&mut rig, 500.0, &[("mic.talking", 0.0)]);
        let quiet = tick_with(&mut rig, 600.0, &[("mic.talking", 1.0)]);
        assert_eq!(quiet.objects["o"]["x"], 2.0);
    }

    #[test]
    fn silence_is_negated_duration() {
        let mut rig = Rig::new(preset(
            vec![object("o", None, "x = quiet")],
            "event silence() { !(mic.talking > 0.5) in 500 }\non silence {\n  quiet = quiet + 1\n}",
        ))
        .unwrap();
        let speaking = tick_with(&mut rig, 0.0, &[("mic.talking", 1.0)]);
        assert_eq!(speaking.objects["o"]["x"], 0.0);
        // Тишина началась на 300-й мс — окно отсчитывается от неё.
        let pause = tick_with(&mut rig, 300.0, &[("mic.talking", 0.0)]);
        assert_eq!(pause.objects["o"]["x"], 0.0);
        let early = tick_with(&mut rig, 700.0, &[("mic.talking", 0.0)]);
        assert_eq!(early.objects["o"]["x"], 0.0);
        let silent = tick_with(&mut rig, 800.0, &[("mic.talking", 0.0)]);
        assert_eq!(silent.objects["o"]["x"], 1.0);
    }

    #[test]
    fn cooldown_limits_refiring_and_keeps_snapshot() {
        let mut rig = Rig::new(preset(
            vec![object("o", None, "x = held")],
            "event clap(loud = mic.loudness ; 1000) { mic.talking > 0.5 }\non clap {\n  held = loud\n}",
        ))
        .unwrap();
        let first = tick_with(&mut rig, 0.0, &[("mic.talking", 1.0), ("mic.loudness", 0.2)]);
        assert_eq!(first.objects["o"]["x"], 0.2);
        // Пауза не пускает повторное срабатывание, значение остаётся прежним.
        let early = tick_with(&mut rig, 500.0, &[("mic.talking", 1.0), ("mic.loudness", 0.9)]);
        assert_eq!(early.objects["o"]["x"], 0.2);
        let later = tick_with(&mut rig, 1000.0, &[("mic.talking", 1.0), ("mic.loudness", 0.9)]);
        assert_eq!(later.objects["o"]["x"], 0.9);
    }

    #[test]
    fn event_variable_is_readable_by_formula() {
        // Переменную меняет только событие — формула объекта обязана её видеть.
        let mut rig = Rig::new(preset(
            vec![object("o", None, "x = counter")],
            "event speak() { mic.talking > 0.5 }\non speak {\n  counter = counter + 5\n}",
        ))
        .unwrap();
        let idle = tick_with(&mut rig, 0.0, &[("mic.talking", 0.0)]);
        assert_eq!(idle.objects["o"]["x"], 0.0);
        let press = tick_with(&mut rig, 0.033, &[("mic.talking", 1.0)]);
        assert_eq!(press.objects["o"]["x"], 5.0);
        assert!(!press
            .diagnostics
            .iter()
            .any(|message| message.contains("неизвестное имя")));
    }

    #[test]
    fn event_variables_are_visible_in_condition() {
        // Живой алиас: `loud` в условии — то же, что `mic.loudness`.
        let mut rig = Rig::new(preset(
            vec![object("o", None, "x = hits")],
            "event clap(loud = mic.loudness) { loud > 0.7 }\non clap {\n  hits = hits + 1\n}",
        ))
        .unwrap();
        let quiet = tick_with(&mut rig, 0.0, &[("mic.loudness", 0.2)]);
        assert_eq!(quiet.objects["o"]["x"], 0.0);
        let loud = tick_with(&mut rig, 0.033, &[("mic.loudness", 0.9)]);
        assert_eq!(loud.objects["o"]["x"], 1.0);
    }

    #[test]
    fn event_body_reads_previous_frame_via_state() {
        let mut rig = Rig::new(preset(
            vec![object("o", None, "x = a")],
            "event click() { mouse.left.up }\non click {\n  a = state.a + 1\n}",
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
    fn global_event_is_shared_with_object_script() {
        // Событие объявлено глобально, обработчик — в скрипте объекта.
        let mut rig = Rig::new(preset(
            vec![object("o", None, "x = 0\non kick {\n  x = x + 1\n}")],
            "event kick() { mouse.left.up }",
        ))
        .unwrap();
        tick_with(&mut rig, 0.0, &[("mouse.left", 0.0)]);
        let press = tick_with(&mut rig, 0.033, &[("mouse.left", 1.0)]);
        assert_eq!(press.objects["o"]["x"], 1.0);
        // Формула `x = 0` побеждает на следующем кадре: событие живёт кадр.
        let held = tick_with(&mut rig, 0.066, &[("mouse.left", 1.0)]);
        assert_eq!(held.objects["o"]["x"], 0.0);
        assert!(held.diagnostics.is_empty(), "{:?}", held.diagnostics);
    }

    #[test]
    fn local_event_belongs_to_its_object() {
        let mut rig = Rig::new(preset(
            vec![object(
                "o",
                None,
                "x = 0\nevent boom() { mouse.left.up }\non boom {\n  x = 7\n}",
            )],
            "",
        ))
        .unwrap();
        tick_with(&mut rig, 0.0, &[("mouse.left", 0.0)]);
        let press = tick_with(&mut rig, 0.033, &[("mouse.left", 1.0)]);
        assert_eq!(press.objects["o"]["x"], 7.0);
        assert!(press.diagnostics.is_empty(), "{:?}", press.diagnostics);
    }

    #[test]
    fn call_runs_handler_immediately_with_arguments() {
        let mut rig = Rig::new(preset(
            vec![object("o", None, "x = held")],
            "event clap(loud = mic.loudness) { mouse.left.up }\non clap {\n  held = loud\n}\non start {\n  call clap(0.75)\n}",
        ))
        .unwrap();
        let first = tick_with(&mut rig, 0.0, &[("mic.loudness", 0.1)]);
        assert_eq!(first.objects["o"]["x"], 0.75);
    }

    #[test]
    fn call_without_arguments_uses_declaration_values() {
        let mut rig = Rig::new(preset(
            vec![object("o", None, "x = held")],
            "event clap(loud = mic.loudness) { mouse.left.up }\non clap {\n  held = loud\n}\non start {\n  call clap()\n}",
        ))
        .unwrap();
        let first = tick_with(&mut rig, 0.0, &[("mic.loudness", 0.3)]);
        assert_eq!(first.objects["o"]["x"], 0.3);
    }

    #[test]
    fn recursion_in_call_is_reported() {
        let mut rig = Rig::new(preset(
            vec![object("o", None, "x = 0")],
            "event a() { mouse.left.up }\nevent b() { mouse.right.up }\non a {\n  call b()\n}\non b {\n  call a()\n}",
        ))
        .unwrap();
        let frame = tick_with(&mut rig, 0.0, &[]);
        assert!(
            frame
                .diagnostics
                .iter()
                .any(|message| message.contains("рекурсия вызова")),
            "{:?}",
            frame.diagnostics
        );
    }

    #[test]
    fn local_redeclaration_of_global_event_is_reported() {
        let mut rig = Rig::new(preset(
            vec![object(
                "o",
                None,
                "x = 0\nevent clap() { mouse.right.up }",
            )],
            "event clap() { mouse.left.up }",
        ))
        .unwrap();
        let frame = tick_with(&mut rig, 0.0, &[]);
        assert!(
            frame
                .diagnostics
                .iter()
                .any(|message| message.contains("уже объявлено глобально")),
            "{:?}",
            frame.diagnostics
        );
    }

    #[test]
    fn event_variable_cannot_shadow_object_param() {
        let mut rig = Rig::new(preset(
            vec![object(
                "o",
                None,
                "x = 0\nevent boom(x = 1) { mouse.left.up }",
            )],
            "",
        ))
        .unwrap();
        let frame = tick_with(&mut rig, 0.0, &[]);
        assert!(
            frame
                .diagnostics
                .iter()
                .any(|message| message.contains("занята")),
            "{:?}",
            frame.diagnostics
        );
    }

    #[test]
    fn input_direction_fields_are_numbers() {
        let mut rig = Rig::new(preset(
            vec![object("o", None, "rotation = mouse.x.up\ny = mouse.x.down\nlayer = mouse.x.change")],
            "",
        ))
        .unwrap();
        let idle = tick_with(&mut rig, 0.0, &[("mouse.x", 10.0)]);
        // Первого кадра в истории нет: фронта на старте не бывает.
        assert_eq!(idle.objects["o"]["rotation"], 0.0);
        let up = tick_with(&mut rig, 0.033, &[("mouse.x", 20.0)]);
        assert_eq!(up.objects["o"]["layer"], 1.0);
        assert_eq!(up.objects["o"]["rotation"], 1.0);
        assert_eq!(up.objects["o"]["y"], 0.0);
        let down = tick_with(&mut rig, 0.066, &[("mouse.x", 5.0)]);
        assert_eq!(down.objects["o"]["y"], 1.0);
        assert_eq!(down.objects["o"]["rotation"], 0.0);
        let same = tick_with(&mut rig, 0.099, &[("mouse.x", 5.0)]);
        assert_eq!(same.objects["o"]["layer"], 0.0);
    }

    #[test]
    fn activity_fields_count_marks_inside_window() {
        let mut rig = Rig::new(preset(
            vec![object("o", None, "rotation = twitch.chat.count(5)\ny = twitch.reward.sum(5)\nlayer = twitch.reward.avg(5)")],
            "",
        ))
        .unwrap();
        let mut inputs = InputValues::default();
        // Внутри окна 5 с — три метки (веса 10 и 30), снаружи — одна.
        inputs.marks.insert(
            "twitch.chat".into(),
            vec![
                InputMark { age_ms: 100.0, weight: 1.0 },
                InputMark { age_ms: 2000.0, weight: 1.0 },
                InputMark { age_ms: 9000.0, weight: 1.0 },
            ],
        );
        inputs.marks.insert(
            "twitch.reward".into(),
            vec![
                InputMark { age_ms: 500.0, weight: 10.0 },
                InputMark { age_ms: 4000.0, weight: 30.0 },
                InputMark { age_ms: 7000.0, weight: 99.0 },
            ],
        );
        let frame = rig.tick(0.0, inputs, false, false, None);
        assert_eq!(frame.objects["o"]["rotation"], 2.0);
        assert_eq!(frame.objects["o"]["y"], 40.0);
        assert_eq!(frame.objects["o"]["layer"], 20.0);
        assert!(frame.diagnostics.is_empty(), "{:?}", frame.diagnostics);
    }

    #[test]
    fn activity_fields_count_edges_of_any_input() {
        // Клавиатура и мышь отметок не присылают: событие входа — подъём с нуля.
        // `count(5)` у них значит «сколько нажатий за 5 секунд».
        let mut rig = Rig::new(preset(
            vec![object(
                "o",
                None,
                "rotation = key.q.count(5)\ny = key.q.sum(5)\nlayer = key.q.avg(5)",
            )],
            "",
        ))
        .unwrap();
        let idle = tick_with(&mut rig, 0.0, &[("key.q", 0.0)]);
        assert_eq!(idle.objects["o"]["rotation"], 0.0);
        let press = tick_with(&mut rig, 0.1, &[("key.q", 1.0)]);
        assert_eq!(press.objects["o"]["rotation"], 1.0);
        assert_eq!(press.objects["o"]["y"], 1.0);
        assert_eq!(press.objects["o"]["layer"], 1.0);
        // Удержание — не новое событие: отметка одна.
        let held = tick_with(&mut rig, 0.2, &[("key.q", 1.0)]);
        assert_eq!(held.objects["o"]["rotation"], 1.0);
        // Отпустили и нажали снова — второе событие.
        tick_with(&mut rig, 0.3, &[("key.q", 0.0)]);
        let again = tick_with(&mut rig, 0.4, &[("key.q", 1.0)]);
        assert_eq!(again.objects["o"]["rotation"], 2.0);
        assert_eq!(again.objects["o"]["y"], 2.0);
        // Через 6 секунд обе отметки вне окна в 5 секунд.
        let later = tick_with(&mut rig, 6.5, &[("key.q", 1.0)]);
        assert_eq!(later.objects["o"]["rotation"], 0.0);
        assert!(later.diagnostics.is_empty(), "{:?}", later.diagnostics);
    }

    #[test]
    fn provider_marks_win_over_edges() {
        // Награда поднимает вход с нуля, но её вес — стоимость в битах.
        // Подъём значения не должен прибавить к сумме лишнюю единицу.
        let mut rig = Rig::new(preset(
            vec![object("o", None, "x = twitch.reward.sum(5)\ny = twitch.reward.count(5)")],
            "",
        ))
        .unwrap();
        let mut inputs = InputValues::default();
        inputs.values.insert("twitch.reward".into(), 500.0);
        inputs.marks.insert(
            "twitch.reward".into(),
            vec![InputMark { age_ms: 100.0, weight: 500.0 }],
        );
        let frame = rig.tick(0.0, inputs, false, false, None);
        assert_eq!(frame.objects["o"]["x"], 500.0);
        assert_eq!(frame.objects["o"]["y"], 1.0);
    }

    #[test]
    fn stop_clears_edge_marks() {
        let mut rig = Rig::new(preset(
            vec![object("o", None, "x = mouse.left.count(10)")],
            "",
        ))
        .unwrap();
        tick_with(&mut rig, 0.0, &[("mouse.left", 0.0)]);
        let press = tick_with(&mut rig, 0.1, &[("mouse.left", 1.0)]);
        assert_eq!(press.objects["o"]["x"], 1.0);
        // «Стоп» начинает историю заново: старые нажатия не считаются.
        let mut stopped = InputValues::default();
        stopped.values.insert("mouse.left".into(), 1.0);
        rig.tick(0.2, stopped, false, true, None);
        let after = tick_with(&mut rig, 0.3, &[("mouse.left", 1.0)]);
        assert_eq!(after.objects["o"]["x"], 0.0);
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
            .any(|message| message.contains("событие 'kick' не объявлено")));
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
                "x = 0\nevent release() { !mouse.right }\non release {\n  x = x + 10\n}",
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
            "event moved() { mouse.x.change }\non moved {\n  a = a + 1\n}",
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
