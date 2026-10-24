import type { ObjectFrame, RigFrame, RigPreset } from "../types";

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
 * Кадр без анимации для всего пресета. Порядок отрисовки — по базовому слою,
 * затем по порядку объектов, как у движка до первого кадра.
 */
export function neutralFrame(preset: RigPreset, seq = 0): RigFrame {
  const objects: Record<string, ObjectFrame> = {};
  for (const object of preset.objects) {
    objects[object.id] = {
      ...NEUTRAL_PARAMS,
      visible: object.base.visible,
      layer: object.base.layer,
    };
  }
  const order = [...preset.objects]
    .sort((a, b) => (a.base.layer - b.base.layer) || (preset.objects.indexOf(a) - preset.objects.indexOf(b)))
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
