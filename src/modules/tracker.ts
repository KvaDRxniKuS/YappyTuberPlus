import type { ExternalSourceConfig, ExternalSourceRule } from "../types";

/**
 * Трекер лица: прямой приём значений с телефона, без посредников.
 *
 * Три приложения говорят по-разному, но отдают одно и то же: 52 блендшейпа
 * ARKit (0…1), повороты головы и глаз в градусах и положение головы. Поэтому
 * разбор живёт здесь, а модули всего лишь выбирают приложение: смена трекера
 * не переписывает таблицу отображения, пока она написана по общим путям
 * (`$.arkit.jawOpen`, `$.head.rx`).
 *
 * iFacialMocap и Facemotion3D шлют строку `имя-значение|имя-значение|…|` и
 * отдельные блоки `=head#…`, `rightEye#…`, `leftEye#…`; значения у них в
 * процентах, поэтому делятся на 100. Facemotion3D умеет отрицательные значения
 * и разделяет имя и число символом `&`. VTube Studio шлёт JSON: массив
 * `BlendShapes` из пар `k/v`, `Rotation`, `Position`, `EyeLeft`, `EyeRight`.
 *
 * Рукопожатие тоже разное, и оно важно: приложения молчат, пока их не попросят.
 * iFacialMocap ждёт строку-пароль на свой порт 49983 и отвечает потоком на порт
 * 49983 компьютера; VTube Studio ждёт JSON-запрос на 21412 и льёт поток на
 * порты, перечисленные в запросе. Отсюда `helloFor`: одна функция для Rust,
 * которая делает приёмник, и для проверок.
 */

export type TrackerTransport = "ifacialmocap" | "vtuberstudio" | "facemotion3d";

/** Три отдельных модуля: у каждого своё приложение и свои порты. */
export const TRACKER_TRANSPORTS: TrackerTransport[] = ["ifacialmocap", "vtuberstudio", "facemotion3d"];

export function isTrackerTransport(transport: string): transport is TrackerTransport {
  return (TRACKER_TRANSPORTS as string[]).includes(transport);
}

export interface TrackerInfo {
  /** Подпись приложения: она же заголовок карточки модуля. */
  label: string;
  /** Порт приложения на телефоне: туда уходит рукопожатие. */
  port: number;
  /** Порт приёма на компьютере: сюда приходят кадры. */
  listenPort: number;
  /** Поколение протокола: строка с `&` (2) или с `-` (1). */
  version: 1 | 2;
  /** Что сделать в приложении, чтобы оно вообще начало слать. */
  setup: string;
  note: string;
}

export const TRACKER_INFO: Record<TrackerTransport, TrackerInfo> = {
  ifacialmocap: {
    label: "iFacialMocap",
    port: 49983,
    listenPort: 49983,
    version: 1,
    setup: "iFacialMocap → шестерёнка → Destination: IP компьютера, порт 49983",
    note: "Поток идёт на порт 49983 компьютера: его нельзя занимать другой программой.",
  },
  vtuberstudio: {
    label: "VTube Studio (телефон)",
    port: 21412,
    listenPort: 21412,
    version: 1,
    setup: "VTube Studio на телефоне → настройки → «3rd Party PC Clients» включить",
    note: "Номер порта приложение показывает само: если он не 21412, впишите свой.",
  },
  facemotion3d: {
    label: "Facemotion3D",
    port: 49983,
    listenPort: 49983,
    version: 2,
    setup: "Facemotion3D → шестерёнка → Destination: IP компьютера, порт 49983",
    note: "Значения могут быть отрицательными: шкала −100…100, делим на 100 без обрезки.",
  },
};

/** Строка-пароль iFacialMocap и Facemotion3D: без неё приложение молчит. */
export const IFM_HELLO = "iFacialMocap_sahuasouryya9218sauhuiayeta91555dy3719";

/**
 * Рукопожатие для приложения: им приёмник просит поток и указывает свой порт.
 *
 * У iFacialMocap порт приёма фиксирован (49983), поэтому в строке его нет.
 * У VTube Studio порт приёма называет сам клиент — он и попадает в `ports`.
 * `time` — сколько секунд слать: единица при запросе пять раз в секунду держит
 * поток непрерывным, а после закрытия приложения он гаснет сам.
 */
export function helloFor(transport: TrackerTransport, listenPort: number): string {
  if (transport === "vtuberstudio") {
    return JSON.stringify({
      messageType: "iOSTrackingDataRequest",
      time: 1,
      sentBy: "YappyTuberPlus",
      ports: [listenPort],
    });
  }
  if (transport === "facemotion3d") return `${IFM_HELLO}|sendDataVersion=v2`;
  return IFM_HELLO;
}

/** Порты модуля: явные из настроек или умолчания приложения. */
export function trackerPorts(source: Partial<ExternalSourceConfig>, transport: TrackerTransport): {
  port: number;
  listenPort: number;
} {
  const info = TRACKER_INFO[transport];
  return {
    port: clampPort(source.port, info.port),
    listenPort: clampPort(source.listenPort, info.listenPort),
  };
}

function clampPort(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const port = Math.round(parsed);
  return port >= 1 && port <= 65_535 ? port : fallback;
}

export type TrackerGroup = "arkit" | "head" | "eye" | "service";

/** Поле кадра в виде, пригодном и для таблицы отображения, и для живой таблицы. */
export interface TrackerField {
  /** Путь в кадре: `$.arkit.jawOpen`. */
  path: string;
  /** Ключ без `$.`: `arkit.jawOpen`. */
  key: string;
  label: string;
  group: TrackerGroup;
  kind: "level" | "flag";
  min: number;
  max: number;
  step: number;
}

/** 52 блендшейпа ARKit: одинаковые имена у обоих форматов после `armName`. */
const ARKIT_SHAPES: Array<[string, string]> = [
  ["browDownLeft", "Бровь вниз (левая)"],
  ["browDownRight", "Бровь вниз (правая)"],
  ["browInnerUp", "Внутренние брови вверх"],
  ["browOuterUpLeft", "Внешняя бровь вверх (левая)"],
  ["browOuterUpRight", "Внешняя бровь вверх (правая)"],
  ["cheekPuff", "Щёки надуты"],
  ["cheekSquintLeft", "Щёки прищурены (левая)"],
  ["cheekSquintRight", "Щёки прищурены (правая)"],
  ["eyeBlinkLeft", "Моргание (левый глаз)"],
  ["eyeBlinkRight", "Моргание (правый глаз)"],
  ["eyeLookDownLeft", "Взгляд вниз (левый)"],
  ["eyeLookDownRight", "Взгляд вниз (правый)"],
  ["eyeLookInLeft", "Взгляд внутрь (левый)"],
  ["eyeLookInRight", "Взгляд внутрь (правый)"],
  ["eyeLookOutLeft", "Взгляд наружу (левый)"],
  ["eyeLookOutRight", "Взгляд наружу (правый)"],
  ["eyeLookUpLeft", "Взгляд вверх (левый)"],
  ["eyeLookUpRight", "Взгляд вверх (правый)"],
  ["eyeSquintLeft", "Прищур (левый глаз)"],
  ["eyeSquintRight", "Прищур (правый глаз)"],
  ["eyeWideLeft", "Широко открыт (левый)"],
  ["eyeWideRight", "Широко открыт (правый)"],
  ["jawForward", "Челюсть вперёд"],
  ["jawLeft", "Челюсть влево"],
  ["jawOpen", "Рот открыт"],
  ["jawRight", "Челюсть вправо"],
  ["mouthClose", "Губы сомкнуты"],
  ["mouthDimpleLeft", "Ямочка (левая)"],
  ["mouthDimpleRight", "Ямочка (правая)"],
  ["mouthFrownLeft", "Уголок вниз (левый)"],
  ["mouthFrownRight", "Уголок вниз (правый)"],
  ["mouthFunnel", "Губы трубочкой"],
  ["mouthLeft", "Рот влево"],
  ["mouthLowerDownLeft", "Нижняя губа вниз (левая)"],
  ["mouthLowerDownRight", "Нижняя губа вниз (правая)"],
  ["mouthPressLeft", "Губы сжаты (левая)"],
  ["mouthPressRight", "Губы сжаты (правая)"],
  ["mouthPucker", "Губы собраны"],
  ["mouthRight", "Рот вправо"],
  ["mouthRollLower", "Нижняя губа внутрь"],
  ["mouthRollUpper", "Верхняя губа внутрь"],
  ["mouthShrugLower", "Нижняя губа вверх"],
  ["mouthShrugUpper", "Верхняя губа вверх"],
  ["mouthSmileLeft", "Улыбка (левая)"],
  ["mouthSmileRight", "Улыбка (правая)"],
  ["mouthStretchLeft", "Растянуть (левая)"],
  ["mouthStretchRight", "Растянуть (правая)"],
  ["mouthUpperUpLeft", "Верхняя губа вверх (левая)"],
  ["mouthUpperUpRight", "Верхняя губа вверх (правая)"],
  ["noseSneerLeft", "Нос сморщен (левый)"],
  ["noseSneerRight", "Нос сморщен (правый)"],
  ["tongueOut", "Язык высунут"],
];

/** Повороты и положение: градусы у поворотов, сантиметры у положения. */
const HEAD_AXES: Array<[string, string]> = [
  ["rx", "Поворот: наклон (X)"],
  ["ry", "Поворот: поворот (Y)"],
  ["rz", "Поворот: наклон вбок (Z)"],
  ["x", "Положение X"],
  ["y", "Положение Y"],
  ["z", "Положение Z"],
];

const EYE_AXES: Array<[string, string]> = [
  ["rx", "Наклон (X)"],
  ["ry", "Поворот (Y)"],
  ["rz", "Скрутка (Z)"],
];

function field(path: string, label: string, group: TrackerGroup, range: { min: number; max: number; step: number }): TrackerField {
  return {
    path: `$.${path}`,
    key: path,
    label,
    group,
    kind: "level",
    min: range.min,
    max: range.max,
    step: range.step,
  };
}

/**
 * Каталог полей: один для всех трёх приложений.
 *
 * Порядок — как в таблице: сначала лицо, потом голова, глаза и служебные поля.
 * Держим его стабильным, чтобы «+» добавлял строку туда, где её ждут.
 */
export const TRACKER_FIELDS: TrackerField[] = [
  ...ARKIT_SHAPES.map(([key, label]) => field(`arkit.${key}`, label, "arkit", { min: 0, max: 1, step: 0.01 })),
  ...HEAD_AXES.map(([axis, label]) => field(`head.${axis}`, label, "head", axis.startsWith("r")
    ? { min: -90, max: 90, step: 0.1 }
    : { min: -20, max: 20, step: 0.01 })),
  ...EYE_AXES.map(([axis, label]) => field(`eyeLeft.${axis}`, `Левый глаз: ${label.toLowerCase()}`, "eye", { min: -90, max: 90, step: 0.1 })),
  ...EYE_AXES.map(([axis, label]) => field(`eyeRight.${axis}`, `Правый глаз: ${label.toLowerCase()}`, "eye", { min: -90, max: 90, step: 0.1 })),
  // Служебные: «лицо найдено» — флаг, номер нажатой кнопки на экране телефона.
  { path: "$.faceFound", key: "faceFound", label: "Лицо найдено", group: "service", kind: "flag", min: 0, max: 1, step: 1 },
  { path: "$.hotkey", key: "hotkey", label: "Кнопка на экране телефона", group: "service", kind: "level", min: 0, max: 8, step: 1 },
];

const FIELD_BY_PATH = new Map(TRACKER_FIELDS.map((item) => [item.path, item]));
const FIELD_BY_KEY = new Map(TRACKER_FIELDS.map((item) => [item.key, item]));

export function trackerField(path: string): TrackerField | undefined {
  return FIELD_BY_PATH.get(path) ?? FIELD_BY_KEY.get(path.replace(/^\$\./, ""));
}

/**
 * Имя входа по умолчанию: `$.arkit.jawOpen` → `jawopen`, `$.head.rx` → `head_rx`.
 *
 * Имена входов в проекте латиницей в нижнем регистре (`mic.speak`, `twitch.cheer`),
 * и пресет всё равно приведёт их к этому виду: предлагать `jawOpen` значило бы
 * показывать одно, а записывать другое.
 */
export function trackerInputName(item: TrackerField): string {
  if (item.group === "arkit") return item.key.replace(/^arkit\./, "").toLowerCase();
  if (item.group === "service") return item.key === "faceFound" ? "face_found" : item.key;
  return item.key.replace(/\./g, "_").toLowerCase();
}

/**
 * Имена ARKit из обоих форматов к одному виду.
 *
 * iFacialMocap пишет сторону суффиксом `_L`/`_R` (`eyeBlink_L`), VTube Studio —
 * словом (`EyeBlinkLeft`). Общее имя — второе: по нему и строятся пути.
 */
export function armName(raw: string): string {
  // Мусор перед именем встречается в живом потоке (`?cheekSquint_R`): он не
  // должен становиться частью входа. Пустая строка означает «не имя».
  const name = raw.trim().replace(/^=/, "").replace(/^[^A-Za-z]+/, "");
  if (!name) return "";
  const side = /_([LR])$/.exec(name);
  const base = side ? name.slice(0, -2) : name;
  // Хвосты вроде `34903,-1.66,` от приложения — не имена блендшейпов.
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(base)) return "";
  const camel = base.charAt(0).toLowerCase() + base.slice(1);
  if (!side) return camel;
  return `${camel}${side[1] === "L" ? "Left" : "Right"}`;
}

function numberList(raw: string): number[] {
  return raw
    .split(",")
    .map((piece) => Number(piece.trim()))
    .filter((value) => Number.isFinite(value));
}

/**
 * Кадр iFacialMocap / Facemotion3D.
 *
 * Разделители нарочно разбираются терпимо: в живом потоке встречаются скобки
 * (приложение иногда перемешивает блоки) и хвост `___iFacialMocap` от TCP-режима.
 * Значение отделяется последним `&` (версия 2) или последним `-` (версия 1):
 * имена дефиса не содержат, поэтому граница находится однозначно.
 */
export function parseIfacialFrame(text: string): Record<string, unknown> | null {
  let body = text.replace(/\u0000/g, "").trim();
  const cut = body.indexOf("___iFacialMocap");
  if (cut >= 0) body = body.slice(0, cut);
  body = body.replace(/[()]/g, "|");
  const arkit: Record<string, number> = {};
  const head: Record<string, number> = {};
  const eyeLeft: Record<string, number> = {};
  const eyeRight: Record<string, number> = {};
  let seen = false;
  for (const token of body.split("|")) {
    const part = token.trim();
    if (!part) continue;
    const hash = part.indexOf("#");
    if (hash >= 0) {
      const name = part.slice(0, hash).replace(/^=/, "").trim().toLowerCase();
      const numbers = numberList(part.slice(hash + 1));
      if (name === "head" || name === "headrotation") {
        if (numbers.length < 3) continue;
        head.rx = numbers[0];
        head.ry = numbers[1];
        head.rz = numbers[2];
        // Положение приходит шестью числами; у Facemotion3D его может не быть.
        if (numbers.length >= 6) {
          head.x = numbers[3];
          head.y = numbers[4];
          head.z = numbers[5];
        }
        seen = true;
      } else if (name === "righteye" || name === "lefteye") {
        if (numbers.length < 3) continue;
        const target = name === "righteye" ? eyeRight : eyeLeft;
        target.rx = numbers[0];
        target.ry = numbers[1];
        target.rz = numbers[2];
        seen = true;
      }
      continue;
    }
    const amp = part.lastIndexOf("&");
    const dash = part.lastIndexOf("-");
    const edge = amp >= 0 ? amp : dash;
    if (edge <= 0) continue;
    const name = armName(part.slice(0, edge));
    const value = Number(part.slice(edge + 1).trim());
    if (!name || !Number.isFinite(value)) continue;
    // Проценты в доли: 0…100 → 0…1. Отрицательные не обрезаем — они значат
    // движение в обратную сторону, и обрезка убила бы половину мимики.
    arkit[name] = value / 100;
    seen = true;
  }
  if (!seen) return null;
  return {
    arkit,
    head,
    eyeLeft,
    eyeRight,
    faceFound: 1,
    hotkey: 0,
    ts: Date.now(),
  };
}

function readVector(raw: unknown): Record<string, number> {
  const result: Record<string, number> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return result;
  const item = raw as Record<string, unknown>;
  for (const axis of ["x", "y", "z"]) {
    const value = Number(item[axis]);
    if (Number.isFinite(value)) result[axis] = value;
  }
  return result;
}

/**
 * Кадр VTube Studio: JSON с блендшейпами в долях и градусами поворотов.
 *
 * Поля ищутся в обоих регистрах: Unity отдаёт `FaceFound`/`BlendShapes`, но
 * приложению ничто не мешает прислать `faceFound`. Незнакомые поля не ломают
 * разбор — протокол обещает их добавлять.
 */
export function parseVtuberStudioFrame(text: string): Record<string, unknown> | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const item = data as Record<string, unknown>;
  const arkit: Record<string, number> = {};
  const blends = item.BlendShapes ?? item.blendShapes ?? item.blend_shapes;
  if (Array.isArray(blends)) {
    for (const entry of blends) {
      if (!entry || typeof entry !== "object") continue;
      const pair = entry as Record<string, unknown>;
      const name = armName(String(pair.k ?? pair.K ?? pair.key ?? ""));
      const value = Number(pair.v ?? pair.V ?? pair.value);
      if (name && Number.isFinite(value)) arkit[name] = value;
    }
  }
  // Unity шлёт векторы как `x/y/z`, а кадр трекера живёт на осях `rx/ry/rz`:
  // угол и координата — разные величины, и складывать их в один ключ нельзя.
  const head: Record<string, number> = {};
  const rotation = readVector(item.Rotation ?? item.rotation);
  if (rotation.x !== undefined) head.rx = rotation.x;
  if (rotation.y !== undefined) head.ry = rotation.y;
  if (rotation.z !== undefined) head.rz = rotation.z;
  const position = readVector(item.Position ?? item.position);
  if (position.x !== undefined) head.x = position.x;
  if (position.y !== undefined) head.y = position.y;
  if (position.z !== undefined) head.z = position.z;
  const asAngles = (raw: Record<string, number>): Record<string, number> => {
    const angles: Record<string, number> = {};
    if (raw.x !== undefined) angles.rx = raw.x;
    if (raw.y !== undefined) angles.ry = raw.y;
    if (raw.z !== undefined) angles.rz = raw.z;
    return angles;
  };
  const eyeLeft = asAngles(readVector(item.EyeLeft ?? item.eyeLeft));
  const eyeRight = asAngles(readVector(item.EyeRight ?? item.eyeRight));
  const found = item.FaceFound ?? item.faceFound;
  const hotkey = Number(item.Hotkey ?? item.hotkey);
  if (Object.keys(arkit).length === 0 && Object.keys(head).length === 0
    && Object.keys(eyeLeft).length === 0 && Object.keys(eyeRight).length === 0) {
    return null;
  }
  return {
    arkit,
    head,
    eyeLeft,
    eyeRight,
    faceFound: found === false || found === 0 ? 0 : 1,
    hotkey: Number.isFinite(hotkey) && hotkey > 0 ? Math.round(hotkey) : 0,
    ts: Number(item.Timestamp ?? item.timestamp) || Date.now(),
  };
}

/** Кадр трекера: приложение выбирает разбор, пути общие. */
export function parseTrackerFrame(text: string, transport: TrackerTransport): Record<string, unknown> | null {
  if (transport === "vtuberstudio") return parseVtuberStudioFrame(text);
  return parseIfacialFrame(text);
}

/**
 * Плоские числа кадра для живой таблицы: `{ "arkit.jawOpen": 0.12 }`.
 *
 * Служебное время сюда не попадает: в таблице полей его нет, а сравнивать
 * каждое обновление пришлось бы по нему одному.
 */
export function flattenFrame(value: unknown, prefix = ""): Record<string, number> {
  const result: Record<string, number> = {};
  if (typeof value === "number") {
    if (prefix && Number.isFinite(value)) result[prefix] = value;
    return result;
  }
  if (typeof value === "boolean") {
    if (prefix) result[prefix] = value ? 1 : 0;
    return result;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!prefix && key === "ts") continue;
    Object.assign(result, flattenFrame(item, prefix ? `${prefix}.${key}` : key));
  }
  return result;
}

/**
 * Какие поля калибруются: голова и глаза.
 *
 * Мимика (52 блендшейпа ARKit) не калибруется никогда: её значения — и есть
 * лицо. Служебные поля (`faceFound`, `hotkey`) — тоже нет: ноль не значит
 * «смотрит вниз», а номер кнопки вообще не поза.
 */
export function calibratablePath(key: string): boolean {
  const flat = key.replace(/^\$\./, "");
  return /^(head|eyeLeft|eyeRight)\./.test(flat);
}

/**
 * Эталон из текущего кадра: значения головы и глаз, снятые как «здесь и сейчас».
 *
 * Пусто — калибровать нечем (лицо не найдено или телефон ещё молчит): тогда
 * эталон не пишется, а карточка говорит, почему.
 */
export function calibrationOffsets(frame: Record<string, number>): Record<string, number> {
  const offsets: Record<string, number> = {};
  for (const [key, value] of Object.entries(frame)) {
    if (!calibratablePath(key) || !Number.isFinite(value)) continue;
    offsets[key] = value;
  }
  return offsets;
}

/** Значение после калибровки: из кадра вычитается эталон. */
export function calibratedValue(value: number | undefined, offset: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (offset === undefined || !Number.isFinite(value)) return value;
  return value - offset;
}

/** Результат поиска: найденные адреса и что сказать, если их нет. */
export interface TrackerDiscovery {
  hosts: string[];
  message: string | null;
}

/**
 * Поиск телефона в сети: широковещательное рукопожатие и сбор ответов.
 *
 * Работает только в приложении — UDP из вебвью недоступен. Ошибка не бросается:
 * панель показывает её текстом, а не падает.
 */
export async function discoverTrackers(
  transport: TrackerTransport,
  port: number,
): Promise<TrackerDiscovery> {
  const { isTauri } = await import("../engine/presetFile");
  if (!isTauri()) {
    return { hosts: [], message: "поиск идёт по UDP: откройте приложение, в браузере он недоступен" };
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    // Параметр команды называется `config`: Tauri разбирает аргументы по имени.
    const hosts = await invoke<string[]>("tracker_discover", { config: { transport, port } });
    if (hosts.length === 0) {
      return {
        hosts,
        message: "никто не отозвался: проверьте, что телефон в той же сети и приложение открыто; можно вписать IP вручную",
      };
    }
    return { hosts, message: null };
  } catch (reason) {
    return { hosts: [], message: reason instanceof Error ? reason.message : String(reason) };
  }
}

/**
 * Имя входа, которого ещё нет в отображении: `jawopen`, затем `jawopen_2`, `jawopen_3`.
 * Общее для галочки у поля и для «выбрать все»: два поля с одним именем затирали
 * бы друг друга, а имена входов должны оставаться предсказуемыми.
 */
export function uniqueTrackerInput(field: TrackerField, used: Set<string>): string {
  const base = trackerInputName(field);
  let input = base;
  let suffix = 2;
  while (used.has(input)) {
    input = `${base}_${suffix}`;
    suffix += 1;
  }
  return input;
}

/** Отмечены ли все поля трекера. Пустое отображение — «не все». */
export function allTrackerFieldsMapped(mapping: { path: string }[]): boolean {
  return TRACKER_FIELDS.every((field) => mapping.some((rule) => rule.path === field.path));
}

/** Отображение полей трекера есть хотя бы одно — для промежуточного состояния галочки. */
export function anyTrackerFieldMapped(mapping: { path: string }[]): boolean {
  return TRACKER_FIELDS.some((field) => mapping.some((rule) => rule.path === field.path));
}

/** Строка отображения по полю — ровно то, что создаёт галочка у поля. */
export function trackerRule(field: TrackerField, input: string): ExternalSourceRule {
  return {
    input,
    path: field.path,
    label: field.label,
    kind: field.kind,
    min: field.min,
    max: field.max,
    holdMs: 0,
  };
}

/**
 * «Выбрать все»: добавить недостающие поля со свободными именами входов.
 * Чужие строки (не поля трекера) остаются на месте, уже отмеченные — тоже:
 * повторное нажатие ничего не дублирует.
 */
export function selectAllTrackerFields(mapping: ExternalSourceRule[]): ExternalSourceRule[] {
  const result = [...mapping];
  const used = new Set(result.map((rule) => rule.input));
  for (const field of TRACKER_FIELDS) {
    if (result.some((rule) => rule.path === field.path)) continue;
    const input = uniqueTrackerInput(field, used);
    used.add(input);
    result.push(trackerRule(field, input));
  }
  return result;
}

/** «Снять все»: убрать из отображения только поля трекера. */
export function clearAllTrackerFields(mapping: ExternalSourceRule[]): ExternalSourceRule[] {
  return mapping.filter((rule) => !TRACKER_FIELDS.some((field) => field.path === rule.path));
}
