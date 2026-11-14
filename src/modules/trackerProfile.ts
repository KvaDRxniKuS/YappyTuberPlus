import type { ExternalSourceConfig, RigPreset, TrackerCalibration } from "../types";
import { readCalibration } from "./external";
import { isTrackerTransport, trackerPorts, type TrackerTransport } from "./tracker";

/**
 * Профиль приложения для трекера лица: адрес телефона, порты и эталон позы.
 *
 * Эти три вещи описывают **эту машину и этот телефон**, а не риг: адрес — точка
 * в домашней сети, порты — настройка конкретного приложения на конкретном
 * устройстве, эталон — положение телефона на этом столе. Риг же переносят на
 * другой компьютер и выкладывают; чужие координаты в нём только мешают —
 * приёмник искал бы телефон в чужой подсети.
 *
 * Поэтому профиль живёт там же, где токен Twitch и пароль obs-websocket: в
 * профиле окна, отдельно от пресета. А отображение (какие поля и под какими
 * именами модуль отдаёт) остаётся в риге — это часть сцены.
 *
 * Настройка читается по транспорту, а не по имени модуля: телефон один на
 * iFacialMocap, переименование модуля адрес не меняет.
 */

export interface TrackerProfile {
  /** Адрес телефона; пусто — рукопожатие идёт широковещательно. */
  host: string;
  /** Порт приложения на телефоне. */
  port: number;
  /** Порт, на который приходят кадры. */
  listenPort: number;
  /** Эталон позы; нет — кадр идёт как есть. */
  calibration?: TrackerCalibration;
}

const PROFILE_KEY = "yappytuber.trackers.v1";

/**
 * Запасное хранилище: без окна (проверки, серверный рендер) профиль живёт в
 * памяти процесса. Приватный режим браузера тоже сюда падает — запомнить
 * адрес до перезапуска не выйдет, но работать карточка не перестанет.
 */
const memory = new Map<string, string>();

function store(): Storage | null {
  try {
    return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

function readText(): string | null {
  try {
    const saved = store();
    if (saved) return saved.getItem(PROFILE_KEY);
  } catch { /* приватный режим: читаем из памяти */ }
  return memory.get(PROFILE_KEY) ?? null;
}

function writeText(text: string): void {
  try {
    const saved = store();
    if (saved) {
      saved.setItem(PROFILE_KEY, text);
      return;
    }
  } catch { /* приватный режим: пишем в память */ }
  memory.set(PROFILE_KEY, text);
}

type Raw = Record<string, unknown>;

/** Все записи профиля: мусор и незнакомые транспорты отбрасываются. */
function readAll(): Record<string, Raw> {
  const text = readText();
  if (!text) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const all: Record<string, Raw> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isTrackerTransport(key) || !value || typeof value !== "object" || Array.isArray(value)) continue;
    all[key] = { ...(value as Raw) };
  }
  return all;
}

function writeAll(all: Record<string, Raw>): void {
  const clean: Record<string, Raw> = {};
  for (const [key, value] of Object.entries(all)) {
    if (isTrackerTransport(key) && Object.keys(value).length > 0) clean[key] = value;
  }
  writeText(JSON.stringify(clean));
}

/** Порт из записи профиля: строка тоже годится, мусор — нет. */
function readPort(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 65_535 ? Math.round(parsed) : undefined;
}

/** Что записано про транспорт; `null` — профиль для него ещё не заведён. */
function storedRecord(transport: TrackerTransport): Raw | null {
  const record = readAll()[transport];
  return record && Object.keys(record).length > 0 ? record : null;
}

/** Адрес, порты и эталон для транспорта: умолчания шаблона — если не записано. */
export function readTrackerProfile(transport: TrackerTransport): TrackerProfile {
  const record = storedRecord(transport) ?? {};
  const ports = trackerPorts(record as Partial<ExternalSourceConfig>, transport);
  return {
    host: typeof record.host === "string" ? record.host.trim() : "",
    port: ports.port,
    listenPort: ports.listenPort,
    calibration: readCalibration(record.calibration),
  };
}

/**
 * Записывает настройки транспорта. Ключ, которого нет в `change`, не трогается;
 * явный `undefined` стирает запись (сброс эталона, очистка адреса).
 */
export function writeTrackerProfile(
  transport: TrackerTransport,
  change: Partial<TrackerProfile>,
): TrackerProfile {
  const all = readAll();
  const record: Raw = { ...(all[transport] ?? {}) };
  if ("host" in change) {
    const host = typeof change.host === "string" ? change.host.trim() : "";
    if (host) record.host = host;
    else delete record.host;
  }
  for (const key of ["port", "listenPort"] as const) {
    if (!(key in change)) continue;
    const value = Number(change[key]);
    if (Number.isFinite(value) && value >= 1 && value <= 65_535) record[key] = Math.round(value);
    else delete record[key];
  }
  if ("calibration" in change) {
    const calibration = readCalibration(change.calibration);
    if (calibration) record.calibration = calibration;
    else delete record.calibration;
  }
  all[transport] = record;
  writeAll(all);
  return readTrackerProfile(transport);
}

/** Забыть настройки транспорта (или всего профиля) — для «Сбросить» и проверок. */
export function forgetTrackerProfile(transport?: TrackerTransport): void {
  if (!transport) {
    writeAll({});
    return;
  }
  const all = readAll();
  delete all[transport];
  writeAll(all);
}

/**
 * Настройки источника с подмешанным профилем.
 *
 * Профиль главнее пресета, но **только там, где он что-то помнит**: иначе
 * открытый чужой риг стирал бы адрес своей машины пустотой, а старый пресет с
 * адресом внутри терял бы его при первом же чтении.
 */
export function sourceWithProfile(source: ExternalSourceConfig): ExternalSourceConfig {
  if (!isTrackerTransport(source.transport)) return source;
  const transport = source.transport;
  const record = storedRecord(transport);
  if (!record) return source;
  const ports = trackerPorts({
    port: readPort(record.port) ?? source.port,
    listenPort: readPort(record.listenPort) ?? source.listenPort,
  }, transport);
  return {
    ...source,
    host: typeof record.host === "string" ? record.host.trim() : source.host ?? "",
    port: ports.port,
    listenPort: ports.listenPort,
    calibration: readCalibration(record.calibration) ?? source.calibration,
  };
}

/** Модули пресета, у которых источник — трекер: `(транспорт, сырые настройки)`. */
function trackerSources(preset: RigPreset): Array<{ transport: TrackerTransport; source: Raw }> {
  const found: Array<{ transport: TrackerTransport; source: Raw }> = [];
  for (const module of preset.modules) {
    const config = module.config as Raw | undefined;
    const source = config?.source;
    if (!config || !source || typeof source !== "object") continue;
    const transport = (source as Raw).transport;
    if (typeof transport !== "string" || !isTrackerTransport(transport)) continue;
    found.push({ transport, source: source as Raw });
  }
  return found;
}

/**
 * Убирает машинные настройки из пресета: файл рига их не содержит.
 *
 * Вызывается при записи файла и при автосохранении, поэтому адрес телефона не
 * уезжает вместе с ригом даже в браузерном хранилище.
 */
export function stripTrackerProfile(preset: RigPreset): RigPreset {
  let touched = false;
  const modules = preset.modules.map((module) => {
    const config = module.config as Raw | undefined;
    const source = config?.source;
    if (!config || !source || typeof source !== "object") return module;
    const raw = source as Raw;
    const transport = raw.transport;
    if (typeof transport !== "string" || !isTrackerTransport(transport)) return module;
    if (raw.host === undefined && raw.port === undefined && raw.listenPort === undefined
      && raw.calibration === undefined) return module;
    const { host: _host, port: _port, listenPort: _listenPort, calibration: _calibration, ...rest } = raw;
    touched = true;
    return { ...module, config: { ...config, source: rest as unknown as ExternalSourceConfig } };
  });
  return touched ? { ...preset, modules } : preset;
}

/**
 * Первый запуск после обновления: машинные настройки из автосохранения
 * переезжают в профиль, а из пресета уходят.
 *
 * Только для автосохранения — это настройки **этой** машины. Открытый файл так
 * не читается: чужой адрес телефона в профиль не попадает, он просто
 * отбрасывается (`stripTrackerProfile`).
 */
export function adoptTrackerProfile(preset: RigPreset): RigPreset {
  const stored = readAll();
  const adopted = new Set<TrackerTransport>();
  for (const { transport, source } of trackerSources(preset)) {
    if (adopted.has(transport)) continue;
    adopted.add(transport);
    // Профиль уже заведён — он главнее пресета.
    if (stored[transport]) continue;
    const change: Partial<TrackerProfile> = {};
    if (typeof source.host === "string" && source.host.trim()) change.host = source.host.trim();
    if (source.port !== undefined) change.port = Number(source.port);
    if (source.listenPort !== undefined) change.listenPort = Number(source.listenPort);
    const calibration = readCalibration(source.calibration);
    if (calibration) change.calibration = calibration;
    if (Object.keys(change).length === 0) continue;
    writeTrackerProfile(transport, change);
  }
  return stripTrackerProfile(preset);
}
