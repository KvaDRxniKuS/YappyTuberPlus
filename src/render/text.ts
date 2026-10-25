import type { RigFrame, RigObject, TextSpec } from "../types";

/**
 * Текстовый канал: последнее сообщение каждого модуля.
 *
 * В формулы текст не попадает — там только числа, — поэтому текст живёт
 * отдельным каналом. Объект `text` подставляет строки в шаблон:
 *
 *   «{twitch.chat.user}: {twitch.chat.message}»
 *
 * Первая часть пути — имя модуля, последняя — поле: `message` (или `text`)
 * даёт сам текст, `user` (или `author`) — автора. Поле в середине пути
 * (`chat`) разрешено и ни на что не влияет: так привычнее читать.
 */
export interface TextChannelEntry {
  text: string;
  author?: string;
}

export type TextChannel = Record<string, TextChannelEntry>;

export const DEFAULT_TEXT: TextSpec = {
  template: "",
  font: "Segoe UI",
  size: 48,
  color: "#ffffff",
  align: "center",
  bold: true,
  italic: false,
  strokeColor: "#11151a",
  strokeWidth: 4,
  lineHeight: 1.2,
};

const PLACEHOLDER = /\{([^{}]+)\}/g;

/** Канал из журнала сообщений модулей: берём последнее сообщение каждого. */
export function textChannel(
  lines?: Record<string, { text: string; author?: string }[]>,
): TextChannel {
  const result: TextChannel = {};
  for (const [module, list] of Object.entries(lines ?? {})) {
    const last = list[list.length - 1];
    if (last) result[module] = { text: last.text, author: last.author };
  }
  return result;
}

/** Шаблон с подстановками. Неизвестный путь даёт пустую строку. */
export function resolveTemplate(template: string, channel?: TextChannel): string {
  if (!template) return "";
  return template.replace(PLACEHOLDER, (_match, raw: string) => {
    const parts = raw.trim().split(".").filter(Boolean);
    if (parts.length < 2) return "";
    const entry = channel?.[parts[0]];
    if (!entry) return "";
    const field = parts[parts.length - 1].toLowerCase();
    if (field === "user" || field === "author" || field === "name") return entry.author ?? "";
    if (field === "message" || field === "text" || field === "chat") return entry.text;
    return "";
  });
}

/** Итоговый текст объекта: команда `text(…)` важнее шаблона. */
export function textContent(
  object: RigObject,
  frame: RigFrame | null,
  channel?: TextChannel,
): string {
  const override = frame?.texts?.[object.id];
  if (typeof override === "string") return override;
  return resolveTemplate((object.text ?? DEFAULT_TEXT).template, channel);
}

export function textFont(spec: TextSpec): string {
  const size = Math.max(1, spec.size);
  const family = spec.font.trim() || DEFAULT_TEXT.font;
  return `${spec.italic ? "italic " : ""}${spec.bold ? 700 : 400} ${size}px "${family}", "Segoe UI", system-ui, sans-serif`;
}

/**
 * Перенос по словам: ширина объекта — это ширина текстового блока.
 * Слишком длинное слово рвётся посимвольно, иначе оно вылезло бы за рамку.
 */
export function wrapLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const result: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (!paragraph) {
      result.push("");
      continue;
    }
    if (!(maxWidth > 0)) {
      result.push(paragraph);
      continue;
    }
    let line = "";
    for (const word of paragraph.split(/(\s+)/)) {
      if (!word) continue;
      const candidate = line + word;
      if (!line || ctx.measureText(candidate).width <= maxWidth) {
        line = candidate;
        continue;
      }
      result.push(line.trimEnd());
      line = word.trimStart();
      while (line && ctx.measureText(line).width > maxWidth) {
        let cut = line.length;
        while (cut > 1 && ctx.measureText(line.slice(0, cut)).width > maxWidth) cut -= 1;
        result.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    result.push(line.trimEnd());
  }
  return result;
}

/**
 * Рисует текст внутри рамки объекта. Левый верхний угол рамки — как у спрайта:
 * `−pivot · размер`, поэтому пивот, масштаб, поворот и перекос работают так же.
 */
export function drawTextObject(
  ctx: CanvasRenderingContext2D,
  object: RigObject,
  content: string,
): void {
  if (!content) return;
  const spec = object.text ?? DEFAULT_TEXT;
  const left = -object.pivot.x * object.width;
  const top = -object.pivot.y * object.height;
  ctx.save();
  ctx.font = textFont(spec);
  ctx.textBaseline = "top";
  ctx.textAlign = spec.align === "left" ? "left" : spec.align === "right" ? "right" : "center";
  const anchor = spec.align === "left" ? left : spec.align === "right" ? left + object.width : left + object.width / 2;
  const lineHeight = Math.max(1, spec.size) * (spec.lineHeight || DEFAULT_TEXT.lineHeight);
  const lines = wrapLines(ctx, content, object.width);
  ctx.fillStyle = spec.color;
  ctx.strokeStyle = spec.strokeColor;
  ctx.lineWidth = Math.max(0, spec.strokeWidth);
  ctx.lineJoin = "round";
  lines.forEach((line, index) => {
    const y = top + index * lineHeight;
    if (spec.strokeWidth > 0) ctx.strokeText(line, anchor, y);
    ctx.fillText(line, anchor, y);
  });
  ctx.restore();
}
