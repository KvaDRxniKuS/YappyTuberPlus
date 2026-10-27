import type { RigPreset } from "../types";
import { normalizePreset } from "./preset";
import { materialSources } from "../render/material";
import { IncompatiblePresetError, presetCompatibility, type CompatibilityReport } from "./presetCheck";
import { withBuildStamp } from "../version";
import { needsCore } from "./coreFeatures";
import {
  assetIdOf,
  assetInfo,
  assetRef,
  diskAssetInfo,
  ensureAssetsOfPresetSettled,
  externalizePreset,
  inlineAssets,
  inlineSource,
  setAssetDisk,
} from "./assets";

/**
 * Работа с пресетом как с файлом на диске.
 *
 * Целевая платформа — приложение Tauri: «Сохранить» перезаписывает текущий
 * файл, «Сохранить как…» открывает нативный диалог выбора директории. Запись
 * и чтение выполняет Rust (`std::fs`).
 *
 * В рабочем состоянии пресета картинки и медиа — ссылки `asset:<id>` на
 * хранилище webview (`src/engine/assets.ts`). На диск файл пишется только
 * самодостаточным: перед записью ссылки встраиваются обратно в data URL, а при
 * открытии снова распаковываются в хранилище. Поэтому пресет переносится на
 * другую машину целиком, а автосохранение в localStorage остаётся маленьким.
 *
 * В браузере (режим разработки) остаётся только скачивание/загрузка файла:
 * специальной браузерной поддержки нет и не планируется.
 */

export type FileBackendKind = "tauri" | "browser";

export interface SaveResult {
  path: string | null;
  backend: FileBackendKind;
  /** В браузере файл скачивается, путь узнать нельзя. */
  downloaded?: boolean;
  /** Объекты, чьи файлы не нашлись и не попали ни в пресет, ни в папку рядом. */
  missing?: string[];
}

export interface OpenResult {
  preset: RigPreset;
  path: string | null;
  backend: FileBackendKind;
  /** Объекты, чьих файлов не оказалось ни в хранилище, ни в папке пресета. */
  missing: string[];
  /**
   * Чем файл расходится с редактором. Пустой список — файл свой, говорить
   * нечего. Непустой при удачном открытии значит «открылось, но часть может
   * не работать»: это показывается списком, а не плашкой.
   */
  report?: CompatibilityReport;
}

/** Паспорт файла из `index.json` папки пресета. */
interface AssetEntry {
  id: string;
  name: string;
  mime: string;
  size: number;
  file: string;
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function presetFileName(name: string): string {
  const safe = name.trim().replace(/[^\p{L}\p{N}_-]+/gu, "_").replace(/^_+|_+$/g, "");
  return `${safe || "preset"}.yappy.json`;
}

function baseName(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || path;
}

export function fileNameOf(path: string | null): string | null {
  return path ? baseName(path) : null;
}

async function tauriInvoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

async function defaultDirectory(): Promise<string | null> {
  try {
    return await tauriInvoke<string>("preset_default_dir", {});
  } catch {
    return null;
  }
}

/**
 * Штамп файла: кто записал (`built`) и что сцене нужно от ядра (`needs`).
 *
 * Считается в момент записи, а не хранится в состоянии: правка сцены меняет
 * требование, и файл должен унести именно его. Ядро при этом может быть
 * старым — `needs` от него не зависит.
 */
export function stampPreset(preset: RigPreset): RigPreset {
  return { ...withBuildStamp(preset), needs: needsCore(preset) };
}

/**
 * Текст файла пресета для **экспорта**: ссылки на файлы встроены обратно в
 * data URL, поэтому получается один самодостаточный файл.
 *
 * Обычное сохранение так не делает: рядом с пресетом появляется папка
 * `<имя>.assets` (`writePresetFile`), и файл остаётся коротким.
 */
export async function presetFileContents(preset: RigPreset): Promise<{ text: string; missing: string[] }> {
  const { preset: inlined, missing } = await inlineAssets(preset);
  // Штамп сборки ставится в момент записи: в памяти пресет остаётся прежним,
  // поэтому сохранение не создаёт шаг истории и не трогает автосохранение.
  return { text: JSON.stringify(stampPreset(inlined), null, 2), missing };
}

/**
 * Привязывает хранилище файлов к пресету на диске.
 *
 * Вызывается при открытии, при сохранении и на старте (путь к последнему файлу
 * запоминается): дальше недостающие в webview файлы читаются из папки лениво.
 */
export async function attachPresetDisk(path: string | null): Promise<void> {
  if (!path || !isTauri()) {
    setAssetDisk(null);
    return;
  }
  const entries = await tauriInvoke<AssetEntry[]>("preset_asset_index", { path }).catch(() => []);
  setAssetDisk(path, entries);
}

/**
 * Пишет файлы объектов в папку `<имя>.assets` и возвращает имена объектов,
 * чьи файлы потерялись.
 *
 * Ссылки остаются короткими (`asset:<id>`): папка и пресет переносятся вместе.
 */
async function writeSidecar(preset: RigPreset, path: string): Promise<string[]> {
  const owners = new Map<string, string[]>();
  for (const object of preset.objects) {
    // Маска, карта нормалей и карты материала — такие же файлы объекта: без них
    // папка `<имя>.assets` переезжает без них, и после переноса объём, маска и
    // материал гаснут молча.
    for (const source of [
      object.image,
      object.media?.src,
      object.mask?.kind === "file" ? object.mask.file : null,
      object.normal?.src,
      ...materialSources(object.material),
    ]) {
      const id = assetIdOf(source);
      if (!id) continue;
      owners.set(id, [...(owners.get(id) ?? []), object.name]);
    }
  }
  const files: { id: string; name: string; mime: string; data: string }[] = [];
  const missing: string[] = [];
  for (const [id, names] of owners) {
    const data = await inlineSource(assetRef(id));
    if (!data) {
      missing.push(names.join(", "));
      continue;
    }
    const meta = (await assetInfo(id)) ?? diskAssetInfo(id);
    files.push({
      id,
      name: meta?.name || id,
      mime: /^data:([^;,]+)/.exec(data)?.[1] || meta?.mime || "application/octet-stream",
      data,
    });
  }
  if (files.length) {
    try {
      await tauriInvoke<number>("preset_write_assets", { path, assets: files });
    } catch (reason) {
      throw new Error(`Файлы объектов не записались рядом с пресетом: ${String(reason)}`);
    }
  }
  // Старые файлы убираются только после успешной записи пресета, поэтому
  // прерванное сохранение ничего не теряет.
  await tauriInvoke<number>("preset_clean_assets", { path }).catch(() => 0);
  return missing;
}

/** Запись пресета на диск: короткий JSON со ссылками плюс папка файлов рядом. */
async function writePresetFile(preset: RigPreset, path: string): Promise<string[]> {
  await tauriInvoke<void>("preset_write", { path, contents: JSON.stringify(stampPreset(preset), null, 2) });
  return writeSidecar(preset, path);
}

/** Записывает пресет в текущий файл или просит путь, если файла ещё нет. */
export async function savePreset(preset: RigPreset, path: string | null): Promise<SaveResult> {
  if (!isTauri()) return downloadPreset(preset);
  let target = path;
  if (!target) {
    const picked = await pickSavePath(preset);
    if (!picked) throw new Error("Сохранение отменено");
    target = picked;
  }
  const missing = await writePresetFile(preset, target);
  await attachPresetDisk(target);
  return { path: target, backend: "tauri", missing };
}

/** Всегда спрашивает директорию и имя файла. */
export async function savePresetAs(preset: RigPreset): Promise<SaveResult> {
  if (!isTauri()) return downloadPreset(preset);
  const target = await pickSavePath(preset);
  if (!target) throw new Error("Сохранение отменено");
  const missing = await writePresetFile(preset, target);
  await attachPresetDisk(target);
  return { path: target, backend: "tauri", missing };
}

async function pickSavePath(preset: RigPreset): Promise<string | null> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const directory = await defaultDirectory();
  const result = await save({
    title: "Сохранить пресет",
    defaultPath: directory ? `${directory}/${presetFileName(preset.name)}` : presetFileName(preset.name),
    filters: [{ name: "Пресет YappyTuberPlus", extensions: ["json"] }],
  });
  return result || null;
}

export async function openPresetFile(): Promise<OpenResult> {
  if (!isTauri()) throw new Error("Открытие файла доступно в приложении");
  const { open } = await import("@tauri-apps/plugin-dialog");
  const directory = await defaultDirectory();
  const selected = await open({
    title: "Открыть пресет",
    multiple: false,
    directory: false,
    defaultPath: directory || undefined,
    filters: [{ name: "Пресет YappyTuberPlus", extensions: ["json"] }],
  });
  const path = Array.isArray(selected) ? selected[0] : selected;
  if (!path) throw new Error("Открытие отменено");
  const text = await tauriInvoke<string>("preset_read", { path });
  const parsed = parsePreset(text);
  // Сначала папка пресета: файлы, которых нет в webview, придут из неё.
  await attachPresetDisk(path);
  // Файлы переезжают в хранилище webview: в редакторе остаются короткие ссылки.
  const extracted = await externalizePreset(parsed);
  const missing = await ensureAssetsOfPresetSettled(extracted.preset);
  // Отчёт считается по исходному JSON, а не по нормализованному пресету:
  // нормализация уже превратила незнакомый вид объекта в спрайт и подняла
  // формат до текущего, и рассказывать о расхождении было бы нечего.
  let report: CompatibilityReport | undefined;
  try {
    report = presetCompatibility(JSON.parse(text));
  } catch {
    report = undefined;
  }
  return { preset: extracted.preset, path, backend: "tauri", missing, report };
}

export function parsePreset(text: string): RigPreset {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("Файл не читается: это не JSON пресета");
  }
  const normalized = normalizePreset(raw);
  if (normalized) return normalized;
  // Не просто «не открылось»: считаем, чем файл новее, и показываем списком.
  throw new IncompatiblePresetError(presetCompatibility(raw));
}

/** Браузерный запасной путь — только для разработки. */
export async function downloadPreset(preset: RigPreset): Promise<SaveResult> {
  const contents = await presetFileContents(preset);
  const blob = new Blob([contents.text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = presetFileName(preset.name);
  anchor.click();
  URL.revokeObjectURL(url);
  return { path: null, backend: "browser", downloaded: true, missing: contents.missing };
}
