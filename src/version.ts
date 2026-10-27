/**
 * Версии проекта: набор чисел вместо одной строки.
 *
 * Продукт состоит из слоёв, которые ломаются по отдельности: файл пресета может
 * остаться прежним, а ядро — научиться новым формулам. Одна строка вида `0.1.0`
 * об этом ничего не говорит, поэтому версия — кортеж из шести чисел:
 *
 * ```
 * 0.1 . 2 . 3 . 1 . 1
 * │    │   │   │   └─ оболочка: приложение Tauri (окна, клавиши, планировщик)
 * │    │   │   └───── мост: протокол редактор ↔ оверлей (OVERLAY_PROTOCOL)
 * │    │   └───────── формат: поколение пресета (PresetFormat, поле version)
 * │    └───────────── ядро: поколение DSL и runtime (rig-core, CORE_GENERATION)
 * └────────────────── релиз: то, что видит пользователь (0.1, 0.2, 1.0)
 * ```
 *
 * Правила, зачем слоты и что делать при расхождении — в `docs/VERSIONS.md`.
 * Здесь только данные и сравнение: одна правда о номерах на весь фронтенд.
 */

/** Слоты поколений: по ним проверяется совместимость файла и сборки. */
export const VERSION_SLOTS = ["core", "format", "bridge", "shell"] as const;
export type VersionSlot = (typeof VERSION_SLOTS)[number];

/**
 * Формат пресета: поколение самой структуры файла.
 *
 * 2 — пресеты до света и карт нормалей, 3 — текущие (вид объекта `light`,
 * поле `normal`). Старый номер принимается при чтении: всё, чего в нём не было,
 * получает значения по умолчанию. Новый номер старый редактор не поймёт — он
 * молча потеряет свет, поэтому формат и растёт вместе с такими видами.
 */
export const PRESET_FORMAT = 3;

/** Форматы, которые этот редактор ещё читает. Здесь только старые поколения. */
export const PRESET_FORMATS_READABLE: readonly number[] = [2, PRESET_FORMAT];

export interface ProjectVersion {
  /** Релиз продукта: два числа, как их видит пользователь. */
  release: [number, number];
  /** Поколение ядра: DSL, параметры, семантика кадра. */
  core: number;
  /** Поколение формата пресета. */
  format: number;
  /** Поколение протокола редактор ↔ оверлей. */
  bridge: number;
  /** Поколение оболочки приложения. */
  shell: number;
}

/**
 * Текущая сборка.
 *
 * **Ядро** и **формат** растут только вместе с правкой `rig-core` и структуры
 * файла. Если поменяли Rust, но забыли поднять `core`, редактор не заметит
 * старое WASM и скрипт тихо посчитает не то — поэтому номер ядра стоит здесь,
 * а такое же число лежит в `crates/rig-core/src/lib.rs`.
 */
export const VERSION: ProjectVersion = {
  release: [0, 1],
  core: 2,
  format: PRESET_FORMAT,
  bridge: 1,
  shell: 1,
};

export const SLOT_LABEL: Record<VersionSlot, string> = {
  core: "ядро",
  format: "формат",
  bridge: "мост",
  shell: "оболочка",
};

/** Что именно ломается, когда слот отстаёт: это текст для подсказок. */
export const SLOT_HINT: Record<VersionSlot, string> = {
  core: "Новые формулы и параметры ядро не поймёт: вернёт 0 с диагностикой. Нужна пересборка `rig_core.wasm`.",
  format: "Новые виды объектов и поля редактор не прочитает и потеряет их при сохранении.",
  bridge: "Оверлей и редактор не поймут друг друга: кадры перестанут доходить или перестанут обновляться.",
  shell: "Возможности приложения (окна, клавиши, планировщик) старше файла: нужна свежая сборка.",
};

/** Строка версии: `0.1.2.3.1.1`. */
export function versionString(version: ProjectVersion = VERSION): string {
  return [
    version.release[0], version.release[1],
    version.core, version.format, version.bridge, version.shell,
  ].join(".");
}

/** Разбор строки версии; мусор и неполный набор дают `null`. */
export function parseVersion(text: unknown): ProjectVersion | null {
  if (typeof text !== "string") return null;
  const clean = text.trim().replace(/^версия\s*/i, "").replace(/^v/i, "");
  const match = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})\.(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(clean);
  if (!match) return null;
  const [major, minor, core, format, bridge, shell] = match.slice(1).map(Number);
  return { release: [major, minor], core, format, bridge, shell };
}

/** Слоты, в которых файл новее сборки: их редактор прочитать не обещает. */
export function outdatedSlots(built: unknown): VersionSlot[] {
  const version = parseVersion(built);
  if (!version) return [];
  return VERSION_SLOTS.filter((slot) => version[slot] > VERSION[slot]);
}

/**
 * Готова ли сборка открыть файл: `null` — да (или версия файла неизвестна),
 * иначе — фраза, которую можно показать пользователю.
 */
export function outdatedMessage(built: unknown): string | null {
  const slots = outdatedSlots(built);
  if (!slots.length) return null;
  const names = slots.map((slot) => `${SLOT_LABEL[slot]} ${parseVersion(built)![slot]}`).join(", ");
  return `Пресет сохранён более новой сборкой (${names} против ${versionString()}). `
    + `Обновите редактор или пересоберите ядро — иначе часть настроек потеряется.`;
}

/**
 * Версия для установщика: `0.1.0`.
 *
 * MSI и NSIS принимают только три числа, поэтому поколения в упаковку не
 * попадают: там живёт релиз, а полный кортеж виден в интерфейсе и в пресете.
 */
export function packagingVersion(version: ProjectVersion = VERSION): string {
  return `${version.release[0]}.${version.release[1]}.0`;
}

/** Подсказка к числу в статусной строке: что означает каждый слот. */
export function versionTitle(version: ProjectVersion = VERSION): string {
  return [
    `Версия ${versionString(version)}`,
    `релиз ${version.release[0]}.${version.release[1]}`,
    ...VERSION_SLOTS.map((slot) => `${SLOT_LABEL[slot]} ${version[slot]}`),
    "подробности — docs/VERSIONS.md",
  ].join(" · ");
}

/** Состояние ядра: своё, старое (нет `version`) или новее редактора. */
export type CoreState = "ready" | "older" | "newer";

/**
 * Сверка поколения ядра с тем, что ожидает редактор.
 *
 * `null` — ядро не ответило: значит, оно собрано до появления запроса версии,
 * то есть заведомо старше. Это не ошибка загрузки (сцена рисуется), но повод
 * сказать «пересоберите ядро»: иначе новые формулы посчитаются нулём.
 */
export function coreState(core: number | null): CoreState {
  if (core === null) return "older";
  return core < VERSION.core ? "older" : core > VERSION.core ? "newer" : "ready";
}

/** Фраза про ядро для статусной строки; `null` — всё в порядке. */
export function coreMessage(core: number | null): string | null {
  const state = coreState(core);
  if (state === "ready") return null;
  if (state === "newer") {
    return `Ядро новее редактора (${core} против ${VERSION.core}): пересоберите редактор, `
      + "иначе часть возможностей ядра просто не используется";
  }
  return `Ядро старше редактора${core === null ? "" : ` (${core} против ${VERSION.core})`}: `
    + "пересоберите его (`npm run build:wasm`), иначе новые формулы вернут 0";
}

/** Пресет получает штамп сборки при сохранении — по нему видно, чем он записан. */
export function withBuildStamp<T extends { built?: string }>(preset: T): T {
  return { ...preset, built: versionString() };
}
