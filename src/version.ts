/**
 * Паспорт версии: набор чисел вместо одной строки.
 *
 * Продукт состоит из слоёв, которые ломаются по отдельности: файл пресета может
 * остаться прежним, а ядро — научиться новым формулам. Одна строка `0.1.0` об
 * этом ничего не говорит, поэтому версия — это **набор чисел с подписями**:
 *
 * ```
 * 1.1 . 23 . 6 . 1 . 3 . 1
 * │     │    │   │   │   └─ оболочка: приложение Tauri
 * │     │    │   │   └───── модули: контракт шаблонов из папки modules
 * │     │    │   └───────── мост: протокол редактор ↔ оверлей
 * │     │    └───────────── файл: поколение формата пресета (и папки файлов)
 * │     └────────────────── ядро: поколение DSL и runtime
 * └──────────────────────── релиз: то, что видит пользователь
 * ```
 *
 * Для человека та же версия пишется подписями:
 * `1.1 · ядро 23 · файл 6 · мост 1 · модули 3 · оболочка 3`.
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
    hint: "Скрипт, параметры кадра и поведение формул. Ядро объявляет два числа: своё "
      + "поколение и то, с какого поколения оно ещё понимает сценарии. Сцена просит своё "
      + "(`needs`), поэтому совпадать числа не обязаны — обязана работать совместимость.",
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
 * 2 — пресеты до света и карт нормалей, 3 — вид `light` и поле `normal`,
 * 4 — материал объекта (`material`) и окружение сцены, 5 — материал с `ior` и
 * пресеты материала, 6 — привязки цветов (`object.colors`) и модуль цвета с
 * каналами. Старые номера
 * принимаются при чтении: чего в них не было, получает значения по умолчанию.
 * Новый номер старый редактор не поймёт — он молча потерял бы свет или
 * материал, поэтому формат растёт вместе с такими полями.
 */
export const PRESET_FORMAT = 6;

/** Форматы, которые этот редактор ещё читает. Здесь только старые поколения. */
export const PRESET_FORMATS_READABLE: readonly number[] = [2, 3, 4, 5, PRESET_FORMAT];

/**
 * Поколение контракта шаблонов модулей: `public/modules/*.json`.
 *
 * 1 — первые шаблоны (звук, клавиши, мышь, внешние источники), 2 — виды
 * «Цвет» и «Свет из экрана»: у модуля появились свои списки входов (каналы и
 * точки выборки), а к цвету объекта можно привязать готовый цвет.
 *
 * Растёт вместе с новым видом или новым полем настроек: шаблон новее редактора
 * читается частично, а незнакомый вид молча становится «Manual».
 */
export const MODULE_FORMAT = 3;

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
  release: [1, 1],
  core: 23,
  format: PRESET_FORMAT,
  bridge: 1,
  modules: MODULE_FORMAT,
  shell: 3,
};

/** Номера поколений в порядке слотов: без релиза. */
export function generationNumbers(version: ProjectVersion = VERSION): number[] {
  return SLOT_ORDER.map((slot) => version[slot]);
}

/** Машинная строка версии: `1.1.22.4.1.1.1`. Её пишут в файл и копируют. */
export function versionString(version: ProjectVersion = VERSION): string {
  return [version.release[0], version.release[1], ...generationNumbers(version)].join(".");
}

/** Строка для человека: `1.1 · ядро 23 · файл 6 · мост 1 · модули 3 · оболочка 3`. */
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

/**
 * Слоты, по которым «файл новее сборки» имеет смысл.
 *
 * Только формат: он один описывает, что лежит в файле. Ядро, мост, модули и
 * оболочка в штампе — это личность записавшего, а не требование файла. Ядро
 * сверяется отдельно и честно — по требованию сцены (`needs`), иначе пресет из
 * одних спрайтов ругался бы на каждую пересборку.
 */
const PRESET_SLOTS: readonly VersionSlot[] = ["format"];

/** Слоты, в которых файл новее сборки: их редактор прочитать не обещает. */
export function outdatedSlots(built: unknown): VersionSlot[] {
  const version = parseVersion(built);
  if (!version) return [];
  return PRESET_SLOTS.filter((slot) => version[slot] > VERSION[slot]);
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
    + "Обновите редактор — иначе часть настроек потеряется.";
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

/** Что ядро рассказало о себе запросом `{ "op": "version" }`. */
export interface CoreAnswer {
  /** Поколение ответившего ядра; `null` — ядро не ответило (собрано до запроса версии). */
  core: number | null;
  /**
   * Старейшее поколение сценариев, которые ядро ещё понимает без потерь.
   *
   * Растёт только тогда, когда из языка что-то **убрали**, переименовали или
   * поменяли смысл. Добавили новое — число не двигается, и старые сцены
   * продолжают работать на новом ядре. `null` — ядро не сообщило диапазон
   * (собрано до этого поля); считаем, что понимает всё с первого поколения.
   */
  acceptsFrom: number | null;
}

/**
 * Состояние ядра.
 *
 * `ready` — считать нечего; `older` — ядро не умеет того, что просит сцена;
 * `newer` — ядро новее редактора, но совместимо (молча, это не ошибка);
 * `incompatible` — числа расходятся по существу: что-то удалено.
 */
export type CoreState = "ready" | "older" | "newer" | "incompatible";

/** Вердикт по ядру: плашка в строке состояния и подсказка к ней. */
export interface CoreVerdict {
  state: CoreState;
  /** Короткая плашка (`ядро`); `null` — говорить не о чем. */
  note: string | null;
  /** Что именно случилось и что делать. Показывается в подсказке. */
  detail: string | null;
}

/** Требование сцены: минимум ядра и то, что в языке уже убрано. */
export interface SceneRequirement {
  /** Минимальное поколение ядра, при котором сцена посчитается. */
  needs: number;
  /** Признаки, которых в языке больше нет: имя и поколение удаления. */
  removed?: Array<{ label: string; removed: number }>;
  /** Вызовы, которых нет в таблице признаков: редактор не знает, чьи они. */
  unknown?: string[];
}

/**
 * Совместимость ядра со сценой и с редактором.
 *
 * Совпадать поколения не обязаны, и это главное. Проверяется не равенство
 * чисел, а три вопроса:
 *
 * 1. **Сцена не просит больше, чем ядро умеет** — `needs` против поколения.
 * 2. **В сцене нет того, что из языка убрали** — по списку `removed`; это
 *    точное знание, поэтому проверяется раньше остальных.
 * 3. **Ядро новее редактора, но всё ещё понимает то, что редактор пишет** —
 *    `acceptsFrom` против поколения редактора. Пока это так, тревоги нет:
 *    просто новые возможности ядра не используются.
 *
 * Незнакомые вызовы — отдельный случай: редактор не знает, новая это
 * конструкция или убранная. Если ядро уже отбрасывает старое
 * (`acceptsFrom > 1`), честнее предупредить, чем молчать.
 */
export function coreVerdict(answer: CoreAnswer, scene?: SceneRequirement | null): CoreVerdict {
  const own = VERSION.core;
  const acceptsFrom = answer.acceptsFrom ?? 1;
  const needs = scene?.needs ?? null;
  const removed = scene?.removed ?? [];
  const unknown = scene?.unknown ?? [];
  if (answer.core === null) {
    return {
      state: "older",
      note: "ядро",
      detail: "Ядро не ответило на запрос версии: оно собрано раньше и не знает новых "
        + "формул, поэтому они молча вернут 0. Пересоберите его — `npm run build:wasm`.",
    };
  }
  if (removed.length) {
    const names = removed.map((item) => `${item.label} (убрано в ядре ${item.removed})`).join(", ");
    const oldest = Math.min(...removed.map((item) => item.removed - 1));
    return {
      state: "incompatible",
      note: "ядро",
      detail: `В сцене используется то, чего в языке больше нет: ${names}. `
        + `Ядро ${answer.core} этого не разберёт. Перепишите эти места по-новому `
        + `(вместо \`hold\`/\`relax\` — оператор \`in\`) или соберите ядро `
        + `поколения не новее ${oldest}.`,
    };
  }
  if (needs !== null && needs > answer.core) {
    return {
      state: "older",
      note: "ядро",
      detail: `Сцене нужно ядро ${needs}, а у ядра ${answer.core}. `
        + "Пересоберите его (`npm run build:wasm`), иначе новые формулы вернут 0.",
    };
  }
  if (unknown.length && acceptsFrom > 1) {
    return {
      state: "incompatible",
      note: "ядро",
      detail: `В сцене есть вызовы, которых нет в таблице признаков: `
        + `${unknown.map((name) => `\`${name}()\``).join(", ")}. Ядро ${answer.core} `
        + `понимает сценарии начиная с поколения ${acceptsFrom}, поэтому возможно, что `
        + "часть из них уже убрана. Проверьте скрипт в редакторе.",
    };
  }
  if (answer.core > own && acceptsFrom > own) {
    return {
      state: "incompatible",
      note: "ядро",
      detail: `Ядро ${answer.core} новее редактора и понимает сценарии только с поколения `
        + `${acceptsFrom}, а редактор пишет для ${own}. Обновите редактор — иначе часть `
        + "формул не посчитается.",
    };
  }
  if (answer.core > own) {
    return {
      state: "newer",
      note: null,
      detail: `Ядро ${answer.core} новее редактора (${own}), но совместимо: новые возможности `
        + "просто не используются. Это не ошибка.",
    };
  }
  return { state: "ready", note: null, detail: null };
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
