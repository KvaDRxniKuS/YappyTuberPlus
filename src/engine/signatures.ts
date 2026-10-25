/**
 * Подписи функций скрипта: что функция ждёт и что делает.
 *
 * Данные держим в одном месте, чтобы редактор, подсказка под курсором и
 * список функций показывали одно и то же. Источник истины — `docs/DESIGN.md`,
 * раздел про формулы; здесь только короткие русские подписи аргументов.
 */

export interface FunctionSignature {
  /** Аргументы по порядку — так, как их ждёт ядро. */
  params: string[];
  /** Необязательные аргументы (можно не писать). */
  optional?: string[];
  /** Функция принимает сколько угодно аргументов начиная с этого места. */
  variadic?: boolean;
  /** Что функция делает — одной строкой. */
  summary: string;
  group: "math" | "vector" | "physics" | "random" | "compare";
}

export const SIGNATURES: Record<string, FunctionSignature> = {
  // Математика
  abs: { params: ["x"], summary: "модуль числа", group: "math" },
  sign: { params: ["x"], summary: "-1, 0 или 1", group: "math" },
  min: { params: ["a", "b"], variadic: true, summary: "минимум из аргументов", group: "math" },
  max: { params: ["a", "b"], variadic: true, summary: "максимум из аргументов", group: "math" },
  limit: { params: ["x", "lo", "hi"], summary: "обычное ограничение x в lo..hi", group: "math" },
  clamp: { params: ["x", "ref", "lo", "hi"], summary: "ограничение смещения относительно ref", group: "math" },
  round: { params: ["x"], summary: "ближайшее целое, половины вверх", group: "math" },
  floor: { params: ["x"], summary: "вниз до целого", group: "math" },
  ceil: { params: ["x"], summary: "вверх до целого", group: "math" },
  sqrt: { params: ["x"], summary: "квадратный корень", group: "math" },
  pow: { params: ["a", "b"], summary: "a в степени b", group: "math" },
  exp: { params: ["x"], summary: "экспонента", group: "math" },
  log: { params: ["x"], summary: "натуральный логарифм", group: "math" },
  sin: { params: ["x"], summary: "синус, радианы", group: "math" },
  cos: { params: ["x"], summary: "косинус, радианы", group: "math" },
  tan: { params: ["x"], summary: "тангенс, радианы", group: "math" },
  sind: { params: ["x"], summary: "синус, градусы", group: "math" },
  cosd: { params: ["x"], summary: "косинус, градусы", group: "math" },
  tand: { params: ["x"], summary: "тангенс, градусы", group: "math" },
  atan2: { params: ["y", "x"], summary: "угол вектора (y, x), радианы", group: "math" },
  mod: { params: ["a", "b"], summary: "остаток от деления", group: "math" },
  lerp: { params: ["a", "b", "t"], summary: "линейная интерполяция a..b, t 0..1", group: "math" },
  smoothstep: { params: ["e0", "e1", "x"], summary: "плавный переход 0..1 между e0 и e1", group: "math" },
  deg: { params: ["x"], summary: "радианы в градусы", group: "math" },
  rad: { params: ["x"], summary: "градусы в радианы", group: "math" },

  // Векторы: все векторы в формулах — пиксели сцены
  vec: { params: ["x", "y"], summary: "создать вектор", group: "vector" },
  vadd: { params: ["a", "b"], summary: "сложение векторов", group: "vector" },
  vsub: { params: ["a", "b"], summary: "вычитание векторов", group: "vector" },
  vmul: { params: ["v", "k"], summary: "вектор, умноженный на число", group: "vector" },
  vscale: { params: ["v", "sx", "sy"], summary: "покомпонентный масштаб", group: "vector" },
  vlen: { params: ["v"], summary: "длина вектора в пикселях", group: "vector" },
  vnorm: { params: ["v"], summary: "единичный вектор без единиц", group: "vector" },
  vdot: { params: ["a", "b"], summary: "скалярное произведение, px²", group: "vector" },
  vangle: { params: ["a", "b"], summary: "угол между векторами, градусы", group: "vector" },
  rotate: { params: ["v", "deg"], summary: "повернуть вектор на угол в градусах", group: "vector" },
  orbit: { params: ["v", "deg"], summary: "rotate(v, deg) - v — смещение по дуге", group: "vector" },
  follow: { params: ["v", "parent"], summary: "смещение от динамики родителя (масштаб и поворот)", group: "vector" },
  px: { params: ["n", "size"], summary: "UV в пиксели по одной оси", group: "vector" },
  uv: { params: ["value", "size"], summary: "пиксели в UV по одной оси", group: "vector" },
  pxv: { params: ["v", "sizeVec"], summary: "UV-вектор в пиксельный вектор", group: "vector" },
  uvv: { params: ["v", "sizeVec"], summary: "пиксельный вектор в UV-вектор", group: "vector" },

  // Физика и сглаживание: stateful, живут между кадрами
  smooth: { params: ["target", "halflifeMs"], summary: "догоняет target; за halflifeMs проходит половину пути", group: "physics" },
  spring: { params: ["target", "frequencyHz", "damping"], summary: "пружина; frequencyHz — частота, damping — затухание 0..1", group: "physics" },

  // Случайность
  rnd: { params: ["seed", "min", "max"], summary: "детерминированное число из seed", group: "random" },
  noise: { params: ["seed", "frequencyHz"], summary: "плавный шум -1..1", group: "random" },
  shake: { params: ["amplitude", "frequencyHz", "seed"], optional: ["seed"], summary: "плавное дрожание вокруг нуля", group: "random" },
  random: { params: ["min", "max"], summary: "новое число каждый кадр", group: "random" },
  autoblink: { params: ["minMs", "maxMs", "seed"], optional: ["seed"], summary: "0/1; сам планирует моргание", group: "random" },

  // Сравнения: возвращают 0 или 1, поэтому их можно умножать и складывать в формуле.
  near: { params: ["a", "b", "eps"], summary: "1, если |a − b| не больше eps", group: "compare" },
  between: { params: ["x", "lo", "hi"], summary: "1, если lo ≤ x ≤ hi (границы в любом порядке)", group: "compare" },
  is: { params: ["x", "a"], variadic: true, summary: "1, если x равно любому из перечисленных", group: "compare" },
};

export const FUNCTION_NAMES = Object.keys(SIGNATURES);

/** `spring(target, frequencyHz, damping)` — подпись без необязательных пометок. */
export function signatureOf(name: string): string {
  const entry = SIGNATURES[name];
  if (!entry) return `${name}()`;
  const params = entry.params.map((param) =>
    entry.optional?.includes(param) ? `${param}?` : param,
  );
  if (entry.variadic) params.push("…");
  return `${name}(${params.join(", ")})`;
}

/** Подсказка про аргумент: `необязательный, можно не писать`. */
export function parameterHint(name: string, index: number): string | null {
  const entry = SIGNATURES[name];
  if (!entry) return null;
  const param = entry.params[index];
  if (!param) return entry.variadic ? "можно добавить ещё аргументы" : null;
  const optional = entry.optional?.includes(param) ? " · необязательный" : "";
  return `аргумент ${index + 1} из ${entry.params.length}: ${param}${optional}`;
}

export interface SignatureHint {
  name: string;
  /** Номер активного аргумента с нуля. */
  index: number;
}

/**
 * Какая функция и какой аргумент окружают позицию курсора.
 * Считаем скобки назад от курсора: так подсказка работает и в многострочных
 * вызовах, и во вложенных (`spring(clamp(x, 0, 1), 8, 0.6)`).
 */
export function signatureAt(text: string, position: number): SignatureHint | null {
  const cursor = Math.max(0, Math.min(position, text.length));
  let closed = 0;
  for (let i = cursor - 1; i >= 0; i -= 1) {
    const char = text[i];
    if (char === ")" || char === "}") closed += 1;
    else if (char === "(" || char === "{") {
      if (closed > 0) {
        closed -= 1;
        continue;
      }
      if (char === "{") return null;
      const match = /([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(text.slice(0, i));
      if (!match || !SIGNATURES[match[1]]) return null;
      let index = 0;
      let depth = 0;
      for (let j = i + 1; j < cursor; j += 1) {
        const inner = text[j];
        if (inner === "(" || inner === "[") depth += 1;
        else if (inner === ")" || inner === "]") depth -= 1;
        else if (inner === "," && depth === 0) index += 1;
      }
      return { name: match[1], index };
    }
  }
  return null;
}

/** Строка-подсказка под редактором: подпись плюс активный аргумент. */
export function signatureLine(hint: SignatureHint | null): string {
  if (!hint) return "";
  return `${signatureOf(hint.name)} — ${parameterHint(hint.name, hint.index) ?? "аргумент не нужен"}`;
}
