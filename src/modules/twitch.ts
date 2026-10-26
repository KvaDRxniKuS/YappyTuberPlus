import type { ExternalSourceConfig, ExternalSourceRule } from "../types";
import { formBody, httpRequest, parseJson, HttpError, type HttpResponse } from "./nativeHttp";
import { externalInputName } from "./external";
import { isTauri } from "../engine/presetFile";

/**
 * Twitch: вход, подписки EventSub и живой поток событий.
 *
 * Устроено так же, как остальные источники: наружу уходят **сырые сообщения**
 * Twitch, а таблица отображения модуля решает, что из них станет входом. Здесь
 * только то, чего нет у обычного WebSocket: OAuth, создание подписок и
 * переподключение сессии.
 *
 * Два правила, которые важны и в коде, и в жизни:
 * - **токен не попадает в пресет** — он лежит в профиле окна (`localStorage`);
 * - **Client ID — не секрет** и хранится в настройках модуля, чтобы пресет
 *   открывался на другой машине без настройки приложения.
 *
 * В браузере Twitch не работает: запросы к его API блокирует CORS, а подписку
 * нельзя создать из окна. Статус говорит об этом прямо, без тишины.
 */

const DEVICE_URL = "https://id.twitch.tv/oauth2/device";
const TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const HELIX = "https://api.twitch.tv/helix";
const SOCKET_URL = "wss://eventsub.wss.twitch.tv/ws";
export const TWITCH_VERIFY = "https://www.twitch.tv/activate";
/**
 * Консоль разработчика: там лежит Client ID приложения.
 *
 * Ссылка стоит прямо в карточке модуля рядом с полем Client ID — искать адрес
 * в документации и набирать руками больше не нужно.
 */
export const TWITCH_APPS = "https://dev.twitch.tv/console/apps";

/** Событие Twitch, которое умеет модуль. */
export interface TwitchEventSpec {
  type: string;
  version: string;
  label: string;
  /** Право доступа: без него Twitch не создаст подписку. Пусто — право не нужно. */
  scope: string;
  /**
   * Дополнительное поле условия с нашим же id.
   *
   * Twitch требует его не всегда, но там, где требует, без него подписка
   * отклоняется с 400: у чата это `user_id` (чей чат читаем), у фоллова
   * (версия 2) — `moderator_user_id` (кто получает события).
   */
  extra?: "user" | "moderator" | "from";
  /** Что появляется во входах по умолчанию. */
  rule: Omit<ExternalSourceRule, "event">;
}

/**
 * Список событий: подобран под то, что реально двигает персонажа — чат, награды,
 * bits, подписки, рейды. Текст чата в числа не идёт: он показывается отдельно.
 */
export const TWITCH_EVENTS: TwitchEventSpec[] = [
  {
    type: "channel.chat.message",
    version: "1",
    label: "Сообщение в чате",
    scope: "user:read:chat",
    extra: "user",
    // Счётчик: каждое сообщение прибавляет единицу. Сам текст в числа не идёт —
    // он показывается в панели «Входы» и в журнале.
    rule: {
      input: "chat", path: "$.payload.event.message_id", label: "Сообщений", kind: "level",
      min: 0, max: 1_000_000, scale: 1, offset: 0, holdMs: 0, count: true,
    },
  },
  {
    type: "channel.channel_points_custom_reward_redemption.add",
    version: "1",
    label: "Награда за баллы канала",
    scope: "channel:read:redemptions",
    rule: {
      input: "reward", path: "$.payload.event.reward.cost", label: "Награда, баллы",
      kind: "level", min: 0, max: 1_000_000, scale: 1, offset: 0, holdMs: 3000,
    },
  },
  {
    type: "channel.cheer",
    version: "1",
    label: "Bits (cheer)",
    scope: "bits:read",
    rule: {
      input: "cheer", path: "$.payload.event.bits", label: "Bits",
      kind: "level", min: 0, max: 100_000, scale: 1, offset: 0, holdMs: 2500,
    },
  },
  {
    type: "channel.follow",
    version: "2",
    label: "Новый подписчик канала",
    scope: "moderator:read:followers",
    extra: "moderator",
    // В событии нет числа: сам факт — это единица на несколько секунд.
    rule: {
      input: "follow", path: "$.payload.event.followed_at", label: "Фоллов",
      kind: "flag", min: 0, max: 1, scale: 1, offset: 0, holdMs: 4000, fallback: 1,
    },
  },
  {
    type: "channel.subscribe",
    version: "1",
    label: "Оформлена подписка",
    scope: "channel:read:subscriptions",
    rule: {
      input: "subscribe", path: "$.payload.event.is_gift", label: "Подписка",
      kind: "flag", min: 0, max: 1, scale: 1, offset: 0, holdMs: 4000, fallback: 1,
    },
  },
  {
    type: "channel.subscription.gift",
    version: "1",
    label: "Подаренные подписки",
    scope: "channel:read:subscriptions",
    rule: {
      input: "gift", path: "$.payload.event.total", label: "Подарено, шт",
      kind: "level", min: 0, max: 1000, scale: 1, offset: 0, holdMs: 4000,
    },
  },
  {
    type: "channel.raid",
    version: "1",
    label: "Рейд на канал",
    scope: "",
    // Рейду нужно, ОТКУДА пришли: без этого условия Twitch отвечает 400.
    extra: "from",
    rule: {
      input: "raid", path: "$.payload.event.viewers", label: "Рейд, зрителей",
      kind: "level", min: 0, max: 100_000, scale: 1, offset: 0, holdMs: 6000,
    },
  },
  {
    type: "channel.hype_train.end",
    version: "1",
    label: "Hype Train завершён",
    scope: "channel:read:hype_train",
    rule: {
      input: "hype", path: "$.payload.event.level", label: "Hype Train, уровень",
      kind: "level", min: 0, max: 100, scale: 1, offset: 0, holdMs: 6000,
    },
  },
];

/**
 * Строка правила по умолчанию для события.
 *
 * `when` обязателен: без него правило с `fallback` срабатывало бы на любом
 * сообщении — «фоллов» появлялся бы от каждой награды. Условие — тип подписки
 * в метаданных EventSub, то есть ровно то событие, к которому относится строка.
 */
export function eventRule(spec: TwitchEventSpec): ExternalSourceRule {
  return {
    ...spec.rule,
    event: spec.type,
    when: { path: "$.metadata.subscription_type", equals: spec.type },
  };
}

/**
 * Правило команды чата: `!dance` → вход `cmd_dance`.
 *
 * Текст сообщения числом не бывает, поэтому путь — тот же текст, а `fallback`
 * даёт единицу: сработало условие — значит, команда прозвучала. Удержание 3 с
 * нужно, чтобы `down` успел поймать событие.
 */
export function commandRule(command: string): ExternalSourceRule {
  const name = externalInputName(command).replace(/^cmd_/, "");
  return {
    input: `cmd_${name}`,
    path: "$.payload.event.message.text",
    label: `!${name}`,
    kind: "flag",
    min: 0,
    max: 1,
    scale: 1,
    offset: 0,
    holdMs: 3000,
    fallback: 1,
    event: "channel.chat.message",
    when: { path: "$.payload.event.message.text", contains: `!${name}`, ignoreCase: true },
  };
}

/** Правило награды по имени: искупили «Смена аватара» → вход `redeem_смена_аватара`. */
export function rewardRule(title: string): ExternalSourceRule {
  const clean = title.trim();
  return {
    input: `redeem_${externalInputName(clean)}`,
    path: "$.payload.event.reward.title",
    label: clean,
    kind: "flag",
    min: 0,
    max: 1,
    scale: 1,
    offset: 0,
    holdMs: 5000,
    fallback: 1,
    event: "channel.channel_points_custom_reward_redemption.add",
    when: { path: "$.payload.event.reward.title", equals: clean },
  };
}

/** Команды, уже заведённые в модуле: берём из условий строк. */
export function twitchCommands(source: ExternalSourceConfig): string[] {
  return source.mapping
    .filter((rule) => rule.input.startsWith("cmd_") && rule.when?.contains)
    .map((rule) => String(rule.when?.contains).replace(/^!/, ""));
}

/** Награды, уже заведённые в модуле: имя награды — это условие равенства. */
export function twitchRewards(source: ExternalSourceConfig): string[] {
  return source.mapping
    .filter((rule) => rule.input.startsWith("redeem_") && rule.when?.equals !== undefined)
    .map((rule) => String(rule.when?.equals));
}

/** События, включённые в модуле: они и только они дают подписки. */
export function selectedEvents(source: ExternalSourceConfig): TwitchEventSpec[] {
  const enabled = new Set(source.mapping.map((rule) => rule.event).filter(Boolean) as string[]);
  return TWITCH_EVENTS.filter((spec) => enabled.has(spec.type));
}

/** Права доступа для device-flow: объединение прав выбранных событий. */
export function twitchScopes(source: ExternalSourceConfig): string[] {
  const scopes = new Set<string>();
  for (const spec of selectedEvents(source)) if (spec.scope) scopes.add(spec.scope);
  return [...scopes];
}

export type TwitchState = "idle" | "needs-auth" | "authorizing" | "connecting" | "live" | "error";

/** Состояние канала: его показывает карточка модуля. */
export interface TwitchInfo {
  state: TwitchState;
  message: string | null;
  /** Код для входа: показывается, пока ждём подтверждения. */
  userCode?: string;
  verificationUri?: string;
  login?: string;
}

export interface TwitchHooks {
  onState: (info: TwitchInfo) => void;
  /** Сырое уведомление EventSub — его разбирает таблица отображения. */
  onMessage: (text: string) => void;
}

interface TwitchToken {
  accessToken: string;
  refreshToken: string;
  /** Когда истечёт, мс с 1970: за минуту до конца токен обновляем. */
  expiresAt: number;
  login?: string;
}

const STORAGE_PREFIX = "yappy.twitch.";
const REFRESH_MARGIN = 60_000;
const RECONNECT_MIN = 1000;
const RECONNECT_MAX = 30_000;

function storageKey(clientId: string): string {
  return `${STORAGE_PREFIX}${clientId}`;
}

/** Токен из профиля окна. В пресете его нет и быть не должно. */
export function readTwitchToken(clientId: string): TwitchToken | null {
  if (!clientId) return null;
  try {
    const raw = window.localStorage.getItem(storageKey(clientId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<TwitchToken>;
    if (!parsed.accessToken || !parsed.refreshToken) return null;
    return {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      expiresAt: Number(parsed.expiresAt) || 0,
      login: parsed.login,
    };
  } catch {
    return null;
  }
}

function writeTwitchToken(clientId: string, token: TwitchToken): void {
  try {
    window.localStorage.setItem(storageKey(clientId), JSON.stringify(token));
  } catch {
    // Приватный режим может запретить запись: тогда вход придётся повторить.
  }
}

export function clearTwitchToken(clientId: string): void {
  try {
    window.localStorage.removeItem(storageKey(clientId));
  } catch { /* нечего чистить */ }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function describe(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return String(reason);
}

interface DeviceStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresIn: number;
}

/** Шаг 1 входа: Twitch выдаёт код, который человек вводит на своём сайте. */
async function startDevice(clientId: string, scopes: string[]): Promise<DeviceStart> {
  // Twitch ждёт права через пробел; `%20` надёжнее, чем `+` из URLSearchParams.
  const query = new URLSearchParams({ client_id: clientId, scopes: scopes.join(" ") });
  const qs = query.toString().replace(/\+/g, "%20");
  const response = await httpRequest({ method: "POST", url: `${DEVICE_URL}?${qs}` });
  const body = parseJson<Record<string, unknown>>(response);
  if (response.status !== 200 || !body.device_code) {
    throw new HttpError(`Twitch не выдал код: ${String(body.message ?? response.status)}`, response.status);
  }
  return {
    deviceCode: String(body.device_code),
    userCode: String(body.user_code ?? ""),
    verificationUri: String(body.verification_uri ?? TWITCH_VERIFY),
    interval: Math.max(1, Number(body.interval) || 5),
    expiresIn: Math.max(30, Number(body.expires_in) || 1800),
  };
}

type PollOutcome =
  | { kind: "token"; token: TwitchToken }
  | { kind: "pending" }
  | { kind: "slow" }
  | { kind: "denied" | "expired"; message: string };

/** Шаг 2 входа: опрос до подтверждения. */
async function pollDevice(clientId: string, scopes: string[], deviceCode: string): Promise<PollOutcome> {
  const query = new URLSearchParams({
    client_id: clientId,
    scopes: scopes.join(" "),
    device_code: deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });
  const qs = query.toString().replace(/\+/g, "%20");
  const response = await httpRequest({ method: "POST", url: `${TOKEN_URL}?${qs}` });
  const body = parseJson<Record<string, unknown>>(response);
  if (response.status === 200 && body.access_token) {
    return {
      kind: "token",
      token: {
        accessToken: String(body.access_token),
        refreshToken: String(body.refresh_token ?? ""),
        expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
      },
    };
  }
  const message = String(body.message ?? "");
  if (message === "authorization_pending") return { kind: "pending" };
  if (message === "slow_down") return { kind: "slow" };
  if (message === "expired_token") return { kind: "expired", message: "код истёк, начните вход заново" };
  if (message === "access_denied") return { kind: "denied", message: "во входе отказано" };
  return { kind: "denied", message: message || `Twitch ответил ${response.status}` };
}

/** Обновление токена: у Twitch пара access/refresh живёт месяц. */
async function refreshToken(clientId: string, token: TwitchToken): Promise<TwitchToken> {
  const query = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: token.refreshToken,
    client_id: clientId,
  });
  const response = await httpRequest({ method: "POST", url: `${TOKEN_URL}?${query.toString()}` });
  const body = parseJson<Record<string, unknown>>(response);
  if (response.status !== 200 || !body.access_token) {
    throw new HttpError(`не удалось обновить токен: ${String(body.message ?? response.status)}`, response.status);
  }
  return {
    accessToken: String(body.access_token),
    refreshToken: String(body.refresh_token ?? token.refreshToken),
    expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
    login: token.login,
  };
}

/**
 * Живой канал Twitch для одного модуля.
 *
 * Один экземпляр = один WebSocket EventSub. Подписки создаются после
 * приветствия сессии (`session_welcome`), потому что Twitch привязывает их к
 * идентификатору сессии; при обрыве сессия новая и подписки создаются заново.
 */
export class TwitchChannel {
  private info: TwitchInfo = { state: "idle", message: null };
  private token: TwitchToken | null = null;
  private socket: WebSocket | null = null;
  private sessionId: string | null = null;
  private broadcasterId: string | null = null;
  /** Наш собственный id: его просят условия чата и фоллова. */
  private ownId: string | null = null;
  /** Логин владельца токена: по нему видно, с какого аккаунта выполнен вход. */
  private ownLogin: string | null = null;
  private stopped = false;
  private retry: number | null = null;
  private attempts = 0;

  constructor(
    private source: ExternalSourceConfig,
    private hooks: TwitchHooks,
  ) {}

  /** Текущее состояние: панель забирает его вместе со статусами источников. */
  current(): TwitchInfo {
    return this.info;
  }

  start(): void {
    this.stopped = false;
    void this.run();
  }

  stop(): void {
    this.stopped = true;
    if (this.retry) window.clearTimeout(this.retry);
    this.retry = null;
    this.socket?.close();
    this.socket = null;
    this.sessionId = null;
  }

  /** Вход по коду: вызывается кнопкой в карточке модуля. */
  async authorize(): Promise<TwitchInfo> {
    const clientId = this.source.clientId ?? "";
    if (!clientId) {
      return this.setState({ state: "error", message: "укажите Client ID приложения Twitch" });
    }
    if (!isTauri()) {
      return this.setState({ state: "error", message: "вход в Twitch доступен в приложении: в браузере запросы блокирует CORS" });
    }
    this.stopped = false;
    const scopes = twitchScopes(this.source);
    let device: DeviceStart;
    try {
      device = await startDevice(clientId, scopes);
    } catch (reason) {
      return this.setState({ state: "error", message: describe(reason) });
    }
    this.setState({
      state: "authorizing",
      message: "откройте страницу активации и введите код",
      userCode: device.userCode,
      verificationUri: device.verificationUri,
    });
    const deadline = Date.now() + device.expiresIn * 1000;
    let interval = device.interval;
    while (!this.stopped && Date.now() < deadline) {
      await sleep(interval * 1000);
      if (this.stopped) return this.current();
      let outcome: PollOutcome;
      try {
        outcome = await pollDevice(clientId, scopes, device.deviceCode);
      } catch (reason) {
        return this.setState({ state: "error", message: describe(reason) });
      }
      if (outcome.kind === "token") {
        this.token = outcome.token;
        writeTwitchToken(clientId, outcome.token);
        this.setState({ state: "connecting", message: "вход выполнен, подключаюсь" });
        await this.connect();
        return this.current();
      }
      if (outcome.kind === "slow") {
        interval += 5;
        continue;
      }
      if (outcome.kind === "pending") continue;
      return this.setState({ state: "error", message: outcome.message });
    }
    return this.setState({ state: "error", message: "код входа истёк, начните заново" });
  }

  /**
   * Проверка по кнопке: Client ID, канал и токен — по шагам, чтобы было видно,
   * какой именно шаг не прошёл. Сеть не трогаем, пока не заполнены поля.
   */
  async probe(): Promise<string> {
    const clientId = this.source.clientId ?? "";
    if (!clientId) return "не указан Client ID приложения Twitch";
    if (!this.source.channel) return "не указан канал";
    if (!isTauri()) return "проверка доступна в приложении: в браузере запросы к API блокирует CORS";
    const token = this.token ?? readTwitchToken(clientId);
    if (!token) return "нет токена: нажмите «Войти в Twitch»";
    this.token = token;
    try {
      const fresh = await this.freshToken();
      this.broadcasterId = null;
      const id = await this.resolveBroadcaster(fresh);
      await this.resolveOwnUser(fresh);
      // Один id на всё — норма для стримера, который следит за своим каналом.
      const channel = this.token?.login ?? this.source.channel;
      const own = this.ownLogin ?? "неизвестно";
      if (id === this.ownId) return `канал «${channel}» найден, ID ${id}, вход с того же аккаунта`;
      return `канал «${channel}» найден, ID ${id}, но вход выполнен как «${own}»: войдите аккаунтом канала`;
    } catch (reason) {
      return describe(reason);
    }
  }

  /** Забыть токен: следующее подключение попросит войти заново. */
  signOut(): void {
    clearTwitchToken(this.source.clientId ?? "");
    this.token = null;
    this.stop();
    this.setState({ state: "needs-auth", message: "вход отменён" });
  }

  private setState(info: TwitchInfo): TwitchInfo {
    this.info = info;
    this.hooks.onState(info);
    return info;
  }

  private async run(): Promise<void> {
    const clientId = this.source.clientId ?? "";
    if (!clientId) {
      this.setState({ state: "error", message: "укажите Client ID приложения Twitch" });
      return;
    }
    if (!this.source.channel) {
      this.setState({ state: "error", message: "укажите канал, за событиями которого следить" });
      return;
    }
    if (!isTauri()) {
      this.setState({ state: "error", message: "Twitch работает в приложении: в браузере запросы к API блокирует CORS" });
      return;
    }
    const stored = readTwitchToken(clientId);
    this.token = stored;
    if (!stored) {
      this.setState({ state: "needs-auth", message: "нужен вход в Twitch" });
      return;
    }
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.setState({ state: "connecting", message: null, login: this.token?.login });
    let token: TwitchToken;
    try {
      token = await this.freshToken();
    } catch (reason) {
      this.setState({ state: "needs-auth", message: describe(reason) });
      return;
    }
    try {
      this.broadcasterId = await this.resolveBroadcaster(token);
    } catch (reason) {
      this.setState({ state: "error", message: describe(reason) });
      return;
    }
    this.openSocket(SOCKET_URL);
  }

  /** Токен с запасом: за минуту до конца обновляем, иначе первый же запрос — 401. */
  private async freshToken(): Promise<TwitchToken> {
    const clientId = this.source.clientId ?? "";
    const token = this.token ?? readTwitchToken(clientId);
    if (!token) throw new HttpError("нужен вход в Twitch");
    if (token.expiresAt - Date.now() > REFRESH_MARGIN) return token;
    const next = await refreshToken(clientId, token);
    this.token = next;
    writeTwitchToken(clientId, next);
    return next;
  }

  /**
   * Свой id по токену: `GET /helix/users` без параметров возвращает владельца токена.
   * Нужен для условий `user_id` (чат) и `moderator_user_id` (фоллов).
   */
  private async resolveOwnUser(token: TwitchToken): Promise<string> {
    if (this.ownId) return this.ownId;
    const body = await this.api<{ data?: Array<{ id: string; login?: string; display_name?: string }> }>("/users", token);
    const user = body.data?.[0];
    if (!user?.id) throw new HttpError("Twitch не вернул пользователя по токену");
    this.ownId = user.id;
    this.ownLogin = user.display_name || user.login || null;
    return this.ownId;
  }

  private async resolveBroadcaster(token: TwitchToken): Promise<string> {
    const login = this.source.channel ?? "";
    if (this.broadcasterId) return this.broadcasterId;
    const body = await this.api<{ data?: Array<{ id: string; display_name: string; login: string }> }>(
      `/users?login=${encodeURIComponent(login)}`,
      token,
    );
    const user = body.data?.[0];
    // Пустой массив — это «не найден», а не «нет прав»: частая путаница в ответах
    // Helix. Текст ошибки должен вести к делу, а не в тупик.
    if (!user?.id) {
      throw new HttpError(`канал «${login}» не найден: проверьте логин (без @ и без адреса)`);
    }
    this.token = { ...token, login: user.display_name };
    writeTwitchToken(this.source.clientId ?? "", this.token);
    return user.id;
  }

  /** Запрос к Helix: при 401 один раз обновляет токен и повторяет. */
  private async api<T>(path: string, token: TwitchToken, retry = true): Promise<T> {
    const response: HttpResponse = await httpRequest({
      method: "GET",
      url: `${HELIX}${path}`,
      headers: {
        "Client-Id": this.source.clientId ?? "",
        Authorization: `Bearer ${token.accessToken}`,
      },
    });
    if (response.status === 401 && retry) {
      const next = await refreshToken(this.source.clientId ?? "", token);
      this.token = next;
      writeTwitchToken(this.source.clientId ?? "", next);
      return this.api<T>(path, next, false);
    }
    if (response.status >= 400) {
      throw new HttpError(`Twitch: ${response.status} ${response.body.slice(0, 160)}`, response.status);
    }
    return parseJson<T>(response);
  }

  /**
   * Условие подписки. Twitch строг к составу: лишнее поле отклоняет подписку так
   * же, как недостающее, поэтому собираем его по описанию события.
   */
  private async condition(spec: TwitchEventSpec, token: TwitchToken): Promise<Record<string, string>> {
    // Пустой id Twitch отклоняет словами «validation error», поэтому проверяем
    // сами и говорим по-человечески.
    if (!this.broadcasterId) {
      throw new HttpError(
        `не определён id канала «${this.source.channel ?? ""}»: проверьте логин и войдите заново`,
      );
    }
    const condition: Record<string, string> = { broadcaster_user_id: this.broadcasterId };
    if (spec.extra === "user") {
      condition.user_id = await this.resolveOwnUser(token);
    } else if (spec.extra === "moderator") {
      condition.moderator_user_id = await this.resolveOwnUser(token);
    } else if (spec.extra === "from") {
      // Ловим рейды, которые приходят на наш канал, с любого канала-источника.
      condition.from_broadcaster_user_id = await this.resolveOwnUser(token);
    }
    return condition;
  }

  /** Подписка на событие. `409` — уже есть такая: это не ошибка для нас. */
  private async subscribe(spec: TwitchEventSpec, token: TwitchToken): Promise<void> {
    // Условие собираем до запроса: в тексте ошибки оно помогает понять причину,
    // а сами id не секрет (это же не токен).
    const condition = await this.condition(spec, token);
    const response = await httpRequest({
      method: "POST",
      url: `${HELIX}/eventsub/subscriptions`,
      headers: {
        "Client-Id": this.source.clientId ?? "",
        Authorization: `Bearer ${token.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: spec.type,
        version: spec.version,
        condition,
        transport: { method: "websocket", session_id: this.sessionId },
      }),
    });
    if (response.status === 202 || response.status === 409) return;
    if (response.status === 403) {
      throw new HttpError(`нет права «${spec.scope}»: отметьте его при входе в Twitch`, 403);
    }
    if (response.status === 400) {
      // 400 у подписки почти всегда про id канала: например, вход выполнен не с
      // того аккаунта, и канал из настроек этому токену не «свой».
      const own = this.ownLogin ? ` (вход выполнен как ${this.ownLogin})` : "";
      throw new HttpError(
        `Twitch отклонил условие подписки${own}: ${JSON.stringify(condition)}. `
        + `Проверьте канал «${this.source.channel ?? ""}» — он должен быть вашим`,
        400,
      );
    }
    throw new HttpError(`подписка «${spec.label}»: ${response.status} ${response.body.slice(0, 160)}`, response.status);
  }

  private openSocket(url: string): void {
    if (this.stopped) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (reason) {
      this.setState({ state: "error", message: describe(reason) });
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    // После переезда на новый адрес старый сокет доживает своё: его обработчики
    // не должны ни менять статус, ни запускать переподключение.
    const current = () => !this.stopped && this.socket === socket;
    socket.onmessage = (event) => {
      if (!current() || typeof event.data !== "string") return;
      void this.handleMessage(event.data);
    };
    socket.onerror = () => {
      if (!current()) return;
      this.setState({ ...this.info, state: "error", message: "ошибка соединения с Twitch" });
    };
    socket.onclose = () => {
      if (!current()) return;
      this.socket = null;
      this.sessionId = null;
      this.setState({ ...this.info, state: "connecting", message: "соединение закрыто, переподключаюсь" });
      this.scheduleReconnect();
    };
  }

  private async handleMessage(raw: string): Promise<void> {
    let payload: {
      metadata?: { message_type?: string; subscription_type?: string };
      payload?: { session?: { id?: string; reconnect_url?: string } };
    };
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    const type = payload.metadata?.message_type ?? "";
    if (type === "session_welcome") {
      this.sessionId = payload.payload?.session?.id ?? null;
      this.attempts = 0;
      this.setState({ state: "live", message: null, login: this.token?.login });
      await this.subscribeAll();
      return;
    }
    if (type === "session_keepalive") return;
    if (type === "session_reconnect") {
      const next = payload.payload?.session?.reconnect_url;
      if (next) {
        // Twitch просит переехать на новый адрес: старый доживает своё, но
        // молча — его обработчики уже не «свои».
        const old = this.socket;
        this.openSocket(next);
        window.setTimeout(() => {
          if (!old) return;
          old.onmessage = null;
          old.onerror = null;
          old.onclose = null;
          old.close();
        }, 5000);
      }
      return;
    }
    if (type === "revocation") {
      const reason = payload.metadata?.subscription_type
        ? `подписка «${payload.metadata.subscription_type}» отозвана`
        : "подписка отозвана";
      this.setState({ ...this.info, state: "error", message: reason });
      return;
    }
    if (type === "notification") {
      this.hooks.onMessage(raw);
    }
  }

  private async subscribeAll(): Promise<void> {
    const events = selectedEvents(this.source);
    if (events.length === 0) {
      this.setState({ ...this.info, message: "не выбрано ни одного события" });
      return;
    }
    let token: TwitchToken;
    try {
      token = await this.freshToken();
    } catch (reason) {
      this.setState({ ...this.info, state: "needs-auth", message: describe(reason) });
      return;
    }
    const problems: string[] = [];
    for (const spec of events) {
      if (this.stopped) return;
      try {
        await this.subscribe(spec, token);
      } catch (reason) {
        problems.push(`${spec.label}: ${describe(reason)}`);
      }
    }
    this.setState({
      ...this.info,
      state: problems.length === events.length ? "error" : "live",
      message: problems.length > 0 ? problems.join(" · ") : null,
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retry) return;
    const delay = Math.min(RECONNECT_MAX, RECONNECT_MIN * 2 ** this.attempts);
    this.attempts += 1;
    this.retry = window.setTimeout(() => {
      this.retry = null;
      void this.connect();
    }, delay);
  }
}
