import type { RigPreset } from "../types";

/**
 * История изменений пресета вместе с выделением.
 *
 * Хранит снимки целиком (пресет неизменяемый, поэтому снимок — это просто
 * ссылка). Одинаковые быстрые правки одного поля склеиваются по ключу
 * `coalesce`, чтобы набор имени не создавал шаг на каждую букву.
 */
export interface HistorySnapshot {
  preset: RigPreset;
  selection: string[];
}

interface Step {
  snapshot: HistorySnapshot;
  label: string;
  key?: string;
  at: number;
}

export class History {
  private past: Step[] = [];
  private future: Step[] = [];

  constructor(private readonly limit = 100, private readonly coalesceMs = 700) {}

  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }
  get undoLabel(): string | null { return this.past.at(-1)?.label ?? null; }
  get redoLabel(): string | null { return this.future.at(-1)?.label ?? null; }
  get depth(): number { return this.past.length; }

  /** Запоминает состояние **до** изменения. Повторный вызов с тем же ключом склеивается. */
  record(snapshot: HistorySnapshot, label: string, key?: string, now = Date.now()): void {
    this.future = [];
    const last = this.past.at(-1);
    if (key && last && last.key === key && now - last.at < this.coalesceMs) {
      last.at = now;
      return;
    }
    this.past.push({ snapshot, label, key, at: now });
    if (this.past.length > this.limit) this.past.shift();
  }

  undo(current: HistorySnapshot, now = Date.now()): HistorySnapshot | null {
    const step = this.past.pop();
    if (!step) return null;
    this.future.push({ snapshot: current, label: step.label, at: now });
    return step.snapshot;
  }

  redo(current: HistorySnapshot, now = Date.now()): HistorySnapshot | null {
    const step = this.future.pop();
    if (!step) return null;
    this.past.push({ snapshot: current, label: step.label, at: now });
    return step.snapshot;
  }

  clear(): void {
    this.past = [];
    this.future = [];
  }
}
