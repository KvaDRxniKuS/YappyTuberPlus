import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { ModuleInstance } from "../types";
import {
  BLINK_OUTPUT_BASE, BLINK_SEED_MAX, autoBlinkOutputs, normalizeBlinkNumber, sanitizeBlinkName, uniqueBlinkName,
  type BlinkNumberField, type BlinkOutput,
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
  // Черновики не меняют ключ карточки на каждый символ: имя сохраняется только
  // при уходе из поля, иначе React размонтирует input и теряет выделение.
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const draftKey = (name: string, field: string) => `${name}\u0000${field}`;
  const setDraft = (key: string, value: string) => setDrafts((current) => ({ ...current, [key]: value }));
  const clearDraft = (key: string) => setDrafts((current) => {
    if (!(key in current)) return current;
    const next = { ...current };
    delete next[key];
    return next;
  });

  const patch = (output: BlinkOutput, changes: Partial<BlinkOutput>, label: string) => {
    props.onOutputs(outputs.map((item) => (item.name === output.name ? { ...item, ...changes } : item)), label);
  };

  const add = () => {
    const name = uniqueBlinkName(outputs, "blink");
    const next: BlinkOutput = {
      ...BLINK_OUTPUT_BASE,
      name,
      label: `Моргание ${outputs.length + 1}`,
      // Новый вывод сразу не в такт первому: семечко по умолчанию своё.
      seed: (outputs.length * 137) % (BLINK_SEED_MAX + 1),
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
    key: BlinkNumberField,
    title: string,
    label: string,
    hint: string,
  ) => {
    const editKey = draftKey(output.name, key);
    const current = output[key];
    return (
      <label className="module-field" title={hint}>
        <span className="module-field-label">{label}</span>
        <input
          className="text-input"
          type="text"
          inputMode="decimal"
          spellCheck={false}
          value={drafts[editKey] ?? String(current)}
          onFocus={(event) => setDraft(editKey, event.currentTarget.value)}
          onChange={(event) => setDraft(editKey, event.target.value)}
          onBlur={(event) => {
            const raw = event.currentTarget.value.trim();
            if (raw) {
              const parsed = Number(raw.replace(",", "."));
              if (Number.isFinite(parsed)) {
                const value = normalizeBlinkNumber(key, parsed);
                if (value !== current) patch(output, { [key]: value }, title);
              }
            }
            clearDraft(editKey);
          }}
          onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
        />
      </label>
    );
  };

  return (
    <div className="blink-editor">
      {outputs.map((output) => {
        const expanded = open === output.name;
        const labelKey = draftKey(output.name, "label");
        const nameKey = draftKey(output.name, "name");
        return (
          <div className="blink-output" key={output.name}>
            <div className="blink-output-head">
              <button
                type="button"
                className="blink-output-toggle"
                title={expanded ? "Свернуть настройки вывода" : "Открыть настройки вывода"}
                onClick={() => setOpen(expanded ? null : output.name)}
              >
                <span>{output.label}</span>
                <small>{output.name}</small>
                <small className="blink-output-timing">
                  {Math.round(output.period / 100) / 10} с · {output.hold} мс
                </small>
              </button>
              <button
                type="button"
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
                <label className="module-field" title="Подпись для панели: пробелы разрешены">
                  <span className="module-field-label">Подпись</span>
                  <input
                    className="text-input"
                    value={drafts[labelKey] ?? output.label}
                    onFocus={(event) => setDraft(labelKey, event.currentTarget.value)}
                    onChange={(event) => setDraft(labelKey, event.target.value.slice(0, 32))}
                    onBlur={(event) => {
                      const label = event.currentTarget.value.slice(0, 32);
                      if (label !== output.label) patch(output, { label }, "Подпись вывода");
                      clearDraft(labelKey);
                    }}
                    onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
                  />
                </label>
                <label className="module-field">
                  <span className="module-field-label" title="В скрипте: <модуль>.<имя>, например auto.blink_2">Имя в скрипте</span>
                  <input
                    className="text-input"
                    spellCheck={false}
                    value={drafts[nameKey] ?? output.name}
                    onFocus={(event) => setDraft(nameKey, event.currentTarget.value)}
                    onChange={(event) => setDraft(nameKey, event.target.value)}
                    onBlur={(event) => {
                      const name = uniqueBlinkName(
                        outputs.filter((item) => item.name !== output.name),
                        sanitizeBlinkName(event.currentTarget.value),
                      );
                      clearDraft(nameKey);
                      if (name !== output.name) patch(output, { name }, "Имя вывода моргания");
                      setOpen(name);
                    }}
                    onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
                  />
                </label>

                {field(output, "period", "Интервал моргания", "Интервал", "Среднее время между морганиями, мс; верхнего ограничения нет, 0 допустимо")}
                {field(output, "hold", "Длительность закрытия", "Длительность", "Сколько вход держится в максимуме, мс; верхнего ограничения нет")}
                {field(output, "jitter", "Разброс интервала", "Разброс", "Случайное отклонение интервала, %; значение может быть больше 100")}
                {field(output, "min", "Значение открытых глаз", "Минимум", "Значение входа, когда глаза открыты; не ограничено диапазоном 0…1")}
                {field(output, "max", "Значение закрытых глаз", "Максимум", "Значение входа, когда глаза закрыты; не ограничено диапазоном 0…1")}
                {field(output, "seed", "Семечко", "Семечко", `0 — случайный рисунок; иначе целое число до ${BLINK_SEED_MAX}`)}

                <p className="module-hint">
                  Интервал, длительность и разброс не имеют произвольного верхнего предела;
                  между началами морганий остаётся пауза не короче длительности + 40 мс.
                  Минимум и максимум можно задать вне 0…1. Семечко смешивается с именем
                  вывода, поэтому два одинаковых набора чисел всё равно моргают по-разному.
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
