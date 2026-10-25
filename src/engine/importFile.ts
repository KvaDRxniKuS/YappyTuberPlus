import type { MediaSpec } from "../types";
import { mediaTypeOf } from "./preset";

/**
 * Импорт файла на сцену: тип объекта определяется по самому файлу.
 *
 * Кнопок «добавить картинку», «добавить видео», «добавить звук» нет и не будет:
 * одна кнопка принимает любой файл, а объект создаётся подходящий:
 *
 * - звук → медиа-объект `audio`;
 * - видео → медиа-объект `video`;
 * - анимированная картинка (GIF, APNG, анимированный WEBP) → медиа-объект
 *   `image`, у которого работает воспроизведение;
 * - обычная картинка (PNG, JPG, статичный WEBP) → спрайт.
 *
 * Группа остаётся отдельной кнопкой: это не файл, а структура.
 */
export interface ImportedFile {
  /** Какой объект создавать. */
  kind: "sprite" | "media";
  /** Значение `media.type` для медиа-объекта (`null` у спрайта). */
  mediaType: MediaSpec["type"] | null;
  /** Файл как data URL: пресет остаётся одним файлом. */
  src: string;
  /** Имя без расширения: оно же имя объекта. */
  name: string;
  width: number;
  height: number;
}

/** Плашка звука: по ней объект видно и можно выделить мышью. */
const AUDIO_SIZE = { width: 280, height: 100 };
const VIDEO_FALLBACK = { width: 480, height: 270 };
const IMAGE_FALLBACK = { width: 320, height: 320 };

/** Прочитать файл как data URL. */
export function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error("Ошибка чтения файла"));
    reader.readAsDataURL(file);
  });
}

/** Натуральный размер картинки. */
async function imageSize(file: File): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(file);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  if (!size.width || !size.height) return IMAGE_FALLBACK;
  return size;
}

/** Натуральный размер видео: нужен, чтобы медиа-объект совпал с кадром. */
function videoSize(source: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const probe = document.createElement("video");
    probe.preload = "metadata";
    probe.onloadedmetadata = () => {
      resolve({ width: probe.videoWidth || VIDEO_FALLBACK.width, height: probe.videoHeight || VIDEO_FALLBACK.height });
    };
    probe.onerror = () => reject(new Error("Не удалось прочитать видео: формат не поддерживается"));
    probe.src = source;
  });
}

const HEAD_BYTES = 256 * 1024;

function head(file: File): Promise<Uint8Array> {
  return file.slice(0, HEAD_BYTES).arrayBuffer().then((buffer) => new Uint8Array(buffer));
}

/** Есть ли последовательность байт: `acTL` у APNG, `ANIM` у WEBP. */
function hasSequence(bytes: Uint8Array, text: string): boolean {
  const needle = Array.from(text, (char) => char.charCodeAt(0));
  outer: for (let index = 0; index + needle.length <= bytes.length; index += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (bytes[index + offset] !== needle[offset]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Анимированная ли картинка.
 *
 * GIF считаем анимированным всегда (статичный тоже рисуется), для PNG ищем
 * управляющий блок `acTL`, для WEBP — блок `ANIM`. Так «добавить анимированную
 * картинку» не нужен отдельной кнопкой.
 */
export function isAnimatedImage(name: string, type: string, bytes: Uint8Array): boolean {
  const extension = name.split(".").pop()?.toLowerCase() || "";
  if (extension === "gif" || type === "image/gif") return true;
  if (extension === "apng" || type === "image/apng") return true;
  if (extension === "png" || type === "image/png") return hasSequence(bytes, "acTL");
  if (extension === "webp" || type === "image/webp") return hasSequence(bytes, "ANIM");
  if (extension === "avif" || type === "image/avif") return hasSequence(bytes, "avis");
  return false;
}

/** Разбирает файл и говорит, какой объект из него получится. */
export async function inspectFile(file: File): Promise<ImportedFile> {
  const type = mediaTypeOf(file);
  const src = await readDataUrl(file);
  const name = file.name.replace(/\.[^.]+$/, "") || "файл";

  if (type === "audio") {
    return { kind: "media", mediaType: "audio", src, name, ...AUDIO_SIZE };
  }
  if (type === "video") {
    const size = await videoSize(src).catch(() => VIDEO_FALLBACK);
    return { kind: "media", mediaType: "video", src, name, ...size };
  }
  if (isAnimatedImage(file.name, file.type, await head(file))) {
    const size = await imageSize(file).catch(() => IMAGE_FALLBACK);
    return { kind: "media", mediaType: "image", src, name, ...size };
  }
  // Осталась обычная картинка — это спрайт, как и раньше.
  const size = await imageSize(file).catch(() => IMAGE_FALLBACK);
  return { kind: "sprite", mediaType: null, src, name, ...size };
}
