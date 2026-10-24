use crate::model::{BaseUpdate, Frame, InputValues, NodeKey, ObjectKind, Param, RigPreset, Vec2};
use crate::parser::{parse_script, BinaryOp, Expr, UnaryOp};
use serde::Deserialize;
use serde_json::{json, Value as JsonValue};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::f64::consts::{E, PI};
use std::sync::Arc;

#[derive(Debug, Clone)]
enum Value {
    Number(f64),
    Vector(Vec2),
    Object(String),
    Signals,
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
        for (name, expr) in
            parse_script(&preset.globals).map_err(|e| format!("глобальные: {}", e))?
        {
            let key = NodeKey::Global(name.clone());
            global_names.push(name);
            expressions.insert(key, expr);
        }
        global_names.sort();

        for object in &preset.objects {
            for (name, expr) in
                parse_script(&object.script).map_err(|e| format!("{}: {}", object.id, e))?
            {
                let param = Param::parse(&name).ok_or_else(|| {
                    format!(
                        "{}: нельзя присвоить неизвестный параметр '{}'",
                        object.id, name
                    )
                })?;
                expressions.insert(NodeKey::Param(object.id.clone(), param), expr);
            }
        }

        let mut previous = Frame::default();
        for object in &preset.objects {
            let mut values = BTreeMap::new();
            for param in Param::ALL {
                let value = match param {
                    Param::SizeX | Param::SizeY | Param::Opacity => 1.0,
                    Param::Visible => object.base.visible,
                    Param::Layer => object.base.layer,
                    _ => 0.0,
                };
                values.insert(param.as_str().to_string(), value);
            }
            previous.objects.insert(object.id.clone(), values);
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
        if reset_clock {
            self.last_now = Some(self.now);
        }
        if paused && step_dt.is_none() {
            self.last_now = Some(self.now);
            let mut frame = self.previous.clone();
            frame.dt = 0.0;
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

        let mut frame = Frame {
            seq: self.seq,
            time: self.time,
            dt: self.dt,
            globals: BTreeMap::new(),
            objects: BTreeMap::new(),
            order: Vec::new(),
            diagnostics: self.diagnostics.iter().cloned().collect(),
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
            .filter(|(_, object)| object.kind == ObjectKind::Sprite)
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
                let a = self.numeric(left, context);
                let b = self.numeric(right, context);
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
                    // Состояние событий и снимки прошлого кадра (state.*, event.*)
                    // приходят из редактора; до первого кадра их может не быть.
                    if matches!(base.as_str(), "state" | "event") {
                        return Value::Number(0.0);
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
            if let Some(own) = Param::parse(name) {
                return Value::Number(self.eval_node(&NodeKey::Param(id.clone(), own)));
            }
        }
        let global_key = NodeKey::Global(name.to_string());
        if self.expressions.contains_key(&global_key) {
            return Value::Number(self.eval_node(&global_key));
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
        match self.eval_expr(expr, context) {
            Value::Number(value) => value,
            _ => {
                self.diagnostics
                    .insert("ожидалось число, получен вектор или объект; использован 0".into());
                0.0
            }
        }
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
        let expected = match name {
            "abs" | "sign" | "round" | "floor" | "ceil" | "sqrt" | "exp" | "log" | "sin"
            | "cos" | "tan" | "sind" | "cosd" | "tand" | "deg" | "rad" => 1,
            "pow" | "atan2" | "mod" | "px" | "uv" => 2,
            "limit" | "lerp" | "smoothstep" => 3,
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
            "smoothstep" => {
                let t = ((v[2] - v[0]) / (v[1] - v[0])).clamp(0.0, 1.0);
                t * t * (3.0 - 2.0 * t)
            }
            _ => 0.0,
        };
        Value::Number(result)
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
        }
    }

    fn tick(rig: &mut Rig, time: f64) -> Frame {
        rig.tick(time, InputValues::default(), false, false, None)
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

    #[test]
    fn invalid_json_does_not_panic() {
        let mut store = RuntimeStore::default();
        let result = store.call_json("not json");
        assert!(result.contains("\"ok\":false"));
    }
}
