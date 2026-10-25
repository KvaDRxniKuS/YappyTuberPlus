import { useCallback, useEffect, useState } from "react";
import { HardDrive, Trash2, X } from "lucide-react";
import { assetStats, listAssets, pruneAssets, type AssetUsage } from "../engine/assets";

interface FilesDialogProps {
  /** Файлы, на которые ссылается открытый пресет. */
  usedIds: Set<string>;
  /**
   * Что нельзя удалять: сцена и снимки истории отмены. Файл может быть не нужен
   * сцене, но понадобиться после Ctrl+Z.
   */
  keepIds: Set<string>;
  onClose: () => void;
  onNotify: (message: string) => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} ГБ`;
}

function kindOf(mime: string): string {
  if (mime.startsWith("image/")) return "картинка";
  if (mime.startsWith("video/")) return "видео";
  if (mime.startsWith("audio/")) return "звук";
  return "файл";
}

/**
 * Файлы объектов сцены живут отдельно от пресета (`src/engine/assets.ts`):
 * в пресете ссылка, байты — в хранилище webview. Эта панель показывает, что
 * там накопилось, и убирает файлы, на которые уже никто не ссылается.
 *
 * Уборка нужна потому, что автоматическая чистка идёт только на старте: за
 * долгую смену можно добавить и удалить десятки картинок, и место в профиле
 * останется занятым до перезапуска приложения.
 */
export function FilesDialog({ usedIds, keepIds, onClose, onNotify }: FilesDialogProps) {
  const [files, setFiles] = useState<AssetUsage[] | null>(null);
  const [stats, setStats] = useState({ count: 0, bytes: 0 });
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const [list, summary] = await Promise.all([listAssets(usedIds), assetStats()]);
    setFiles(list);
    setStats(summary);
  }, [usedIds]);

  useEffect(() => { void reload(); }, [reload]);

  const unused = (files ?? []).filter((file) => !keepIds.has(file.id)).length;

  const clean = async () => {
    setBusy(true);
    // Оставляем всё, что может понадобиться сцене и истории: уборка трогает
    // только «сирот».
    const removed = await pruneAssets(keepIds);
    setBusy(false);
    await reload();
    onNotify(removed
      ? `Убрано файлов: ${removed}`
      : "Неиспользуемых файлов нет");
  };

  return (
    <div className="dialog-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="overlay-dialog files-dialog" role="dialog" aria-label="Файлы объектов">
        <header className="dialog-head">
          <div className="dialog-title">
            <div className="dialog-icon"><HardDrive size={17} /></div>
            <div><span className="eyebrow">ХРАНИЛИЩЕ ПРОФИЛЯ</span><h2>Файлы объектов</h2></div>
          </div>
          <button className="icon-button" title="Закрыть" onClick={onClose}><X size={15} /></button>
        </header>

        <div className="files-summary">
          <b>{stats.count} {stats.count === 1 ? "файл" : "файлов"}</b>
          <span>{formatBytes(stats.bytes)}</span>
          <span className={unused ? "files-unused" : ""}>
            {unused ? `не используется: ${unused}` : "все файлы в сцене"}
          </span>
        </div>

        <div className="dialog-body">
          <p className="dialog-note">
            В пресете лежит только ссылка на файл, а сами байты — в хранилище приложения и в
            папке <code>&lt;имя&gt;.assets</code> рядом с сохранённым пресетом. Поэтому
            автосохранение весит килобайты даже с видео в сцене, а папку можно перенести на
            другую машину вместе с файлом пресета. Экспорт JSON по-прежнему даёт один
            самодостаточный файл: картинки встраиваются в него. Уборка удаляет только те файлы,
            на которые не ссылаются ни сцена, ни шаги истории отмены: если объект можно вернуть
            через Ctrl+Z, его картинка останется. Удалённый файл возвращается только повторным
            импортом.
          </p>

          <div className="file-list">
            {files === null && <div className="file-empty">Читаю хранилище…</div>}
            {files !== null && files.length === 0 && (
              <div className="file-empty">Хранилище пустое: файлы появятся после импорта картинок, видео или звука.</div>
            )}
            {(files ?? []).map((file) => (
              <div className={`file-row ${file.used ? "" : "orphan"}`} key={file.id}>
                <span className="file-name" title={file.name}>{file.name}</span>
                <span className="file-kind">{kindOf(file.mime)}</span>
                <span className="file-size">{formatBytes(file.size)}</span>
                <span className={`file-state ${file.used ? "used" : keepIds.has(file.id) ? "kept" : ""}`}>
                  {file.used ? "в сцене" : keepIds.has(file.id) ? "в истории" : "свободен"}
                </span>
              </div>
            ))}
          </div>
        </div>

        <footer className="files-footer">
          <span>Ссылка в пресете: <code>asset:…</code></span>
          <button
            className="button secondary"
            disabled={busy || unused === 0}
            title={unused ? `Удалить ${unused} файл(ов), на которые не ссылается пресет` : "Неиспользуемых файлов нет"}
            onClick={() => void clean()}
          >
            <Trash2 size={13} /> {busy ? "Убираю…" : `Убрать неиспользуемые${unused ? ` (${unused})` : ""}`}
          </button>
        </footer>
      </div>
    </div>
  );
}
