import type { MeshSpec } from "../types";
import { regularGrid, resetGrid, resizeGrid } from "./mesh";

/*
 * Буфер сетки: «Скопировать сетку» → «Вставить сетку».
 *
 * Буфер общий на всё приложение и живёт в памяти: сетка — это структура
 * объекта, а не текст, и переживать перезапуск ей незачем. Артмеш при переносе
 * **не трогается**: нарезка принадлежит картинке, а сетка — форме, и вставлять
 * чужую нарезку в другую картинку значило бы порвать её молча.
 */

let held: MeshSpec | null = null;

/** Положить сетку в буфер: копия, чтобы дальнейшие правки её не меняли. */
export function holdMesh(mesh: MeshSpec | null): void {
  held = mesh
    ? {
      ...mesh,
      frame: { ...mesh.frame },
      art: { ...mesh.art, points: [...mesh.art.points], triangles: [...mesh.art.triangles] },
      deform: { ...mesh.deform, points: mesh.deform.points.map((point) => ({ ...point })) },
      brush: mesh.brush ? { ...mesh.brush } : undefined,
      mirror: mesh.mirror ? { ...mesh.mirror } : undefined,
    }
    : null;
}

/** Что лежит в буфере. */
export function heldMesh(): MeshSpec | null {
  return held;
}

/** Режим вставки: перенести как есть, пересчитать на текущую густоту или сбросить. */
export type PasteMode = "transfer" | "resample" | "reset";

/** Нужно ли спрашивать режим: разная густота или другая нарезка — да. */
export function askPasteMode(target: MeshSpec, source: MeshSpec): boolean {
  return target.deform.cols !== source.deform.cols
    || target.deform.rows !== source.deform.rows
    || target.art.points.length !== source.art.points.length;
}

/**
 * Сетка после вставки.
 *
 * - `transfer` — размер и форма источника заменяют текущие, ось симметрии едет
 *   с сеткой; нарезка, зона и кисть остаются своими.
 * - `resample` — густота остаётся текущей, форма источника раскладывается на неё
 *   билинейно.
 * - `reset` — регулярная сетка текущего размера.
 */
export function pasteMesh(target: MeshSpec, source: MeshSpec, mode: PasteMode): MeshSpec {
  if (mode === "reset") return { ...target, deform: resetGrid(target.deform) };
  if (mode === "resample") {
    return { ...target, deform: resizeGrid(source.deform, target.deform.cols, target.deform.rows) };
  }
  return {
    ...target,
    deform: { ...source.deform, points: source.deform.points.map((point) => ({ ...point })) },
    // Ось симметрии — часть сетки: переехала сетка, переехала и она.
    mirror: source.mirror ? { ...source.mirror } : target.mirror,
  };
}

/** Пустая сетка текущей густоты: пригодится тому, кто вставляет «сброс». */
export function emptyGrid(cols: number, rows: number) {
  return regularGrid(cols, rows);
}
