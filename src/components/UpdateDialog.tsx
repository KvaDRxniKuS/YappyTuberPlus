import { useEffect, useState } from "react";
import { ArrowDownToLine, FileWarning, X } from "lucide-react";
import type { CompatibilityIssue } from "../engine/presetCheck";
import type { UpdateChannel, UpdateManifest } from "../engine/update";
import { updateSummary } from "../engine/update";
import { versionLabel } from "../version";

interface UpdateDialogProps {
  manifest: UpdateManifest;
  /**
   * Та же версия, но файлы в репозитории другие: пересборка без нового
   * поколения ядра (например, исправление внутри ядра).
   */
  refresh: boolean;
  /** Появившиеся и изменённые файлы. */
  changedFiles: string[];
  /** Пропавшие файлы: их удалит обновление. */
  removedFiles: string[];
  /** Что может не работать после обновления: пустой список — всё сочетается. */
  issues: CompatibilityIssue[];
  channel: UpdateChannel;
  /** Пресет не сохранён в файл: перед обновлением предложим сохранить. */
  needsSave: boolean;
  /** Сохраняет пресет в файл. */
  onSave: () => Promise<void>;
  /**
   * Ставит обновление. `null` — установка пошла (страница перезагрузится или
   * приложение перезапустится), строка — инструкция для ручного случая.
   */
  onInstall: () => Promise<string | null>;
  /** Закрыть до следующего запуска. */
  onLater: () => void;
  /** Больше не предлагать именно эту версию. */
  onSkipVersion: () => void;
  onClose: () => void;
}

type Step = "offer" | "save" | "work" | "done";

/**
 * «Доступно обновление».
 *
 * Три двери, как и просили: обновить, позже, пропустить версию. Перед
 * установкой проверяется, сохранён ли пресет: обновление меняет сборку, и
 * терять несохранённую сцену из-за него не нужно.
 */
/** Сколько путей показывать в списке: остальное — числом. */
const FILE_ROWS = 8;

export function UpdateDialog(props: UpdateDialogProps) {
  const [step, setStep] = useState<Step>("offer");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && step !== "work") props.onClose(); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [props, step]);

  const install = async (save: boolean) => {
    setStep("work");
    setMessage(save ? "Сохраняю пресет…" : "Скачиваю обновление…");
    try {
      if (save) await props.onSave();
      setMessage(props.channel === "manual"
        ? "Готовлю инструкцию…"
        : "Скачиваю и проверяю файлы…");
      const instruction = await props.onInstall();
      if (instruction) {
        setStep("done");
        setMessage(instruction);
        return;
      }
      setMessage("Готово: перезапускаюсь…");
    } catch (reason) {
      setStep("done");
      setMessage(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const start = () => {
    if (props.needsSave) { setStep("save"); return; }
    void install(false);
  };

  const channelNote = props.channel === "manual"
    ? "Запуск из исходников: файлы принадлежат git. «Обновить» покажет, как подтянуть версию лаунчером."
    : props.channel === "agent"
      ? "Собранная папка: файлы заменятся на диске, страница перезагрузится."
      : "Приложение: скачается новая версия, приложение перезапустится само.";

  return (
    <div
      className="dialog-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && step !== "work") props.onClose();
      }}
    >
      <div className="module-dialog" role="dialog" aria-label="Доступно обновление">
        <header className="dialog-head">
          <div className="dialog-title">
            <div className="dialog-icon"><ArrowDownToLine size={17} /></div>
            <div>
              <span className="eyebrow">{props.refresh ? "ПАПКА В РЕПОЗИТОРИИ НОВЕЕ" : "ДОСТУПНО ОБНОВЛЕНИЕ"}</span>
              <h2>{step === "save"
                ? "Пресет не сохранён"
                : props.refresh ? "Та же версия, но файлы новее" : "Новая сборка"}</h2>
            </div>
          </div>
          <button
            className="icon-button"
            title="Закрыть"
            disabled={step === "work"}
            onClick={props.onClose}
          ><X size={15} /></button>
        </header>

        <div className="dialog-body">
          <ul className="module-dialog-list">
            <li>
              <code>новая</code>
              <span>{updateSummary(props.manifest)}</span>
            </li>
            <li>
              <code>сейчас</code>
              <span>{versionLabel()}</span>
            </li>
          </ul>

          {props.refresh && (
            <>
              <p className="dialog-note">
                Номер версии не изменился, а содержимое папки сборки — да: в
                репозитории лежит пересборка этого же поколения. Сцена и пресеты
                останутся на месте, заменятся только файлы программы.
              </p>
              {(props.changedFiles.length > 0 || props.removedFiles.length > 0) && (
                <ul className="module-dialog-list">
                  <li>
                    <code>файлы</code>
                    <span>
                      {props.changedFiles.slice(0, FILE_ROWS).join(", ")}
                      {props.changedFiles.length > FILE_ROWS
                        ? ` и ещё ${props.changedFiles.length - FILE_ROWS}` : ""}
                      {props.removedFiles.length
                        ? ` · удалится: ${props.removedFiles.slice(0, FILE_ROWS).join(", ")}` : ""}
                    </span>
                  </li>
                </ul>
              )}
            </>
          )}

          {props.issues.length > 0 && (
            <>
              <p className="dialog-note small">
                <FileWarning size={12} /> С текущей сценой эта сборка несовместима местами:
              </p>
              <ul className="module-dialog-list">
                {props.issues.map((issue) => (
                  <li key={issue.label}>
                    <code>{issue.label}</code>
                    <span>{issue.detail}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {step === "offer" && (
            <>
              <p className="dialog-note small">{channelNote}</p>
              <div className="dialog-actions">
                <button className="button primary" onClick={start}>Обновить</button>
                <button className="button secondary" onClick={props.onLater}>Позже</button>
                <button className="button secondary" onClick={props.onSkipVersion}>Пропустить версию</button>
              </div>
            </>
          )}

          {step === "save" && (
            <>
              <p className="dialog-note">
                Текущая сцена не сохранена в файл. Обновление перезапустит сборку —
                несохранённое останется только в автосохранении браузера.
              </p>
              <div className="dialog-actions">
                <button className="button primary" onClick={() => void install(true)}>Сохранить и обновить</button>
                <button className="button secondary" onClick={() => void install(false)}>Обновить без сохранения</button>
                <button className="button secondary" onClick={() => setStep("offer")}>Отмена</button>
              </div>
            </>
          )}

          {(step === "work" || step === "done") && message && (
            <>
              <p className="dialog-note">{message}</p>
              {step === "done" && (
                <div className="dialog-actions">
                  <button className="button primary" onClick={props.onClose}>Понятно</button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
