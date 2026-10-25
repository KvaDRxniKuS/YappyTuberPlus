import type { RigPreset } from "../types";
import { normalizePreset } from "./preset";
import { externalizePreset, inlineAssets } from "./assets";

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
  /** Объекты, чьи файлы не нашлись в хранилище и не попали в файл пресета. */
  missing?: string[];
}

export interface OpenResult {
  preset: RigPreset;
  path: string | null;
  backend: FileBackendKind;
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

/** Текст файла пресета: ссылки на файлы встроены обратно в data URL. */
export async function presetFileContents(preset: RigPreset): Promise<{ text: string; missing: string[] }> {
  const { preset: inlined, missing } = await inlineAssets(preset);
  return { text: JSON.stringify(inlined, null, 2), missing };
}

/** Записывает пресет в текущий файл или просит путь, если файла ещё нет. */
export async function savePreset(preset: RigPreset, path: string | null): Promise<SaveResult> {
  if (!isTauri()) return downloadPreset(preset);
  const contents = await presetFileContents(preset);
  let target = path;
  if (!target) {
    const picked = await pickSavePath(preset);
    if (!picked) throw new Error("Сохранение отменено");
    target = picked;
  }
  await tauriInvoke<void>("preset_write", { path: target, contents: contents.text });
  return { path: target, backend: "tauri", missing: contents.missing };
}

/** Всегда спрашивает директорию и имя файла. */
export async function savePresetAs(preset: RigPreset): Promise<SaveResult> {
  if (!isTauri()) return downloadPreset(preset);
  const target = await pickSavePath(preset);
  if (!target) throw new Error("Сохранение отменено");
  const contents = await presetFileContents(preset);
  await tauriInvoke<void>("preset_write", { path: target, contents: contents.text });
  return { path: target, backend: "tauri", missing: contents.missing };
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
  // Файлы переезжают в хранилище webview: в редакторе остаются короткие ссылки.
  const extracted = await externalizePreset(parsed);
  return { preset: extracted.preset, path, backend: "tauri" };
}

export function parsePreset(text: string): RigPreset {
  const normalized = normalizePreset(JSON.parse(text));
  if (!normalized) throw new Error("Это не пресет YappyTuberPlus версии 2");
  return normalized;
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
