import type { ObjectFrame, RigFrame, RigObject, RigPreset } from "../types";
import { frontness, structurePaths } from "./structure";

/**
 * Нейтральная поза: динамические параметры выключены, видны только базовые.
 * Используется кнопкой «Стоп» — спрайты встают ровно туда, где задана базовая
 * поза, и их удобно расставлять мышью.
 */
export const NEUTRAL_PARAMS: ObjectFrame = {
  x: 0, y: 0, rotation: 0, sizeX: 1, sizeY: 1, skewX: 0, skewY: 0,
  opacity: 1, visible: 1, layer: 0,
};

/**
 * Объекты, недоступные для показа: у которых выключен `enabled` или выключен
 * кто-то из родителей. Глаз в структуре меняет только этот флаг, формулы и
 * `visible` в скрипте остаются нетронутыми.
 */
export function disabledIds(objects: RigObject[]): Set<string> {
  const byId = new Map(objects.map((object) => [object.id, object]));
  const cache = new Map<string, boolean>();
  const isDisabled = (id: string): boolean => {
    if (cache.has(id)) return cache.get(id)!;
    const chain: string[] = [];
    const seen = new Set<string>();
    let pointer: string | null = id;
    while (pointer && !seen.has(pointer) && !cache.has(pointer)) {
      seen.add(pointer);
      chain.push(pointer);
      pointer = byId.get(pointer)?.parentId ?? null;
    }
    let value = pointer ? cache.get(pointer) ?? false : false;
    for (const item of chain.reverse()) {
      value = byId.get(item)?.enabled === false || value;
      cache.set(item, value);
    }
    return cache.get(id) ?? false;
  };
  return new Set(objects.filter((object) => isDisabled(object.id)).map((object) => object.id));
}

/**
 * Применяет флаг `enabled` к готовому кадру движка: у выключенных объектов и их
 * потомков `visible` становится нулём. Движок про этот флаг не знает — он живёт
 * только в редакторе и в оверлее, поэтому кадр правится один раз на выходе.
 */
export function applyEnabled(preset: RigPreset, frame: RigFrame): RigFrame {
  const disabled = disabledIds(preset.objects);
  if (!disabled.size) return frame;
  let changed = false;
  const objects: Record<string, ObjectFrame> = {};
  for (const [id, values] of Object.entries(frame.objects)) {
    if (disabled.has(id) && values.visible !== 0) {
      objects[id] = { ...values, visible: 0 };
      changed = true;
    } else {
      objects[id] = values;
    }
  }
  return changed ? { ...frame, objects } : frame;
}

/**
 * Порядок отрисовки движка: слой по возрастанию, а при равном слое поверх
 * оказывается тот объект, который **выше в структуре**. Раньше при равном слое
 * поверх был нижний, поэтому перестановка строк в дереве ни на что не влияла.
 */
export function applyTreeOrder(preset: RigPreset, frame: RigFrame): RigFrame {
  const paths = structurePaths(preset.objects);
  const order = [...frame.order].sort((a, b) => {
    const layerA = frame.objects[a]?.layer ?? 0;
    const layerB = frame.objects[b]?.layer ?? 0;
    if (layerA !== layerB) return layerA - layerB;
    // При равном слое поверх тот, кто выше в структуре (и потомок поверх предка).
    return frontness(paths.get(a), paths.get(b));
  });
  const unchanged = order.length === frame.order.length && order.every((id, index) => id === frame.order[index]);
  return unchanged ? frame : { ...frame, order };
}

/** Всё, что редактор доделывает поверх кадра движка: флаг enabled и порядок структуры. */
export function prepareFrame(preset: RigPreset, frame: RigFrame): RigFrame {
  return applyTreeOrder(preset, applyEnabled(preset, frame));
}

/**
 * Кадр без анимации для всего пресета. Порядок отрисовки — по базовому слою,
 * затем по порядку объектов, как у движка до первого кадра.
 */
export function neutralFrame(preset: RigPreset, seq = 0): RigFrame {
  const disabled = disabledIds(preset.objects);
  const objects: Record<string, ObjectFrame> = {};
  for (const object of preset.objects) {
    objects[object.id] = {
      ...NEUTRAL_PARAMS,
      visible: disabled.has(object.id) ? 0 : object.base.visible,
      layer: object.base.layer,
    };
  }
  const paths = structurePaths(preset.objects);
  const order = [...preset.objects]
    .sort((a, b) => (a.base.layer - b.base.layer) || frontness(paths.get(a.id), paths.get(b.id)))
    .map((object) => object.id);
  return {
    seq,
    time: 0,
    dt: 0,
    globals: {},
    objects,
    order,
    diagnostics: [],
  };
}
