/**
 * Признаки контракта ядра: что появилось в каком поколении и что нужно сцене.
 *
 * Поколение ядра растёт на каждой правке контракта, но совместимость — не
 * равенство чисел. Правило простое: **сцена просит минимум**, ядро отвечает,
 * что умеет. Сцене из одних спрайтов достаточно ядра 4 — и она спокойно
 * работает на ядре 21, потому что старое поведение никуда не делось.
 *
 * Отсюда поле `needs` в пресете: это не «чем записан файл» (для этого есть
 * `built`), а «какое поколение ядра обязано быть, чтобы всё посчиталось».
 * Считается по содержимому сцены, поэтому правка формулы, не использующей
 * новых возможностей, требования не поднимает.
 *
 * Таблица признаков — единственное место, где записано «признак → поколение».
 * Её сверяет `npm run version:report`: каждое имя должно существовать в
 * `crates/rig-core`, а каждое поколение — в таблице `docs/VERSIONS.md` §4.
 */
import type { ObjectKind, RigPreset } from "../types";
import { VERSION } from "../version";

/** Один признак контракта: как называется, с какого поколения и как узнаётся. */
export interface CoreFeature {
  /** Стабильный ключ для отчёта и тестов. */
  id: string;
  /** Как назвать признак пользователю. */
  label: string;
  /** С какого поколения ядра признак работает. */
  since: number;
  /** Вызовы функций: узнаются по `имя(`. */
  functions?: string[];
  /** Слова: параметры и ключевые слова, узнаются по `слово` без скобок. */
  words?: string[];
  /** Синтаксис, который не сводится к одному слову. */
  syntax?: RegExp[];
  /** Виды объектов, которым признак обязателен. */
  kinds?: ObjectKind[];
  /** Поля объекта: признак нужен, только если поле есть. */
  fields?: ("mask" | "warp" | "material" | "normal")[];
  /**
   * Поколение, в котором признак **убран** из языка.
   *
   * Это вторая половина совместимости: добавили — старые сцены работают,
   * убрали — сцена с этим признаком на новом ядре не разберётся. Такие
   * признаки не поднимают `needs` (сцена просит старый минимум), они дают
   * отдельный вердикт «этого в языке больше нет».
   */
  removed?: number;
}

/**
 * Функции, которые были в ядре с первого поколения.
 *
 * Нужны не для красоты: любой вызов, которого нет ни здесь, ни в таблице
 * признаков, считается **незнакомым**, и сцена получает требование «текущее
 * ядро». Лучше перестраховаться, чем тихо недосчитать и получить нули.
 */
export const BASE_FUNCTIONS: readonly string[] = [
  // Математика.
  "abs", "sign", "min", "max", "limit", "clamp", "round", "floor", "ceil",
  "sqrt", "pow", "exp", "log", "sin", "cos", "tan", "sind", "cosd", "tand",
  "atan2", "mod", "lerp", "smoothstep", "deg", "rad",
  // Векторы.
  "vec", "vadd", "vsub", "vmul", "vscale", "vlen", "vnorm", "vdot", "vangle",
  "rotate", "orbit", "follow", "px", "uv", "pxv", "uvv",
  // Физика и сглаживание.
  "smooth", "spring",
  // Случайность.
  "rnd", "noise", "shake", "random", "autoblink",
];

/**
 * Признаки контракта в порядке появления.
 *
 * Правка ядра, которая добавляет возможность, получает здесь строку с новым
 * поколением. Правка, которая ничего не добавляет (сборка, диагностика,
 * интерфейс), строки не получает — иначе таблица перестанет быть таблицей.
 */
export const CORE_FEATURES: readonly CoreFeature[] = [
  {
    id: "hold",
    label: "`hold` в блоке события",
    since: 3,
    removed: 16,
    words: ["hold"],
  },
  {
    id: "parent-pose",
    label: "чтение позы родителя (`parent.…`)",
    since: 4,
    syntax: [/\bparent\s*\./],
  },
  {
    id: "events",
    label: "блоки `on event.…`",
    since: 5,
    syntax: [/\bon\s+event\./],
  },
  {
    id: "relax",
    label: "`relax`",
    since: 7,
    removed: 16,
    words: ["relax"],
  },
  {
    id: "state",
    label: "`state.…`",
    since: 7,
    words: ["state"],
  },
  {
    id: "on-start",
    label: "`on start`",
    since: 8,
    syntax: [/\bon\s+start\b/],
  },
  {
    id: "trigger",
    label: "`trigger имя = …`",
    since: 8,
    removed: 16,
    words: ["trigger"],
  },
  {
    id: "compare",
    label: "`near`/`between`/`is`",
    since: 9,
    functions: ["near", "between", "is"],
  },
  {
    id: "media-text",
    label: "виды объектов «медиа» и «текст»",
    since: 10,
    kinds: ["media", "text"],
  },
  {
    id: "media-commands",
    label: "команды медиа",
    since: 10,
    functions: ["play", "resume", "pause", "stop", "seek", "rate", "volume"],
  },
  {
    id: "text-command",
    label: "`text(\"…\")`",
    since: 11,
    functions: ["text"],
  },
  {
    id: "strings",
    label: "строки и строковые функции",
    since: 12,
    functions: ["str", "fixed", "upper", "lower", "len"],
    syntax: [/\btext\s*=[^=]/],
  },
  {
    id: "input-fields",
    label: "паспорт и история входа (`.min`, `.message(-1)`)",
    since: 15,
    syntax: [/\.(min|max|step|label|kind)\b/, /\.(message|user)\s*\(\s*-/],
  },
  {
    id: "activity",
    label: "`count`/`sum`/`avg`, `call`, `in`",
    since: 16,
    functions: ["count", "sum", "avg", "call"],
    syntax: [/\.(up|down|change)\b/, /\bin\s*[\[({]/],
  },
  {
    id: "warp",
    label: "деформация (`warp…`)",
    since: 18,
    words: [
      "warpTLx", "warpTLy", "warpTRx", "warpTRy",
      "warpBRx", "warpBRy", "warpBLx", "warpBLy",
    ],
    fields: ["warp"],
  },
  {
    id: "mask",
    label: "маска (`mask`)",
    since: 19,
    words: ["mask"],
    fields: ["mask"],
  },
  {
    id: "shape",
    label: "вид объекта «фигура»",
    since: 20,
    kinds: ["shape"],
  },
  {
    id: "light",
    label: "вид объекта «свет»",
    since: 21,
    kinds: ["light"],
  },
  {
    id: "material",
    label: "материал (`roughness`, `metallic`, `ao`, `emissive`)",
    since: 22,
    words: ["roughness", "metallic", "ao", "emissive"],
    fields: ["material"],
  },
  {
    id: "ior",
    label: "отражение из скрипта (`ior`)",
    since: 23,
    words: ["ior"],
  },
];

/** Что сцена просит у ядра и почему. */
export interface NeedsReport {
  /** Минимальное поколение ядра, при котором сцена посчитается. */
  needs: number;
  /** Признаки, поднявшие требование: по ним и пишется объяснение. */
  reasons: Array<{ label: string; since: number }>;
  /**
   * Признаки, которых в языке уже нет. Встретились — сцена не разберётся на
   * текущем ядре независимо от того, какое у него поколение.
   */
  removed: Array<{ label: string; removed: number }>;
  /** Вызовы, которых нет в таблице: тогда требование — текущее ядро целиком. */
  unknown: string[];
}

/**
 * Разбор скрипта: код без комментариев и содержимого строк.
 *
 * Нужен, чтобы признак не находился в тексте, который ядро не считает:
 * сообщение `text = "count(…)"` новой функции не требует. Кавычки остаются на
 * месте — присваивание `text = "…"` видно как синтаксис, а слово внутри — нет.
 */
function scanScript(text: string): { code: string; calls: string[] } {
  const calls: string[] = [];
  let code = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1] ?? "";
    if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") {
        code += " ";
        index += 1;
      }
      continue;
    }
    if (char === "/" && next === "*") {
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) {
        code += text[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      for (let skip = 0; skip < 2 && index < text.length; skip += 1, index += 1) code += " ";
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      code += quote;
      index += 1;
      while (index < text.length && text[index] !== quote) {
        if (text[index] === "\\") {
          code += "  ";
          index += 2;
          continue;
        }
        code += text[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      if (index < text.length) {
        code += quote;
        index += 1;
      }
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let name = "";
      let cursor = index;
      while (cursor < text.length && /[A-Za-z0-9_]/.test(text[cursor])) {
        name += text[cursor];
        cursor += 1;
      }
      let after = cursor;
      while (after < text.length && (text[after] === " " || text[after] === "\t")) after += 1;
      if (text[after] === "(") calls.push(name);
      code += name;
      index = cursor;
      continue;
    }
    code += char;
    index += 1;
  }
  return { code, calls };
}

/** Имена, которые сцена может вызывать, не поднимая требование выше первого поколения. */
export function knownNames(): Set<string> {
  const names = new Set<string>(BASE_FUNCTIONS);
  for (const feature of CORE_FEATURES) {
    for (const name of feature.functions ?? []) names.add(name);
    for (const name of feature.words ?? []) names.add(name);
  }
  return names;
}

/**
 * Требование сцены к ядру с объяснением.
 *
 * Строки, комментарии и незнакомые имена учитываются осторожно: непонятный
 * вызов поднимает требование до текущего ядра, а не притворяется старым.
 */
export function needsReport(preset: RigPreset): NeedsReport {
  const parts: string[] = [preset.globals ?? ""];
  for (const object of preset.objects) parts.push(object.script ?? "");
  const { code, calls } = scanScript(parts.join("\n"));

  const reasons: Array<{ label: string; since: number }> = [];
  const removed: Array<{ label: string; removed: number }> = [];
  const hit = (feature: CoreFeature) => {
    const byKind = feature.kinds?.some((kind) => preset.objects.some((object) => object.kind === kind));
    const byField = feature.fields?.some((field) => preset.objects.some((object) => Boolean(object[field])));
    const byFunction = feature.functions?.some((name) => calls.includes(name));
    const byWord = feature.words?.some((name) => new RegExp(`\\b${name}\\b`).test(code));
    const bySyntax = feature.syntax?.some((pattern) => pattern.test(code));
    return Boolean(byKind || byField || byFunction || byWord || bySyntax);
  };
  for (const feature of CORE_FEATURES) {
    if (!hit(feature)) continue;
    if (feature.removed) {
      if (!removed.some((item) => item.label === feature.label)) {
        removed.push({ label: feature.label, removed: feature.removed });
      }
      continue;
    }
    if (!reasons.some((reason) => reason.label === feature.label)) {
      reasons.push({ label: feature.label, since: feature.since });
    }
  }

  const known = knownNames();
  const unknown = [...new Set(calls.filter((name) => !known.has(name)))].sort();

  const detected = reasons.reduce((max, reason) => Math.max(max, reason.since), 1);
  const needs = unknown.length ? Math.max(detected, VERSION.core) : detected;
  return { needs, reasons, removed, unknown };
}

/** Минимальное поколение ядра для сцены: короткая форма для сохранения файла. */
export function needsCore(preset: RigPreset): number {
  return needsReport(preset).needs;
}

/**
 * Почему сцене нужно именно это поколение — одной строкой для подсказки.
 *
 * Число без причины читается как требование к человеку: «нужно 20» — и что
 * теперь делать? На деле это «сцене достаточно 20», а поднять его могла одна
 * фигура в углу. Поэтому рядом с числом показываются признаки, давшие
 * максимум: именно они объясняют, что сцену держит на этом поколении.
 */
export function needsReason(report: NeedsReport): string {
  if (report.unknown.length) {
    return `незнакомые вызовы: ${report.unknown.map((name) => `${name}()`).join(", ")}`;
  }
  if (!report.reasons.length) return "только базовые формулы";
  const top = Math.max(...report.reasons.map((reason) => reason.since));
  const labels = report.reasons.filter((reason) => reason.since === top).map((reason) => reason.label);
  return labels.join(", ");
}
