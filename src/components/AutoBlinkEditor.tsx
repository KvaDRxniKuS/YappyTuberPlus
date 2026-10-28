import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { ModuleInstance } from "../types";
import {
  BLINK_OUTPUT_BASE, BLINK_RANGES, autoBlinkOutputs, sanitizeBlinkName, uniqueBlinkName,
  type BlinkOutput,
} from "../modules/autoblink";

/**
 * Выводы модуля «Моргание».
 *
 * Вывод — это свой таймер: интервал, длительность, разброс, минимум и максимум
 * плюс семечко. Имя вывода уходит в скрипт (`auto.blink`, `auto.blink_2`),
 * подпись — только для панели и списков.
 *
 * Зачем несколько выводов: «глаза», «брови» и «редкое моргание» — это три разных
 * рисунка, и держать три почти одинаковых модуля было нечем оправдать. Зачем
 * семечко: два вывода с одинаковыми числами иначе моргали бы в такт — семечко
 * задаёт каждому свой поток случайных чисел.
 */
export function AutoBlinkEditor(props: {
  module: ModuleInstance;
  onOutputs: (outputs: BlinkOutput[], label?: string) => void;
}) {
  const outputs = autoBlinkOutputs(props.module);
  const [open, setOpen] = useState<string | null>(outputs[0]?.name ?? null);

  const patch = (output: BlinkOutput, changes: Partial<BlinkOutput>, label: string) => {
    props.onOutputs(outputs.map((item) => (item.name === output.name ? { ...item, ...changes } : item)), label);
  };

  /** Число из поля: пустое и битое не превращается в ноль молча. */
  const number = (raw: string, current: number, min: number, max: number, step: number) => {
    const parsed = Number(raw.replace(",", "."));
    if (!Number.isFinite(parsed)) return current;
    const clamped = Math.min(max, Math.max(min, parsed));
    return step >= 1 ? Math.round(clamped) : Math.round(clamped * 100) / 100;
  };

  const add = () => {
    const name = uniqueBlinkName(outputs, "blink");
    const next: BlinkOutput = {
      ...BLINK_OUTPUT_BASE,
      name,
      label: `Моргание ${outputs.length + 1}`,
      // Новый вывод сразу не в такт первому: семечко по умолчанию своё.
      seed: (outputs.length * 137) % BLINK_RANGES.seed.max,
    };
    props.onOutputs([...outputs, next], "Добавление вывода моргания");
    setOpen(name);
  };

  const remove = (output: BlinkOutput) => {
    // Последний вывод не удаляем: модуль без выводов ничего не отдаёт, и
    // формулы `auto.blink` в скриптах сломались бы молча.
    if (outputs.length <= 1) return;
    props.onOutputs(outputs.filter((item) => item.name !== output.name), "Удаление вывода моргания");
  };

  const field = (
    output: BlinkOutput,
    key: keyof typeof BLINK_RANGES,
    title: string,
    label: string,
    hint: string,
  ) => {
    const range = BLINK_RANGES[key];
    return (
      <label className="module-field" title={hint}>
        <span className="module-field-label">{label}</span>
        <input
          className="text-input"
          type="number"
          min={range.min}
          max={range.max}
          step={range.step}
          value={output[key as keyof BlinkOutput] as number}
          onChange={(event) => {
            const value = number(event.target.value, output[key as keyof BlinkOutput] as number, range.min, range.max, range.step);
            patch(output, { [key]: value } as Partial<BlinkOutput>, title);
          }}
        />
      </label>
    );
  };

  return (
    <div className="blink-editor">
      {outputs.map((output) => {
        const expanded = open === output.name;
        return (
          <div className="blink-output" key={output.name}>
            <div className="blink-output-head">
              <button
                className="blink-output-toggle"
                title="Открыть настройки вывода"
                onClick={() => setOpen(expanded ? null : output.name)}
              >
                <span>{output.label}</span>
                <small>{output.name}</small>
                <small className="blink-output-timing">
                  {Math.round(output.period / 100) / 10} с · {output.hold} мс
                </small>
              </button>
              <button
                className="button secondary"
                title={outputs.length > 1 ? "Удалить вывод" : "Последний вывод удалить нельзя"}
                disabled={outputs.length <= 1}
                onClick={() => remove(output)}
              >
                <Trash2 size={13} />
              </button>
            </div>

            {expanded && (
              <div className="blink-output-body">
                <label className="module-field">
                  <span className="module-field-label">Подпись</span>
                  <input
                    className="text-input"
                    value={output.label}
                    onChange={(event) => patch(output, { label: event.target.value.slice(0, 32) }, "Подпись вывода")}
                  />
                </label>
                <label className="module-field">
                  <span className="module-field-label" title="В скрипте: <модуль>.<имя>, например auto.blink_2">Имя в скрипте</span>
                  <input
                    className="text-input"
                    value={output.name}
                    onChange={(event) => {
                      const clean = event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 24);
                      if (!clean) return;
                      const name = uniqueBlinkName(outputs.filter((item) => item.name !== output.name), sanitizeBlinkName(clean));
                      patch(output, { name }, "Имя вывода моргания");
                      setOpen(name);
                    }}
                  />
                </label>

                {field(output, "period", "Интервал моргания", "Интервал", "Среднее время между морганиями, мс")}
                {field(output, "hold", "Длительность закрытия", "Длительность", "Сколько вход держится в максимуме, мс")}
                {field(output, "jitter", "Разброс интервала", "Разброс", "Случайное отклонение интервала, %: 0 — метроном")}
                {field(output, "min", "Значение открытых глаз", "Минимум", "Значение входа, когда глаза открыты")}
                {field(output, "max", "Значение закрытых глаз", "Максимум", "Значение входа, когда глаза закрыты")}
                {field(output, "seed", "Семечко", "Семечко", "Число задаёт рисунок моргания. 0 — случайное при каждом запуске")}

                <p className="module-hint">
                  Два вывода с одинаковыми числами всё равно моргают по-разному: семечко
                  смешивается с именем вывода. Одинаковый рисунок нужен редко — тогда
                  поставьте выводы в один, а не подбирайте числа.
                </p>
              </div>
            )}
          </div>
        );
      })}

      <button className="button secondary blink-add" onClick={add} title="Ещё один вывод со своими настройками">
        <Plus size={13} /> Добавить вывод
      </button>
    </div>
  );
}
