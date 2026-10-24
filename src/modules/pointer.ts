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

export interface MouseSample {
  /** Позиция курсора по сцене: 0…1. */
  x: number;
  y: number;
  /** Смещение за кадр: −1…1. */
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
}

export const EMPTY_POINTER: PointerFrame = {
  keys: {},
  mouse: { x: 0.5, y: 0.5, dx: 0, dy: 0, left: 0, right: 0, wheel: 0, buttons: {} },
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
  private position = { x: 0.5, y: 0.5 };
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

  move(x: number, y: number): void {
    this.pending.dx += x - this.position.x;
    this.pending.dy += y - this.position.y;
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
      x: clamp01(this.position.x),
      y: clamp01(this.position.y),
      dx: clamp(this.pending.dx, -1, 1),
      dy: clamp(this.pending.dy, -1, 1),
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

/** Число мыши по имени входа: обычные поля мыши плюс дополнительные кнопки. */
export function mouseValue(mouse: MouseSample | undefined, name: string): number {
  if (!mouse) return 0;
  if (name === "x") return mouse.x;
  if (name === "y") return mouse.y;
  if (name === "dx") return mouse.dx;
  if (name === "dy") return mouse.dy;
  if (name === "left") return mouse.left;
  if (name === "right") return mouse.right;
  if (name === "wheel") return mouse.wheel;
  return mouse.buttons[name] ?? 0;
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
