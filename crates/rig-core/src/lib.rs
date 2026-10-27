mod model;
mod parser;
mod runtime;

/// Поколение ядра — слот «ядро» в паспорте версии (`docs/VERSIONS.md`).
///
/// Считается хронологически: это номер правки контракта ядра, начиная с 1.
/// Контракт — это то, что видит скрипт или файл пресета: функции DSL,
/// параметры кадра, виды объектов, семантика кадра. Правки без изменения
/// контракта (сборка, диагностика, исправления) номер не двигают.
///
/// Полная таблица с коммитами — `docs/VERSIONS.md`, раздел «Хронология ядра».
/// Сверить, что ни одна правка не забыта, помогает `npm run version:report`.
///
/// Растёт, когда прежнее ядро новую формулу уже не поймёт: оно молча вернёт
/// ноль. Редактор спрашивает это число запросом `{ "op": "version" }` и
/// сравнивает со своим — так видно, что сборку пора пересобрать.
pub const CORE_GENERATION: u32 = 21;

#[cfg(target_arch = "wasm32")]
mod ffi;

pub use model::{
    BasePose, BaseUpdate, CanvasConfig, Frame, InputMark, InputMeta, InputText, InputValues,
    RigObject, RigPreset, TextLine, Vec2,
};
pub use runtime::RuntimeStore;
