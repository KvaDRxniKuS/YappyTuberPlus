/**
 * Паспорт собранной папки: `build.json` рядом с `index.html`.
 *
 * Сам код редактора знает свою версию из `src/version.ts`, но собранная папка —
 * это ещё и `rig_core.wasm`, страница оверлея и шаблоны модулей. Их можно
 * смешать: положить свежий фронтенд со старым ядром, распаковать поверх старую
 * сборку, взять папку недельной давности. По файлам это не видно, поэтому
 * сборка пишет рядом паспорт (`scripts/build-version.mjs`), а приложение при
 * запуске его читает и сверяет со своими числами.
 *
 * В режиме разработки (`npm run dev`) файла нет — и это нормально: там всё
 * собирается из одного репозитория.
 */
import { SLOT_INFO, SLOT_ORDER, VERSION, parseVersion, type VersionSlot } from "../version";

export interface BuildInfo {
  /** Машинная запись: `1.0.21.3.1.1.1`. */
  version: string;
  /** Версия для установщика: `1.0.0`. */
  packaging?: string;
  /** Время сборки, ISO. */
  builtAt?: string;
  /** Коммит, из которого собрана папка. */
  commit?: string | null;
  /** Поколение самого формата `build.json`. */
  schema?: number;
}

/** Читает паспорт папки; `null` — файла нет (разработка) или он нечитаем. */
export async function loadBuildInfo(): Promise<BuildInfo | null> {
  try {
    const base = import.meta.env?.BASE_URL ?? "/";
    const response = await fetch(`${base}build.json`, { cache: "no-store" });
    if (!response.ok) return null;
    const data: unknown = await response.json();
    if (!data || typeof data !== "object") return null;
    const version = (data as BuildInfo).version;
    return typeof version === "string" ? (data as BuildInfo) : null;
  } catch {
    return null;
  }
}

/** Слоты, в которых папка расходится с запущенным кодом. */
export function buildInfoSlots(info: BuildInfo | null): VersionSlot[] {
  const version = parseVersion(info?.version);
  if (!version) return [];
  return SLOT_ORDER.filter((slot) => version[slot] !== VERSION[slot]);
}

/** Строка для подсказки: из чего и когда собрана папка. */
export function buildInfoLine(info: BuildInfo | null): string | null {
  if (!info) return null;
  const date = info.builtAt ? new Date(info.builtAt) : null;
  const when = date && !Number.isNaN(date.getTime())
    ? date.toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })
    : null;
  const parts = [`сборка ${info.version}`];
  if (when) parts.push(when);
  if (info.commit) parts.push(`коммит ${info.commit}`);
  return parts.join(" · ");
}

/**
 * Расхождение папки с кодом редактора.
 *
 * `null` — паспорт свой (или его нет). Иначе — какие слои не совпали и что это
 * значит на практике: старая папка чаще всего означает старое ядро, а оно
 * молча возвращает нули вместо новых формул.
 */
export function buildInfoMessage(info: BuildInfo | null): string | null {
  const slots = buildInfoSlots(info);
  if (!slots.length || !info) return null;
  const version = parseVersion(info.version)!;
  const names = slots
    .map((slot) => `${SLOT_INFO[slot].label}: в папке ${version[slot]}, в коде ${VERSION[slot]}`)
    .join("; ");
  return `Файлы сборки от другой версии (${names}). `
    + "Пересоберите папку целиком — `npm run build` — иначе часть формул или видов "
    + "объектов может не совпасть с кодом, который их показывает.";
}
