import { useCallback, useEffect, useRef, useState } from "react";
import {
  Box, Check, ChevronDown, ChevronLeft, ChevronRight, FilePlus2, FolderOpen,
  Gauge, ImagePlus, MonitorPlay, Pause, Play, Redo2, RotateCcw, Save, Square,
  Undo2, X,
} from "lucide-react";
import { TreePanel } from "./components/TreePanel";
import { Scene, type SceneTool } from "./components/Scene";
import { Inspector } from "./components/Inspector";
import { RightPanel } from "./components/RightPanel";
import { Splitter } from "./components/Splitter";
import { OverlayDialog } from "./components/OverlayDialog";
import { createDemoPreset, createEmptyPreset, withDemoMouth } from "./data/demoPreset";
import {
  baseUpdates, descendantIds, isDescendant, makeGroup, makeSprite, normalizeOverlay, normalizePreset,
  scriptValue, setParent, setScriptValue, uniqueId,
} from "./engine/preset";
import { useRigEngine } from "./engine/useRigEngine";
import {
  downloadPreset, fileNameOf, isTauri, openPresetFile, savePreset, savePresetAs,
} from "./engine/presetFile";
import { useOverlayHost } from "./hooks/useOverlayHost";
import {
  DEFAULT_INPUTS, DEFAULT_LAYOUT, nextGuideMode, type BasePose, type EditorLayout,
  type InputValues, type RigObject, type RigPreset,
} from "./types";

const PRESET_KEY = "yappytuberplus.preset.v2";
const LAYOUT_KEY = "yappytuberplus.layout.v1";

function loadPreset(): RigPreset {
  try {
    const stored = localStorage.getItem(PRESET_KEY);
    if (stored) {
      const normalized = normalizePreset(JSON.parse(stored));
      // Presets saved before the closed mouth existed are migrated in place.
      if (normalized) return withDemoMouth(normalized);
    }
  } catch { /* use demo */ }
  return createDemoPreset();
}

function loadLayout(): EditorLayout {
  try {
    return { ...DEFAULT_LAYOUT, ...JSON.parse(localStorage.getItem(LAYOUT_KEY) || "{}") };
  } catch { return DEFAULT_LAYOUT; }
}

export default function App() {
  const [preset, setPreset] = useState<RigPreset>(loadPreset);
  const [selectedId, setSelectedId] = useState<string | null>(() => preset.objects[0]?.id || null);
  const [inputs, setInputs] = useState<InputValues>(DEFAULT_INPUTS);
  const [layout, setLayout] = useState<EditorLayout>(loadLayout);
  const [paused, setPaused] = useState(false);
  const [tool, setTool] = useState<SceneTool>("move");
  const [showGrid, setShowGrid] = useState(true);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [presetPath, setPresetPath] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const presetRef = useRef(preset);
  const inputsRef = useRef(inputs);
  const undoStack = useRef<RigPreset[]>([]);
  const redoStack = useRef<RigPreset[]>([]);
  const imageInput = useRef<HTMLInputElement>(null);
  const presetInput = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<number | null>(null);
  presetRef.current = preset;
  inputsRef.current = inputs;

  const overlay = useOverlayHost(preset);
  const engine = useRigEngine(preset, inputsRef, paused || stopped, overlay.sinkRef);
  const overlayConfig = preset.overlay || normalizeOverlay(undefined);
  const selected = preset.objects.find((object) => object.id === selectedId) || null;
  const globalNames = preset.globals.split("\n").map((line) => line.match(/^\s*([A-Za-z0-9_]+)\s*=/)?.[1]).filter((name): name is string => !!name);

  const notify = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  const pushUndo = useCallback(() => {
    undoStack.current.push(presetRef.current);
    if (undoStack.current.length > 60) undoStack.current.shift();
    redoStack.current = [];
  }, []);

  const commit = useCallback((next: RigPreset | ((current: RigPreset) => RigPreset), record = true) => {
    if (record) pushUndo();
    setPreset(next);
  }, [pushUndo]);

  const undo = useCallback(() => {
    const previous = undoStack.current.pop();
    if (!previous) return;
    redoStack.current.push(presetRef.current);
    setPreset(previous);
    if (!previous.objects.some((object) => object.id === selectedId)) setSelectedId(previous.objects[0]?.id || null);
  }, [selectedId]);

  const redo = useCallback(() => {
    const next = redoStack.current.pop();
    if (!next) return;
    undoStack.current.push(presetRef.current);
    setPreset(next);
  }, []);

  const saveCurrent = useCallback(async () => {
    try {
      const result = await savePreset(presetRef.current, presetPath);
      if (result.downloaded) {
        notify("Браузерный режим: файл скачан. В приложении «Сохранить» перезаписывает файл на диске");
        return;
      }
      setPresetPath(result.path);
      setSavedAt(new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }));
      notify(`Сохранено: ${fileNameOf(result.path) || "пресет"}`);
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "Не удалось сохранить пресет");
    }
  }, [notify, presetPath]);

  const saveCurrentAs = useCallback(async () => {
    try {
      const result = await savePresetAs(presetRef.current);
      if (result.downloaded) {
        notify("Браузерный режим: файл скачан. В приложении доступен выбор директории");
        return;
      }
      setPresetPath(result.path);
      setSavedAt(new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }));
      notify(`Сохранено как: ${fileNameOf(result.path) || "пресет"}`);
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "Не удалось сохранить пресет");
    }
  }, [notify]);

  const openFile = useCallback(async () => {
    if (!isTauri()) { presetInput.current?.click(); return; }
    try {
      const result = await openPresetFile();
      commit(result.preset);
      setPresetPath(result.path);
      setSavedAt(null);
      setSelectedId(result.preset.objects[0]?.id || null);
      notify(`Открыт ${fileNameOf(result.path) || "пресет"}`);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      if (!/отмен/i.test(message)) notify(message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commit, notify]);

  const togglePause = useCallback(() => {
    setStopped(false);
    setPaused((value) => !value);
  }, []);

  /** Стоп: пауза + нейтральная поза + сброс состояния движка (smooth, spring, autoblink). */
  const stopTimeline = useCallback(() => {
    setStopped(true);
    setPaused(true);
  }, []);

  const newPreset = useCallback(() => {
    const empty = createEmptyPreset();
    commit(empty);
    setPresetPath(null);
    setSavedAt(null);
    setSelectedId(null);
    notify("Создан пустой пресет");
  }, [commit, notify]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try { localStorage.setItem(PRESET_KEY, JSON.stringify(preset)); }
      catch { notify("Не удалось автосохранить: превышена квота браузера"); }
    }, 700);
    return () => window.clearTimeout(timer);
  }, [preset, notify]);

  useEffect(() => {
    overlay.setFrozen(stopped, presetRef.current);
    if (stopped) engine.resetTimeline();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopped]);

  useEffect(() => {
    const timer = window.setTimeout(() => localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)), 250);
    return () => window.clearTimeout(timer);
  }, [layout]);

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const editing = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.closest(".cm-editor");
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (event.shiftKey) void saveCurrentAs(); else void saveCurrent();
        return;
      }
      if (editing) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo(); else undo();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
        event.preventDefault(); redo();
      } else if (event.key.toLowerCase() === "v") setTool("move");
      else if (event.key.toLowerCase() === "p") setTool("pivot");
      else if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (event.shiftKey) stopTimeline(); else togglePause();
      }
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [notify, redo, undo, saveCurrent, saveCurrentAs, stopTimeline, togglePause]);

  const updateObject = useCallback((next: RigObject, record = true) => {
    commit((current) => ({ ...current, objects: current.objects.map((object) => object.id === next.id ? next : object) }), record);
  }, [commit]);

  const updateInputs = useCallback((patch: Partial<InputValues>) => {
    const next = { ...inputsRef.current, ...patch };
    inputsRef.current = next;
    setInputs(next);
  }, []);

  const importSprites = async (files: FileList | null) => {
    if (!files?.length) return;
    pushUndo();
    const current = presetRef.current;
    const added: RigObject[] = [];
    try {
      for (const [index, file] of Array.from(files).entries()) {
        const dataUrl = await readFile(file);
        const bitmap = await createImageBitmap(file);
        const name = file.name.replace(/\.[^.]+$/, "");
        const id = uniqueId([...current.objects, ...added], name);
        added.push(makeSprite(id, name, dataUrl, bitmap.width, bitmap.height, 500 + index * 28, 300 + index * 28));
        bitmap.close();
      }
      setPreset({ ...current, objects: [...current.objects, ...added] });
      setSelectedId(added.at(-1)?.id || null);
      notify(`Добавлено спрайтов: ${added.length}`);
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "Не удалось импортировать изображение");
    }
  };

  const deleteSelected = () => {
    if (!selected) return;
    pushUndo();
    const replacement = selected.parentId;
    const objects = preset.objects.filter((object) => object.id !== selected.id).map((object) => {
      let updated = object.parentId === selected.id ? setParent(object, replacement) : object;
      if (replacement && updated.script.includes(selected.id)) {
        updated = { ...updated, script: updated.script.replace(new RegExp(`\\b${selected.id}\\b`, "g"), replacement) };
      }
      return updated;
    });
    commit({ ...preset, objects }, false);
    setSelectedId(replacement || objects[0]?.id || null);
  };

  const duplicateSelected = () => {
    if (!selected) return;
    const id = uniqueId(preset.objects, selected.id);
    const copy: RigObject = {
      ...selected, id, name: `${selected.name} · копия`,
      base: { ...selected.base, x: selected.base.x + 24, y: selected.base.y + 24 },
      pivot: { ...selected.pivot },
    };
    commit({ ...preset, objects: [...preset.objects, copy] });
    setSelectedId(id);
  };

  const reparent = (id: string, parentId: string | null) => {
    if (id === parentId || (parentId && isDescendant(preset.objects, parentId, id))) {
      notify("Нельзя прикрепить объект к себе или своему потомку");
      return;
    }
    const object = preset.objects.find((item) => item.id === id);
    if (!object || object.parentId === parentId) return;
    commit({
      ...preset,
      objects: preset.objects.map((item) => item.id === id ? setParent(item, parentId) : item),
    });
  };

  /** Загрузка файла через input — путь для браузерного режима разработки. */
  const importPreset = async (file: File | undefined) => {
    if (!file) return;
    try {
      const parsed = normalizePreset(JSON.parse(await file.text()));
      if (!parsed) throw new Error("Это не пресет YappyTuberPlus версии 2");
      commit(withDemoMouth(parsed));
      setPresetPath(null);
      setSavedAt(null);
      setSelectedId(parsed.objects[0]?.id || null);
      notify("Пресет загружен из файла");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "Ошибка загрузки пресета");
    }
  };

  const resize = (key: "leftWidth" | "rightWidth" | "sceneHeight" | "rightEditorHeight", delta: number) => {
    setLayout((current) => {
      const limits = {
        leftWidth: [170, 460], rightWidth: [300, 760], sceneHeight: [200, Math.max(220, window.innerHeight - 285)], rightEditorHeight: [180, Math.max(200, window.innerHeight - 250)],
      } as const;
      const [min, max] = limits[key];
      return { ...current, [key]: Math.min(max, Math.max(min, current[key] + delta)) };
    });
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><div className="brand-mark"><Box size={19} /></div><div><b>YappyTuber<span>Plus</span></b><small>RIG STUDIO · MVP</small></div></div>
        <div className="topbar-divider" />
        <div className="preset-identity">
          <input value={preset.name} onChange={(event) => setPreset({ ...preset, name: event.target.value })} />
          <span>{preset.objects.length} объектов · v2</span>
        </div>
        <div className="history-actions">
          <button className="icon-button" title="Undo · Ctrl+Z" disabled={!undoStack.current.length} onClick={undo}><Undo2 size={16} /></button>
          <button className="icon-button" title="Redo · Ctrl+Shift+Z" disabled={!redoStack.current.length} onClick={redo}><Redo2 size={16} /></button>
        </div>
        <div className="topbar-spacer" />

        <div className="playback-controls">
          <button
            className={`icon-button playback ${paused ? "paused" : ""}`}
            title={paused ? "Продолжить · K" : "Пауза · K"}
            onClick={togglePause}
          >
            {paused ? <Play size={16} /> : <Pause size={16} />}
          </button>
          <button
            className={`icon-button stop ${stopped ? "active" : ""}`}
            title="Стоп: нейтральная поза для расстановки, состояние анимации сбрасывается · Shift+K"
            onClick={stopTimeline}
          >
            <Square size={13} fill={stopped ? "currentColor" : "none"} />
          </button>
        </div>
        <FpsControl
          mode={preset.runtime.fpsMode}
          limit={preset.runtime.fpsLimit}
          actual={engine.actualFps}
          onChange={(runtime) => setPreset({ ...preset, runtime })}
        />
        <div className={`engine-status ${engine.status}`} title={engine.error || engine.backendLabel}>
          <span /> <div><b>{engine.actualFps} FPS</b><small>{engine.backendLabel}</small></div>
        </div>
        <div className="topbar-actions">
          <button
            className={`icon-button overlay-button ${overlay.viewers.length ? "live" : ""}`}
            title={overlay.viewers.length ? `Оверлей подключён: ${overlay.viewers.length}` : "OBS-оверлей"}
            onClick={() => setOverlayOpen(true)}
          >
            <MonitorPlay size={16} />
            {overlay.viewers.length > 0 && <span className="overlay-badge">{overlay.viewers.length}</span>}
          </button>
          <button className="button secondary" title="Создать пустой пресет" onClick={newPreset}><FilePlus2 size={14} /> Создать</button>
          <button className="button secondary" title="Открыть файл пресета" onClick={() => void openFile()}><FolderOpen size={14} /> Открыть</button>
          <div className="split-button">
            <button className="button primary" title="Сохранить файл · Ctrl+S" onClick={() => void saveCurrent()}><Save size={14} /> Сохранить</button>
            <button className="button primary caret" title="Сохранить как… · Ctrl+Shift+S" onClick={() => void saveCurrentAs()}><ChevronDown size={13} /></button>
          </div>
        </div>
      </header>

      <div
        className={`workspace ${layout.leftCollapsed ? "left-collapsed" : ""} ${layout.rightCollapsed ? "right-collapsed" : ""}`}
        style={{
          gridTemplateColumns: `${layout.leftCollapsed ? 0 : layout.leftWidth}px ${layout.leftCollapsed ? 0 : 8}px minmax(300px, 1fr) ${layout.rightCollapsed ? 0 : 8}px ${layout.rightCollapsed ? 0 : layout.rightWidth}px`,
        }}
      >
        <div className="workspace-panel left-workspace"><TreePanel
          objects={preset.objects}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onImport={() => imageInput.current?.click()}
          onAddGroup={() => {
            const id = uniqueId(preset.objects, "group");
            commit({ ...preset, objects: [...preset.objects, makeGroup(id, "Новая группа")] });
            setSelectedId(id);
          }}
          onDelete={deleteSelected}
          onDuplicate={duplicateSelected}
          onToggleVisibility={(id) => {
            const object = preset.objects.find((item) => item.id === id);
            if (!object) return;
            const hidden = scriptValue(object.script, "visible") === "0" || object.base.visible === 0;
            updateObject({
              ...object,
              base: { ...object.base, visible: hidden ? 1 : 0 },
              script: setScriptValue(object.script, "visible", hidden ? (object.parentId ? "inherit" : "1") : "0"),
            });
          }}
          onReparent={reparent}
        /></div>
        <Splitter className="splitter-left" orientation="vertical" onDelta={(delta) => resize("leftWidth", delta)} onReset={() => setLayout((current) => ({ ...current, leftWidth: DEFAULT_LAYOUT.leftWidth }))} label="Ширина дерева объектов" />

        <main className="center-workspace" style={{ gridTemplateRows: `minmax(190px, ${Math.min(layout.sceneHeight, window.innerHeight - 285)}px) 8px minmax(150px, 1fr)` }}>
          <Scene
            preset={preset}
            frameRef={engine.frameRef}
            selectedId={selectedId}
            tool={tool}
            showGrid={showGrid}
            bounds={layout.showBounds}
            pivots={layout.showPivots}
            onTool={setTool}
            onToggleGrid={() => setShowGrid(!showGrid)}
            onCycleBounds={() => setLayout((current) => ({ ...current, showBounds: nextGuideMode(current.showBounds) }))}
            onCyclePivots={() => setLayout((current) => ({ ...current, showPivots: nextGuideMode(current.showPivots) }))}
            onSelect={setSelectedId}
            onDragStart={pushUndo}
            onDragObjects={(id, initial: Record<string, BasePose>, delta) => {
              setPreset((current) => {
                const subtree = descendantIds(current.objects, id);
                return {
                  ...current,
                  objects: current.objects.map((object) => subtree.has(object.id) && initial[object.id] ? {
                    ...object,
                    base: { ...object.base, x: initial[object.id].x + delta.x, y: initial[object.id].y + delta.y },
                  } : object),
                };
              });
            }}
            onPivot={(id, pivot) => {
              const object = preset.objects.find((item) => item.id === id);
              if (object) updateObject({ ...object, pivot });
            }}
          />
          <Splitter orientation="horizontal" onDelta={(delta) => resize("sceneHeight", delta)} onReset={() => setLayout((current) => ({ ...current, sceneHeight: DEFAULT_LAYOUT.sceneHeight }))} label="Высота сцены и инспектора" />
          <Inspector object={selected} objects={preset.objects} frame={engine.snapshot} onChange={updateObject} />
        </main>

        <Splitter className="splitter-right" orientation="vertical" onDelta={(delta) => resize("rightWidth", -delta)} onReset={() => setLayout((current) => ({ ...current, rightWidth: DEFAULT_LAYOUT.rightWidth }))} label="Ширина панели скрипта" />
        <div className="workspace-panel right-workspace"><RightPanel
          selected={selected}
          objects={preset.objects}
          globals={globalNames}
          globalScript={preset.globals}
          frame={engine.snapshot}
          engineError={engine.error}
          inputs={inputs}
          editorHeight={layout.rightEditorHeight}
          onEditorHeight={(delta) => resize("rightEditorHeight", delta)}
          onResetEditorHeight={() => setLayout((current) => ({ ...current, rightEditorHeight: DEFAULT_LAYOUT.rightEditorHeight }))}
          onObjectScript={(script) => { if (selected) updateObject({ ...selected, script }); }}
          onGlobalScript={(globals) => updateObjectScriptGlobals(globals)}
          onInputs={updateInputs}
        /></div>
      </div>

      <footer className="statusbar">
        <div className="status-left">
          <button className="status-collapse" onClick={() => setLayout((current) => ({ ...current, leftCollapsed: !current.leftCollapsed }))}>{layout.leftCollapsed ? <ChevronRight size={13} /> : <ChevronLeft size={13} />} Объекты</button>
          <button className="status-collapse" onClick={() => setLayout((current) => ({ ...current, rightCollapsed: !current.rightCollapsed }))}>Скрипт {layout.rightCollapsed ? <ChevronLeft size={13} /> : <ChevronRight size={13} />}</button>
          <span className="status-file" title={presetPath || "Файл ещё не сохранён"}>
            <Save size={11} /> {fileNameOf(presetPath) || "файл не сохранён"}
            {savedAt ? ` · ${savedAt}` : ""}
          </span>
          {stopped && <span className="status-stopped"><Square size={10} fill="currentColor" /> стоп · расстановка</span>}
          <span className={`status-message ${engine.status}`}>
            {engine.status === "error" ? <X size={12} /> : engine.status === "ready" ? <Check size={12} /> : <Gauge size={12} />}
            {engine.status === "error" ? engine.error : engine.status === "ready" ? `Кадр #${engine.snapshot?.seq || 0} · ${engine.snapshot?.time.toFixed(1) || "0.0"} c` : "Компиляция Rust-ядра…"}
          </span>
        </div>
        <div className="status-right">
          <button onClick={() => setOverlayOpen(true)} className={overlay.viewers.length ? "overlay-live" : undefined}><MonitorPlay size={12} /> Оверлей{overlay.viewers.length ? ` · ${overlay.viewers.length}` : ""}</button>
          <button onClick={() => { commit(createDemoPreset()); setSelectedId("head"); notify("Демо-риг восстановлен · Ctrl+Z для отмены"); }}><RotateCcw size={12} /> Демо</button>
          <span>{selectedId || "—"}</span><span>Windows · Tauri 2</span><b>MVP 0.1</b>
        </div>
      </footer>

      <input ref={imageInput} type="file" accept="image/png,image/webp" multiple hidden onChange={(event) => { void importSprites(event.target.files); event.target.value = ""; }} />
      <input ref={presetInput} type="file" accept=".json,.yappy.json,application/json" hidden onChange={(event) => { void importPreset(event.target.files?.[0]); event.target.value = ""; }} />
      {overlayOpen && <OverlayDialog
        config={overlayConfig}
        viewers={overlay.viewers}
        transport={overlay.transport}
        bridgeReady={overlay.bridgeReady}
        bridgeUrl={overlay.bridgeUrl}
        transportParam={new URLSearchParams(window.location.search).get("transport") || undefined}
        onChange={(patch) => commit({ ...presetRef.current, overlay: { ...(presetRef.current.overlay || overlayConfig), ...patch } }, false)}
        onClose={() => setOverlayOpen(false)}
        onNotify={notify}
      />}
      {toast && <div className="toast"><ImagePlus size={15} />{toast}</div>}
      <div className="mobile-warning">Для работы с ригом откройте редактор на широком экране.</div>
    </div>
  );

  function updateObjectScriptGlobals(globals: string) {
    commit({ ...presetRef.current, globals });
  }
}

function FpsControl({ mode, limit, actual, onChange }: {
  mode: "limited" | "display"; limit: number; actual: number;
  onChange: (runtime: RigPreset["runtime"]) => void;
}) {
  const [draft, setDraft] = useState(String(limit));
  useEffect(() => setDraft(String(limit)), [limit]);
  const apply = () => {
    const value = Number(draft);
    if (Number.isInteger(value) && value >= 1 && value <= 240) onChange({ fpsMode: mode, fpsLimit: value });
    else setDraft(String(limit));
  };
  return (
    <div className="fps-control" title={`Фактически: ${actual} FPS`}>
      <div className="segmented">
        <button className={mode === "limited" ? "active" : ""} onClick={() => onChange({ fpsMode: "limited", fpsLimit: limit })}>Лимит</button>
        <button className={mode === "display" ? "active" : ""} onClick={() => onChange({ fpsMode: "display", fpsLimit: limit })}>Экран</button>
      </div>
      <label className={mode === "display" ? "disabled" : ""} title="Лимит кадров в секунду: 1–240, применяется по Enter">
        <input
          type="number"
          min="1"
          max="240"
          value={draft}
          disabled={mode === "display"}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={apply}
          onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
        />
        <span>FPS</span>
      </label>
    </div>
  );
}

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error("Ошибка чтения файла"));
    reader.readAsDataURL(file);
  });
}
