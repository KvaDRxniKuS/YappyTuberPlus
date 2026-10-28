import type { ModuleInstance } from "../types";
import type { ModuleInputSpec } from "./registry";
import type { Rgba } from "../render/color";
import type { SampleArea } from "../render/sceneSample";

/**
 * Модуль «Свет из экрана» (ambient).
 *
 * Берёт средний цвет участков картинки и отдаёт его числами — как канал цвета,
 * только палитру никто не выбирает: цвет приходит из кадра.
 *
 * Источников два, и оба нужны:
 *
 * - **своя сцена** — бесплатно, работает везде, годится для «свет подстраивается
 *   под то, что мы сами нарисовали»;
 * - **источник OBS** — единственный способ увидеть чужое окно или игру: браузер
 *   не имеет права читать чужие окна, а OBS имеет.
 *
 * Точка выборки живёт в долях кадра, поэтому переживает смену размера сцены.
 * `follow` — про OBS: точка привязана к источнику и едет вместе с ним по сцене.
 */

export type AmbientSourceKind = "scene" | "obs";

export interface AmbientSource {
  kind: AmbientSourceKind;
  /** Сцена OBS: имя как в OBS, с пробелами и кириллицей. */
  scene: string;
  /** Источник (сцена или элемент сцены) — тоже имя из OBS. */
  item: string;
}

export interface AmbientPoint {
  /** Имя для скрипта: входы — `<имя>_r`, `<имя>_g`, `<имя>_b`, `<имя>_a`, `<имя>_level`. */
  name: string;
  /** Подпись в панели и в списках привязки цвета. */
  label: string;
  source: AmbientSource;
  /** Где брать пиксели: центр и сторона квадрата в долях кадра. */
  area: SampleArea;
  /** Сколько пикселей уменьшенной копии добавить по краям: «сила размытия». */
  blur: number;
  /** Точка едет за источником OBS. Для своей сцены не значит ничего. */
  follow: boolean;
  /** 0…100 %: инерция между замерами, чтобы цвет не дёргался. */
  smooth: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const number = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

/** Стартовая точка нового модуля: одна, в центре, из своей сцены. */
export const AMBIENT_POINT_BASE: AmbientPoint = {
  name: "spot_1",
  label: "Точка 1",
  source: { kind: "scene", scene: "", item: "" },
  area: { x: 0.5, y: 0.5, size: 0.2 },
  blur: 8,
  follow: true,
  smooth: 30,
};

/** Замеров в секунду по умолчанию: 10 хватает, чтобы цвет не «шагал». */
export const AMBIENT_RATE_DEFAULT = 10;
export const AMBIENT_RATE_MIN = 1;
export const AMBIENT_RATE_MAX = 30;

/** Имя точки — латиница, цифры и `_`: оно попадает в скрипт. */
export function pointNameAllowed(raw: string): boolean {
  return /^[a-z0-9_]*$/.test(raw);
}

export function sanitizePointName(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24);
  if (!cleaned) return "spot";
  return /^[a-z_]/.test(cleaned) ? cleaned : `s_${cleaned}`;
}

export function uniquePointName(points: AmbientPoint[], base: string): string {
  const clean = sanitizePointName(base);
  if (!points.some((point) => point.name === clean)) return clean;
  let index = 2;
  while (points.some((point) => point.name === `${clean}_${index}`)) index += 1;
  return `${clean}_${index}`;
}

function normalizePoint(raw: unknown, fallbackName: string): AmbientPoint | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Partial<AmbientPoint> & { source?: Partial<AmbientSource>; area?: Partial<SampleArea> };
  const name = typeof source.name === "string" && source.name ? sanitizePointName(source.name) : fallbackName;
  const kind: AmbientSourceKind = source.source?.kind === "obs" ? "obs" : "scene";
  return {
    name,
    label: typeof source.label === "string" && source.label.trim() ? source.label.trim() : name,
    source: {
      kind,
      scene: typeof source.source?.scene === "string" ? source.source.scene : "",
      item: typeof source.source?.item === "string" ? source.source.item : "",
    },
    area: {
      x: clamp(number(source.area?.x, 0.5), 0, 1),
      y: clamp(number(source.area?.y, 0.5), 0, 1),
      size: clamp(number(source.area?.size, 0.2), 0.005, 1),
    },
    blur: clamp(number(source.blur, 8), 0, 64),
    follow: source.follow !== false,
    smooth: clamp(number(source.smooth, 30), 0, 100),
  };
}

/** Точки экземпляра. Битые записи отбрасываются, имена не повторяются. */
export function ambientPoints(module: ModuleInstance): AmbientPoint[] {
  const raw = module.config.points;
  const list: AmbientPoint[] = [];
  if (Array.isArray(raw)) {
    raw.forEach((item, index) => {
      const point = normalizePoint(item, `spot_${index + 1}`);
      if (!point) return;
      point.name = uniquePointName(list, point.name);
      list.push(point);
    });
  }
  if (!list.length) list.push(normalizePoint(AMBIENT_POINT_BASE, "spot_1")!);
  return list;
}

/** Замеров в секунду для экземпляра. */
export function ambientRate(module: ModuleInstance): number {
  return clamp(number(module.config.rate, AMBIENT_RATE_DEFAULT), AMBIENT_RATE_MIN, AMBIENT_RATE_MAX);
}

/**
 * Настройки соединения с OBS: только хост и порт.
 *
 * Пароля здесь нет и не будет: он лежит в настройках приложения, чтобы пресет
 * можно было выкладывать. В пресете — имя соединения, а не секрет.
 */
export function ambientConnection(module: ModuleInstance): { host: string; port: number } {
  const raw = module.config.connection as unknown as { host?: unknown; port?: unknown } | undefined;
  const host = raw && typeof raw.host === "string" ? raw.host.trim() : "";
  const port = number(raw && typeof raw === "object" ? raw.port : undefined, 4455);
  return { host: host || "127.0.0.1", port: clamp(Math.round(port), 1, 65535) };
}

/**
 * Входы точки: цвет четырьмя числами и яркость.
 *
 * Яркость — `max(r,g,b)`, умноженный на прозрачность: у прозрачного участка
 * видимого света нет, и `level` не должен показывать «ярко».
 */
export function ambientInputs(module: ModuleInstance): ModuleInputSpec[] {
  const result: ModuleInputSpec[] = [];
  for (const point of ambientPoints(module)) {
    const parts: Array<{ part: "r" | "g" | "b" | "a" | "level"; label: string; hint: string }> = [
      { part: "r", label: "красный", hint: "Средний красный участка 0…1" },
      { part: "g", label: "зелёный", hint: "Средний зелёный участка 0…1" },
      { part: "b", label: "синий", hint: "Средний синий участка 0…1" },
      { part: "a", label: "прозрачность", hint: "Средняя прозрачность участка 0…1: берётся, только если так сказано в привязке" },
      { part: "level", label: "яркость", hint: "Яркость участка: max(r, g, b), умноженный на прозрачность" },
    ];
    for (const part of parts) {
      result.push({
        name: `${point.name}_${part.part}`,
        label: `${point.label}: ${part.label}`,
        min: 0,
        max: 1,
        step: 0.01,
        kind: "level",
        hint: part.hint,
      });
    }
  }
  return result;
}

/** Сглаживание между замерами живёт по точке: `smooth` — инерция, а не фильтр. */
const smoothState = new Map<string, Rgba>();

export function resetAmbientState(): void {
  smoothState.clear();
}

/**
 * Цвет точки с учётом сглаживания.
 *
 * `null` — замера ещё не было (OBS не подключён, файл идёт): возвращаем прошлое
 * значение, чтобы свет не гас от каждой заминки. Если прошлого нет — ноль.
 */
export function ambientColor(moduleName: string, point: AmbientPoint, sample: Rgba | null, dt: number): Rgba {
  const key = `${moduleName}:${point.name}`;
  const previous = smoothState.get(key);
  if (!sample) return previous ?? { r: 0, g: 0, b: 0, a: 0 };
  const smooth = clamp(point.smooth, 0, 100) / 100;
  let color = sample;
  if (previous && smooth > 0) {
    const tau = smooth * 1.5;
    const k = dt > 0 ? 1 - Math.exp(-dt / Math.max(0.02, tau)) : 1;
    color = {
      r: previous.r + (sample.r - previous.r) * k,
      g: previous.g + (sample.g - previous.g) * k,
      b: previous.b + (sample.b - previous.b) * k,
      a: previous.a + (sample.a - previous.a) * k,
    };
  }
  smoothState.set(key, color);
  return color;
}

/** Числа для входов точки: `_r`, `_g`, `_b`, `_a`, `_level`. */
export function ambientValues(color: Rgba): Record<"r" | "g" | "b" | "a" | "level", number> {
  const r = clamp(color.r, 0, 1);
  const g = clamp(color.g, 0, 1);
  const b = clamp(color.b, 0, 1);
  const a = clamp(color.a, 0, 1);
  return { r, g, b, a, level: clamp(Math.max(r, g, b) * a, 0, 1) };
}
