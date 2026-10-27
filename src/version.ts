/**
 * Паспорт версии: набор чисел вместо одной строки.
 *
 * Продукт состоит из слоёв, которые ломаются по отдельности: файл пресета может
 * остаться прежним, а ядро — научиться новым формулам. Одна строка `0.1.0` об
 * этом ничего не говорит, поэтому версия — это **набор чисел с подписями**:
 *
 * ```
 * 1.0 . 21 . 3 . 1 . 1 . 1
 * │     │    │   │   │   └─ оболочка: приложение Tauri
 * │     │    │   │   └───── модули: контракт шаблонов из папки modules
 * │     │    │   └───────── мост: протокол редактор ↔ оверлей
 * │     │    └───────────── файл: поколение формата пресета (и папки файлов)
 * │     └────────────────── ядро: поколение DSL и runtime
 * └──────────────────────── релиз: то, что видит пользователь
 * ```
 *
 * Для человека та же версия пишется подписями:
 * `1.0 · ядро 21 · файл 3 · мост 1 · модули 1 · оболочка 1`.
 *
 * Правила, когда какое число растёт, и таблица поколений ядра — в
 * `docs/VERSIONS.md`. Здесь только данные и сверка: одна правда о номерах.
 */

/** Слоты поколений: по ним проверяется совместимость файла и сборки. */
export const SLOT_ORDER = ["core", "format", "bridge", "modules", "shell"] as const;
export type VersionSlot = (typeof SLOT_ORDER)[number];

export interface SlotInfo {
  /** Как слот называется для пользователя. */
  label: string;
  /** Что именно сломается, если слот отстаёт. Это текст подсказок. */
  hint: string;
}

export const SLOT_INFO: Record<VersionSlot, SlotInfo> = {
  core: {
    label: "ядро",
    hint: "Скрипт, параметры кадра и поведение формул. Старое ядро не понимает новую "
      + "формулу и молча вернёт 0: нужна пересборка `rig_core.wasm`.",
  },
  format: {
    label: "файл",
    hint: "Формат пресета и папки файлов рядом с ним. Новые виды объектов и поля старый "
      + "редактор не прочитает и потеряет при сохранении.",
  },
  bridge: {
    label: "мост",
    hint: "Протокол редактор ↔ оверлей. Оверлей другой сборки перестаёт получать кадры: "
      + "в OBS картинка замирает.",
  },
  modules: {
    label: "модули",
    hint: "Контракт шаблонов из папки `modules`: виды модулей, поля настроек, входы. "
      + "Шаблон новее редактора читается частично — незнакомый вид модуля станет «Manual».",
  },
  shell: {
    label: "оболочка",
    hint: "Приложение Tauri: окна, клавиши, планировщик кадров, файловые команды. "
      + "Сборка старше пресета просто не умеет часть того, что он ждёт.",
  },
};

/**
 * Поколение формата пресета.
 *
 * 2 — пресеты до света и карт нормалей, 3 — текущие (вид `light`, поле
 * `normal`). Старые номера принимаются при чтении: чего в них не было, получает
 * значения по умолчанию. Новый номер старый редактор не поймёт — он молча
 * потерял бы свет, поэтому формат растёт вместе с такими видами.
 */
export const PRESET_FORMAT = 3;

/** Форматы, которые этот редактор ещё читает. Здесь только старые поколения. */
export const PRESET_FORMATS_READABLE: readonly number[] = [2, PRESET_FORMAT];

/** Поколение контракта шаблонов модулей: `public/modules/*.json`. */
export const MODULE_FORMAT = 1;

export interface ProjectVersion {
  /** Релиз продукта: то, что видит пользователь и установщик. */
  release: [number, number];
  /** Поколение ядра: DSL, параметры, семантика кадра. */
  core: number;
  /** Поколение формата пресета и папки файлов. */
  format: number;
  /** Поколение протокола редактор ↔ оверлей. */
  bridge: number;
  /** Поколение контракта шаблонов модулей. */
  modules: number;
  /** Поколение оболочки приложения. */
  shell: number;
}

/**
 * Текущая сборка.
 *
 * **Ядро** растёт на каждой правке контракта `rig-core` — это
 * `CORE_GENERATION` в `crates/rig-core/src/lib.rs`, а полная хронология правок
 * с коммитами лежит таблицей в `docs/VERSIONS.md`. Рост числа здесь значит
 * «ядро стало понимать больше, старое WASM это уже не посчитает».
 *
 * **Файл** и **мост** сверяются с данными: поколением в пресете и `protocol`
 * в `hello`. **Модули** — с полем `format` в шаблонах. **Оболочка** только
 * объявляется: приложение не может быть старше самого себя.
 */
export const VERSION: ProjectVersion = {
  release: [1, 0],
  core: 21,
  format: PRESET_FORMAT,
  bridge: 1,
  modules: MODULE_FORMAT,
  shell: 1,
};

/** Номера поколений в порядке слотов: без релиза. */
export function generationNumbers(version: ProjectVersion = VERSION): number[] {
  return SLOT_ORDER.map((slot) => version[slot]);
}

/** Машинная строка версии: `1.0.21.3.1.1.1`. Её пишут в файл и копируют. */
export function versionString(version: ProjectVersion = VERSION): string {
  return [version.release[0], version.release[1], ...generationNumbers(version)].join(".");
}

/** Строка для человека: `1.0 · ядро 21 · файл 3 · мост 1 · модули 1 · оболочка 1`. */
export function versionLabel(version: ProjectVersion = VERSION): string {
  const slots = SLOT_ORDER.map((slot) => `${SLOT_INFO[slot].label} ${version[slot]}`);
  return [`${version.release[0]}.${version.release[1]}`, ...slots].join(" · ");
}

/** Короткая версия для строки состояния: `1.0`. */
export function versionShort(version: ProjectVersion = VERSION): string {
  return `${version.release[0]}.${version.release[1]}`;
}

/** Разбор машинной строки; мусор и неполный набор дают `null`. */
export function parseVersion(text: unknown): ProjectVersion | null {
  if (typeof text !== "string") return null;
  const clean = text.trim().replace(/^версия\s*/i, "").replace(/^v/i, "");
  const pattern = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})\.(\d{1,6})\.(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;
  const match = pattern.exec(clean);
  if (!match) return null;
  const [major, minor, core, format, bridge, modules, shell] = match.slice(1).map(Number);
  return { release: [major, minor], core, format, bridge, modules, shell };
}

/** Слоты, в которых файл новее сборки: их редактор прочитать не обещает. */
export function outdatedSlots(built: unknown): VersionSlot[] {
  const version = parseVersion(built);
  if (!version) return [];
  return SLOT_ORDER.filter((slot) => version[slot] > VERSION[slot]);
}

/**
 * Готова ли сборка открыть файл: `null` — да (или версия файла неизвестна),
 * иначе — фраза, которую можно показать пользователю.
 */
export function outdatedMessage(built: unknown): string | null {
  const slots = outdatedSlots(built);
  if (!slots.length) return null;
  const version = parseVersion(built)!;
  const names = slots.map((slot) => `${SLOT_INFO[slot].label} ${version[slot]}`).join(", ");
  return `Пресет сохранён более новой сборкой (${names} против ${versionLabel()}). `
    + "Обновите редактор или пересоберите ядро — иначе часть настроек потеряется.";
}

/**
 * Версия для установщика: `1.0.0`.
 *
 * MSI и NSIS принимают только три числа, поэтому поколения в упаковку не
 * попадают: там живёт релиз, а полный набор виден в интерфейсе и в пресете.
 */
export function packagingVersion(version: ProjectVersion = VERSION): string {
  return `${version.release[0]}.${version.release[1]}.0`;
}

/** Подсказка к версии в строке состояния: что означает каждый слот. */
export function versionTitle(version: ProjectVersion = VERSION): string {
  return [
    `Версия ${versionLabel(version)}`,
    `машинная запись: ${versionString(version)}`,
    ...SLOT_ORDER.map((slot) => `${SLOT_INFO[slot].label} — ${SLOT_INFO[slot].hint}`),
    "подробности — docs/VERSIONS.md",
  ].join("\n");
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

/** Фраза про ядро для строки состояния; `null` — всё в порядке. */
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

/**
 * Шаблоны модулей новее редактора.
 *
 * Незнакомый вид модуля тихо становится «Manual», а незнакомые поля настроек
 * не показываются — то есть модуль «работает», но не так, как задумано. Это
 * тот же класс ошибок, что старое ядро: молчание вместо сообщения.
 */
export function modulesMessage(definitions: Array<{ title: string; format: number; unknownKind?: boolean }>): string | null {
  const outdated = definitions.filter((definition) => definition.format > MODULE_FORMAT || definition.unknownKind);
  if (!outdated.length) return null;
  const names = outdated.map((definition) => definition.title).join(", ");
  return `Шаблоны модулей новее редактора: ${names}. Незнакомый вид модуля станет «Manual», `
    + "а его поля настроек не покажутся — обновите редактор";
}

/** Пресет получает штамп сборки при сохранении — по нему видно, чем он записан. */
export function withBuildStamp<T extends { built?: string }>(preset: T): T {
  return { ...preset, built: versionString() };
}
