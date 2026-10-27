import { useEffect } from "react";
import { FileWarning, X } from "lucide-react";
import type { CompatibilityReport } from "../engine/presetCheck";
import { versionLabel } from "../version";

interface PresetIncompatibleDialogProps {
  report: CompatibilityReport;
  /** Имя файла, если известно: в диалоге видно, о чём речь. */
  fileName?: string | null;
  /**
   * Файл всё-таки открылся. Тогда диалог — предупреждение: сцена уже на экране,
   * но часть её может считаться не так, как задумал автор.
   */
  opened?: boolean;
  onClose: () => void;
}

/**
 * «Версии несовместимы» — вместо тихого отказа открыть пресет.
 *
 * Отдельного режима «только для чтения» нет: файл не открывается. Но человек
 * должен видеть, чем именно не сошлись версии, — иначе непонятно, обновлять
 * редактор или просить у автора пресет попроще.
 */
export function PresetIncompatibleDialog(props: PresetIncompatibleDialogProps) {
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") props.onClose(); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [props]);

  const report = props.report;
  return (
    <div
      className="dialog-backdrop"
      onPointerDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }}
    >
      <div className="module-dialog" role="dialog" aria-label="Версии несовместимы">
        <header className="dialog-head">
          <div className="dialog-title">
            <div className="dialog-icon"><FileWarning size={17} /></div>
            <div>
              <span className="eyebrow">ВЕРСИИ НЕСОВМЕСТИМЫ</span>
              <h2>{props.opened ? "Пресет открыт, но версии расходятся" : "Пресет не открыт"}</h2>
            </div>
          </div>
          <button className="icon-button" title="Закрыть" onClick={props.onClose}><X size={15} /></button>
        </header>

        <div className="dialog-body">
          <p className="dialog-note">
            {props.fileName ? <><code>{props.fileName}</code> — </> : null}
            {props.opened
              ? "Файл открылся, но записан другой сборкой: часть настроек может считаться не так, как задумывал автор."
              : "Файл записан сборкой, которая знает больше этой. Открыть его нельзя: редактор не понимает часть данных и потерял бы их при первом сохранении."}
          </p>

          <ul className="module-dialog-list">
            <li>
              <code>файл</code>
              <span>{report.fileLabel ?? report.fileVersion ?? "версия не записана"}</span>
            </li>
            <li>
              <code>редактор</code>
              <span>{versionLabel()}</span>
            </li>
          </ul>

          <p className="dialog-note small">Что может не работать:</p>
          <ul className="module-dialog-list">
            {report.issues.map((issue) => (
              <li key={issue.label}>
                <code>{issue.label}</code>
                <span>{issue.detail}</span>
              </li>
            ))}
          </ul>

          <div className="dialog-actions">
            <button className="button primary" onClick={props.onClose}>Понятно</button>
          </div>
          <p className="dialog-note small">
            {props.opened
              ? "Сцена уже на экране — работать можно. Если что-то выглядит не так, обновите редактор."
              : "Обновите редактор до версии не ниже файла — тогда пресет откроется целиком. "
                + "Если он пришёл от другого человека, попросите сохранить его этой сборкой."}
          </p>
        </div>
      </div>
    </div>
  );
}
