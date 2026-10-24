import { useEffect, useMemo, useRef, useState } from "react";
import {
  Box, ChevronDown, ChevronRight, Copy, Eye, EyeOff, FileImage,
  Folder, FolderPlus, Import, Plus, Trash2,
} from "lucide-react";
import type { RigObject } from "../types";
import { isDescendant, scriptValue } from "../engine/preset";
import { rangeIds, selectionRoots } from "../engine/selection";

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
  onImport: () => void;
  onAddGroup: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onToggleVisibility: (id: string) => void;
  onReparent: (id: string, parentId: string | null) => void;
}

interface Row { object: RigObject; depth: number }

export function TreePanel(props: TreePanelProps) {
  const { objects, selectedIds, primaryId } = props;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dragIds, setDragIds] = useState<string[]>([]);
  const [dropId, setDropId] = useState<string | null>(null);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const rows = useMemo(() => {
    const result: Row[] = [];
    const visited = new Set<string>();
    const walk = (parentId: string | null, depth: number) => {
      for (const object of objects.filter((item) => item.parentId === parentId)) {
        if (visited.has(object.id)) continue;
        visited.add(object.id);
        result.push({ object, depth });
        if (!collapsed.has(object.id)) walk(object.id, depth + 1);
      }
    };
    walk(null, 0);
    for (const object of objects) if (!visited.has(object.id)) result.push({ object, depth: 0 });
    return result;
  }, [objects, collapsed]);

  const order = useMemo(() => rows.map((row) => row.object.id), [rows]);
  const primary = objects.find((object) => object.id === primaryId) || null;

  return (
    <aside className="tree-panel panel-surface">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">СТРУКТУРА</span>
          <h2>Объекты <span className="count-badge">{objects.length}</span></h2>
        </div>
        <button className="icon-button" title="Импорт PNG/WebP" onClick={props.onImport}><Plus size={17} /></button>
      </div>

      <div className="tree-toolbar">
        <button onClick={props.onImport}><FileImage size={14} /> Спрайт</button>
        <button onClick={props.onAddGroup}><FolderPlus size={14} /> Группа</button>
      </div>

      <div
        className="object-tree"
        onDragLeave={() => setDropId(null)}
        onClick={(event) => { if (event.target === event.currentTarget) props.onSelect(null); }}
      >
        {rows.map(({ object, depth }) => {
          const hasChildren = objects.some((item) => item.parentId === object.id);
          const hidden = scriptValue(object.script, "visible") === "0" || object.base.visible === 0;
          const dragging = dragIds.includes(object.id);
          const invalidDrop = dragging || (!!dragIds.length && dragIds.some((id) => isDescendant(objects, object.id, id)));
          return (
            <div
              key={object.id}
              className={[
                "tree-row",
                selectedSet.has(object.id) ? "selected" : "",
                primaryId === object.id ? "primary" : "",
                dropId === object.id ? "drop-target" : "",
              ].filter(Boolean).join(" ")}
              style={{ "--depth": depth } as React.CSSProperties}
              aria-selected={selectedSet.has(object.id)}
              draggable={props.renamingId !== object.id}
              onDragStart={(event) => {
                const ids = selectedSet.has(object.id) ? selectionRoots(objects, selectedIds) : [object.id];
                setDragIds(ids);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/yappy-object", object.id);
              }}
              onDragEnd={() => { setDragIds([]); setDropId(null); }}
              onDragOver={(event) => {
                if (!dragIds.length || invalidDrop) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setDropId(object.id);
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (dragIds.length && !invalidDrop) for (const id of dragIds) props.onReparent(id, object.id);
                setDragIds([]);
                setDropId(null);
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
                {object.kind === "group" ? <Folder size={15} /> : object.image ? <img src={object.image} alt="" draggable={false} /> : <Box size={15} />}
              </span>
              {props.renamingId === object.id
                ? <TreeRename
                    value={object.name}
                    onCommit={(name) => props.onRename(object.id, name)}
                    onCancel={props.onRenameCancel}
                  />
                : <span className="tree-name" title="F2 — переименовать">{object.name}</span>}
              <button
                className="tree-eye"
                title={hidden ? "Показать" : "Скрыть"}
                onDoubleClick={(event) => event.stopPropagation()}
                onClick={(event) => { event.stopPropagation(); props.onToggleVisibility(object.id); }}
              >
                {hidden ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          );
        })}
        <div
          className={`root-drop-zone ${dropId === "root" ? "drop-target" : ""}`}
          onDragOver={(event) => { if (dragIds.length) { event.preventDefault(); setDropId("root"); } }}
          onDrop={(event) => {
            event.preventDefault();
            for (const id of dragIds) props.onReparent(id, null);
            setDragIds([]); setDropId(null);
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
