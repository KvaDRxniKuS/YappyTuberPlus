use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct Vec2 {
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CanvasConfig {
    #[serde(default = "default_canvas_width")]
    pub width: f64,
    #[serde(default = "default_canvas_height")]
    pub height: f64,
}

fn default_canvas_width() -> f64 {
    1000.0
}
fn default_canvas_height() -> f64 {
    600.0
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BasePose {
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    #[serde(default)]
    pub rotation: f64,
    #[serde(default = "one")]
    pub size_x: f64,
    #[serde(default = "one")]
    pub size_y: f64,
    #[serde(default)]
    pub skew_x: f64,
    #[serde(default)]
    pub skew_y: f64,
    #[serde(default = "one")]
    pub opacity: f64,
    #[serde(default = "one")]
    pub visible: f64,
    #[serde(default)]
    pub layer: f64,
}

fn one() -> f64 {
    1.0
}

impl Default for BasePose {
    fn default() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            rotation: 0.0,
            size_x: 1.0,
            size_y: 1.0,
            skew_x: 0.0,
            skew_y: 0.0,
            opacity: 1.0,
            visible: 1.0,
            layer: 0.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ObjectKind {
    #[default]
    Sprite,
    Group,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RigObject {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub kind: ObjectKind,
    #[serde(default)]
    pub image: Option<String>,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub pivot: Vec2,
    #[serde(default)]
    pub base: BasePose,
    #[serde(default)]
    pub script: String,
    #[serde(default)]
    pub width: f64,
    #[serde(default)]
    pub height: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RigPreset {
    #[serde(default)]
    pub canvas: CanvasConfig,
    #[serde(default)]
    pub objects: Vec<RigObject>,
    #[serde(default)]
    pub globals: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Param {
    X,
    Y,
    Rotation,
    SizeX,
    SizeY,
    SkewX,
    SkewY,
    Opacity,
    Visible,
    Layer,
}

impl Param {
    pub const ALL: [Param; 10] = [
        Param::X,
        Param::Y,
        Param::Rotation,
        Param::SizeX,
        Param::SizeY,
        Param::SkewX,
        Param::SkewY,
        Param::Opacity,
        Param::Visible,
        Param::Layer,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Param::X => "x",
            Param::Y => "y",
            Param::Rotation => "rotation",
            Param::SizeX => "sizeX",
            Param::SizeY => "sizeY",
            Param::SkewX => "skewX",
            Param::SkewY => "skewY",
            Param::Opacity => "opacity",
            Param::Visible => "visible",
            Param::Layer => "layer",
        }
    }

    /// Имена параметров в скрипте. Канонические — как в `as_str`; короткие и
    /// «с подчёркиванием» оставлены синонимами, чтобы формулы читались удобнее.
    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "x" => Param::X,
            "y" => Param::Y,
            "rotation" | "rot" => Param::Rotation,
            "sizeX" | "size_x" => Param::SizeX,
            "sizeY" | "size_y" => Param::SizeY,
            "skewX" | "skew_x" => Param::SkewX,
            "skewY" | "skew_y" => Param::SkewY,
            "opacity" => Param::Opacity,
            "visible" => Param::Visible,
            "layer" => Param::Layer,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum NodeKey {
    Global(String),
    Param(String, Param),
}

/// Значения входов, приходящие от модулей редактора.
///
/// Ядро не знает имён входов заранее: набор задаётся модулями, поэтому ключи —
/// произвольные строки вида `<модуль>.<вход>`, например `mic.talking` или
/// `viseme_left.a`. Отдельный канал `signals` (`signal.<имя>`) остаётся для
/// плагинов и ручных сигналов.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct InputValues {
    #[serde(default)]
    pub signals: HashMap<String, f64>,
    /// Ключи вида `<модуль>.<вход>`; набор задаёт редактор.
    #[serde(default)]
    pub values: BTreeMap<String, f64>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Frame {
    pub seq: u64,
    pub time: f64,
    pub dt: f64,
    pub globals: BTreeMap<String, f64>,
    pub objects: BTreeMap<String, BTreeMap<String, f64>>,
    pub order: Vec<String>,
    pub diagnostics: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseUpdate {
    pub id: String,
    pub base: BasePose,
}
