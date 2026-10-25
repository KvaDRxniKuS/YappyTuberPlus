import type { MediaSpec } from "../types";
import { mediaTypeOf } from "./preset";
import { blobToDataUrl, storeFile } from "./assets";

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
  /**
   * Ссылка на файл в хранилище (`asset:<id>`). Если хранилище недоступно,
   * здесь остаётся data URL — пресет тогда работает по-старому.
   */
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

/** Натуральный размер картинки. */
async function imageSize(file: File): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(file);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  if (!size.width || !size.height) return IMAGE_FALLBACK;
  return size;
}

/**
 * Натуральный размер видео: нужен, чтобы медиа-объект совпал с кадром.
 *
 * Читается по временному `blob:` URL, поэтому файл не превращается в base64
 * только ради двух чисел.
 */
function videoSize(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const probe = document.createElement("video");
    const url = URL.createObjectURL(file);
    const finish = (result: { width: number; height: number } | null) => {
      URL.revokeObjectURL(url);
      probe.removeAttribute("src");
      if (result) resolve(result);
      else reject(new Error("Не удалось прочитать видео: формат не поддерживается"));
    };
    probe.preload = "metadata";
    probe.onloadedmetadata = () => {
      finish({ width: probe.videoWidth || VIDEO_FALLBACK.width, height: probe.videoHeight || VIDEO_FALLBACK.height });
    };
    probe.onerror = () => finish(null);
    probe.src = url;
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

function textAt(bytes: Uint8Array, offset: number, length: number): string {
  if (bytes.length < offset + length) return "";
  let result = "";
  for (let index = 0; index < length; index += 1) result += String.fromCharCode(bytes[offset + index]);
  return result;
}

function startsWith(bytes: Uint8Array, pattern: number[]): boolean {
  if (bytes.length < pattern.length) return false;
  return pattern.every((byte, index) => bytes[index] === byte);
}

/**
 * Тип файла по сигнатурам байт.
 *
 * Расширению и MIME верить нельзя: `.mkv` приходит из диалога с пустым типом, а
 * переименованный файл вообще не говорит о содержимом. Поэтому сначала смотрим
 * контейнер (PNG/JPEG/GIF/RIFF/EBML/`ftyp`/Ogg/FLAC/MP3), и только если байты
 * ничего не сказали — верим имени файла. Это и убирает «The source image could
 * not be decoded»: видео физически не может попасть в спрайт.
 */
export function sniffContainer(bytes: Uint8Array): MediaSpec["type"] | null {
  if (!bytes.length) return null;
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return "image"; // PNG / APNG
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image"; // JPEG
  const tag = textAt(bytes, 0, 4);
  if (tag === "GIF8") return "image";
  if (tag === "RIFF") {
    const form = textAt(bytes, 8, 4);
    if (form === "WEBP") return "image";
    if (form === "WAVE") return "audio";
    if (form === "AVI ") return "video";
  }
  if (tag === "OggS") return "audio";
  if (tag === "fLaC") return "audio";
  if (textAt(bytes, 0, 3) === "ID3") return "audio";
  if (textAt(bytes, 4, 4) === "ftyp") {
    const brand = textAt(bytes, 8, 4);
    if (brand.startsWith("M4A") || brand.startsWith("M4B")) return "audio";
    if (["avif", "avis", "heic", "heix", "mif1", "msf1"].includes(brand)) return "image";
    return "video"; // mp4 / mov / m4v
  }
  // EBML: WebM и Matroska — оба видео-контейнеры.
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "video";
  // MP3 без ID3: кадр начинается с 11 единиц синхронизации.
  if (bytes.length > 1 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return "audio";
  if (startsWith(bytes, [0x42, 0x4d])) return "image"; // BMP
  return null;
}

/** Узнаёт тип файла: сигнатуры байт важнее MIME и расширения. */
export async function fileKind(file: File): Promise<MediaSpec["type"] | null> {
  return sniffContainer(await head(file)) ?? mediaTypeOf(file);
}

/** Разбирает файл и говорит, какой объект из него получится. */
export async function inspectFile(file: File): Promise<ImportedFile> {
  const bytes = await head(file);
  const type = sniffContainer(bytes) ?? mediaTypeOf(file);
  const name = file.name.replace(/\.[^.]+$/, "") || "файл";

  if (!type) {
    throw new Error(`Файл «${file.name}» не похож на картинку, видео или звук`);
  }
  if (type === "audio") {
    return { kind: "media", mediaType: "audio", src: await keep(file), name, ...AUDIO_SIZE };
  }
  if (type === "video") {
    const size = await videoSize(file).catch(() => ({ ...VIDEO_FALLBACK }));
    return { kind: "media", mediaType: "video", src: await keep(file), name, ...size };
  }
  // Картинка обязана декодироваться: иначе на сцене появился бы битый спрайт
  // с ошибкой «The source image could not be decoded».
  const size = await imageSize(file).catch(() => null);
  if (!size) throw new Error(`Не удалось прочитать картинку «${file.name}»`);
  if (isAnimatedImage(file.name, file.type, bytes)) {
    return { kind: "media", mediaType: "image", src: await keep(file), name, ...size };
  }
  // Осталась обычная картинка — это спрайт, как и раньше.
  return { kind: "sprite", mediaType: null, src: await keep(file), name, ...size };
}

/**
 * Кладёт файл в хранилище и отдаёт `asset:<id>`.
 *
 * Запасной путь — data URL: если IndexedDB недоступна, пресет всё равно
 * получит файл, просто он будет лежать внутри JSON, как раньше.
 */
async function keep(file: File): Promise<string> {
  const ref = await storeFile(file);
  return ref ?? blobToDataUrl(file);
}
