import { useEffect } from "react";
import { Blocks, X } from "lucide-react";
import type { ModuleInstance } from "../types";
import { moduleDefinition } from "../modules/registry";

interface ModuleApplyDialogProps {
  /** Модули из открываемого пресета. */
  modules: ModuleInstance[];
  onApply: () => void;
  onKeep: () => void;
  onDisable: () => void;
}

/**
 * Пресет приносит свой набор модулей. Спрашиваем один раз при открытии:
 * применить его, оставить текущий набор сессии или отключить все входы.
 */
export function ModuleApplyDialog(props: ModuleApplyDialogProps) {
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") props.onKeep(); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [props]);

  return (
    <div className="dialog-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) props.onKeep(); }}>
      <div className="module-dialog" role="dialog" aria-label="Модули пресета">
        <header className="dialog-head">
          <div className="dialog-title">
            <div className="dialog-icon"><Blocks size={17} /></div>
            <div><span className="eyebrow">ПРЕСЕТ С МОДУЛЯМИ</span><h2>Подключить входы?</h2></div>
          </div>
          <button className="icon-button" title="Оставить как есть" onClick={props.onKeep}><X size={15} /></button>
        </header>

        <div className="dialog-body">
          <p className="dialog-note">
            В пресете сохранены модули и их настройки (микрофоны, усиление, пороги).
            Выберите, что делать с текущим набором входов.
          </p>
          <ul className="module-dialog-list">
            {props.modules.map((module) => (
              <li key={module.name}>
                <code>{module.name}</code>
                <span>{moduleDefinition(module.type).title}</span>
                <small>{module.enabled ? "" : "выключен"}</small>
                <small>{module.type === "loudness" ? (module.source === "live" ? "микрофон" : "ползунки") : ""}</small>
              </li>
            ))}
            {props.modules.length === 0 && <li className="muted">В пресете нет модулей</li>}
          </ul>

          <div className="dialog-actions">
            <button className="button primary" onClick={props.onApply}>Применить</button>
            <button className="button secondary" onClick={props.onKeep}>Оставить как есть</button>
            <button className="button secondary" onClick={props.onDisable}>Отключить все</button>
          </div>
          <p className="dialog-note small">
            «Применить» полностью заменяет список модулей списком пресета; «Оставить как есть»
            открывает пресет без чужих входов; «Отключить все» открывает его без модулей —
            все входы дают нули.
          </p>
        </div>
      </div>
    </div>
  );
}
