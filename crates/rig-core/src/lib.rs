mod model;
mod parser;
mod runtime;

/// Поколение ядра — слот «ядро» в версии проекта (`docs/VERSIONS.md`).
///
/// Растёт, когда в DSL, параметрах или семантике кадра появляется то, чего
/// прежнее ядро не понимает: старое WASM тогда молча считает новое нулём.
/// Редактор спрашивает это число запросом `{ "op": "version" }` и сравнивает
/// со своим — так видно, что сборку пора пересобрать.
pub const CORE_GENERATION: u32 = 2;

#[cfg(target_arch = "wasm32")]
mod ffi;

pub use model::{
    BasePose, BaseUpdate, CanvasConfig, Frame, InputMark, InputMeta, InputText, InputValues,
    RigObject, RigPreset, TextLine, Vec2,
};
pub use runtime::RuntimeStore;
