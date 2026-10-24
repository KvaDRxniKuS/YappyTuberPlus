import { useMemo, useState } from "react";
import {
  Box, ChevronDown, ChevronRight, Copy, Eye, EyeOff, FileImage,
  Folder, FolderPlus, Import, Plus, Trash2,
} from "lucide-react";
import type { RigObject } from "../types";
import { isDescendant, scriptValue } from "../engine/preset";

interface TreePanelProps {
  objects: RigObject[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onImport: () => void;
  onAddGroup: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onToggleVisibility: (id: string) => void;
  onReparent: (id: string, parentId: string | null) => void;
}

interface Row { object: RigObject; depth: number }

export function TreePanel(props: TreePanelProps) {
  const { objects, selectedId } = props;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);

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

  const selected = objects.find((object) => object.id === selectedId);

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

      <div className="object-tree" onDragLeave={() => setDropId(null)}>
        {rows.map(({ object, depth }) => {
          const hasChildren = objects.some((item) => item.parentId === object.id);
          const hidden = scriptValue(object.script, "visible") === "0" || object.base.visible === 0;
          const invalidDrop = dragId === object.id || (!!dragId && isDescendant(objects, object.id, dragId));
          return (
            <div
              key={object.id}
              className={`tree-row ${selectedId === object.id ? "selected" : ""} ${dropId === object.id ? "drop-target" : ""}`}
              style={{ "--depth": depth } as React.CSSProperties}
              draggable
              onDragStart={(event) => {
                setDragId(object.id);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/yappy-object", object.id);
              }}
              onDragEnd={() => { setDragId(null); setDropId(null); }}
              onDragOver={(event) => {
                if (!dragId || invalidDrop) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setDropId(object.id);
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (dragId && !invalidDrop) props.onReparent(dragId, object.id);
                setDragId(null);
                setDropId(null);
              }}
              onClick={() => props.onSelect(object.id)}
            >
              <button
                className={`tree-expander ${hasChildren ? "" : "empty"}`}
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
              <span className="tree-name">{object.name}</span>
              <button
                className="tree-eye"
                title={hidden ? "Показать" : "Скрыть"}
                onClick={(event) => { event.stopPropagation(); props.onToggleVisibility(object.id); }}
              >
                {hidden ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          );
        })}
        <div
          className={`root-drop-zone ${dropId === "root" ? "drop-target" : ""}`}
          onDragOver={(event) => { if (dragId) { event.preventDefault(); setDropId("root"); } }}
          onDrop={(event) => {
            event.preventDefault();
            if (dragId) props.onReparent(dragId, null);
            setDragId(null); setDropId(null);
          }}
        >
          Перетащите сюда, чтобы открепить
        </div>
      </div>

      <div className="tree-footer">
        <span>{selected ? selected.id : "Ничего не выбрано"}</span>
        <div>
          <button className="icon-button" title="Дублировать" disabled={!selected} onClick={props.onDuplicate}><Copy size={14} /></button>
          <button className="icon-button danger" title="Удалить" disabled={!selected} onClick={props.onDelete}><Trash2 size={14} /></button>
        </div>
      </div>
      <div className="tree-hint"><Import size={12} /> PNG или WebP · до 256 объектов</div>
    </aside>
  );
}
