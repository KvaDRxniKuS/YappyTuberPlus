import { expect, test } from "@playwright/test";
import { sniffContainer } from "../../src/engine/importFile";

/** Байты: числа — как есть, строки — их ASCII-коды. */
const bytes = (...values: (number | string)[]): Uint8Array => {
  const out: number[] = [];
  for (const value of values) {
    if (typeof value === "number") out.push(value);
    else for (const char of value) out.push(char.charCodeAt(0));
  }
  return new Uint8Array([...out, ...new Array(Math.max(0, 40 - out.length)).fill(0)]);
};

test("тип файла определяется по содержимому, а не по расширению", () => {
  // Картинки.
  expect(sniffContainer(bytes(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image");
  expect(sniffContainer(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image");
  expect(sniffContainer(bytes("GIF89a"))).toBe("image");
  expect(sniffContainer(bytes("RIFF", 0, 0, 0, 0, "WEBP"))).toBe("image");
  expect(sniffContainer(bytes(0, 0, 0, 0x1c, "ftyp", "avif"))).toBe("image");
  // Видео: mp4/mov, webm/mkv, avi.
  expect(sniffContainer(bytes(0, 0, 0, 0x18, "ftyp", "mp42"))).toBe("video");
  expect(sniffContainer(bytes(0, 0, 0, 0x14, "ftyp", "qt  "))).toBe("video");
  expect(sniffContainer(bytes(0x1a, 0x45, 0xdf, 0xa3))).toBe("video");
  expect(sniffContainer(bytes("RIFF", 0, 0, 0, 0, "AVI "))).toBe("video");
  // Звук: wav, ogg, flac, mp3 с тегом и без, m4a.
  expect(sniffContainer(bytes("RIFF", 0, 0, 0, 0, "WAVE"))).toBe("audio");
  expect(sniffContainer(bytes("OggS"))).toBe("audio");
  expect(sniffContainer(bytes("fLaC"))).toBe("audio");
  expect(sniffContainer(bytes("ID3", 0x03, 0x00))).toBe("audio");
  expect(sniffContainer(bytes(0xff, 0xfb, 0x90))).toBe("audio");
  expect(sniffContainer(bytes(0, 0, 0, 0x1c, "ftyp", "M4A "))).toBe("audio");
  // Всё остальное — не наш файл: молча спрайт из него не делается.
  expect(sniffContainer(bytes("hello world"))).toBeNull();
  expect(sniffContainer(new Uint8Array())).toBeNull();
});
