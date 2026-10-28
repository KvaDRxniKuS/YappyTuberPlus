/**
 * OBS через obs-websocket v5 (OBS 28+).
 *
 * Зачем свой клиент, а не библиотека: нужен ровно один сценарий — «возьми
 * картинку участка сцены OBS». Всё остальное (сцены, элементы, трансформация)
 * нужно только чтобы понять, **где** этот участок.
 *
 * Что важно знать про протокол:
 *
 * - при подключении OBS присылает `Hello` с `rpcVersion` и, если включена
 *   авторизация, `challenge`/`salt`;
 * - пароль не передаётся как есть: `base64(sha256(base64(sha256(пароль+salt)) +
 *   challenge))`. Считаем сами, без `crypto.subtle`: в WebView2 он доступен не
 *   везде (нужен «безопасный контекст»), а SHA-256 — шестьдесят строк;
 * - запросы и ответы ходят по `requestId`, события приходят сами.
 *
 * Пароль здесь **не хранится в пресете**: он лежит в настройках приложения
 * (`localStorage` профиля окна), как токен Twitch. Пресет можно выкладывать.
 */

export interface ObsStatus {
  /** Что показать человеку: «подключено», «нет соединения», «пароль не подошёл». */
  text: string;
  ok: boolean;
}

export interface ObsAuthChallenge {
  challenge: string;
  salt: string;
}

export interface ObsTransform {
  positionX: number;
  positionY: number;
  /** Ширина элемента на сцене уже с учётом масштаба и обрезки. */
  width: number;
  height: number;
  cropLeft: number;
  cropTop: number;
  cropRight: number;
  cropBottom: number;
  rotation: number;
}

export interface ObsVideoSettings {
  baseWidth: number;
  baseHeight: number;
}

/* ------------------------------------------------------------------ */
/* SHA-256 и base64                                                    */
/* ------------------------------------------------------------------ */

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const rotr = (value: number, bits: number) => (value >>> bits) | (value << (32 - bits));

/** SHA-256 от байтов. Возвращает 32 байта. */
export function sha256(input: Uint8Array): Uint8Array {
  const length = input.length;
  const withPadding = new Uint8Array((((length + 9) >> 6) + 1) * 64);
  withPadding.set(input);
  withPadding[length] = 0x80;
  const view = new DataView(withPadding.buffer);
  // Длина в битах: два слова по 32 бита, старшее почти всегда ноль.
  view.setUint32(withPadding.length - 8, Math.floor((length * 8) / 0x100000000));
  view.setUint32(withPadding.length - 4, (length * 8) >>> 0);

  const hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Uint32Array(64);
  for (let offset = 0; offset < withPadding.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) w[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotr(w[index - 15], 7) ^ rotr(w[index - 15], 18) ^ (w[index - 15] >>> 3);
      const s1 = rotr(w[index - 2], 17) ^ rotr(w[index - 2], 19) ^ (w[index - 2] >>> 10);
      w[index] = (w[index - 16] + s0 + w[index - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + s1 + ch + K[index] + w[index]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0; hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0; hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0; hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0; hash[7] = (hash[7] + h) >>> 0;
  }
  const result = new Uint8Array(32);
  const out = new DataView(result.buffer);
  hash.forEach((word, index) => out.setUint32(index * 4, word));
  return result;
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** base64 от байтов. Без `btoa`: он есть не везде и капризен с юникодом. */
export function base64(bytes: Uint8Array): string {
  let result = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = index + 1 < bytes.length ? bytes[index + 1] : undefined;
    const c = index + 2 < bytes.length ? bytes[index + 2] : undefined;
    result += BASE64[a >> 2];
    result += BASE64[((a & 0b11) << 4) | ((b ?? 0) >> 4)];
    result += b === undefined ? "=" : BASE64[((b & 0b1111) << 2) | ((c ?? 0) >> 6)];
    result += c === undefined ? "=" : BASE64[c & 0b111111];
  }
  return result;
}

/** UTF-8 байты строки: пароль может быть любым, а хеш считается по байтам. */
export function utf8(text: string): Uint8Array {
  const encoded = typeof TextEncoder !== "undefined" ? new TextEncoder().encode(text) : null;
  if (encoded) return encoded;
  const escaped = unescape(encodeURIComponent(text));
  const bytes = new Uint8Array(escaped.length);
  for (let index = 0; index < escaped.length; index += 1) bytes[index] = escaped.charCodeAt(index);
  return bytes;
}

/**
 * Ответ на запрос авторизации OBS.
 *
 * `null` — авторизация не требуется (OBS сам не прислал `challenge`).
 * Формула из документации obs-websocket v5:
 * `base64(sha256(base64(sha256(пароль + salt)) + challenge))`.
 */
export function obsAuth(password: string, challenge: ObsAuthChallenge | null | undefined): string | null {
  if (!challenge) return null;
  const secret = base64(sha256(utf8(`${password}${challenge.salt}`)));
  return base64(sha256(utf8(`${secret}${challenge.challenge}`)));
}

/* ------------------------------------------------------------------ */
/* Где именно смотреть: трансформация → доли кадра                     */
/* ------------------------------------------------------------------ */

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/**
 * Точка, заданная в долях **элемента**, переводится в доли кадра сцены.
 *
 * Нужна ровно для `follow`: человек ставит точку на окне один раз, а когда окно
 * двигают в OBS, точка едет вместе с ним. `width`/`height` из OBS уже включают
 * масштаб и обрезку, поэтому поворот не учитываем: он встречается редко, а
 * ошибка от него — в пределах самого окна.
 */
export function areaOnScene(
  area: { x: number; y: number; size: number },
  transform: ObsTransform,
  video: ObsVideoSettings,
): { x: number; y: number; size: number } {
  const baseWidth = video.baseWidth || 1920;
  const baseHeight = video.baseHeight || 1080;
  const width = Math.max(1, transform.width);
  const height = Math.max(1, transform.height);
  return {
    x: clamp01((transform.positionX + area.x * width) / baseWidth),
    y: clamp01((transform.positionY + area.y * height) / baseHeight),
    // Сторона квадрата в долях меньшей стороны кадра: так она не растягивается
    // вместе с пропорциями сцены.
    size: clamp01((area.size * Math.min(width, height)) / Math.min(baseWidth, baseHeight)),
  };
}

/** Точка на всём кадре: то же самое, когда элемента нет или следование выключено. */
export function areaOnFrame(area: { x: number; y: number; size: number }): { x: number; y: number; size: number } {
  return { x: clamp01(area.x), y: clamp01(area.y), size: clamp01(area.size) };
}

/* ------------------------------------------------------------------ */
/* Хранение пароля: настройки приложения, не пресет                    */
/* ------------------------------------------------------------------ */

const PASSWORD_KEY = "yappytuber.obs.password";

/** Пароль obs-websocket из настроек приложения. В пресете его нет. */
export function obsPassword(): string {
  try {
    return window.localStorage.getItem(PASSWORD_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setObsPassword(password: string): void {
  try {
    if (password) window.localStorage.setItem(PASSWORD_KEY, password);
    else window.localStorage.removeItem(PASSWORD_KEY);
  } catch {
    // Приватный режим — просто не запоминаем; соединение всё равно работает.
  }
}

/* ------------------------------------------------------------------ */
/* Клиент                                                             */
/* ------------------------------------------------------------------ */

/** Версия протокола, на которую рассчитан клиент. */
export const OBS_RPC_VERSION = 1;

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (reason: Error) => void;
}

/**
 * Клиент obs-websocket.
 *
 * Держит одно соединение и очередь запросов. Ошибкой считается только
 * отсутствие соединения или отказ OBS: «источник переименован» — это ответ с
 * `requestStatus.result = false`, и он приходит как обычная ошибка запроса.
 */
export class ObsClient {
  private socket: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private nextId = 1;
  private opened = false;

  get connected(): boolean {
    return this.opened && this.socket?.readyState === WebSocket.OPEN;
  }

  async connect(host: string, port: number, password: string): Promise<void> {
    this.close();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(`ws://${host}:${port}`);
      this.socket = socket;
      const fail = (reason: string) => {
        if (settled) return;
        settled = true;
        this.close();
        reject(new Error(reason));
      };
      socket.onerror = () => fail("OBS не отвечает: проверьте, включён ли obs-websocket");
      socket.onclose = () => fail("Соединение с OBS закрыто");
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as {
          op: number;
          d: Record<string, unknown>;
        };
        if (message.op === 0) {
          // Hello: отвечаем Identify.
          const authentication = message.d.authentication as ObsAuthChallenge | undefined;
          socket.send(JSON.stringify({
            op: 1,
            d: {
              rpcVersion: OBS_RPC_VERSION,
              authentication: obsAuth(password, authentication) ?? undefined,
              // Events: только те, что нужны для `follow` и обновления списков.
              eventSubscriptions: 0x1 | 0x4 | 0x400,
            },
          }));
          return;
        }
        if (message.op === 2) {
          this.opened = true;
          if (!settled) {
            settled = true;
            resolve();
          }
          return;
        }
        if (message.op === 7) {
          const requestId = String(message.d.requestId ?? "");
          const waiter = this.pending.get(requestId);
          if (!waiter) return;
          this.pending.delete(requestId);
          const status = message.d.requestStatus as { result?: boolean; comment?: string } | undefined;
          if (status && status.result === false) {
            waiter.reject(new Error(status.comment || "OBS отказал в запросе"));
            return;
          }
          waiter.resolve((message.d.responseData as Record<string, unknown>) ?? {});
        }
        // Остальные op (события, Identified) нам здесь не нужны: состояния
        // подключения достаточно.
      };
    });
  }

  request<T = Record<string, unknown>>(type: string, data?: Record<string, unknown>): Promise<T> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Нет соединения с OBS"));
    }
    const requestId = String(this.nextId++);
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.socket!.send(JSON.stringify({
        op: 6,
        d: { requestType: type, requestId, requestData: data ?? {} },
      }));
    });
  }

  /** Список сцен: имена как в OBS, с пробелами и кириллицей. */
  async scenes(): Promise<string[]> {
    const data = await this.request<{ scenes?: Array<{ sceneName?: string }> }>("GetSceneList");
    return (data.scenes ?? []).map((scene) => String(scene.sceneName ?? "")).filter(Boolean);
  }

  /** Элементы сцены — то, что можно выбрать источником точки. */
  async items(scene: string): Promise<string[]> {
    const data = await this.request<{ sceneItems?: Array<{ sourceName?: string }> }>("GetSceneItemList", { sceneName: scene });
    return (data.sceneItems ?? []).map((item) => String(item.sourceName ?? "")).filter(Boolean);
  }

  /** Трансформация элемента: положение и размер на сцене. */
  async transform(scene: string, item: string): Promise<ObsTransform | null> {
    try {
      const id = await this.request<{ sceneItemId?: number }>("GetSceneItemId", { sceneName: scene, sourceName: item });
      if (!Number.isFinite(id.sceneItemId)) return null;
      const data = await this.request<{ sceneItemTransform?: Record<string, number> }>(
        "GetSceneItemTransform",
        { sceneName: scene, sceneItemId: id.sceneItemId },
      );
      const raw = data.sceneItemTransform;
      if (!raw) return null;
      return {
        positionX: Number(raw.positionX ?? 0),
        positionY: Number(raw.positionY ?? 0),
        width: Number(raw.width ?? 0),
        height: Number(raw.height ?? 0),
        cropLeft: Number(raw.cropLeft ?? 0),
        cropTop: Number(raw.cropTop ?? 0),
        cropRight: Number(raw.cropRight ?? 0),
        cropBottom: Number(raw.cropBottom ?? 0),
        rotation: Number(raw.rotation ?? 0),
      };
    } catch {
      return null;
    }
  }

  async video(): Promise<ObsVideoSettings> {
    try {
      const data = await this.request<{ baseWidth?: number; baseHeight?: number }>("GetVideoSettings");
      return { baseWidth: Number(data.baseWidth ?? 1920), baseHeight: Number(data.baseHeight ?? 1080) };
    } catch {
      return { baseWidth: 1920, baseHeight: 1080 };
    }
  }

  /**
   * Скриншот источника данных URL-строкой (`data:image/png;base64,…`).
   *
   * Просим маленький: для среднего цвета хватает 128 пикселей по длинной
   * стороне, а OBS при этом перерисовывает источник целиком — чем реже, тем
   * дешевле.
   */
  async screenshot(source: string, width = 128): Promise<string | null> {
    try {
      // Пустое имя — «вся программная сцена»: её имя знает только OBS.
      let name = source;
      if (!name) {
        const program = await this.request<{ currentProgramSceneName?: string }>("GetCurrentProgramScene");
        name = program.currentProgramSceneName ?? "";
      }
      if (!name) return null;
      const data = await this.request<{ imageData?: string }>("GetSourceScreenshot", {
        sourceName: name,
        imageFormat: "png",
        imageWidth: width,
        imageHeight: Math.round(width * 9 / 16),
      });
      return typeof data.imageData === "string" ? data.imageData : null;
    } catch {
      return null;
    }
  }

  close(): void {
    this.opened = false;
    for (const waiter of this.pending.values()) waiter.reject(new Error("Соединение с OBS закрыто"));
    this.pending.clear();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        socket.close();
      } catch {
        // Уже закрыт — не страшно.
      }
    }
  }
}
