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
// Версия 2 разделила байты и описание файла: списку файлов (панель «Файлы
// объектов») нужны только имена и размеры, и незачем ради этого вычитывать из
// хранилища видео на сотни мегабайт.
const DB_VERSION = 2;
/** Байты: `{ id, name, blob, … }`. */
const STORE = "assets";
/** Описание файла без байтов: `{ id, name, mime, size, hash, createdAt }`. */
const META = "meta";

/** Префикс ссылки на файл в хранилище. Всё остальное — обычный URL или data URL. */
export const ASSET_PREFIX = "asset:";

export interface AssetRecord {
  id: string;
  name: string;
  mime: string;
  size: number;
  createdAt: number;
  /** Отпечаток содержимого: по нему один и тот же файл не хранится дважды. */
  hash?: string;
  blob: Blob;
}

/** Описание файла без байтов: то, что показывает панель «Файлы объектов». */
export interface AssetInfo {
  id: string;
  name: string;
  mime: string;
  size: number;
  hash: string;
  createdAt: number;
}

/** Готовые `blob:` URL по id: их отдают канве и медиа-элементам. */
const urls = new Map<string, string>();
/** Загрузки в процессе: повторный запрос того же файла не читает хранилище снова. */
const pending = new Map<string, Promise<void>>();
/** Файлы, которых в хранилище нет: не пытаемся читать их на каждом кадре. */
const missing = new Set<string>();
/**
 * Пресет на диске: рядом с ним лежит папка файлов `<имя>.assets`
 * (`src-tauri/src/lib.rs`, команды `preset_*_assets`). Пока путь не задан,
 * редактор работает только с хранилищем webview.
 */
let diskPath: string | null = null;
/** Паспорта файлов из папки пресета: имя и тип нужны, чтобы сохранить их обратно. */
const diskIndex = new Map<string, { name: string; mime: string }>();
/** Прочитанные с диска data URL: второй раз файл не читаем. */
const diskCache = new Map<string, string | Promise<string | null>>();
/** Один раз прочитанный data URL на файл: экспорт не перекодирует видео повторно. */
const inlined = new Map<string, Promise<string | null>>();
const listeners = new Set<() => void>();
let dbPromise: Promise<IDBDatabase | null> | null = null;
/** Паспорта старых файлов переносятся в `meta` один раз за сеанс. */
let backfilled: Promise<void> | null = null;

export function assetRef(id: string): string {
  return `${ASSET_PREFIX}${id}`;
}

export function isAssetRef(source: string | null | undefined): boolean {
  return typeof source === "string" && source.startsWith(ASSET_PREFIX);
}

export function assetIdOf(source: string | null | undefined): string | null {
  return isAssetRef(source) ? String(source).slice(ASSET_PREFIX.length) : null;
}

/**
 * Привязывает хранилище к пресету на диске.
 *
 * `entries` — паспорта из `index.json` папки пресета: по ним редактор знает,
 * как файлы называются, не читая байты. Пустой путь означает «пресет ещё не
 * сохранён»: читать можно только из хранилища webview.
 */
export function setAssetDisk(
  path: string | null,
  entries: Iterable<{ id: string; name: string; mime: string }> = [],
): void {
  diskPath = path;
  diskIndex.clear();
  for (const entry of entries) diskIndex.set(entry.id, { name: entry.name, mime: entry.mime });
  diskCache.clear();
  // Другая папка — прежние «файла нет» больше не в силе: файл мог найтись.
  missing.clear();
}

export function assetDiskPath(): string | null {
  return diskPath;
}

/** Паспорт файла из папки пресета (если он там есть). */
export function diskAssetInfo(id: string): { name: string; mime: string } | null {
  return diskIndex.get(id) ?? null;
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
/** Файла точно нет: его искали и не нашли (загрузка ещё идёт — не «нет»). */
export function assetMissing(source: string | null | undefined): boolean {
  const id = assetIdOf(source);
  return !!id && missing.has(id);
}

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

/** Файлы одного объекта: картинка, медиа и картинка-маска. */
function sourcesOf(object: RigObject): Array<string | null> {
  return [
    object.image,
    object.media?.src ?? null,
    object.mask?.kind === "file" ? object.mask.file : null,
    // Карта нормалей — такой же файл объекта. Без неё она не загружалась при
    // открытии пресета и не попадала в сохранение: объект виден, объёма нет.
    object.normal?.src ?? null,
  ];
}

/** Все файлы, на которые ссылается пресет. */
export function assetIdsOfPreset(preset: RigPreset): Set<string> {
  const ids = new Set<string>();
  for (const object of preset.objects) {
    for (const source of sourcesOf(object)) {
      const id = assetIdOf(source);
      if (id) ids.add(id);
    }
  }
  return ids;
}

export function ensureAssetsOfPreset(preset: RigPreset): void {
  for (const id of assetIdsOfPreset(preset)) ensureAsset(id);
}

/**
 * Дожидается загрузки всех файлов пресета и называет объекты, у которых файла
 * не нашлось ни в хранилище, ни в папке пресета.
 *
 * Нужно сразу после открытия файла: иначе объект просто остался бы пустым без
 * объяснения, почему.
 */
export async function ensureAssetsOfPresetSettled(preset: RigPreset): Promise<string[]> {
  const ids = [...assetIdsOfPreset(preset)];
  for (const id of ids) ensureAsset(id);
  await Promise.all(ids.map((id) => pending.get(id) ?? Promise.resolve()));
  const lost = new Set(ids.filter((id) => missing.has(id)));
  if (!lost.size) return [];
  const owners: string[] = [];
  for (const object of preset.objects) {
    if (sourcesOf(object).some((source) => { const id = assetIdOf(source); return !!id && lost.has(id); })) {
      owners.push(object.name);
    }
  }
  return owners;
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
      if (!db.objectStoreNames.contains(META)) {
        const meta = db.createObjectStore(META, { keyPath: "id" });
        meta.createIndex("hash", "hash", { unique: false });
      }
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

function transaction(db: IDBDatabase, mode: IDBTransactionMode, name: string = STORE): IDBObjectStore {
  return db.transaction(name, mode).objectStore(name);
}

async function readAsset(id: string): Promise<void> {
  const db = await openDb();
  if (db) {
    try {
      const record = await done<AssetRecord | undefined>(transaction(db, "readonly").get(id));
      if (record?.blob) {
        urls.set(id, URL.createObjectURL(record.blob));
        emit();
        return;
      }
    } catch {
      // Хранилище ответило ошибкой — не повод сдаваться: файл может лежать
      // в папке пресета.
    }
  }
  // Пресет открыли из файла: байты лежат в `<имя>.assets` рядом с ним.
  const data = await readDiskData(id);
  if (!data) { missing.add(id); return; }
  acceptAssetData(id, data);
  void remember(id, data);
}

/**
 * Файл из папки `<имя>.assets` рядом с пресетом.
 *
 * Читается лениво, по одному файлу: видео на сотни мегабайт не попадает в
 * память, пока объект не попросят нарисовать. Успешное чтение кладётся в
 * хранилище webview (`remember`), поэтому следующий запуск не трогает диск.
 */
function readDiskData(id: string): Promise<string | null> {
  const path = diskPath;
  if (!path) return Promise.resolve(null);
  const cached = diskCache.get(id);
  if (typeof cached === "string") return Promise.resolve(cached);
  if (cached) return cached;
  const job = (async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const data = await invoke<string | null>("preset_read_asset", { path, id });
      if (data) diskCache.set(id, data);
      else diskCache.delete(id);
      return data;
    } catch {
      diskCache.delete(id);
      return null;
    }
  })();
  diskCache.set(id, job);
  return job;
}

/** Кладёт прочитанный с диска файл в хранилище под тем же id. */
async function remember(id: string, dataUrl: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const blob = dataUrlToBlob(dataUrl);
    const meta = diskIndex.get(id);
    const name = meta?.name || id;
    const mime = meta?.mime || blob.type || "application/octet-stream";
    const createdAt = Date.now();
    const hash = await hashOf(blob, name);
    const info = { id, name, mime, size: blob.size, hash, createdAt };
    await done(transaction(db, "readwrite").put({ ...info, blob }));
    await done(transaction(db, "readwrite", META).put(info));
  } catch {
    // Кэш — не обязательный шаг: на отрисовку он не влияет.
  }
}

function newId(): string {
  const globalCrypto = typeof crypto !== "undefined" ? crypto : null;
  if (globalCrypto && "randomUUID" in globalCrypto) return globalCrypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Отпечаток файла для дедупликации.
 *
 * До 32 МБ считается SHA-256 по содержимому: одинаковые картинки, скачанные
 * дважды, лягут в хранилище одним файлом. Более крупные файлы не читаются
 * целиком — для них отпечаток строится из размера, типа и имени: этого хватает,
 * чтобы повторный импорт того же видео не удвоил хранилище, и не требует держать
 * сотни мегабайт в памяти.
 */
async function hashOf(blob: Blob, name: string): Promise<string> {
  const mime = blob.type || "application/octet-stream";
  if (blob.size > 32 * 1024 * 1024) return `big:${blob.size}:${mime}:${name}`;
  try {
    const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return `size:${blob.size}:${mime}:${name}`;
  }
}

function infoOf(record: AssetRecord): AssetInfo {
  return {
    id: record.id,
    name: record.name,
    mime: record.mime,
    size: record.size,
    hash: record.hash ?? "",
    createdAt: record.createdAt,
  };
}

/**
 * Паспорта файлов, сохранённых первой версией хранилища: там метаданных в
 * отдельном месте не было. Перенос идёт один раз и не мешает работе — если
 * паспорт не успел появиться, его просто не будет в списке до следующего раза.
 */
async function backfillMeta(): Promise<void> {
  if (backfilled) return backfilled;
  backfilled = (async () => {
    const db = await openDb();
    if (!db) return;
    try {
      const known = new Set(
        (await done<IDBValidKey[]>(transaction(db, "readonly", META).getAllKeys())).map(String),
      );
      // Ключи читаются отдельно от записей: список файлов не должен тянуть в
      // память сразу все байты (в сцене может быть видео на сотни мегабайт).
      const keys = await done<IDBValidKey[]>(transaction(db, "readonly").getAllKeys());
      for (const key of keys) {
        const id = String(key);
        if (known.has(id)) continue;
        const record = await done<AssetRecord | undefined>(transaction(db, "readonly").get(id));
        if (!record?.blob) continue;
        const hash = record.hash ?? await hashOf(record.blob, record.name);
        await done(transaction(db, "readwrite", META).put({ ...infoOf(record), hash }));
      }
    } catch {
      // Хранилище недоступно или испорчено — панель файлов просто покажет меньше.
    }
  })();
  return backfilled;
}

/**
 * Кладёт файл в хранилище и возвращает ссылку `asset:<id>`.
 *
 * Один и тот же файл хранится один раз: если отпечаток уже есть, возвращается
 * существующая ссылка. `null` означает «хранилище недоступно» — вызывающий код
 * тогда оставляет data URL, и пресет ведёт себя как раньше.
 */
export async function storeBlob(blob: Blob, name: string): Promise<string | null> {
  const db = await openDb();
  if (!db) return null;
  const hash = await hashOf(blob, name);
  try {
    const same = await done<AssetInfo[]>(transaction(db, "readonly", META).index("hash").getAll(hash) as IDBRequest<AssetInfo[]>);
    const existing = same.find((info) => info.size === blob.size && info.mime === (blob.type || "application/octet-stream"));
    if (existing) {
      if (!urls.has(existing.id)) urls.set(existing.id, URL.createObjectURL(blob));
      missing.delete(existing.id);
      emit();
      return assetRef(existing.id);
    }
  } catch { /* индекса нет — просто положим новую запись */ }
  const id = newId();
  const createdAt = Date.now();
  const mime = blob.type || "application/octet-stream";
  const record: AssetRecord = { id, name, mime, size: blob.size, createdAt, hash, blob };
  try {
    await done(transaction(db, "readwrite").add(record));
    await done(transaction(db, "readwrite", META).put({ id, name, mime, size: blob.size, hash, createdAt }));
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

/** Какой файл чем занят: панель «Файлы объектов» показывает это в списке. */
export interface AssetUsage extends AssetInfo {
  /** На файл ссылается открытый пресет. */
  used: boolean;
}

export async function listAssets(used: Set<string> = new Set()): Promise<AssetUsage[]> {
  await backfillMeta();
  const db = await openDb();
  if (!db) return [];
  try {
    const infos = await done<AssetInfo[]>(
      transaction(db, "readonly", META).getAll() as IDBRequest<AssetInfo[]>,
    );
    return infos
      .map((info) => ({ ...info, used: used.has(info.id) }))
      .sort((left, right) => right.createdAt - left.createdAt);
  } catch {
    return [];
  }
}

/** Паспорт одного файла из хранилища (без байтов). */
export async function assetInfo(id: string): Promise<AssetInfo | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    return (await done<AssetInfo | undefined>(transaction(db, "readonly", META).get(id))) ?? null;
  } catch {
    return null;
  }
}

/** Сколько файлов и байт лежит в хранилище. */
export async function assetStats(): Promise<{ count: number; bytes: number }> {
  await backfillMeta();
  const db = await openDb();
  if (!db) return { count: 0, bytes: 0 };
  try {
    const infos = await done<AssetInfo[]>(
      transaction(db, "readonly", META).getAll() as IDBRequest<AssetInfo[]>,
    );
    return {
      count: infos.length,
      bytes: infos.reduce((sum, info) => sum + (info.size || 0), 0),
    };
  } catch {
    return { count: 0, bytes: 0 };
  }
}

async function removeAsset(db: IDBDatabase, id: string): Promise<void> {
  await done(transaction(db, "readwrite").delete(id));
  try { await done(transaction(db, "readwrite", META).delete(id)); } catch { /* паспорта могло не быть */ }
  const url = urls.get(id);
  if (url) { URL.revokeObjectURL(url); urls.delete(id); }
  inlined.delete(id);
  missing.delete(id);
  backfilled = null;
}

/**
 * Удаляет файлы, на которые больше никто не ссылается.
 *
 * Вызывается на старте (история отмены пуста — вернуть ссылку нечем) и кнопкой
 * «Убрать неиспользуемые» в панели файлов.
 */
export async function pruneAssets(keep: Set<string>): Promise<number> {
  await backfillMeta();
  const db = await openDb();
  if (!db) return 0;
  let removed = 0;
  try {
    // Источник правды — оба хранилища: если запись осталась только в одном
    // (оборванная запись, старый профиль), она тоже считается мусором.
    const keys = new Set<string>();
    for (const key of await done<IDBValidKey[]>(transaction(db, "readonly").getAllKeys())) {
      keys.add(String(key));
    }
    try {
      const metaKeys = await done<IDBValidKey[]>(transaction(db, "readonly", META).getAllKeys());
      for (const key of metaKeys) keys.add(String(key));
    } catch { /* паспортов ещё нет */ }
    for (const id of keys) {
      if (keep.has(id)) continue;
      await removeAsset(db, id);
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
    // Картинка-маска — такой же файл: в пресете остаётся ссылка, не data URL.
    if (next.mask?.kind === "file" && next.mask.file && isDataUrl(next.mask.file)) {
      const ref = await storeBlob(dataUrlToBlob(next.mask.file), `${next.id}-mask.${extensionOf(next.mask.file)}`);
      if (ref) { next = { ...next, mask: { ...next.mask, file: ref } }; changed = true; }
    }
    // Карта нормалей: без этого data URL из чужого пресета оставался в файле,
    // а при следующем сохранении карта и вовсе терялась.
    if (next.normal?.src && isDataUrl(next.normal.src)) {
      const ref = await storeBlob(dataUrlToBlob(next.normal.src), `${next.id}-normal.${extensionOf(next.normal.src)}`);
      if (ref) { next = { ...next, normal: { ...next.normal, src: ref } }; changed = true; }
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
    // Неудачу не кэшируем: файл могли импортировать заново, и следующая запись
    // пресета должна попробовать ещё раз.
    job = (async () => {
      const stored = await readDataUrl(id);
      if (stored) return stored;
      // Пресет открыт из файла: байты лежат в папке рядом с ним.
      const fromDisk = await readDiskData(id);
      if (fromDisk) void remember(id, fromDisk);
      return fromDisk;
    })().then((data) => {
      if (!data) inlined.delete(id);
      return data;
    });
    inlined.set(id, job);
  }
  return job;
}

/**
 * Пресет для записи на диск: все ссылки заменены на data URL, поэтому файл
 * пресета остаётся одним самодостаточным файлом.
 *
 * Если файла в хранилище не оказалось (папку профиля чистили, ссылка пришла из
 * чужого пресета), ссылка остаётся как есть, а объект попадает в `missing`:
 * молча записывать битый пресет нельзя, человек должен узнать, что файл не
 * попал в сохранение.
 */
export async function inlineAssets(preset: RigPreset): Promise<{ preset: RigPreset; missing: string[] }> {
  let changed = false;
  const missing: string[] = [];
  const objects: RigObject[] = [];
  for (const object of preset.objects) {
    let next = object;
    if (isAssetRef(object.image) && object.image) {
      const source = await inlineSource(object.image);
      if (source) { next = { ...next, image: source }; changed = true; }
      else missing.push(`${object.name} (картинка)`);
    }
    if (next.media?.src && isAssetRef(next.media.src)) {
      const source = await inlineSource(next.media.src);
      if (source) { next = { ...next, media: { ...next.media, src: source } }; changed = true; }
      else missing.push(`${object.name} (${next.media.fileName || "файл"})`);
    }
    if (next.mask?.kind === "file" && next.mask.file && isAssetRef(next.mask.file)) {
      const source = await inlineSource(next.mask.file);
      if (source) { next = { ...next, mask: { ...next.mask, file: source } }; changed = true; }
      else missing.push(`${object.name} (маска)`);
    }
    if (next.normal?.src && isAssetRef(next.normal.src)) {
      const source = await inlineSource(next.normal.src);
      if (source) { next = { ...next, normal: { ...next.normal, src: source } }; changed = true; }
      else missing.push(`${object.name} (карта нормалей)`);
    }
    objects.push(next);
  }
  return { preset: changed ? { ...preset, objects } : preset, missing };
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
