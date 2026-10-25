import type { RigObject, RigPreset } from "../types";

/**
 * Файлы объектов сцены (картинки, видео, звук) живут отдельно от пресета.
 *
 * В пресете лежит только ссылка `asset:<id>`, а сами байты — в IndexedDB
 * webview. Это даёт сразу три вещи:
 *
 * - автосохранение в `localStorage` больше не упирается в квоту: строка пресета
 *   весит килобайты, даже если в сцене видео на сотни мегабайт;
 * - редактор не переливает base64 на каждую правку и не ест память дважды;
 * - файл, который читают редактор, окно оверлея и окно захвата, лежит в одном
 *   месте (у них общий origin), поэтому достаточно один раз создать `blob:` URL.
 *
 * При сохранении пресета и при экспорте JSON ссылки **встраиваются обратно**
 * (`inlineAssets`): файл пресета остаётся самодостаточным и переносится на
 * другую машину целиком. При открытии пресета data URL, наоборот, распаковываются
 * в хранилище (`extractAssets`), поэтому старые пресеты просто продолжают работать.
 *
 * Хранилище — кэш, а не архив: если IndexedDB недоступна (приватный режим,
 * испорченный профиль), объекты остаются с data URL и всё работает как раньше.
 */

const DB_NAME = "yappytuberplus.assets";
const DB_VERSION = 1;
const STORE = "assets";

/** Префикс ссылки на файл в хранилище. Всё остальное — обычный URL или data URL. */
export const ASSET_PREFIX = "asset:";

export interface AssetRecord {
  id: string;
  name: string;
  mime: string;
  size: number;
  createdAt: number;
  blob: Blob;
}

/** Готовые `blob:` URL по id: их отдают канве и медиа-элементам. */
const urls = new Map<string, string>();
/** Загрузки в процессе: повторный запрос того же файла не читает хранилище снова. */
const pending = new Map<string, Promise<void>>();
/** Файлы, которых в хранилище нет: не пытаемся читать их на каждом кадре. */
const missing = new Set<string>();
/** Один раз прочитанный data URL на файл: экспорт не перекодирует видео повторно. */
const inlined = new Map<string, Promise<string | null>>();
const listeners = new Set<() => void>();
let dbPromise: Promise<IDBDatabase | null> | null = null;

export function assetRef(id: string): string {
  return `${ASSET_PREFIX}${id}`;
}

export function isAssetRef(source: string | null | undefined): boolean {
  return typeof source === "string" && source.startsWith(ASSET_PREFIX);
}

export function assetIdOf(source: string | null | undefined): string | null {
  return isAssetRef(source) ? String(source).slice(ASSET_PREFIX.length) : null;
}

/** Подписка на появление файлов: по ней редактор и оверлей перерисовываются. */
export function onAssetsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function emit(): void {
  for (const listener of listeners) listener();
}

/**
 * URL, готовый для `<img>`, `<video>` или `Audio`.
 *
 * Обычный путь, http-URL и data URL возвращаются как есть. Для ссылки на файл
 * возвращается `blob:` URL, если он уже готов; иначе запускается чтение из
 * хранилища и возвращается `null` — после загрузки придёт событие
 * `onAssetsChanged`, и отрисовка попросит URL снова.
 */
export function assetUrl(source: string | null | undefined): string | null {
  if (!source) return null;
  const id = assetIdOf(source);
  if (!id) return source;
  const ready = urls.get(id);
  if (ready) return ready;
  ensureAsset(id);
  return null;
}

/** Начинает загрузку файла, если он ещё не загружен. */
export function ensureAsset(id: string): void {
  if (urls.has(id) || pending.has(id) || missing.has(id)) return;
  const job = readAsset(id).finally(() => { pending.delete(id); });
  pending.set(id, job);
}

/**
 * Принимает файл, присланный редактором по протоколу оверлея.
 *
 * Нужно странице оверлея на другом origin (источник браузера в OBS): своего
 * хранилища у неё нет, поэтому data URL превращается в `blob:` на месте.
 */
export function acceptAssetData(id: string, dataUrl: string): void {
  if (urls.has(id) || !dataUrl) return;
  try {
    urls.set(id, URL.createObjectURL(dataUrlToBlob(dataUrl)));
    missing.delete(id);
    emit();
  } catch {
    missing.delete(id);
  }
}

/** Файлы, для которых URL ещё не готов: их нужно спросить у редактора. */
export function unresolvedAssetIds(ids: Iterable<string>): string[] {
  const result: string[] = [];
  for (const id of ids) if (!urls.has(id)) result.push(id);
  return result;
}

export function ensureAssets(sources: Iterable<string | null | undefined>): void {
  for (const source of sources) {
    const id = assetIdOf(source);
    if (id) ensureAsset(id);
  }
}

/** Все файлы, на которые ссылается пресет. */
export function assetIdsOfPreset(preset: RigPreset): Set<string> {
  const ids = new Set<string>();
  for (const object of preset.objects) {
    const image = assetIdOf(object.image);
    if (image) ids.add(image);
    const media = assetIdOf(object.media?.src);
    if (media) ids.add(media);
  }
  return ids;
}

export function ensureAssetsOfPreset(preset: RigPreset): void {
  for (const id of assetIdsOfPreset(preset)) ensureAsset(id);
}

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") { resolve(null); return; }
    let request: IDBOpenDBRequest;
    try { request = indexedDB.open(DB_NAME, DB_VERSION); }
    catch { resolve(null); return; }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transaction(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(STORE, mode).objectStore(STORE);
}

async function readAsset(id: string): Promise<void> {
  const db = await openDb();
  if (!db) { missing.add(id); return; }
  try {
    const record = await done<AssetRecord | undefined>(transaction(db, "readonly").get(id));
    if (!record?.blob) { missing.add(id); return; }
    urls.set(id, URL.createObjectURL(record.blob));
    emit();
  } catch {
    missing.add(id);
  }
}

function newId(): string {
  const globalCrypto = typeof crypto !== "undefined" ? crypto : null;
  if (globalCrypto && "randomUUID" in globalCrypto) return globalCrypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Кладёт файл в хранилище и возвращает ссылку `asset:<id>`.
 *
 * `null` означает «хранилище недоступно» — вызывающий код тогда оставляет
 * data URL, и пресет ведёт себя как раньше.
 */
export async function storeBlob(blob: Blob, name: string): Promise<string | null> {
  const db = await openDb();
  if (!db) return null;
  const id = newId();
  const record: AssetRecord = {
    id,
    name,
    mime: blob.type || "application/octet-stream",
    size: blob.size,
    createdAt: Date.now(),
    blob,
  };
  try {
    await done(transaction(db, "readwrite").add(record));
  } catch {
    return null;
  }
  urls.set(id, URL.createObjectURL(blob));
  emit();
  return assetRef(id);
}

export async function storeFile(file: File): Promise<string | null> {
  return storeBlob(file, file.name);
}

/** Сколько файлов и байт лежит в хранилище. */
export async function assetStats(): Promise<{ count: number; bytes: number }> {
  const db = await openDb();
  if (!db) return { count: 0, bytes: 0 };
  try {
    const records = await done<AssetRecord[]>(transaction(db, "readonly").getAll() as IDBRequest<AssetRecord[]>);
    return {
      count: records.length,
      bytes: records.reduce((sum, record) => sum + (record.size || 0), 0),
    };
  } catch {
    return { count: 0, bytes: 0 };
  }
}

/**
 * Удаляет файлы, на которые больше никто не ссылается. Вызывается на старте,
 * когда история отмены пуста и вернуть удалённую ссылку уже нечем.
 */
export async function pruneAssets(keep: Set<string>): Promise<number> {
  const db = await openDb();
  if (!db) return 0;
  let removed = 0;
  try {
    const keys = await done<IDBValidKey[]>(transaction(db, "readonly").getAllKeys());
    for (const key of keys) {
      const id = String(key);
      if (keep.has(id)) continue;
      await done(transaction(db, "readwrite").delete(key));
      const url = urls.get(id);
      if (url) { URL.revokeObjectURL(url); urls.delete(id); }
      inlined.delete(id);
      missing.delete(id);
      removed += 1;
    }
  } catch {
    return removed;
  }
  return removed;
}

function isDataUrl(source: string): boolean {
  return source.startsWith("data:");
}

/**
 * data URL → ссылка на файл. Применяется к только что открытому пресету:
 * файл переезжает в хранилище, а в пресете остаётся короткая ссылка.
 */
export async function extractAssets(preset: RigPreset): Promise<{ preset: RigPreset; changed: boolean }> {
  let changed = false;
  const objects: RigObject[] = [];
  for (const object of preset.objects) {
    let next = object;
    if (object.image && isDataUrl(object.image)) {
      const ref = await storeBlob(dataUrlToBlob(object.image), `${object.id}.${extensionOf(object.image)}`);
      if (ref) { next = { ...next, image: ref }; changed = true; }
    }
    if (next.media?.src && isDataUrl(next.media.src)) {
      const ref = await storeBlob(
        dataUrlToBlob(next.media.src),
        next.media.fileName || `${next.id}.${extensionOf(next.media.src)}`,
      );
      if (ref) { next = { ...next, media: { ...next.media, src: ref } }; changed = true; }
    }
    objects.push(next);
  }
  return changed ? { preset: { ...preset, objects }, changed } : { preset, changed };
}

async function readDataUrl(id: string): Promise<string | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    const record = await done<AssetRecord | undefined>(transaction(db, "readonly").get(id));
    if (!record?.blob) return null;
    return blobToDataUrl(record.blob);
  } catch {
    return null;
  }
}

/** Ссылка на файл → data URL (с кэшем: один и тот же файл кодируется один раз). */
export function inlineSource(source: string): Promise<string | null> {
  const id = assetIdOf(source);
  if (!id) return Promise.resolve(source);
  let job = inlined.get(id);
  if (!job) {
    job = readDataUrl(id);
    inlined.set(id, job);
  }
  return job;
}

/**
 * Пресет для записи на диск: все ссылки заменены на data URL, поэтому файл
 * пресета остаётся одним самодостаточным файлом.
 */
export async function inlineAssets(preset: RigPreset): Promise<RigPreset> {
  let changed = false;
  const objects: RigObject[] = [];
  for (const object of preset.objects) {
    let next = object;
    if (isAssetRef(object.image) && object.image) {
      const source = await inlineSource(object.image);
      next = { ...next, image: source };
      changed = true;
    }
    if (next.media?.src && isAssetRef(next.media.src)) {
      const source = await inlineSource(next.media.src);
      next = { ...next, media: { ...next.media, src: source } };
      changed = true;
    }
    objects.push(next);
  }
  return changed ? { ...preset, objects } : preset;
}

/** Пресет, у которого файлы заменены на ссылки: рабочее состояние редактора. */
export async function externalizePreset(preset: RigPreset): Promise<{ preset: RigPreset; changed: boolean }> {
  const extracted = await extractAssets(preset);
  ensureAssetsOfPreset(extracted.preset);
  return extracted;
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const match = /^data:([^,]*),([\s\S]*)$/.exec(dataUrl);
  if (!match) return new Blob([dataUrl]);
  const [, header, payload] = match;
  const base64 = /;base64$/i.test(header);
  const mime = header.replace(/;base64$/i, "") || "application/octet-stream";
  if (!base64) {
    try { return new Blob([decodeURIComponent(payload)], { type: mime }); }
    catch { return new Blob([payload], { type: mime }); }
  }
  try {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: mime });
  } catch {
    return new Blob([payload], { type: mime });
  }
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Ошибка чтения файла"));
    reader.readAsDataURL(blob);
  });
}

function extensionOf(dataUrl: string): string {
  const mime = /^data:([^;,]+)/.exec(dataUrl)?.[1] || "";
  const known: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/ogg": "ogg",
    "audio/mp4": "m4a",
    "audio/flac": "flac",
  };
  return known[mime] || "bin";
}
