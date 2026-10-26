import { useEffect, useMemo, useRef, useState } from "react";
import {
  Box, ChevronDown, ChevronRight, Copy, Eye, EyeOff, FileImage, FileVideo, Film,
  Folder, FolderPlus, Import, Plus, Shapes, Trash2, Type,
} from "lucide-react";
import type { RigObject } from "../types";
import { isDescendant, scriptValue } from "../engine/preset";
import { rangeIds, selectionRoots, treeRows } from "../engine/selection";
import { useAssetUrl } from "../hooks/useAssets";

/**
 * Миниатюра строки дерева.
 *
 * Файл объекта лежит в хранилище webview (`asset:<id>`), поэтому URL берётся
 * хуком: пока IndexedDB читает блоб, строка показывает значок типа.
 */
function TreeThumbnail({ object }: { object: RigObject }) {
  const preview = useAssetUrl(object.image);
  const mediaPreview = useAssetUrl(object.media?.src);
  if (object.kind === "group") return <Folder size={15} />;
  if (object.kind === "text") return <Type size={15} />;
  if (object.kind === "shape") return <Shapes size={15} />;
  if (object.kind === "media") {
    if (object.media?.type === "audio") return <FileVideo size={15} />;
    return mediaPreview ? <img src={mediaPreview} alt="" draggable={false} /> : <Film size={15} />;
  }
  return preview ? <img src={preview} alt="" draggable={false} /> : <Box size={15} />;
}

interface TreePanelProps {
  objects: RigObject[];
  selectedIds: string[];
  primaryId: string | null;
  renamingId: string | null;
  onSelect: (id: string | null) => void;
  onToggleSelect: (id: string) => void;
  onSelectRange: (ids: string[]) => void;
  onRename: (id: string, name: string) => void;
  onRequestRename: (id: string | null) => void;
  onRenameCancel: () => void;
  /** Любой файл: тип объекта определяется по нему самому. */
  onImport: () => void;
  onAddGroup: () => void;
  /** Текстовый объект: шаблон с подстановками из чата. */
  onAddText: () => void;
  /** Объект-фигура: контуры для заливки и маски. */
  onAddShape: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onToggleVisibility: (id: string) => void;
  /** Вложение и открепление применяются ко всей перетаскиваемой выборке. */
  onReparent: (ids: string[], parentId: string | null) => void;
  /** Перестановка строк: вставка перед/после цели, порядок = порядок отрисовки. */
  onReorder: (ids: string[], targetId: string, position: "before" | "after") => void;
}

type DropTarget = { id: string; position: "before" | "after" | "inside" } | null;

/** Свой тип переноса: по нему строка понимает, что тащат объект, а не файл. */
const OBJECT_MIME = "text/yappy-object";

export function TreePanel(props: TreePanelProps) {
  const { objects, selectedIds, primaryId } = props;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dragIds, setDragIds] = useState<string[]>([]);
  const [drop, setDrop] = useState<DropTarget>(null);
  // Те же значения в ref: `drop` переключается на каждом движении мыши, а
  // `onDrop` обязан видеть последнюю зону, даже если React не успел
  // перерисовать строку. Без этого перетаскивание в структуре срабатывало как
  // «внутрь группы» вместо «перед/после строки».
  const dragRef = useRef<string[]>([]);
  const dropRef = useRef<DropTarget>(null);
  const setDrag = (ids: string[]) => {
    dragRef.current = ids;
    setDragIds(ids);
  };
  const setDropTarget = (next: DropTarget) => {
    dropRef.current = next;
    setDrop(next);
  };
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const rows = useMemo(() => treeRows(objects, collapsed), [objects, collapsed]);

  const order = useMemo(() => rows.map((row) => row.object.id), [rows]);
  const primary = objects.find((object) => object.id === primaryId) || null;

  return (
    <aside className="tree-panel panel-surface">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">СТРУКТУРА</span>
          <h2>Объекты <span className="count-badge">{objects.length}</span></h2>
        </div>
        <button
          className="icon-button"
          title="Добавить файл: картинка, анимация, видео или звук — тип определится сам"
          onClick={props.onImport}
        ><Plus size={17} /></button>
      </div>

      <div className="tree-toolbar">
        <button
          onClick={props.onImport}
          title="Картинка станет спрайтом, анимация, видео и звук — медиа-объектом. Тип определяется по файлу"
        >
          <FileImage size={14} /> Файл
        </button>
        <button onClick={props.onAddGroup}><FolderPlus size={14} /> Группа</button>
        <button onClick={props.onAddText} title="Текст с подстановками из чата">
          <Type size={14} /> Текст
        </button>
        <button onClick={props.onAddShape} title="Фигура: прямоугольник, эллипс или перо — и маска для других объектов">
          <Shapes size={14} /> Фигура
        </button>
      </div>

      <div
        className="object-tree"
        // Уход из дерева гасит подсветку, но переход между строками — нет:
        // dragleave прилетает и от детей, и раньше подсветка мигала.
        onDragLeave={(event) => {
          const next = event.relatedTarget as Node | null;
          if (next && event.currentTarget.contains(next)) return;
          setDropTarget(null);
        }}
        onClick={(event) => { if (event.target === event.currentTarget) props.onSelect(null); }}
      >
        {rows.map(({ object, depth }) => {
          const hasChildren = objects.some((item) => item.parentId === object.id);
          const disabled = object.enabled === false;
          const hiddenByScript = scriptValue(object.script, "visible") === "0" || object.base.visible === 0;
          const dragging = dragIds.includes(object.id);
          const invalidDrop = dragging || (!!dragIds.length && dragIds.some((id) => isDescendant(objects, object.id, id)));
          const zone = drop?.id === object.id ? drop.position : null;
          return (
            <div
              key={object.id}
              className={[
                "tree-row",
                selectedSet.has(object.id) ? "selected" : "",
                primaryId === object.id ? "primary" : "",
                disabled ? "is-disabled" : "",
                hiddenByScript ? "hidden-by-script" : "",
                zone === "inside" ? "drop-target" : "",
                zone === "before" ? "drop-before" : "",
                zone === "after" ? "drop-after" : "",
              ].filter(Boolean).join(" ")}
              style={{ "--depth": depth } as React.CSSProperties}
              aria-selected={selectedSet.has(object.id)}
              draggable={props.renamingId !== object.id}
              onDragStart={(event) => {
                const ids = selectedSet.has(object.id) ? selectionRoots(objects, selectedIds) : [object.id];
                setDrag(ids);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/yappy-object", object.id);
              }}
              onDragEnd={() => { setDrag([]); setDropTarget(null); }}
              onDragOver={(event) => {
                // Тип в dataTransfer — второй признак: состояние могло не дойти,
                // если строка перерисовалась между началом переноса и наведением.
                const ours = dragRef.current.length > 0 || Array.from(event.dataTransfer.types).includes(OBJECT_MIME);
                if (!ours || invalidDrop) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                const rect = event.currentTarget.getBoundingClientRect();
                const ratio = rect.height ? (event.clientY - rect.top) / rect.height : 0.5;
                // Верхняя и нижняя четверти строки — вставка рядом, середина — внутрь.
                const position = ratio < 0.25 ? "before" : ratio > 0.75 ? "after" : "inside";
                const current = dropRef.current;
                if (current?.id !== object.id || current.position !== position) setDropTarget({ id: object.id, position });
              }}
              onDrop={(event) => {
                event.preventDefault();
                const ids = dragRef.current;
                const target = dropRef.current;
                const position = target?.id === object.id ? target.position : "inside";
                if (ids.length && !invalidDrop) {
                  if (position === "inside") props.onReparent(ids, object.id);
                  else props.onReorder(ids, object.id, position);
                }
                setDrag([]);
                setDropTarget(null);
              }}
              onClick={(event) => {
                if (event.ctrlKey || event.metaKey) { props.onToggleSelect(object.id); return; }
                if (event.shiftKey) { props.onSelectRange(rangeIds(order, primaryId, object.id)); return; }
                props.onSelect(object.id);
              }}
              onDoubleClick={() => props.onRequestRename(object.id)}
            >
              <button
                className={`tree-expander ${hasChildren ? "" : "empty"}`}
                onDoubleClick={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  if (!hasChildren) return;
                  setCollapsed((current) => {
                    const next = new Set(current);
                    if (next.has(object.id)) next.delete(object.id); else next.add(object.id);
                    return next;
                  });
                }}
              >
                {hasChildren ? (collapsed.has(object.id) ? <ChevronRight size={13} /> : <ChevronDown size={13} />) : <span />}
              </button>
              <span className={`tree-thumbnail ${object.kind}`}>
                <TreeThumbnail object={object} />
              </span>
              {props.renamingId === object.id
                ? <TreeRename
                    value={object.name}
                    onCommit={(name) => props.onRename(object.id, name)}
                    onCancel={props.onRenameCancel}
                  />
                : <span className="tree-name" title="F2 — переименовать">{object.name}</span>}
              <button
                className={`tree-eye ${hiddenByScript ? "script-driven" : ""}`}
                title={disabled
                  ? "Включить показ (видимость из скрипта не меняется)"
                  : hiddenByScript
                    ? "Скрыт формулой видимости: глаз спрячет объект поверх неё, скрипт не изменится"
                    : "Временно скрыть, не меняя формулы"}
                onDoubleClick={(event) => event.stopPropagation()}
                onClick={(event) => { event.stopPropagation(); props.onToggleVisibility(object.id); }}
              >
                {hiddenByScript && <i className="eye-brace">{`{`}</i>}
                {disabled || hiddenByScript ? <EyeOff size={13} /> : <Eye size={14} />}
                {hiddenByScript && <i className="eye-brace">{`}`}</i>}
              </button>
            </div>
          );
        })}
        <div
          className={`root-drop-zone ${drop?.id === "root" ? "drop-target" : ""}`}
          onDragOver={(event) => {
            if (!dragRef.current.length) return;
            event.preventDefault();
            setDropTarget({ id: "root", position: "inside" });
          }}
          onDrop={(event) => {
            event.preventDefault();
            const ids = dragRef.current;
            if (ids.length) props.onReparent(ids, null);
            setDrag([]); setDropTarget(null);
          }}
        >
          Перетащите сюда, чтобы открепить
        </div>
      </div>

      <div className="tree-footer">
        <span>
          {primary
            ? `${primary.id}${selectedIds.length > 1 ? ` · выделено ${selectedIds.length}` : ""}`
            : "Ничего не выбрано"}
        </span>
        <div>
          <button className="icon-button" title="Дублировать · Ctrl+D" disabled={!selectedIds.length} onClick={props.onDuplicate}><Copy size={14} /></button>
          <button className="icon-button danger" title="Удалить" disabled={!selectedIds.length} onClick={props.onDelete}><Trash2 size={14} /></button>
        </div>
      </div>
      <div className="tree-hint"><Import size={12} /> PNG или WebP · до 256 объектов</div>
    </aside>
  );
}

/** Поле переименования прямо в строке дерева: Enter/blur — применить, Esc — отменить. */
function TreeRename({ value, onCommit, onCancel }: {
  value: string; onCommit: (name: string) => void; onCancel: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const input = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const finish = (commit: boolean) => {
    if (finished.current) return;
    finished.current = true;
    if (commit) onCommit(draft); else onCancel();
  };
  return (
    <span className="tree-rename">
      <input
        ref={input}
        value={draft}
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onBlur={() => finish(true)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") { event.preventDefault(); finish(true); }
          else if (event.key === "Escape") { event.preventDefault(); finish(false); }
        }}
      />
    </span>
  );
}
