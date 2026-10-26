import type { ModuleInstance, MouseButton } from "../types";

/**
 * Состояние клавиатуры и мыши, из которого собираются входы модулей.
 *
 * Класс ничего не знает про DOM и Tauri: события приходят снаружи (window в
 * браузере или глобальный хук в нативном окне), поэтому логику можно проверить
 * тестами в Node.
 */
export interface KeySample {
  /** 1, пока клавиша нажата. */
  down: number;
  /** Сколько секунд держится: сбрасывается в 0 при отпускании. */
  hold: number;
  /** Сколько раз нажали с момента запуска. */
  hits: number;
}

/**
 * Прямоугольник экрана.
 *
 * Единицы — пиксели одного пространства: в нативном окне это физические пиксели
 * монитора (их отдаёт системный хук), в браузере — CSS-пиксели. `scale` —
 * масштаб монитора, чтобы показать пользователю привычные логические пиксели
 * (1920×1080 при масштабе 125 % — это 2400 физических).
 */
export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

/** Монитор в том же пространстве, что и окно: по нему модуль читает курсор. */
export interface ScreenMonitor extends ScreenRect {
  index: number;
  name: string;
  primary: boolean;
}

/** Геометрия экрана на момент кадра: окно, мониторы и видимая сцена. */
export interface ScreenSpace {
  window: ScreenRect;
  monitors: ScreenMonitor[];
  scene: ScreenRect | null;
}

/** Область, относительно которой модуль мыши читает курсор. */
export type MouseSpace = "window" | "monitor" | "scene";

export interface MouseSample {
  /**
   * Курсор в пикселях экрана: от левого-верхнего угла монитора.
   *
   * Модуль сам решает, от чего считать: от окна, от выбранного монитора или от
   * сцены (`mouseArea`). Здесь всегда одно и то же — абсолютное место на экране.
   */
  screenX: number;
  screenY: number;
  /** Смещение за кадр в пикселях экрана. */
  dx: number;
  dy: number;
  left: number;
  right: number;
  /** Вращение колеса за кадр: −1…1 (один щелчок ≈ 1). */
  wheel: number;
  /** Дополнительные кнопки (`back`, `forward`, `button7`): 0/1. */
  buttons: Record<string, number>;
}

export interface PointerFrame {
  keys: Record<string, KeySample>;
  mouse: MouseSample;
  /** Окно, мониторы и сцена: без них модуль не знает, от чего считать пиксели. */
  screen?: ScreenSpace;
}

export const EMPTY_POINTER: PointerFrame = {
  keys: {},
  mouse: { screenX: 0, screenY: 0, dx: 0, dy: 0, left: 0, right: 0, wheel: 0, buttons: {} },
};

interface KeyState {
  down: boolean;
  /** Момент нажатия: от него считается `hold`. */
  since: number;
  hits: number;
}

/** Сколько «весит» один щелчок колеса: у DOM ~100, у глобального хука 120. */
const WHEEL_STEP = 100;

export class PointerState {
  private keys = new Map<string, KeyState>();
  private position = { x: 0, y: 0 };
  /**
   * Было ли уже движение. Первый замер только запоминает место: иначе первый
   * кадр получал бы смещение от нуля координат, то есть рывок на весь экран.
   */
  private primed = false;
  private pending = { dx: 0, dy: 0, wheel: 0 };
  /** Состояние кнопок по имени: `left`, `right`, `middle`, `back`, `forward`… */
  private buttons = new Map<string, boolean>();

  key(code: string, down: boolean, now = performance.now()): void {
    const current = this.keys.get(code) ?? { down: false, since: now, hits: 0 };
    if (down) {
      // Автоповтор клавиши не должен накручивать `hits` и сбрасывать `hold`.
      if (current.down) return;
      current.down = true;
      current.since = now;
      current.hits += 1;
    } else {
      if (!current.down) return;
      current.down = false;
    }
    this.keys.set(code, current);
  }

  /** Курсор пришёл в пикселях экрана: смещение считается в тех же пикселях. */
  move(x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (this.primed) {
      this.pending.dx += x - this.position.x;
      this.pending.dy += y - this.position.y;
    }
    this.primed = true;
    this.position = { x, y };
  }

  button(name: string, down: boolean): void {
    if (!name) return;
    this.buttons.set(name, down);
  }

  wheel(delta: number): void {
    if (Number.isFinite(delta)) this.pending.wheel += delta;
  }

  /** Стоп анимации: счётчики нажатий начинаются заново. */
  resetHits(): void {
    for (const [code, state] of this.keys) {
      if (state.hits !== 0) this.keys.set(code, { ...state, hits: 0 });
    }
  }

  /** Отпускает всё: потеря фокуса окна не должна оставлять клавишу зажатой. */
  releaseAll(): void {
    for (const [code, state] of this.keys) {
      if (state.down) this.keys.set(code, { ...state, down: false });
    }
    for (const [name, down] of this.buttons) if (down) this.buttons.set(name, false);
  }

  /** Снимок на кадр: `dx/dy/wheel` копятся между кадрами и обнуляются здесь. */
  snapshot(now = performance.now()): PointerFrame {
    const keys: Record<string, KeySample> = {};
    for (const [code, state] of this.keys) {
      keys[code] = {
        down: state.down ? 1 : 0,
        hold: state.down ? Math.max(0, (now - state.since) / 1000) : 0,
        hits: state.hits,
      };
    }
    const extras: Record<string, number> = {};
    for (const [name, down] of this.buttons) {
      if (name === "left" || name === "right") continue;
      extras[name] = down ? 1 : 0;
    }
    const mouse: MouseSample = {
      screenX: this.position.x,
      screenY: this.position.y,
      // Смещение — пиксели за кадр. Предел нужен только от мусора в событиях:
      // за один кадр курсор не проходит больше пары экранов.
      dx: clamp(this.pending.dx, -10000, 10000),
      dy: clamp(this.pending.dy, -10000, 10000),
      left: this.buttons.get("left") ? 1 : 0,
      right: this.buttons.get("right") ? 1 : 0,
      wheel: clamp(this.pending.wheel / WHEEL_STEP, -1, 1),
      buttons: extras,
    };
    this.pending = { dx: 0, dy: 0, wheel: 0 };
    return { keys, mouse };
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/** Человеческая подпись клавиши по `event.code`: в скрипте остаётся код. */
export function keyLabel(code: string): string {
  if (!code) return "—";
  if (code === "Space") return "Пробел";
  if (code === "Enter") return "Enter";
  if (code === "Escape") return "Esc";
  if (code === "Tab") return "Tab";
  if (code === "Backspace") return "Backspace";
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return `Num ${code.slice(6)}`;
  if (code.startsWith("Arrow")) return { Up: "↑", Down: "↓", Left: "←", Right: "→" }[code.slice(5)] ?? code;
  if (code === "ShiftLeft") return "Shift лев.";
  if (code === "ShiftRight") return "Shift прав.";
  if (code === "ControlLeft") return "Ctrl лев.";
  if (code === "ControlRight") return "Ctrl прав.";
  if (code === "AltLeft") return "Alt лев.";
  if (code === "AltRight") return "Alt прав.";
  if (code === "MetaLeft" || code === "MetaRight") return "Win";
  if (code === "CapsLock") return "Caps Lock";
  return code;
}

/** Имя входа из кода клавиши: `Space` → `space`, `KeyA` → `a`, `Digit1` → `1`. */
export function keyInputName(code: string): string {
  if (code.startsWith("Key")) return code.slice(3).toLowerCase();
  if (code.startsWith("Digit")) return code.slice(5);
  if (code === "Space") return "space";
  const cleaned = code
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "key";
}

/**
 * Список клавиш клавиатурного модуля: имена латиницей и без повторов —
 * они становятся именами входов (`keyboard.space`).
 */
export function keyboardKeys(module: ModuleInstance): Array<{ code: string; name: string }> {
  const raw = module.config.keys;
  if (!Array.isArray(raw)) return [];
  const seenNames = new Set<string>();
  const seenCodes = new Set<string>();
  const keys: Array<{ code: string; name: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const code = typeof item.code === "string" ? item.code.trim() : "";
    const name = typeof item.name === "string" ? item.name.trim() : "";
    // Одна клавиша — одна строка: дубли по коду и по имени отбрасываем.
    if (!code || !name || seenNames.has(name) || seenCodes.has(code)) continue;
    seenNames.add(name);
    seenCodes.add(code);
    keys.push({ code, name });
  }
  return keys;
}

/** Уникальное имя входа клавиши. */
export function uniqueKeyName(keys: Array<{ name: string }>, base: string): string {
  const clean = base.replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "key";
  if (!keys.some((key) => key.name === clean)) return clean;
  let index = 2;
  while (keys.some((key) => key.name === `${clean}_${index}`)) index += 1;
  return `${clean}_${index}`;
}

/** Область, относительно которой модуль читает курсор. */
export function mouseSpaceOf(config: Record<string, unknown> | undefined): MouseSpace {
  const space = config?.space;
  if (space === "window" || space === "scene") return space;
  // По умолчанию — монитор: весь экран, а не только окно приложения.
  return "monitor";
}

/**
 * Прямоугольник, от которого считается позиция.
 *
 * Монитор выбирается по номеру из настроек модуля; если такого нет — берётся
 * основной, иначе первый. Без геометрии экрана считать не от чего: `null`.
 */
export function mouseArea(
  space: MouseSpace,
  monitorIndex: number,
  screen: ScreenSpace | undefined,
): ScreenRect | null {
  if (!screen) return null;
  if (space === "window") return screen.window;
  if (space === "scene") return screen.scene ?? screen.window;
  const monitors = screen.monitors;
  if (!monitors.length) return screen.window;
  const wanted = monitors.find((monitor) => monitor.index === monitorIndex);
  const primary = monitors.find((monitor) => monitor.primary);
  return wanted ?? primary ?? monitors[0];
}

/** Доли 0…1 внутри области: край области — 0 или 1. */
function fraction(value: number, start: number, size: number): number {
  if (!Number.isFinite(size) || size <= 0) return 0;
  return clamp01((value - start) / size);
}

/** Пиксели внутри области — в логических пикселях монитора (как в настройках Windows). */
function offset(value: number, start: number, scale: number): number {
  const clean = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return (value - start) / clean;
}

/**
 * Число мыши по имени входа.
 *
 * `x`/`y` — доли 0…1 внутри области, `px`/`py` — пиксели внутри неё,
 * `dx`/`dy` — смещение за кадр в пикселях. Без области остаются только
 * кнопки: координаты не к чему привязать.
 */
export function mouseValue(
  mouse: MouseSample | undefined,
  name: string,
  area: ScreenRect | null = null,
): number {
  if (!mouse) return 0;
  if (name === "x" && area) return fraction(mouse.screenX, area.x, area.width);
  if (name === "y" && area) return fraction(mouse.screenY, area.y, area.height);
  if (name === "px" && area) return offset(mouse.screenX, area.x, area.scale);
  if (name === "py" && area) return offset(mouse.screenY, area.y, area.scale);
  if (name === "dx") return mouse.dx;
  if (name === "dy") return mouse.dy;
  if (name === "left") return mouse.left;
  if (name === "right") return mouse.right;
  if (name === "wheel") return mouse.wheel;
  // Дополнительные кнопки живут в карте: СКМ тоже приходит туда.
  return mouse.buttons?.[name] ?? 0;
}

/** Вариант выбора монитора в настройках модуля. */
export interface MonitorOption {
  /** Номер монитора строкой: он и лежит в настройках. */
  id: string;
  label: string;
}

/** Подпись монитора для настроек модуля: номер, размер и «основной». */
export function monitorLabel(monitor: ScreenMonitor): string {
  const width = Math.round(monitor.width / (monitor.scale || 1));
  const height = Math.round(monitor.height / (monitor.scale || 1));
  return `Монитор ${monitor.index + 1} · ${width}×${height}${monitor.primary ? " · основной" : ""}`;
}

/** Имя кнопки мыши из `MouseEvent.button`: 3 и 4 — боковые кнопки. */
export function mouseButtonFromIndex(index: number): string {
  if (index === 0) return "left";
  if (index === 1) return "middle";
  if (index === 2) return "right";
  if (index === 3) return "back";
  if (index === 4) return "forward";
  return `button${index + 1}`;
}

/** Человеческая подпись кнопки: в скрипте остаётся имя. */
export function mouseButtonLabel(button: string): string {
  if (button === "left") return "ЛКМ";
  if (button === "right") return "ПКМ";
  if (button === "middle") return "СКМ";
  if (button === "back") return "Назад (4)";
  if (button === "forward") return "Вперёд (5)";
  return button;
}

/**
 * Дополнительные кнопки мыши из настроек экземпляра: имена латиницей и без
 * повторов — они становятся именами входов (`cursor.back`).
 */
export function mouseButtons(module: ModuleInstance): MouseButton[] {
  const raw = module.config.buttons;
  if (!Array.isArray(raw)) return [];
  const seenNames = new Set<string>();
  const seenButtons = new Set<string>();
  const list: MouseButton[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const button = typeof item.button === "string" ? item.button.trim() : "";
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!button || !name || seenButtons.has(button) || seenNames.has(name)) continue;
    seenButtons.add(button);
    seenNames.add(name);
    list.push({ button, name });
  }
  return list;
}

/** Уникальное имя входа кнопки мыши. */
export function uniqueButtonName(buttons: Array<{ name: string }>, base: string): string {
  const clean = base.replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "button";
  if (!buttons.some((item) => item.name === clean)) return clean;
  let index = 2;
  while (buttons.some((item) => item.name === `${clean}_${index}`)) index += 1;
  return `${clean}_${index}`;
}
