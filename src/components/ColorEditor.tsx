import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { ModuleInstance } from "../types";
import {
  COLOR_CHANNEL_BASE, COLOR_MODES, colorChannels, sanitizeChannelName, uniqueChannelName,
  type ColorChannel, type ColorMode,
} from "../modules/color";

/**
 * Каналы модуля «Цвет».
 *
 * Канал — это палитра плюс режим: что и как быстро переливается. Имя канала
 * уходит в скрипт (`<имя>_r`, `<имя>_g`…), подпись — только для панели и для
 * списков привязки цвета в «Поведении».
 *
 * Каналов можно добавить сколько угодно: каждый канал независим, поэтому один
 * может мигать по кругу, а другой стоять на месте.
 */
export function ColorEditor(props: {
  module: ModuleInstance;
  /** Входы других модулей — из них выбирается источник для «Реакции». */
  reactOptions?: Array<{ key: string; label: string }>;
  onChannels: (channels: ColorChannel[], label?: string) => void;
}) {
  const channels = colorChannels(props.module);
  const [open, setOpen] = useState<string | null>(channels[0]?.name ?? null);

  const patch = (channel: ColorChannel, changes: Partial<ColorChannel>, label: string) => {
    props.onChannels(channels.map((item) => (item.name === channel.name ? { ...item, ...changes } : item)), label);
  };

  const add = () => {
    const name = uniqueChannelName(channels, "c");
    const next: ColorChannel = {
      ...COLOR_CHANNEL_BASE,
      name,
      label: `Канал ${channels.length + 1}`,
      colors: COLOR_CHANNEL_BASE.colors.map((stop) => ({ ...stop })),
    };
    props.onChannels([...channels, next], "Добавление канала цвета");
    setOpen(name);
  };

  const remove = (channel: ColorChannel) => {
    // Последний канал не удаляем: модуль без каналов ничего не отдаёт, и
    // привязка цвета в объекте молча перестала бы работать.
    if (channels.length <= 1) return;
    props.onChannels(channels.filter((item) => item.name !== channel.name), "Удаление канала цвета");
  };

  return (
    <div className="color-editor">
      {channels.map((channel) => {
        const expanded = open === channel.name;
        return (
          <div className="color-channel" key={channel.name}>
            <div className="color-channel-head">
              <button
                className="color-channel-toggle"
                title="Открыть настройки канала"
                onClick={() => setOpen(expanded ? null : channel.name)}
              >
                <span className="color-swatch" style={{ background: channel.colors[0]?.color ?? "#000" }} />
                <span>{channel.label}</span>
                <small>{channel.name}</small>
              </button>
              <button
                className="button secondary"
                title={channels.length > 1 ? "Удалить канал" : "Последний канал удалить нельзя"}
                disabled={channels.length <= 1}
                onClick={() => remove(channel)}
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
                    value={channel.label}
                    onChange={(event) => patch(channel, { label: event.target.value.slice(0, 32) }, "Подпись канала")}
                  />
                </label>
                <label className="module-field">
                  <span className="module-field-label" title="В скрипте: <имя>_r, <имя>_g, <имя>_b, <имя>_a, <имя>_level">Имя в скрипте</span>
                  <input
                    className="text-input"
                    value={channel.name}
                    onChange={(event) => {
                      const clean = event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 24);
                      if (!clean) return;
                      const name = uniqueChannelName(channels.filter((item) => item.name !== channel.name), clean);
                      patch(channel, { name }, "Имя канала");
                      setOpen(name);
                    }}
                  />
                </label>

                <label className="module-field">
                  <span className="module-field-label">Режим</span>
                  <select
                    value={channel.mode}
                    title={COLOR_MODES.find((mode) => mode.value === channel.mode)?.hint}
                    onChange={(event) => patch(channel, { mode: event.target.value as ColorMode }, "Режим цвета")}
                  >
                    {COLOR_MODES.map((mode) => (
                      <option key={mode.value} value={mode.value}>{mode.label}</option>
                    ))}
                  </select>
                </label>

                <div className="color-palette">
                  <div className="key-editor-head">
                    <span>Палитра</span>
                    <span>Секунд</span>
                    <span />
                  </div>
                  {channel.colors.map((stop, index) => (
                    <div className="key-row" key={`${channel.name}-${index}`}>
                      <input
                        type="color"
                        className="color-input"
                        value={stop.color.slice(0, 7)}
                        onChange={(event) => {
                          const colors = channel.colors.map((item, position) => (
                            position === index ? { ...item, color: event.target.value } : item
                          ));
                          patch(channel, { colors }, "Цвет палитры");
                        }}
                      />
                      <input
                        className="text-input"
                        type="number"
                        min={0.05}
                        max={60}
                        step={0.1}
                        value={stop.hold}
                        title="Сколько секунд цвет стоит в «последовательности» и «случайном»"
                        onChange={(event) => {
                          const hold = Math.min(60, Math.max(0.05, Number(event.target.value) || 0.05));
                          const colors = channel.colors.map((item, position) => (
                            position === index ? { ...item, hold } : item
                          ));
                          patch(channel, { colors }, "Время цвета");
                        }}
                      />
                      <button
                        className="button secondary"
                        title={channel.colors.length > 1 ? "Убрать цвет" : "Хотя бы один цвет нужен"}
                        disabled={channel.colors.length <= 1}
                        onClick={() => patch(channel, {
                          colors: channel.colors.filter((_, position) => position !== index),
                        }, "Удаление цвета")}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                  <button
                    className="button secondary"
                    onClick={() => patch(channel, {
                      colors: [...channel.colors, { color: "#ffffff", hold: 1 }],
                    }, "Добавление цвета")}
                  >
                    <Plus size={13} /> Цвет
                  </button>
                </div>

                <label className="range-property">
                  <span>Скорость <b>{Math.round(channel.speed)}%</b></span>
                  <input
                    type="range" min={0} max={200} step={1} value={channel.speed}
                    title="100 % — две секунды на шаг палитры"
                    onChange={(event) => patch(channel, { speed: Number(event.target.value) }, "Скорость цвета")}
                  />
                </label>
                <label className="range-property">
                  <span>Яркость <b>{Math.round(channel.brightness)}%</b></span>
                  <input
                    type="range" min={0} max={200} step={1} value={channel.brightness}
                    onChange={(event) => patch(channel, { brightness: Number(event.target.value) }, "Яркость цвета")}
                  />
                </label>
                <label className="range-property">
                  <span>Сглаживание <b>{Math.round(channel.smooth)}%</b></span>
                  <input
                    type="range" min={0} max={100} step={1} value={channel.smooth}
                    title="0 % — цвет меняется мгновенно, 100 % — тянется около полутора секунд"
                    onChange={(event) => patch(channel, { smooth: Number(event.target.value) }, "Сглаживание цвета")}
                  />
                </label>
                <label className="range-property">
                  <span>Сдвиг <b>{Math.round(channel.phase)}%</b></span>
                  <input
                    type="range" min={0} max={100} step={1} value={channel.phase}
                    title="Сдвиг по времени: два канала не мигают в такт"
                    onChange={(event) => patch(channel, { phase: Number(event.target.value) }, "Сдвиг цвета")}
                  />
                </label>

                {channel.mode === "react" && (
                  <label className="module-field">
                    <span className="module-field-label" title="Цвет стоит, яркость ведёт этот вход">Яркость от входа</span>
                    <select
                      value={channel.react ? `${channel.react.module}.${channel.react.input}` : ""}
                      onChange={(event) => {
                        const value = event.target.value;
                        const [moduleName, input] = value.split(".");
                        patch(channel, { react: value ? { module: moduleName, input } : null }, "Источник яркости");
                      }}
                    >
                      <option value="">не выбран</option>
                      {(props.reactOptions ?? []).map((option) => (
                        <option key={option.key} value={option.key}>{option.label}</option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
            )}
          </div>
        );
      })}

      <button className="button secondary" onClick={add}>
        <Plus size={13} /> Канал цвета
      </button>
    </div>
  );
}
