import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { ModuleConfig, ModuleInstance } from "../types";
import {
  AMBIENT_POINT_BASE, AMBIENT_RATE_MAX, AMBIENT_RATE_MIN, ambientConnection, ambientPoints,
  ambientRate, sanitizePointName, uniquePointName, type AmbientPoint, type AmbientSourceKind,
} from "../modules/ambient";
import type { ObsStatus } from "../modules/obs";

/**
 * Точки модуля «Свет из экрана».
 *
 * Точка — это «где смотреть» и «как усреднять»: центр и сторона квадрата в долях
 * кадра, сила размытия в пикселях, инерция. Источник — своя сцена (бесплатно и
 * везде) или элемент сцены OBS (единственный способ увидеть чужое окно).
 *
 * Имя точки уходит в скрипт (`<имя>_r`, `<имя>_g`…), подпись — в панель и в
 * списки привязки цвета в «Поведении». Точек можно добавить сколько угодно.
 */
export function AmbientEditor(props: {
  module: ModuleInstance;
  onConfig: (config: ModuleConfig, label: string) => void;
  /** Состояние OBS и списки имён: их отдаёт соединение, а не шаблон. */
  obs?: {
    status: ObsStatus;
    scenes: string[];
    items: string[];
    probe: () => void;
  };
}) {
  const points = ambientPoints(props.module);
  const [open, setOpen] = useState<string | null>(points[0]?.name ?? null);

  const patchPoint = (point: AmbientPoint, changes: Partial<AmbientPoint>, label: string) => {
    props.onConfig({
      ...props.module.config,
      points: points.map((item) => (item.name === point.name ? { ...item, ...changes } : item)),
    }, label);
  };

  const add = () => {
    const name = uniquePointName(points, "spot");
    const next: AmbientPoint = {
      ...AMBIENT_POINT_BASE,
      name,
      label: `Точка ${points.length + 1}`,
      source: { ...AMBIENT_POINT_BASE.source },
      area: { ...AMBIENT_POINT_BASE.area },
    };
    props.onConfig({ ...props.module.config, points: [...points, next] }, "Добавление точки");
    setOpen(name);
  };

  const remove = (point: AmbientPoint) => {
    // Последняя точка не удаляется: модуль без точек ничего не отдаёт, и
    // привязка цвета в объекте молча перестала бы работать.
    if (points.length <= 1) return;
    props.onConfig({
      ...props.module.config,
      points: points.filter((item) => item.name !== point.name),
    }, "Удаление точки");
  };

  const connection = ambientConnection(props.module);
  const obs = props.obs;

  return (
    <div className="color-editor ambient-editor">
      <label className="range-property">
        <span>Замеров в секунду <b>{ambientRate(props.module)}</b></span>
        <input
          type="range" min={AMBIENT_RATE_MIN} max={AMBIENT_RATE_MAX} step={1} value={ambientRate(props.module)}
          title="Чаще — цвет точнее, но OBS перерисовывает источник на каждый замер"
          onChange={(event) => props.onConfig({
            ...props.module.config, rate: Number(event.target.value),
          }, "Частота замеров")}
        />
      </label>

      {points.map((point) => {
        const expanded = open === point.name;
        const source: AmbientSourceKind = point.source.kind;
        return (
          <div className="color-channel" key={point.name}>
            <div className="color-channel-head">
              <button
                className="color-channel-toggle"
                title="Открыть настройки точки"
                onClick={() => setOpen(expanded ? null : point.name)}
              >
                <span className="color-swatch ambient-swatch" />
                <span>{point.label}</span>
                <small>{point.name}</small>
              </button>
              <button
                className="button secondary"
                title={points.length > 1 ? "Удалить точку" : "Последнюю точку удалить нельзя"}
                disabled={points.length <= 1}
                onClick={() => remove(point)}
              >
                <Trash2 size={13} />
              </button>
            </div>

            {expanded && (
              <div className="color-channel-body">
                <label className="module-field">
                  <span className="module-field-label">Подпись</span>
                  <input
                    className="text-input"
                    value={point.label}
                    onChange={(event) => patchPoint(point, { label: event.target.value.slice(0, 32) }, "Подпись точки")}
                  />
                </label>
                <label className="module-field">
                  <span
                    className="module-field-label"
                    title="В скрипте: <имя>_r, <имя>_g, <имя>_b, <имя>_a, <имя>_level"
                  >
                    Имя в скрипте
                  </span>
                  <input
                    className="text-input"
                    value={point.name}
                    onChange={(event) => {
                      const clean = sanitizePointName(event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 24));
                      if (!clean) return;
                      const name = uniquePointName(points.filter((item) => item.name !== point.name), clean);
                      patchPoint(point, { name }, "Имя точки");
                      setOpen(name);
                    }}
                  />
                </label>

                <label className="module-field">
                  <span className="module-field-label">Источник</span>
                  <select
                    value={source}
                    title="Своя сцена — из редактора; OBS — из окна, которое OBS и так захватывает"
                    onChange={(event) => patchPoint(point, {
                      source: { ...point.source, kind: event.target.value as AmbientSourceKind },
                    }, "Источник точки")}
                  >
                    <option value="scene">своя сцена</option>
                    <option value="obs">источник OBS</option>
                  </select>
                </label>

                {source === "obs" && (
                  <>
                    <label className="module-field">
                      <span className="module-field-label">Сцена OBS</span>
                      {obs?.scenes.length ? (
                        <select
                          value={point.source.scene}
                          onChange={(event) => patchPoint(point, {
                            source: { ...point.source, scene: event.target.value },
                          }, "Сцена OBS")}
                        >
                          <option value="">программная сцена</option>
                          {obs.scenes.map((name) => (
                            <option key={name} value={name}>{name}</option>
                          ))}
                        </select>
                      ) : (
                        <input
                          className="text-input"
                          value={point.source.scene}
                          placeholder="программная сцена"
                          onChange={(event) => patchPoint(point, {
                            source: { ...point.source, scene: event.target.value },
                          }, "Сцена OBS")}
                        />
                      )}
                    </label>
                    <label className="module-field">
                      <span
                        className="module-field-label"
                        title="Элемент сцены: у него берётся картинка, а с включённым «Следовать» — и положение на сцене"
                      >
                        Источник сцены
                      </span>
                      {obs?.items.length ? (
                        <select
                          value={point.source.item}
                          onChange={(event) => patchPoint(point, {
                            source: { ...point.source, item: event.target.value },
                          }, "Источник OBS")}
                        >
                          <option value="">вся сцена</option>
                          {obs.items.map((name) => (
                            <option key={name} value={name}>{name}</option>
                          ))}
                        </select>
                      ) : (
                        <input
                          className="text-input"
                          value={point.source.item}
                          placeholder="вся сцена"
                          onChange={(event) => patchPoint(point, {
                            source: { ...point.source, item: event.target.value },
                          }, "Источник OBS")}
                        />
                      )}
                    </label>
                    <label
                      className="check-line"
                      title="Точка едет вместе с источником: двинули окно в OBS — свет поехал за ним"
                    >
                      <input
                        type="checkbox"
                        checked={point.follow}
                        onChange={(event) => patchPoint(point, { follow: event.target.checked }, "Следование за источником")}
                      />
                      <span>Следовать за источником</span>
                    </label>
                  </>
                )}

                <label className="range-property">
                  <span>Слева <b>{Math.round(point.area.x * 100)}%</b></span>
                  <input
                    type="range" min={0} max={100} step={1} value={Math.round(point.area.x * 100)}
                    onChange={(event) => patchPoint(point, {
                      area: { ...point.area, x: Number(event.target.value) / 100 },
                    }, "Положение точки")}
                  />
                </label>
                <label className="range-property">
                  <span>Сверху <b>{Math.round(point.area.y * 100)}%</b></span>
                  <input
                    type="range" min={0} max={100} step={1} value={Math.round(point.area.y * 100)}
                    onChange={(event) => patchPoint(point, {
                      area: { ...point.area, y: Number(event.target.value) / 100 },
                    }, "Положение точки")}
                  />
                </label>
                <label className="range-property">
                  <span>Размер участка <b>{Math.round(point.area.size * 100)}%</b></span>
                  <input
                    type="range" min={1} max={100} step={1} value={Math.round(point.area.size * 100)}
                    title="Сторона квадрата в долях меньшей стороны кадра"
                    onChange={(event) => patchPoint(point, {
                      area: { ...point.area, size: Number(event.target.value) / 100 },
                    }, "Размер участка")}
                  />
                </label>
                <label className="range-property">
                  <span>Размытие <b>{Math.round(point.blur)} px</b></span>
                  <input
                    type="range" min={0} max={64} step={1} value={Math.round(point.blur)}
                    title="Сколько пикселей уменьшенной копии добавить по краям: мягче границы — ровнее цвет"
                    onChange={(event) => patchPoint(point, { blur: Number(event.target.value) }, "Размытие участка")}
                  />
                </label>
                <label className="range-property">
                  <span>Сглаживание <b>{Math.round(point.smooth)}%</b></span>
                  <input
                    type="range" min={0} max={100} step={1} value={Math.round(point.smooth)}
                    title="0 % — цвет меняется мгновенно, 100 % — тянется около полутора секунд"
                    onChange={(event) => patchPoint(point, { smooth: Number(event.target.value) }, "Сглаживание точки")}
                  />
                </label>
              </div>
            )}
          </div>
        );
      })}

      <button className="button secondary" onClick={add}>
        <Plus size={13} /> Точка
      </button>

      {points.some((point) => point.source.kind === "obs") && (
        <div className="ambient-obs">
          <div className="section-title"><span>OBS</span><small>obs-websocket</small></div>
          <div className="ambient-obs-row">
            <label className="module-field">
              <span className="module-field-label">Адрес</span>
              <input
                className="text-input"
                value={connection.host}
                onChange={(event) => props.onConfig({
                  ...props.module.config,
                  connection: { ...connection, host: event.target.value },
                }, "Адрес OBS")}
              />
            </label>
            <label className="module-field">
              <span className="module-field-label">Порт</span>
              <input
                className="text-input"
                type="number"
                min={1}
                max={65535}
                value={connection.port}
                onChange={(event) => props.onConfig({
                  ...props.module.config,
                  connection: { ...connection, port: Number(event.target.value) || 4455 },
                }, "Порт OBS")}
              />
            </label>
          </div>
          <p className="behaviour-hint">
            Пароль obs-websocket хранится в настройках приложения, а не в пресете: пресет можно
            выкладывать, а секрет — нет.
          </p>
          <button className="button secondary" onClick={() => obs?.probe()}>
            Проверить соединение
          </button>
          {obs?.status.text && (
            <p className={obs.status.ok ? "muted" : "inline-error"}>{obs.status.text}</p>
          )}
        </div>
      )}
    </div>
  );
}
