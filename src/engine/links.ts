import { isTauri } from "./presetFile";

/**
 * Внешние ссылки из интерфейса — в браузере, а не в окне редактора.
 *
 * Ссылка в карточке модуля (`dev.twitch.tv/console/apps`, страница активации
 * Twitch) не должна уводить вебвью: навигация внутри окна приложения заменила бы
 * студию страницей Twitch, а вернуться было бы некуда. Поэтому адрес передаётся
 * системе: в приложении — командой `open_external`, в браузере — новым вкладкой.
 */

/**
 * Приводит адрес к безопасному виду.
 *
 * Открываем только веб-схемы и только те символы, из которых состоит обычный
 * URL: адрес уходит в системную команду, поэтому `&`, кавычки и переводы строк
 * здесь недопустимы. `javascript:` и `file:` отсекаются вместе с ними.
 */
export function externalUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!/^https?:\/\/[^\s]+$/i.test(trimmed)) return null;
  if (/["'`\\^|&;<>()$\s]/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Открывает адрес в браузере по умолчанию.
 *
 * Возвращает `false`, если адрес не веб-ссылка или открыть не удалось: тогда
 * интерфейс показывает адрес текстом, чтобы его можно было скопировать руками.
 */
export async function openExternal(url: string): Promise<boolean> {
  const safe = externalUrl(url);
  if (!safe) return false;
  if (typeof window === "undefined") return false;
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_external", { url: safe });
      return true;
    } catch {
      // Старая сборка приложения без команды `open_external`: не молчим, а
      // пробуем открыть ссылку отдельным окном — студия при этом остаётся.
    }
  }
  return window.open(safe, "_blank", "noopener,noreferrer") !== null;
}
