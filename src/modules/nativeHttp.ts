import { isTauri } from "../engine/presetFile";

/**
 * HTTP-запрос из нативного слоя.
 *
 * Обычный `fetch` из окна упирается в CORS: Twitch, локальные сервисы и почти
 * любой API без заголовка `Access-Control-Allow-Origin` просто не ответят. В
 * приложении запрос делает Rust (`source_request`), поэтому работают и
 * `Authorization`, и POST с телом.
 *
 * В браузере запрос не подменяется «как будто сработало»: возвращается понятная
 * ошибка, и вызывающий код показывает её в статусе источника.
 */

export interface HttpRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  body: string;
}

export class HttpError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
    this.name = "HttpError";
  }
}

/** Запрос через Rust. Ошибка сети и не-2xx различаются: у второй есть код. */
export async function httpRequest(request: HttpRequest): Promise<HttpResponse> {
  if (!isTauri()) {
    throw new HttpError("сетевые запросы доступны в приложении: в браузере их блокирует CORS");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<HttpResponse>("source_request", { request });
  } catch (reason) {
    throw new HttpError(reason instanceof Error ? reason.message : String(reason));
  }
}

/** Разбор JSON с понятной ошибкой: ответ сервера может быть и HTML. */
export function parseJson<T>(response: HttpResponse): T {
  try {
    return JSON.parse(response.body) as T;
  } catch {
    throw new HttpError(`ответ не JSON (${response.status}): ${response.body.slice(0, 120)}`, response.status);
  }
}

/** Тело формы `a=1&b=2` — им пользуется OAuth Twitch. */
export function formBody(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}
