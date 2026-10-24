import type { RigObject, Vec2 } from "../types";

/**
 * Пружинная цепочка: готовый «хвост» из выделенных объектов.
 *
 * Идея в том, что цепочка не хранит физику нигде, кроме скриптов: у каждого
 * сегмента `rotation` — это пружина, которая тянется за углом родителя. Из-за
 * отставания пружины волна бежит от корня к кончику, а `noise` в цели даёт
 * покачивание в покое. Параметры меняются от сегмента к сегменту: чем дальше
 * от корня, тем ниже частота и выше затухание — так кончик не дребезжит.
 */

export interface ChainSettings {
  /** Частота пружины у первого сегмента, Гц. */
  frequency: number;
  /** Затухание 0..1: меньше — дольше качается. */
  damping: number;
  /** Изгиб покоя на сегмент, градусы. Знак задаёт сторону закрутки. */
  bend: number;
  /** Амплитуда покачивания в покое, градусы. */
  sway: number;
  /** Ставить пивот на верхнюю кромку: там шарнир, вокруг него и вращаемся. */
  hinge: boolean;
}

export const DEFAULT_CHAIN: ChainSettings = {
  frequency: 2.2,
  damping: 0.3,
  bend: 4,
  sway: 2.5,
  hinge: true,
};

/** Пивот-шарнир: чуть ниже верхней кромки, чтобы вращение шло по стыку. */
export const CHAIN_PIVOT: Vec2 = { x: 0.5, y: 0.06 };

/** Число без хвостовых нулей: 2.20 → 2.2, 4 → 4. */
function num(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/** Скрипт сегмента: `link` — сколько сегментов выше него в цепочке. */
export function chainScript(link: number, settings: ChainSettings): string {
  const frequency = Math.max(0.4, settings.frequency * (1 - 0.08 * link));
  const damping = Math.min(0.95, settings.damping + 0.03 * link);
  const seed = 13 + link * 29;
  const wiggle = settings.sway > 0 ? ` + noise(${seed}, 0.3) * ${num(settings.sway)}` : "";
  return [
    `// Сегмент ${link + 1} пружинной цепочки: пружина тянется за родителем,`,
    "// отставание и даёт волну по хвосту. Числа можно править руками.",
    "x = inherit + follow(offset, parent).x",
    "y = inherit + follow(offset, parent).y",
    `rotation = spring(inherit + ${num(settings.bend)}${wiggle}, ${num(frequency)}, ${num(damping)})`,
    "sizeX = inherit",
    "sizeY = inherit",
    "skewX = inherit",
    "skewY = inherit",
    "opacity = inherit",
    "visible = inherit",
    "layer = inherit",
  ].join("\n");
}

/**
 * Новый пивот двигает сам спрайт (он рисуется от `-pivot * размер`), поэтому
 * базу сдвигаем ровно на столько, чтобы картинка осталась на месте.
 */
export function hingeBase(object: RigObject, pivot: Vec2 = CHAIN_PIVOT): { base: RigObject["base"]; pivot: Vec2 } {
  const scaleX = object.base.sizeX;
  const scaleY = object.base.sizeY;
  const localX = (pivot.x - object.pivot.x) * object.width * scaleX;
  const localY = (pivot.y - object.pivot.y) * object.height * scaleY;
  const radians = (object.base.rotation * Math.PI) / 180;
  const dx = localX * Math.cos(radians) - localY * Math.sin(radians);
  const dy = localX * Math.sin(radians) + localY * Math.cos(radians);
  return {
    pivot,
    base: { ...object.base, x: object.base.x + dx, y: object.base.y + dy },
  };
}

/** Ходит вверх по новой иерархии и ищет петлю — такую цепочку строить нельзя. */
function hasCycle(parents: Map<string, string | null>): boolean {
  for (const start of parents.keys()) {
    const seen = new Set<string>();
    let current = parents.get(start) ?? null;
    while (current) {
      if (current === start) return true;
      if (seen.has(current)) break;
      seen.add(current);
      current = parents.get(current) ?? null;
    }
  }
  return false;
}

export interface ChainResult {
  objects: RigObject[];
  /** Сколько сегментов получило физику (корень без родителя в неё не входит). */
  links: number;
}

/**
 * Связывает выделенные объекты в цепочку: второй становится ребёнком первого,
 * третий — ребёнком второго и так далее. Порядок выделения = порядок от корня.
 */
export function buildChain(
  objects: RigObject[],
  ids: string[],
  settings: ChainSettings,
): ChainResult {
  const chain = ids.filter((id, index) => ids.indexOf(id) === index && objects.some((object) => object.id === id));
  if (chain.length < 2) throw new Error("Выделите хотя бы два объекта: первый — корень, дальше по порядку");

  const byId = new Map(objects.map((object) => [object.id, object]));
  const root = byId.get(chain[0])!;
  // У корня уже есть родитель — значит он тоже сегмент и тоже получает пружину.
  const rewriteRoot = Boolean(root.parentId);

  const parents = new Map<string, string | null>();
  for (let index = 1; index < chain.length; index += 1) {
    parents.set(chain[index], chain[index - 1]);
  }
  for (const object of objects) {
    if (!parents.has(object.id)) parents.set(object.id, object.parentId);
  }
  if (hasCycle(parents)) throw new Error("Так получится петля: объект окажется родителем самому себе");

  let links = 0;
  const next = objects.map((object) => {
    const position = chain.indexOf(object.id);
    if (position < 0) return object;
    // Корень рига (без родителя) не переписываем: его движение — это движение
    // всего персонажа, а не хвоста.
    if (position === 0 && !rewriteRoot) return object;

    const link = rewriteRoot ? position : position - 1;
    links = Math.max(links, link + 1);
    const parentId = position === 0 ? object.parentId : chain[position - 1];
    const posed = settings.hinge ? hingeBase(object) : { base: object.base, pivot: object.pivot };
    return {
      ...object,
      parentId,
      pivot: posed.pivot,
      base: posed.base,
      script: chainScript(link, settings),
    };
  });

  return { objects: next, links };
}
