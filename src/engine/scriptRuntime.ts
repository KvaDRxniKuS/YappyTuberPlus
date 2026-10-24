import type { RigFrame, RigPreset } from "../types";

/**
 * События и ссылки на чужие объекты.
 *
 * Ядро исполняет только присваивания `имя = выражение`, поэтому блоки событий и
 * обращения вида `рот.parent.size_x` разворачиваются в обычные выражения ещё до
 * отправки пресета в движок:
 *
 * ```
 * on event.mouse.left.down { a = !a }
 * ```
 * превращается в
 *
 * ```
 * a = event.e1 ? (!a) : state.g_a
 * ```
 *
 * где `event.e1` — импульс текущего кадра, а `state.g_a` — значение `a` с
 * прошлого кадра. Импульсы и снимки объектов редактор подставляет в значения
 * входов каждый кадр, поэтому движок остаётся прежним.
 */

/** Параметры объекта, доступные по имени из другого объекта. */
const PARAMS = new Set([
  "x", "y", "rotation", "size_x", "size_y", "skew_x", "skew_y", "opacity", "visible", "layer",
]);

/** Имена, которые нельзя принять за объект: ключевые слова языка и служебные. */
const RESERVED = new Set(["parent", "inherit", "signal", "event", "state", "vec", "time", "dt", "pi", "e"]);

export type EventKind = "down" | "up" | "change" | "hold" | "relax";

export interface EventRule {
  /** Ключ импульса в значениях входов: `event.e1`. */
  key: string;
  /** Вход-источник: `mouse.left`, `jump.down`, `mic.talking`. */
  source: string;
  kind: EventKind;
  /** Для `hold`/`relax`: сколько секунд держать уровень. */
  seconds: number;
  /** «Высокий уровень» для аналоговых входов, по умолчанию 0.5. */
  threshold: number;
}

export interface StateRef {
  /** Ключ в значениях входов: `state.g_a`, `state.o_mouth_x`. */
  key: string;
  /** Имя глобальной переменной, если это переменная. */
  name?: string;
  /** Объект и параметр, если это снимок чужого объекта. */
  objectId?: string;
  param?: string;
}

export interface CompiledScripts {
  globals: string;
  objects: Map<string, string>;
  events: EventRule[];
  states: StateRef[];
  /** Ошибки разбора: строка скрипта и текст (показываются в диагностике). */
  problems: string[];
}

interface Assignment {
  name: string;
  expression: string;
}

interface EventBlock {
  header: string;
  body: Assignment[];
}

interface OwnerScript {
  /** Строки без блоков событий: на их местах остаются пустые строки. */
  lines: string[];
  assignments: Map<string, Assignment>;
  order: string[];
  events: Array<{ rule: EventRule; body: Assignment[] }>;
}

const PARAM_DEFAULTS: Record<string, number> = {
  rotation: 0, skew_x: 0, skew_y: 0, layer: 0, x: 0, y: 0,
  size_x: 1, size_y: 1, opacity: 1, visible: 1,
};

/** Разбор заголовка `on event.mouse.left.down { … }`. */
function parseHeader(header: string): { source: string; kind: EventKind; seconds: number; threshold: number } | null {
  const text = header.trim().replace(/^on\s+/, "");
  const match = text.match(/^event\.([a-z0-9_]+)\.([a-z0-9_]+)\.([a-z_]+)(?:\(([^)]*)\))?$/i);
  if (!match) return null;
  const kind = match[3].toLowerCase() as EventKind;
  if (!["down", "up", "change", "hold", "relax"].includes(kind)) return null;
  const args = (match[4] || "").split(",").map((part) => part.trim()).filter(Boolean).map(Number);
  const seconds = kind === "hold" || kind === "relax" ? (Number.isFinite(args[0]) ? Math.max(0, args[0]) : 0) : 0;
  const threshold = Number.isFinite(args[1]) ? Math.min(1, Math.max(0, args[1])) : 0.5;
  return { source: `${match[1]}.${match[2]}`, kind, seconds, threshold };
}

function splitAssignment(line: string): Assignment | null {
  const text = line.split("//")[0].trim();
  if (!text) return null;
  const index = text.indexOf("=");
  if (index <= 0) return null;
  const name = text.slice(0, index).trim();
  const expression = text.slice(index + 1).replace(/^=/, "").trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !expression) return null;
  return { name, expression };
}

/** Достаёт блоки `on … { … }` из строк скрипта. */
function readOwner(script: string, problems: string[], ownerLabel: string): OwnerScript {
  const rawLines = script.split("\n");
  const lines: string[] = [];
  const assignments = new Map<string, Assignment>();
  const order: string[] = [];
  const events: Array<{ rule: EventRule; body: Assignment[] }> = [];

  for (let index = 0; index < rawLines.length; index += 1) {
    const line = rawLines[index];
    const trimmed = line.trim();
    if (!trimmed.startsWith("on ")) {
      lines.push(line);
      const assignment = splitAssignment(line);
      if (assignment) {
        assignments.set(assignment.name, assignment);
        if (!order.includes(assignment.name)) order.push(assignment.name);
      }
      continue;
    }

    // Заголовок события: тело может быть в той же строке или на следующих.
    const open = trimmed.indexOf("{");
    const header = open >= 0 ? trimmed.slice(0, open) : trimmed;
    const bodyLines: string[] = [];
    if (open >= 0) {
      const rest = trimmed.slice(open + 1);
      const close = rest.lastIndexOf("}");
      if (close >= 0) {
        if (rest.slice(0, close).trim()) bodyLines.push(rest.slice(0, close).trim());
      } else if (rest.trim()) {
        bodyLines.push(rest.trim());
      }
    }
    let closed = open >= 0 && trimmed.slice(open + 1).includes("}");
    // Сколько строк редактора занял блок: столько же пустых строк останется,
    // чтобы номера строк в диагностике совпадали с текстом.
    let consumed = 1;
    while (!closed && index + 1 < rawLines.length) {
      index += 1;
      consumed += 1;
      const next = rawLines[index];
      const nextTrimmed = next.trim();
      if (nextTrimmed === "}") { closed = true; break; }
      if (nextTrimmed.endsWith("}")) {
        const body = nextTrimmed.slice(0, nextTrimmed.lastIndexOf("}")).trim();
        if (body) bodyLines.push(body);
        closed = true;
        break;
      }
      bodyLines.push(next);
    }

    const parsed = parseHeader(header);
    if (!parsed) {
      problems.push(`${ownerLabel}: не разобрано «${header.trim()}»; ожидалось on event.модуль.вход.тип`);
      lines.push(line);
      continue;
    }
    const body: Assignment[] = [];
    for (const bodyLine of bodyLines) {
      const assignment = splitAssignment(bodyLine);
      if (assignment) body.push(assignment);
    }
    // Каждая строка блока остаётся пустой строкой: номера строк в диагностике
    // движка продолжают совпадать с текстом в редакторе.
    for (let blank = 0; blank < consumed; blank += 1) lines.push("");
    events.push({ rule: { key: "", source: parsed.source, kind: parsed.kind, seconds: parsed.seconds, threshold: parsed.threshold }, body });
  }

  return { lines, assignments, order, events };
}

/**
 * Разбор и разворачивание скриптов пресета.
 *
 * Возвращает готовые тексты для движка, список импульсов и снимков, которые
 * редактор обязан прикладывать к значениям входов каждый кадр.
 */
export function compileScripts(preset: RigPreset): CompiledScripts {
  const problems: string[] = [];
  const objects = new Map(preset.objects.map((object) => [object.id, object]));
  const moduleNames = new Set(preset.modules.map((module) => module.name));
  const states = new Map<string, StateRef>();
  const events: EventRule[] = [];
  // Нумерация с единицы: `event.e1`, `event.e2` читаются как «событие 1».
  let impulseIndex = 1;

  const globalKey = (name: string) => `state.g_${name}`;
  // Ключ остаётся двухуровневым (`state.o_mouth_x`): движок ищет входы только
  // по имени вида `модуль.вход`, а голое имя считает переменной.
  const paramKey = (objectId: string, param: string) =>
    `state.o_${objectId.replace(/[^A-Za-z0-9_]/g, "_")}_${param}`;

  const stateValue = (ref: StateRef): string => ref.key;

  /** Ссылки на саму переменную заменяются снимком прошлого кадра. */
  const ownReference = (expression: string, name: string, key: string): string =>
    expression.replace(new RegExp(`(?<![\\w.])${name}(?![\\w])`, "g"), key);

  /**
   * Приведение выражений к тому, что понимает ядро: `!a` пишется как `not a`
   * (лексер ядра знает `not`, а одиночный `!` — только как часть `!=`).
   */
  const normalizeOperators = (expression: string): string => expression.replace(/!(?!=)/g, "not ");

  /** `объект.параметр` и `объект.parent.параметр` → `state.o_…_…`. */
  const lowerExpression = (expression: string): string => {
    return normalizeOperators(expression).replace(
      /\b([a-z_][a-z0-9_]*)\.(?:(parent)\.)?([a-z_][a-z0-9_]*)\b/gi,
      (whole, base: string, parent: string | undefined, member: string) => {
        const name = base.toLowerCase();
        if (RESERVED.has(name) || moduleNames.has(name)) return whole;
        const object = objects.get(base) ?? objects.get(name);
        if (!object) return whole;
        const param = member.toLowerCase();
        if (!PARAMS.has(param)) return whole;
        const targetId = parent ? object.parentId : object.id;
        if (!targetId || !objects.has(targetId)) return whole;
        const key = paramKey(targetId, param);
        if (!states.has(key)) states.set(key, { key, objectId: targetId, param });
        return key;
      },
    );
  };

  const buildOwner = (script: string, ownerId: string | null): string => {
    const label = ownerId ? `объект ${ownerId}` : "глобальные";
    const owner = readOwner(script, problems, label);
    const lines = owner.lines.map((line) => lowerExpression(line));

    // Цели блоков: свои параметры объекта или глобальные переменные.
    const targets = new Map<string, Array<{ impulse: string; expression: string }>>();
    for (const event of owner.events) {
      const rule: EventRule = { ...event.rule, key: `event.e${impulseIndex}` };
      impulseIndex += 1;
      events.push(rule);
      for (const assignment of event.body) {
        // Своя переменная внутри блока читается как прошлый кадр: `a = !a`
        // превращается в `not state.g_a`, иначе ядро видит цикл зависимости.
        const key = ownerId !== null && PARAMS.has(assignment.name)
          ? paramKey(ownerId, assignment.name)
          : globalKey(assignment.name);
        const expression = ownReference(lowerExpression(assignment.expression), assignment.name, key);
        const list = targets.get(assignment.name) ?? [];
        list.push({ impulse: rule.key, expression });
        targets.set(assignment.name, list);
      }
    }

    for (const [name, guards] of targets) {
      const isParam = ownerId !== null && PARAMS.has(name);
      const key = isParam ? paramKey(ownerId as string, name) : globalKey(name);
      if (!states.has(key)) {
        states.set(key, isParam
          ? { key, objectId: ownerId as string, param: name }
          : { key, name });
      }
      // Было ли у переменной обычное присваивание? Тогда событие его заменяет
      // только на своём кадре, иначе берётся прошлое значение.
      const existing = owner.assignments.get(name);
      let expression = existing ? lowerExpression(existing.expression) : stateValue(states.get(key)!);
      for (let index = guards.length - 1; index >= 0; index -= 1) {
        const guard = guards[index];
        expression = `${guard.impulse} ? (${guard.expression}) : (${expression})`;
      }
      const next = `${name} = ${expression}`;
      const lineIndex = owner.lines.findIndex((line) => splitAssignment(line)?.name === name);
      if (lineIndex >= 0) lines[lineIndex] = next;
      else lines.push(next);
    }

    return lines.join("\n");
  };

  const globals = buildOwner(preset.globals, null);
  const compiledObjects = new Map<string, string>();
  for (const object of preset.objects) {
    compiledObjects.set(object.id, buildOwner(object.script, object.id));
  }

  return { globals, objects: compiledObjects, events, states: [...states.values()], problems };
}

export interface EventRuntimeState {
  /** Значение входа на прошлом кадре и таймер удержания. */
  rules: Map<string, { value: number; since: number | null; fired: boolean }>;
}

export function createEventState(): EventRuntimeState {
  return { rules: new Map() };
}

/**
 * Значения, которые редактор добавляет к входам каждый кадр: импульсы событий
 * и снимки прошлого кадра (`state.*`).
 */
export function runtimeValues(
  compiled: CompiledScripts,
  frame: RigFrame | null,
  values: Record<string, number>,
  now: number,
  state: EventRuntimeState,
): Record<string, number> {
  const result: Record<string, number> = {};

  // Снимки прошлого кадра. Кадр приходит в редактор уже после тика, поэтому
  // здесь лежит именно то, что движок посчитал в прошлый раз.
  for (const ref of compiled.states) {
    if (ref.name) {
      result[ref.key] = frame?.globals?.[ref.name] ?? 0;
    } else if (ref.objectId && ref.param) {
      const object = frame?.objects?.[ref.objectId] as Record<string, number> | undefined;
      result[ref.key] = object?.[ref.param] ?? PARAM_DEFAULTS[ref.param] ?? 0;
    }
  }

  for (const rule of compiled.events) {
    const current = values[rule.source] ?? 0;
    const previous = state.rules.get(rule.key) ?? { value: current, since: null, fired: false };
    const high = current > rule.threshold;
    let fired = false;
    let since = previous.since;
    let latch = previous.fired;

    if (rule.kind === "down") fired = previous.value <= rule.threshold && high;
    else if (rule.kind === "up") fired = previous.value > rule.threshold && !high;
    else if (rule.kind === "change") fired = Math.abs(current - previous.value) > 1e-6;
    else if (rule.kind === "hold" || rule.kind === "relax") {
      const active = rule.kind === "hold" ? high : !high;
      if (!active) {
        since = null;
        latch = false;
      } else {
        if (since === null) since = now;
        if (!latch && now - since >= rule.seconds * 1000) {
          fired = true;
          latch = true;
        }
      }
    }

    state.rules.set(rule.key, { value: current, since, fired: latch });
    result[rule.key] = fired ? 1 : 0;
  }

  return result;
}
