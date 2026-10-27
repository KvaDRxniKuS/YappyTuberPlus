import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assetIdsOfPreset } from "../../src/engine/assets";
import { normalizePreset } from "../../src/engine/preset";
import { DEFAULT_BASE, type RigObject, type RigPreset } from "../../src/types";
import { PRESET_FORMAT } from "../../src/version";

/*
 * Файлы объекта: карта нормалей — такой же файл, как картинка и маска.
 *
 * Две регрессии, которые эти тесты держат:
 *
 * 1. **Объект пропадал при силе объёма больше 0.** Проход объёма рисовал в низ
 *    кадрового буфера, а читал из верха, и `copy` заменял объект прозрачностью.
 *    Проверка в `light.spec.ts` (`viewportOf`), здесь — вторая часть.
 *
 * 2. **Нормали пропадали, а объекты оставались.** Карта нормалей не попадала ни
 *    в список файлов пресета, ни в сохранение: `asset:<id>` оставался, файла по
 *    нему не было — объём молча выключался. Отсюда и разное поведение разных
 *    файлов: у кого карта лежала в хранилище, у того объём работал.
 */

function object(patch: Partial<RigObject>): RigObject {
  return {
    id: "face",
    name: "Лицо",
    kind: "sprite",
    enabled: true,
    image: "asset:face-image",
    parentId: null,
    pivot: { x: 0.5, y: 0.5 },
    base: { ...DEFAULT_BASE },
    script: "",
    width: 200,
    height: 200,
    ...patch,
  };
}

function preset(objects: RigObject[]): RigPreset {
  const value = normalizePreset({ version: PRESET_FORMAT, name: "Проба", objects, canvas: { width: 800, height: 600 } } as never);
  expect(value, "пресет собрался").not.toBeNull();
  return value!;
}

test("файлы объекта: карта нормалей входит в список файлов пресета", () => {
  const withMap = preset([
    object({ normal: { src: "asset:face-normal", strength: 100, animate: false } }),
  ]);
  const ids = assetIdsOfPreset(withMap);
  // Картинка и карта: без неё пресет открывался без файла, и объём гас.
  expect([...ids].sort()).toEqual(["face-image", "face-normal"]);
});

test("файлы объекта: карта у медиа и карта без ссылки не ломают список", () => {
  const media = preset([
    object({ id: "clip", kind: "media", image: "", media: { type: "video", src: "asset:clip-file", fileName: "clip.mp4" } as never,
      normal: { src: "asset:clip-normal", strength: 50, animate: true } }),
  ]);
  expect([...assetIdsOfPreset(media)].sort()).toEqual(["clip-file", "clip-normal"]);

  // Карта-внешний путь и карта без файла: в список попадает только хранилище.
  const edge = preset([
    object({ image: "", normal: { src: null, strength: 100, animate: false } }),
    object({ id: "second", image: "https://example.test/a.png", normal: { src: "https://example.test/n.png", strength: 100, animate: false } }),
  ]);
  expect(assetIdsOfPreset(edge).size).toBe(0);
});

test("файлы объекта: сохранение и папка <имя>.assets перечисляют карту и маску", () => {
  const assets = readFileSync(join(process.cwd(), "src", "engine", "assets.ts"), "utf8");
  // Встраивание в файл пресета: иначе data URL из чужого пресета терялся.
  expect(assets).toContain("if (next.normal?.src && isAssetRef(next.normal.src))");
  expect(assets).toContain('missing.push(`${object.name} (карта нормалей)`)');
  // Разбор data URL при открытии: карта остаётся в хранилище, а не в пресете.
  expect(assets).toContain("if (next.normal?.src && isDataUrl(next.normal.src))");
  expect(assets).toContain("`${next.id}-normal.${extensionOf(next.normal.src)}`");

  // Папка рядом с пресетом: маска и карта переезжают вместе с ним.
  const file = readFileSync(join(process.cwd(), "src", "engine", "presetFile.ts"), "utf8");
  const sidecar = file.slice(file.indexOf("async function writeSidecar"), file.indexOf("if (files.length)"));
  expect(sidecar).toContain("object.normal?.src");
  expect(sidecar).toContain('object.mask?.kind === "file" ? object.mask.file : null');
});

test("файлы объекта: пропавшая карта называется в инспекторе", () => {
  // Молча выключенный объём читается как поломка рендера: причина должна быть
  // видна там же, где карта выбирается.
  const section = readFileSync(join(process.cwd(), "src", "components", "LightSection.tsx"), "utf8");
  expect(section).toContain("const missing = useAssetMissing(normal?.src);");
  expect(section).toContain("Файл карты не найден");
  // «Нет файла» и «ещё грузится» — разные состояния, иначе плашка мигала бы.
  const hooks = readFileSync(join(process.cwd(), "src", "hooks", "useAssets.ts"), "utf8");
  expect(hooks).toContain("export function useAssetMissing");
  expect(readFileSync(join(process.cwd(), "src", "engine", "assets.ts"), "utf8"))
    .toContain("export function assetMissing");
});

test("файлы объекта: карты материала тоже входят в список файлов", () => {
  // Материал — это до пяти файлов: упаковка, три канала и карта свечения.
  // Пропустить любой из них значит потерять его при переносе пресета.
  const scene = preset([
    object({
      material: {
        roughness: { value: 0, file: "asset:rough", from: "file", packedChannel: "r" },
        metallic: { value: 0, file: null, from: "packed", packedChannel: "g" },
        ao: { value: 1, file: "asset:ao", from: "file", packedChannel: "b" },
        emissive: { color: "#ffffff", strength: 40, file: "asset:glow" },
        packed: "asset:orm",
        specular: 100,
      },
    }),
  ]);
  expect([...assetIdsOfPreset(scene)].sort()).toEqual([
    "ao", "face-image", "glow", "orm", "rough",
  ]);

  // Сохранение и папка `.assets` берут тот же список: одна правда о файлах.
  const assets = readFileSync(join(process.cwd(), "src", "engine", "assets.ts"), "utf8");
  expect(assets).toContain("...materialSources(object.material)");
  expect(assets).toContain("(упакованная карта)");
  expect(assets).toContain("(карта свечения)");
  const file = readFileSync(join(process.cwd(), "src", "engine", "presetFile.ts"), "utf8");
  const sidecar = file.slice(file.indexOf("async function writeSidecar"), file.indexOf("if (files.length)"));
  expect(sidecar).toContain("...materialSources(object.material)");
});
