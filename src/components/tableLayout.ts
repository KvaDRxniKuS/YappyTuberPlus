/**
 * Раскладка таблицы настроек модуля.
 *
 * Таблица — grid из ролей (`input`, `path`, `label`, …). Минимальную ширину
 * колонки задаёт разработчик модуля в шаблоне:
 *
 * ```json
 * "editor": { "minWidth": 470, "columns": { "input": 84, "path": 170 } }
 * ```
 *
 * Роль, которой в шаблоне нет, берёт ширину по умолчанию. Колонка с `grow`
 * тянется, если места больше, но не уже своего минимума: при сужении панели
 * таблица перестаёт влезать и прокручивается **внутри блока**, а не уводит
 * поля за край окна.
 */

export interface TableColumn {
  /** Роль колонки: по ней шаблон модуля задаёт ширину. */
  key: string;
  /** Минимальная ширина по умолчанию, px. */
  width: number;
  /** Доля свободного места: без неё колонка фиксированная. */
  grow?: number;
}

/** Значение `grid-template-columns` для таблицы с учётом шаблона модуля. */
export function tableTemplate(columns: TableColumn[], custom: Record<string, number> = {}): string {
  return columns
    .map((column) => {
      const width = Math.max(24, Math.round(custom[column.key] ?? column.width));
      return column.grow ? `minmax(${width}px, ${column.grow}fr)` : `${width}px`;
    })
    .join(" ");
}

/** Насколько широкой таблица должна быть как минимум: прокрутка начинается здесь. */
export function tableMinWidth(
  columns: TableColumn[],
  custom: Record<string, number> = {},
  gap = 4,
  minimum?: number,
): number {
  const sum = columns.reduce(
    (total, column) => total + Math.max(24, Math.round(custom[column.key] ?? column.width)) + gap,
    0,
  );
  return Math.max(minimum ?? 0, sum);
}
