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
  group: "math" | "vector" | "physics" | "random" | "compare" | "media" | "text";
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

  // Команды медиа и текста. В отличие от функций они ничего не возвращают:
  // пишутся отдельной строкой внутри блока события. Первый аргумент-строка —
  // id чужого объекта, без него команда действует на свой объект.
  play: { params: ["объект"], optional: ["объект"], summary: "начать с начала по политике повтора", group: "media" },
  resume: { params: ["объект"], optional: ["объект"], summary: "продолжить с текущего места", group: "media" },
  pause: { params: ["объект"], optional: ["объект"], summary: "пауза без перемотки", group: "media" },
  stop: { params: ["объект"], optional: ["объект"], summary: "остановить и вернуться в начало", group: "media" },
  seek: { params: ["объект", "секунды"], optional: ["объект"], summary: "перемотать звук или видео на время", group: "media" },
  rate: { params: ["объект", "скорость"], optional: ["объект"], summary: "скорость воспроизведения, 0.1…4", group: "media" },
  volume: { params: ["объект", "громкость"], optional: ["объект"], summary: "громкость 0…1 на время", group: "media" },

  // Текст: значение-строка. `text = …` — переменная объекта, а `text(x)` ещё и
  // превращает число в строку: `text = "db " + text(mic.db)`.
  text: { params: ["значение", "объект"], optional: ["объект"], summary: "значение в текст; как команда — задать текст объекта", group: "text" },
  upper: { params: ["текст"], summary: "все буквы заглавные", group: "text" },
  lower: { params: ["текст"], summary: "все буквы строчные", group: "text" },
  len: { params: ["текст"], summary: "сколько символов в тексте", group: "text" },
  fixed: { params: ["число", "знаки"], summary: "число текстом с нужным числом знаков после запятой", group: "text" },
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

/** Вход модуля для подсказки: полное имя и подпись из панели. */
export interface EventHintInput {
  key: string;
  label?: string;
}

/**
 * Поля входа в выражении: направления уровня и активность за окно.
 *
 * Это обычные числа, а не отдельные виды событий: `mouse.left.up` — 1 на кадре,
 * когда сигнал вырос, `twitch.chat.count(5)` — сколько сообщений было за 5 с.
 */
export const INPUT_FIELDS = [
  { field: "up", note: "значение выше, чем в прошлом кадре" },
  { field: "down", note: "значение ниже, чем в прошлом кадре" },
  { field: "change", note: "значение отличается от прошлого кадра" },
  { field: "count(5)", note: "сколько событий входа было за 5 секунд" },
  { field: "sum(5)", note: "суммарный вес событий за 5 секунд" },
  { field: "avg(5)", note: "средний вес событий за 5 секунд" },
] as const;

/** Как пишется время: миллисекунды с необязательным суффиксом. */
export const TIME_HINT = "in 500 · in 250ms · in 0.5s";

/** Что нужно подсказке: входы модулей и объявленные события этой области. */
export interface HintOptions {
  inputs?: EventHintInput[];
  /** Имена из `event имя(…) { … }`: подсказываются после `on` и `call`. */
  events?: string[];
}

/** Строка, в которой стоит курсор, и текст до курсора. */
function lineAt(source: string, cursor: number): { before: string; line: string } {
  const lineStart = source.lastIndexOf("\n", cursor - 1) + 1;
  const lineEnd = source.indexOf("\n", cursor);
  const line = source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd);
  return { before: source.slice(lineStart, cursor), line };
}

/**
 * Подсказка по месту курсора — всплывает в самом редакторе, а не строкой снизу.
 *
 * Подсказка никогда не повторяет то, что уже написано целиком: как только блок
 * открыт (`{`), она молчит, чтобы не закрывать код; дальше работает
 * автодополнение. Ошибки старых форм (`on модуль.вход.тип`, `trigger`) тоже
 * объясняются здесь — человек видит новую запись рядом с курсором.
 */
export function hintAt(source: string, position: number, options: HintOptions = {}): string | null {
  const inputs = options.inputs ?? [];
  const events = options.events ?? [];
  const cursor = Math.max(0, Math.min(position, source.length));
  const { before, line } = lineAt(source, cursor);
  const opened = line.includes("{");

  // `on …` — подписка на объявленное имя; пути к входам больше не пишутся.
  const on = /^\s*on\s+([A-Za-z0-9_.]*)$/.exec(before);
  if (on && !opened) {
    const typed = on[1];
    if (typed.includes(".")) {
      return `«${typed}» — не событие: объявите его как event имя() { ${typed} }, а подписку пишите on имя { … }`;
    }
    const close = typed ? events.filter((name) => name.startsWith(typed)) : events;
    if (!typed) {
      return events.length
        ? `on имя { … } — объявленные события: ${events.join(", ")}; первый кадр — on start { … }`
        : "on start { … } — первый кадр; своё событие сначала объявляют: event имя() { условие }";
    }
    return close.length
      ? `on ${close[0]} { … } — объявленные события: ${close.join(", ")}`
      : `события '${typed}' нет: сначала event ${typed}() { условие }`;
  }

  // `call имя(…)` — прямой запуск обработчика.
  const call = /(?:^|[^\w.])call\s+([A-Za-z0-9_]*)$/.exec(before);
  if (call) {
    const typed = call[1];
    const close = typed ? events.filter((name) => name.startsWith(typed)) : events;
    const list = close.length ? `: ${close.join(", ")}` : "";
    return `call имя(аргументы) — обработчик выполняется сразу, пауза не мешает${list}`;
  }

  // `event имя (переменные ; пауза) { условие }`.
  if (/^\s*event\s+[A-Za-z0-9_]*$/.test(before) && !opened) {
    return "event имя(переменные ; пауза) { условие } — например event click() { mouse.left.up }";
  }
  if (/^\s*event\s+[A-Za-z0-9_]+\s*\([^)]*$/.test(before)) {
    return "переменные события: имя = выражение, через запятую; после ';' — пауза в миллисекундах";
  }
  if (/^\s*event\./.test(before)) {
    return "префикс 'event.' не нужен: условие пишется как event имя() { … }";
  }
  // Условие в `event` уже набрано, имя переменной или входа — дальше `in`.
  if (/(?:^|[^\w.])in\s*[0-9.]*$/.test(before)) {
    return `длительность условия: ${TIME_HINT}`;
  }

  // `<вход>.<поле>` — направления уровня и активность.
  const field = /(?:^|[^\w.])([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z0-9_]*)$/.exec(before);
  if (field && inputs.some((input) => input.key === field[1])) {
    const label = inputs.find((input) => input.key === field[1])?.label;
    const name = label ? `«${label}»` : field[1];
    return `${field[1]}.<поле> — ${name}: ${INPUT_FIELDS.map((entry) => entry.field).join(" · ")}`;
  }
  return null;
}
