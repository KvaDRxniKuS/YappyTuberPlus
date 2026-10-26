import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { EnumState, ModuleConfig, ModuleInstance } from "../types";
import { sanitizeStateName, uniqueStateName } from "../modules/manual";
import {
  presetEntries, presetIssues, presetPreview, presetRewardModules, presetRewardPrefixes,
  presetVariable,
} from "../modules/presets";

/**
 * Редактор модуля «Пресеты».
 *
 * Пользователь пишет только подписи: имя для скрипта выводится из подписи, а
 * события, переменную и константы модуль делает сам. Галочка «искать среди
 * наград» связывает пресет с наградой Twitch: `redeem_лето` → пресет «Лето».
 */
export function PresetsEditor(props: {
  module: ModuleInstance;
  /** Все модули: из них выбирают, где искать награды. */
  modules: ModuleInstance[];
  onPatch: (patch: Partial<ModuleConfig>, label?: string) => void;
}) {
  const [draftLabel, setDraftLabel] = useState("");
  const entries = presetEntries(props.module);
  const search = props.module.config.rewardSearch === true;
  const chosenModules = presetRewardModules(props.module);
  const prefixes = presetRewardPrefixes(props.module);
  const preview = presetPreview(props.module);
  const issues = presetIssues(props.module, props.modules);
  // Себя в наградах не ищем: пресеты не выдают награды.
  const sources = props.modules.filter((module) => module.name !== props.module.name);

  const setEntries = (next: EnumState[], label: string) => {
    // Если удалили показанный пресет, предпросмотр сбрасывается: иначе он
    // указывал бы на несуществующий номер.
    const limit = next.length - 1;
    const nextPreview = preview > limit ? -1 : preview;
    props.onPatch({ presets: next, preview: nextPreview }, label);
  };

  const add = () => {
    const label = draftLabel.trim();
    if (!label) return;
    const name = uniqueStateName(entries, sanitizeStateName(label));
    setEntries([...entries, { name, label: label.slice(0, 24) }], "Добавление пресета");
    setDraftLabel("");
  };

  const renameLabel = (entry: EnumState, raw: string) => {
    const label = raw.trim();
    if (!label || label === entry.label) return;
    setEntries(entries.map((item) => (item.name === entry.name ? { ...item, label: label.slice(0, 24) } : item)), "Подпись пресета");
  };

  const renameName = (entry: EnumState, raw: string) => {
    const clean = raw.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 24);
    if (!clean || clean === entry.name) return;
    const name = uniqueStateName(entries.filter((item) => item.name !== entry.name), clean);
    setEntries(entries.map((item) => (item.name === entry.name ? { ...item, name } : item)), "Имя пресета");
  };

  const remove = (entry: EnumState) => setEntries(entries.filter((item) => item.name !== entry.name), "Удаление пресета");

  const toggleModule = (name: string) => {
    const next = chosenModules.includes(name)
      ? chosenModules.filter((item) => item !== name)
      : [...chosenModules, name];
    props.onPatch({ rewardModules: next }, "Модули наград");
  };

  return (
    <div className="key-editor preset-editor">
      <div className="key-editor-head">
        <span>Пресет</span>
        <span>Имя в скрипте</span>
        <span>№</span>
        <span />
      </div>

      {entries.map((entry, index) => (
        <div className="key-row" key={entry.name}>
          <input
            className="key-name"
            defaultValue={entry.label}
            key={`${entry.name}-${entry.label}`}
            spellCheck={false}
            title="Подпись: как пресет называется в панели"
            onBlur={(event) => renameLabel(entry, event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
          />
          <input
            className="key-name"
            defaultValue={entry.name}
            key={`${entry.name}-name`}
            spellCheck={false}
            title="Имя для скрипта: латиница, цифры и _"
            onBlur={(event) => renameName(entry, event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
          />
          <span className="enum-index" title="Номер пресета — это значение переменной">{index}</span>
          <button
            className={`icon-button ${preview === index ? "active" : ""}`}
            title={preview === index ? "Снять предпросмотр" : "Показать пресет в редакторе"}
            onClick={() => props.onPatch({ preview: preview === index ? -1 : index }, "Предпросмотр пресета")}
          >
            <span className="preset-preview-dot">{preview === index ? "●" : "○"}</span>
          </button>
          <button
            className="icon-button"
            title={entries.length <= 1 ? "Нужен хотя бы один пресет" : "Удалить пресет"}
            disabled={entries.length <= 1}
            onClick={() => remove(entry)}
          ><Trash2 size={12} /></button>
        </div>
      ))}

      <div className="key-capture enum-add">
        <input
          className="key-name"
          value={draftLabel}
          placeholder="Новый пресет: «Летний костюм»"
          spellCheck={false}
          onChange={(event) => setDraftLabel(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") add(); }}
        />
        <button className="button secondary" disabled={!draftLabel.trim()} onClick={add}>
          <Plus size={13} /> Добавить
        </button>
      </div>

      <label className="number-field preset-variable">
        <span className="number-label">Переменная</span>
        <div>
          <input
            defaultValue={presetVariable(props.module)}
            key={presetVariable(props.module)}
            spellCheck={false}
            title="Имя переменной пресета в скрипте: preset"
            onBlur={(event) => {
              const value = event.target.value.trim();
              if (!value || value === presetVariable(props.module)) return;
              props.onPatch({ variable: value }, "Переменная пресетов");
            }}
            onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
          />
        </div>
      </label>

      <label className="check-line">
        <input
          type="checkbox"
          checked={search}
          onChange={(event) => props.onPatch({ rewardSearch: event.target.checked }, "Поиск среди наград")}
        />
        <span>Искать среди наград</span>
      </label>

      {search && (
        <>
          <div className="preset-sources">
            <span className="muted">Модули наград</span>
            <div className="preset-source-list">
              {sources.length === 0 && <span className="muted">Добавьте модуль Twitch, чтобы включать пресеты наградами.</span>}
              {sources.map((module) => (
                <label className="check-line" key={module.name}>
                  <input
                    type="checkbox"
                    checked={chosenModules.includes(module.name)}
                    onChange={() => toggleModule(module.name)}
                  />
                  <span>{module.name}</span>
                </label>
              ))}
            </div>
          </div>

          <label className="number-field preset-variable">
            <span className="number-label">Префиксы наград</span>
            <div>
              <input
                defaultValue={prefixes.join(", ")}
                key={prefixes.join(",")}
                spellCheck={false}
                placeholder="redeem"
                title="То, что стоит между модулем и именем пресета: redeem_лето"
                onBlur={(event) => {
                  const list = event.target.value
                    .split(/[,;\s]+/)
                    .map((item) => item.trim())
                    .filter(Boolean);
                  props.onPatch({ rewardPrefixes: list.length ? list : ["redeem"] }, "Префиксы наград");
                }}
                onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
              />
            </div>
          </label>
        </>
      )}

      {issues.length > 0 && (
        <ul className="preset-issues">
          {issues.map((issue) => <li key={issue}>{issue}</li>)}
        </ul>
      )}

      <p className="muted">
        В скрипте: <code>{presetVariable(props.module)} == {props.module.name}_{entries[0]?.name ?? "preset"}</code>{" "}
        и событие <code>on {props.module.name}.{entries[0]?.name ?? "preset"}.up</code>. События пресетов
        модуль сам дописывает в глобальный скрипт — руками их писать не нужно.
      </p>
    </div>
  );
}
