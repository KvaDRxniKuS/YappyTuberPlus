/**
 * Обновление сборки: проверка опубликованной версии, совместимость и установка.
 *
 * Опубликованная сборка — папка `dist` в репозитории. У неё есть паспорт
 * `build.json` (его пишет `scripts/build-version.mjs`): версия, время, коммит и
 * список файлов с размерами и хешами. Приложение читает паспорт по обычному
 * `https` и сравнивает с собой — сервер не нужен.
 *
 * Три канала установки, потому что продукт живёт в трёх видах:
 *
 * - `app` — нативное приложение Tauri: фронтенд внутри `.exe`, поэтому
 *   обновляется сам бинарник (скачали, подменили, перезапустились);
 * - `agent` — собранная папка, рядом с которой запущен лаунчер с локальным
 *   агентом (`scripts/update-agent.mjs`): файлы заменяются на диске, страница
 *   перезагружается;
 * - `manual` — запуск из исходников (`npm run dev`): файлы принадлежат git,
 *   их обновляет лаунчер при следующем запуске, и честнее так и сказать.
 *
 * Совместимость считается до предложения: обновление, после которого открытая
 * сцена перестанет считаться, показывается списком, а не «установить?».
 */
import type { RigPreset } from "../types";
import { PRESET_FORMAT, VERSION, parseVersion } from "../version";
import { needsReport } from "./coreFeatures";
import type { BuildInfo } from "./buildInfo";
import type { CompatibilityIssue } from "./presetCheck";

/** Файл опубликованной сборки: что скачивать и чем проверять. */
export interface UpdateFile {
  /** Путь относительно папки сборки. */
  path: string;
  size: number;
  sha256: string;
}

/**
 * Паспорт опубликованной сборки: `build.json` из папки `dist`.
 *
 * Здесь же лежат поколения слоёв: по ним видно, что именно изменится после
 * обновления, не скачивая ни одного файла сборки.
 */
export interface UpdateManifest extends BuildInfo {
  release?: [number, number];
  core?: number;
  format?: number;
  bridge?: number;
  modules?: number;
  shell?: number;
  packaging?: string;
  /** Поколение формата самого манифеста. */
  schema?: number;
  /** Старейшее поколение сценариев, которое понимает ядро этой сборки. */
  acceptsFrom?: number;
  /** Все файлы папки. */
  files?: UpdateFile[];
  /** Собранное приложение, если оно лежит в папке (для нативного обновления). */
  app?: UpdateFile;
}

/** Где лежит опубликованная сборка. Меняется здесь, а не в коде интерфейса. */
export const UPDATE_MANIFEST_URL =
  "https://raw.githubusercontent.com/KvaDRxniKuS/YappyTuberPlus/main/dist/build.json";

/** Локальный агент обновления: его поднимает лаунчер рядом с собранной папкой. */
export const UPDATE_AGENT_URL = "/update";

/** Каким способом этот запуск умеет ставить обновление. */
export type UpdateChannel = "app" | "agent" | "manual";

export type UpdateVerdict = "newer" | "older" | "none" | "mixed" | "unknown";

const SKIP_KEY = "yappytuberplus.update.skip";

function tuple(version: string | null | undefined): number[] | null {
  const parsed = parseVersion(version);
  if (!parsed) return null;
  return [parsed.release[0], parsed.release[1], parsed.core, parsed.format,
    parsed.bridge, parsed.modules, parsed.shell];
}

/**
 * Сравнение паспортов.
 *
 * `newer` — опубликованная сборка не старше ни в одном слое и новее хотя бы в
 * одном. `mixed` — где-то новее, где-то старее: такое обновление не предлагаем
 * молча, слои разъехались и это уже повод разбираться руками.
 */
export function updateVerdict(localVersion: string | null, remoteVersion: string | null): UpdateVerdict {
  const local = tuple(localVersion);
  const remote = tuple(remoteVersion);
  if (!local || !remote) return "unknown";
  const diffs = local.map((value, index) => remote[index] - value);
  if (diffs.every((diff) => diff === 0)) return "none";
  if (diffs.every((diff) => diff >= 0)) return "newer";
  if (diffs.every((diff) => diff <= 0)) return "older";
  return "mixed";
}

/** Папка, из которой берутся файлы: адрес манифеста без имени файла. */
export function manifestBaseUrl(manifestUrl = UPDATE_MANIFEST_URL): string {
  const cut = manifestUrl.lastIndexOf("/");
  return cut < 0 ? manifestUrl : manifestUrl.slice(0, cut + 1);
}

/** Читает паспорт опубликованной сборки; `null` — сети нет или ответ не тот. */
export async function fetchUpdateManifest(
  manifestUrl = UPDATE_MANIFEST_URL,
  timeoutMs = 8000,
): Promise<UpdateManifest | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(manifestUrl, { cache: "no-store", signal: controller.signal });
    if (!response.ok) return null;
    const data: unknown = await response.json();
    if (!data || typeof data !== "object") return null;
    const manifest = data as UpdateManifest;
    return typeof manifest.version === "string" ? manifest : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Что может не работать после обновления.
 *
 * Проверяется не только «версии разные», но и открытая сцена: обновление
 * предлагается всегда, но человек видит, что именно рискует.
 */
export function updateIssues(
  remote: UpdateManifest,
  preset: RigPreset | null,
  /** Граница совместимости текущего ядра: нужна, чтобы не пугать без причины. */
  currentAcceptsFrom = 1,
): CompatibilityIssue[] {
  const issues: CompatibilityIssue[] = [];
  const report = preset ? needsReport(preset) : null;
  const remoteCore = typeof remote.core === "number" ? remote.core : null;
  const remoteAccepts = typeof remote.acceptsFrom === "number" ? remote.acceptsFrom : 1;

  if (report && remoteCore !== null && report.needs > remoteCore) {
    const reasons = report.reasons
      .filter((reason) => reason.since > remoteCore)
      .map((reason) => reason.label);
    issues.push({
      label: `сцене нужно ядро ${report.needs}, в новой сборке ${remoteCore}`,
      detail: reasons.length
        ? `${reasons.join(", ")} — после обновления эти формулы вернут 0.`
        : "После обновления новые формулы этой сцены вернут 0.",
    });
  }

  // Новая сборка могла убрать часть языка: тогда страдает всё, что ниже границы.
  // Сравниваем с текущей границей, а не с нулём: если она не сдвинулась,
  // тревога была бы ложной.
  if (report && remoteAccepts > currentAcceptsFrom) {
    const affected = report.reasons
      .filter((reason) => reason.since < remoteAccepts)
      .map((reason) => reason.label);
    if (affected.length || report.removed.length) {
      const names = [...affected, ...report.removed.map((item) => item.label)];
      issues.push({
        label: `новая сборка понимает сценарии только с ядра ${remoteAccepts}`,
        detail: `${names.join(", ")} — в сцене используется то, что в новой сборке может быть убрано. `
          + "Проверьте эти места после обновления.",
      });
    }
  }

  if (typeof remote.bridge === "number" && remote.bridge !== VERSION.bridge) {
    issues.push({
      label: `мост ${remote.bridge} против ${VERSION.bridge}`,
      detail: "После обновления страницу источника в OBS нужно перезагрузить — иначе картинка замрёт.",
    });
  }

  if (typeof remote.format === "number" && remote.format > PRESET_FORMAT) {
    issues.push({
      label: `файлы станут формата ${remote.format}`,
      detail: "Пресеты, сохранённые новой сборкой, этот редактор уже не откроет: откатиться будет нельзя без потери настроек.",
    });
  }

  return issues;
}

/** Короткая строка о том, что предлагают поставить. */
export function updateSummary(remote: UpdateManifest): string {
  const date = remote.builtAt ? new Date(remote.builtAt) : null;
  const when = date && !Number.isNaN(date.getTime())
    ? date.toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })
    : null;
  // Изменившиеся слои: видно, что именно приедет, не открывая паспорт руками.
  const slots: Array<[string, number | undefined, number]> = [
    ["ядро", remote.core, VERSION.core],
    ["файл", remote.format, VERSION.format],
    ["мост", remote.bridge, VERSION.bridge],
    ["модули", remote.modules, VERSION.modules],
    ["оболочка", remote.shell, VERSION.shell],
  ];
  const changed = slots
    .filter(([, next, now]) => typeof next === "number" && next !== now)
    .map(([name, next, now]) => `${name} ${now} → ${next}`);
  return [`версия ${remote.version}`, ...changed, when,
    remote.commit ? `коммит ${remote.commit}` : null]
    .filter(Boolean)
    .join(" · ");
}

/** SHA-256 в hex: им сверяются скачанные байты. */
export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // Своя копия в обычный ArrayBuffer: crypto.subtle не принимает view на
  // разделяемую память, а типы это различают.
  const copy = new ArrayBuffer(source.byteLength);
  new Uint8Array(copy).set(source);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Скачивает файлы обновления и проверяет каждый по хешу из паспорта. */
export async function downloadUpdate(
  manifest: UpdateManifest,
  onProgress?: (done: number, total: number, path: string) => void,
): Promise<Map<string, Uint8Array>> {
  const files = manifest.files ?? [];
  if (!files.length) throw new Error("В паспорте новой сборки нет списка файлов");
  const base = manifestBaseUrl();
  const result = new Map<string, Uint8Array>();
  let done = 0;
  for (const file of files) {
    const response = await fetch(`${base}${file.path}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`${file.path}: ответ ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (file.size && bytes.length !== file.size) {
      throw new Error(`${file.path}: пришло ${bytes.length} байт вместо ${file.size}`);
    }
    if (file.sha256 && (await sha256Hex(bytes)) !== file.sha256) {
      throw new Error(`${file.path}: файл не совпал по отпечатку`);
    }
    result.set(file.path, bytes);
    done += 1;
    onProgress?.(done, files.length, file.path);
  }
  return result;
}

/** Есть ли рядом локальный агент: он умеет заменять файлы собранной папки. */
export async function updateAgentReady(): Promise<boolean> {
  try {
    const response = await fetch(`${UPDATE_AGENT_URL}/health`, { cache: "no-store" });
    if (!response.ok) return false;
    const data: unknown = await response.json();
    return Boolean(data && typeof data === "object" && (data as { ok?: boolean }).ok);
  } catch {
    return false;
  }
}

/** Чем этот запуск умеет обновляться. */
export async function updateChannel(): Promise<UpdateChannel> {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) return "app";
  if (await updateAgentReady()) return "agent";
  return "manual";
}

/**
 * Установка через локального агента: файлы скачивает и проверяет он же.
 *
 * Через страницу байты не гоняем: агент работает в той же папке, что и
 * сервер, ему и писать.
 */
export async function applyUpdateWithAgent(manifestUrl = UPDATE_MANIFEST_URL): Promise<void> {
  const response = await fetch(`${UPDATE_AGENT_URL}/apply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ manifest: manifestUrl }),
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok || !(data as { ok?: boolean } | null)?.ok) {
    const error = (data as { error?: string } | null)?.error;
    throw new Error(error || `Агент обновления ответил ${response.status}`);
  }
}

/**
 * Установка нативного приложения: подменяем `.exe` и перезапускаемся.
 *
 * Скачивание и проверка хеша — здесь (в webview есть `fetch` и `crypto`),
 * запись и подмена — в Rust: работающий `.exe` на Windows заблокирован, файл
 * меняет вспомогательный скрипт после выхода процесса.
 */
export async function applyUpdateApp(manifest: UpdateManifest): Promise<void> {
  const app = manifest.app;
  if (!app) throw new Error("В паспорте нет файла приложения — обновитесь установщиком");
  const response = await fetch(`${manifestBaseUrl()}${app.path}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`${app.path}: ответ ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (app.size && bytes.length !== app.size) throw new Error("Файл приложения скачался не целиком");
  if (app.sha256 && (await sha256Hex(bytes)) !== app.sha256) {
    throw new Error("Файл приложения не совпал по отпечатку");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  const staged = await invoke<string>("update_stage", { payload: toBase64(bytes) });
  await invoke("update_restart", { staged });
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/** Версия, которую пользователь попросил больше не предлагать. */
export function skippedUpdate(): string | null {
  try {
    return localStorage.getItem(SKIP_KEY);
  } catch {
    return null;
  }
}

export function skipUpdate(version: string | null): void {
  try {
    if (version) localStorage.setItem(SKIP_KEY, version);
    else localStorage.removeItem(SKIP_KEY);
  } catch {
    // Приватный режим: пропуск просто не запомнится.
  }
}
