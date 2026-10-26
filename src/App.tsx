import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Box, Check, ChevronDown, ChevronLeft, ChevronRight, FilePlus2, FolderOpen,
  Gauge, HardDrive, ImagePlus, MonitorPlay, Pause, Play, Redo2, RotateCcw, Save, Square,
  Undo2, X,
} from "lucide-react";
import { TreePanel } from "./components/TreePanel";
import { Scene, type SceneTool } from "./components/Scene";
import { Inspector } from "./components/Inspector";
import { RightPanel } from "./components/RightPanel";
import { Splitter } from "./components/Splitter";
import { OverlayDialog } from "./components/OverlayDialog";
import { ModuleApplyDialog } from "./components/ModuleApplyDialog";
import { FilesDialog } from "./components/FilesDialog";
import { createDemoPreset, createEmptyPreset, migrateDemoPreset } from "./data/demoPreset";
import {
  baseUpdates, groupSpot, isDescendant, makeGroup, makeMedia, makeShape, makeSprite, makeText,
  normalizeModules, normalizeOverlay, normalizePreset, parentNewObject, setParent, setScriptValue,
  uniqueId,
} from "./engine/preset";
import { inspectFile } from "./engine/importFile";
import { parseMaskBlock, writeMaskBlock } from "./engine/maskScript";
import {
  assetIdsOfPreset,
  ensureAssetsOfPreset,
  ensureAssetsOfPresetSettled,
  externalizePreset,
  pruneAssets,
} from "./engine/assets";
import { textChannel } from "./render/text";
import { History, type HistorySnapshot } from "./engine/history";
import { rangeIds, selectionRoots, subtreeIds, toggleId } from "./engine/selection";
import { propagateBase, repivot, reorderNeighbor, reorderObjects } from "./engine/structure";
import { useRigEngine } from "./engine/useRigEngine";
import { appendSnippet } from "./engine/scripts";
import {
  attachPresetDisk,
  fileNameOf,
  isTauri,
  openPresetFile,
  savePreset,
  savePresetAs,
} from "./engine/presetFile";
import { applyCaptureWindow, applyOverlayWindow } from "./overlay/window";
import { useOverlayHost } from "./hooks/useOverlayHost";
import { useModuleInputs } from "./hooks/useModuleInputs";
import { useModuleLibrary } from "./hooks/useModuleLibrary";
import {
  DEFAULT_LAYOUT, nextGuideMode, type BasePose, type EditorLayout,
  type ModuleInstance, type RigObject, type RigPreset, type Vec2, type WarpSpec,
} from "./types";

const PRESET_KEY = "yappytuberplus.preset.v2";
const LAYOUT_KEY = "yappytuberplus.layout.v1";
/**
 * Последний файл пресета: по нему на старте подключается папка `<имя>.assets`.
 * В самом пресете лежат только ссылки, поэтому путь к папке надо помнить.
 */
const PRESET_PATH_KEY = "yappytuberplus.preset.path.v1";

/** Как записывать изменение в историю: метка для подсказки и ключ склейки быстрых правок. */
interface CommitOptions { record?: boolean; label?: string; coalesce?: string }

/** Сообщение о сохранении: к нему добавляются объекты, чьи файлы потерялись. */
function withMissing(message: string, missing?: string[]): string {
  if (!missing?.length) return message;
  return `${message} · без файлов: ${missing.join(", ")}. Не нашлись ни в хранилище, ни в папке пресета — импортируйте их заново`;
}

function loadPreset(): RigPreset {
  try {
    const stored = localStorage.getItem(PRESET_KEY);
    if (stored) {
      const normalized = normalizePreset(JSON.parse(stored));
      // Presets saved before the closed mouth existed are migrated in place.
      if (normalized) return migrateDemoPreset(normalized);
    }
  } catch { /* use demo */ }
  return createDemoPreset();
}

function loadLayout(): EditorLayout {
  try {
    return { ...DEFAULT_LAYOUT, ...JSON.parse(localStorage.getItem(LAYOUT_KEY) || "{}") };
  } catch { return DEFAULT_LAYOUT; }
}

/** Ширина разделителя: она тоже занимает место в раскладке. */
const SPLITTER_WIDTH = 8;
/** Сколько места обязано остаться сцене: меньше — и рисовать негде. */
const SCENE_MIN = 300;

/**
 * Пределы панелей считаются от окна, а не берутся из головы: тянуть разделитель
 * можно до тех пор, пока сцена не упрётся в минимум. Иначе на узком экране
 * «максимальная» панель вылезала бы за границу и утаскивала раскладку вправо.
 */
function layoutLimits(layout: { leftWidth: number; rightWidth: number; leftCollapsed: boolean; rightCollapsed: boolean }) {
  const width = typeof window === "undefined" ? 1440 : window.innerWidth;
  const leftSplitter = layout.leftCollapsed ? 0 : SPLITTER_WIDTH;
  const rightSplitter = layout.rightCollapsed ? 0 : SPLITTER_WIDTH;
  const leftShown = layout.leftCollapsed ? 0 : layout.leftWidth;
  const rightShown = layout.rightCollapsed ? 0 : layout.rightWidth;
  const maxLeft = Math.max(170, width - SCENE_MIN - rightSplitter - rightShown);
  const maxRight = Math.max(300, width - SCENE_MIN - leftSplitter - leftShown);
  const height = typeof window === "undefined" ? 900 : window.innerHeight;
  return {
    leftWidth: [170, maxLeft] as const,
    rightWidth: [300, maxRight] as const,
    sceneHeight: [200, Math.max(220, height - 285)] as const,
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export default function App() {
  const [preset, setPreset] = useState<RigPreset>(loadPreset);
  const [selection, setSelection] = useState<string[]>(() => (preset.objects[0] ? [preset.objects[0].id] : []));
  const [renameId, setRenameId] = useState<string | null>(null);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [layout, setLayout] = useState<EditorLayout>(loadLayout);
  const [paused, setPaused] = useState(false);
  const [tool, setTool] = useState<SceneTool>("move");
  /**
   * Перо: контур фигуры, который сейчас рисуется на сцене. Состояние живёт
   * здесь, потому что его видят двое — сцена (клики) и инспектор (кнопка).
   */
  const [pen, setPen] = useState<{ objectId: string; itemId: string } | null>(null);
  const [showGrid, setShowGrid] = useState(true);
  const [overlayOpen, setOverlayOpen] = useState(false);
  /** Пресет, ждущий решения по модулям при открытии. */
  const [pending, setPending] = useState<{ preset: RigPreset; path: string | null } | null>(null);
  const [stopped, setStopped] = useState(false);
  const [presetPath, setPresetPath] = useState<string | null>(() => {
    try { return localStorage.getItem(PRESET_PATH_KEY); } catch { return null; }
  });
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  const notify = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);
  const presetRef = useRef(preset);
  const library = useModuleLibrary();
  const moduleInputs = useModuleInputs(preset.modules, library.version);
  // Пресет нормализуется до того, как прочитана папка modules, поэтому поля
  // настроек (режим, границы) дозаполняются один раз, когда шаблоны появились.
  const modulesNormalized = useRef(false);
  useEffect(() => {
    if (!library.ready || modulesNormalized.current) return;
    modulesNormalized.current = true;
    setPreset((current) => {
      const modules = normalizeModules(current.modules);
      return JSON.stringify(modules) === JSON.stringify(current.modules) ? current : { ...current, modules };
    });
  }, [library.ready]);
  /**
   * Файлы объектов — вне пресета (`src/engine/assets.ts`).
   *
   * На старте подключается папка последнего сохранённого пресета
   * (`<имя>.assets` рядом с файлом), затем data URL из автосохранения
   * переезжают в хранилище webview, а файлы, на которые больше никто не
   * ссылается, удаляются: история отмены в этот момент пуста, вернуть ссылку
   * на них уже нечем. Так автосохранение остаётся маленьким, а хранилище не
   * растёт вечно.
   */
  useEffect(() => {
    let active = true;
    void (async () => {
      await attachPresetDisk(presetPath);
      if (!active) return;
      const extracted = await externalizePreset(presetRef.current);
      if (!active) return;
      if (extracted.changed) setPreset(extracted.preset);
      ensureAssetsOfPreset(extracted.preset);
      const lost = await ensureAssetsOfPresetSettled(extracted.preset);
      if (lost.length && active) {
        notify(`Не нашлись файлы: ${lost.join(", ")}. Импортируйте их заново`);
      }
      await pruneAssets(assetIdsOfPreset(extracted.preset));
    })();
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Путь пресета запоминается: по нему на старте находится папка файлов. */
  useEffect(() => {
    try {
      if (presetPath) localStorage.setItem(PRESET_PATH_KEY, presetPath);
      else localStorage.removeItem(PRESET_PATH_KEY);
    } catch {
      // Приватный режим: путь просто не запомнится.
    }
  }, [presetPath]);

  const inputsRef = useRef(moduleInputs.inputs);
  const history = useRef(new History());
  const selectionRef = useRef(selection);
  const fileInput = useRef<HTMLInputElement>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  const presetInput = useRef<HTMLInputElement>(null);
  presetRef.current = preset;
  inputsRef.current = moduleInputs.inputs;
  selectionRef.current = selection;

  const overlay = useOverlayHost(preset);
  // Текстовый канал: последнее сообщение каждого модуля. Кадр получает уже
  // готовый текст, поэтому оверлею не нужен доступ к модулям.
  const textsRef = useRef<Record<string, { text: string; author?: string }>>({});
  const engineTexts = useMemo(() => textChannel(moduleInputs.externalTexts), [moduleInputs.externalTexts]);
  textsRef.current = engineTexts;
  const engine = useRigEngine(
    preset, inputsRef, paused || stopped, overlay.sinkRef, textsRef, moduleInputs.marks,
  );
  const overlayConfig = preset.overlay || normalizeOverlay(undefined);
  const primaryId = selection.at(-1) ?? null;
  const selected = preset.objects.find((object) => object.id === primaryId) || null;
  // Порядок важен: последний элемент — основной объект, его и показывает инспектор.
  const selectedObjects = selection
    .map((id) => preset.objects.find((object) => object.id === id))
    .filter((object): object is RigObject => !!object);
  const historyState = useMemo(() => ({
    canUndo: history.current.canUndo,
    canRedo: history.current.canRedo,
    undoLabel: history.current.undoLabel,
    redoLabel: history.current.redoLabel,
  }), [historyVersion]);
  const globalNames = preset.globals.split("\n").map((line) => line.match(/^\s*([A-Za-z0-9_]+)\s*=/)?.[1]).filter((name): name is string => !!name);

  const snapshot = useCallback((): HistorySnapshot => ({
    preset: presetRef.current,
    selection: selectionRef.current,
  }), []);

  const bumpHistory = useCallback(() => setHistoryVersion((value) => value + 1), []);

  /** Запомнить состояние перед изменением. */
  const pushUndo = useCallback((label = "Изменение", coalesce?: string) => {
    history.current.record(snapshot(), label, coalesce);
    bumpHistory();
  }, [snapshot, bumpHistory]);

  const commit = useCallback((
    next: RigPreset | ((current: RigPreset) => RigPreset),
    options: boolean | CommitOptions = true,
  ) => {
    const settings: CommitOptions = typeof options === "boolean" ? { record: options } : options;
    if (settings.record !== false) pushUndo(settings.label || "Изменение", settings.coalesce);
    setPreset(next);
  }, [pushUndo]);

  const applySnapshot = useCallback((value: HistorySnapshot) => {
    setPreset(value.preset);
    setSelection(value.selection.filter((id) => value.preset.objects.some((object) => object.id === id)));
    setRenameId(null);
    bumpHistory();
  }, [bumpHistory]);

  const undo = useCallback(() => {
    const previous = history.current.undo(snapshot());
    if (previous) applySnapshot(previous);
  }, [applySnapshot, snapshot]);

  const redo = useCallback(() => {
    const next = history.current.redo(snapshot());
    if (next) applySnapshot(next);
  }, [applySnapshot, snapshot]);

  const selectOnly = useCallback((id: string | null) => setSelection(id ? [id] : []), []);
  const toggleSelection = useCallback((id: string) => setSelection((current) => toggleId(current, id)), []);
  const selectRange = useCallback((ids: string[]) => setSelection(ids), []);
  const selectMany = useCallback((ids: string[], mode: "replace" | "add") => {
    setSelection((current) => (mode === "add"
      ? [...current.filter((id) => !ids.includes(id)), ...ids]
      : ids));
  }, []);

  const saveCurrent = useCallback(async () => {
    try {
      const result = await savePreset(presetRef.current, presetPath);
      if (result.downloaded) {
        notify(withMissing(
          "Браузерный режим: файл скачан. В приложении «Сохранить» перезаписывает файл на диске",
          result.missing,
        ));
        return;
      }
      setPresetPath(result.path);
      setSavedAt(new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }));
      notify(withMissing(`Сохранено: ${fileNameOf(result.path) || "пресет"}`, result.missing));
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "Не удалось сохранить пресет");
    }
  }, [notify, presetPath]);

  /**
   * Файлы, на которые ссылается сцена: по этому набору панель файлов понимает,
   * что можно убрать. Набор мемоизируется — иначе новый `Set` на каждый кадр
   * заставлял бы панель перечитывать хранилище.
   */
  const usedAssetIds = useMemo(() => assetIdsOfPreset(preset), [preset]);
  /** Сцена плюс снимки истории: файлы из-под Ctrl+Z уборка не трогает. */
  const keepAssetIds = useMemo(
    () => new Set([...usedAssetIds, ...history.current.assetIds()]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [usedAssetIds, historyState],
  );

  /** «Сохранить как…» всегда спрашивает папку и имя; в браузере такого диалога нет. */
  const saveCurrentAs = useCallback(async () => {
    if (!isTauri()) {
      notify("Выбор папки доступен в приложении. В браузере файл сохраняется кнопкой «Сохранить»");
      return;
    }
    try {
      const result = await savePresetAs(presetRef.current);
      setPresetPath(result.path);
      setSavedAt(new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }));
      notify(withMissing(`Сохранено как: ${fileNameOf(result.path) || "пресет"}`, result.missing));
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "Не удалось сохранить пресет");
    }
  }, [notify]);

  /**
   * Открывает пресет. Если набор модулей отличается от текущего, сначала
   * спрашиваем: применить модули пресета, оставить текущие или отключить все.
   */
  const applyOpenedPreset = useCallback((next: RigPreset, path: string | null) => {
    const incoming = next.modules;
    if (!sameModules(presetRef.current.modules, incoming)) {
      setPending({ preset: next, path });
      return;
    }
    commit(next, { label: "Открытие пресета" });
    setPresetPath(path);
    setSavedAt(null);
    setSelection(next.objects[0] ? [next.objects[0].id] : []);
  }, [commit]);

  const resolvePending = useCallback((choice: "apply" | "keep" | "disable") => {
    if (!pending) return;
    const modules = choice === "apply"
      ? pending.preset.modules
      : choice === "keep"
        ? presetRef.current.modules
        : [];
    const result: RigPreset = { ...pending.preset, modules };
    setPending(null);
    commit(result, {
      label: choice === "apply" ? "Модули пресета" : choice === "disable" ? "Модули отключены" : "Пресет с текущими модулями",
    });
    setPresetPath(pending.path);
    setSavedAt(null);
    setSelection(result.objects[0] ? [result.objects[0].id] : []);
    notify(choice === "apply"
      ? "Применены модули пресета"
      : choice === "disable"
        ? "Входы отключены: все значения нулевые"
        : "Оставлен текущий набор модулей");
  }, [pending, commit, notify]);

  const openFile = useCallback(async () => {
    if (!isTauri()) { presetInput.current?.click(); return; }
    try {
      const result = await openPresetFile();
      applyOpenedPreset(result.preset, result.path);
      notify(withMissing(`Открыт ${fileNameOf(result.path) || "пресет"}`, result.missing));
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      if (!/отмен/i.test(message)) notify(message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyOpenedPreset, notify]);

  const togglePause = useCallback(() => {
    setStopped(false);
    setPaused((value) => !value);
  }, []);

  /** Стоп: пауза + нейтральная поза + сброс состояния движка (smooth, spring, autoblink). */
  const stopTimeline = useCallback(() => {
    setStopped(true);
    setPaused(true);
    // Счётчики `hits` живут в состоянии ввода, а не в движке: их тоже обнуляем,
    // иначе после стопа счёт продолжается с прежнего числа.
    moduleInputs.resetPointerHits();
  }, [moduleInputs]);

  const newPreset = useCallback(() => {
    const empty = createEmptyPreset();
    commit(empty, { label: "Новый пресет" });
    setPresetPath(null);
    setSavedAt(null);
    setSelection([]);
    notify("Создан пустой пресет");
  }, [commit, notify]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try { localStorage.setItem(PRESET_KEY, JSON.stringify(preset)); }
      catch { notify("Не удалось автосохранить: превышена квота браузера"); }
    }, 700);
    return () => window.clearTimeout(timer);
  }, [preset, notify]);

  /**
   * Окно оверлея и окно захвата по умолчанию равны холсту, поэтому при смене
   * размера холста они должны переехать вместе с ним — иначе риг окажется
   * вписан в окно другого размера и «поедет» по масштабу.
   */
  useEffect(() => {
    void applyOverlayWindow(preset.overlay || normalizeOverlay(undefined), preset.canvas);
    void applyCaptureWindow(preset.overlay || normalizeOverlay(undefined), preset.canvas);
  }, [preset.canvas.width, preset.canvas.height, preset.overlay?.followCanvas]);

  useEffect(() => {
    overlay.setFrozen(stopped, presetRef.current);
    if (stopped) engine.resetTimeline();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopped]);

  useEffect(() => {
    const timer = window.setTimeout(() => localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)), 250);
    return () => window.clearTimeout(timer);
  }, [layout]);

  /** F2: переименование на месте в дереве, а если оно свёрнуто — в инспекторе. */
  const requestRename = useCallback((id: string | null) => {
    if (!id) return;
    if (layout.leftCollapsed) {
      const input = document.querySelector<HTMLInputElement>(".inspector-title input");
      if (input) { input.focus(); input.select(); return; }
    }
    setRenameId(id);
  }, [layout.leftCollapsed]);

  const renameObject = useCallback((id: string, name: string) => {
    const current = presetRef.current;
    const object = current.objects.find((item) => item.id === id);
    setRenameId(null);
    const trimmed = name.trim();
    if (!object || !trimmed || trimmed === object.name) return;
    commit({
      ...current,
      objects: current.objects.map((item) => (item.id === id ? { ...item, name: trimmed } : item)),
    }, { label: `Переименование «${object.name}»` });
  }, [commit]);

  /** Перестановка объектов в структуре: она же меняет порядок отрисовки при равном слое. */
  const reorderSelected = useCallback((ids: string[], targetId: string, position: "before" | "after") => {
    const current = presetRef.current;
    const objects = reorderObjects(current.objects, ids, targetId, position);
    if (objects === current.objects) return;
    commit({ ...current, objects }, { label: "Перестановка объектов" });
  }, [commit]);

  /** Сдвиг выделения на строку вверх/вниз (Alt+↑ / Alt+↓). */
  const moveSelected = useCallback((direction: -1 | 1) => {
    const current = presetRef.current;
    const neighbor = reorderNeighbor(current.objects, selectionRef.current, direction);
    if (neighbor) reorderSelected(selectionRef.current, neighbor.targetId, neighbor.position);
  }, [reorderSelected]);

  /**
   * Горячие клавиши. Сравниваем `event.code`, а не `event.key`: при русской
   * раскладке Ctrl+Z приходит как «я», и на `key` сочетания просто не срабатывают.
   */
  const deleteRef = useRef<() => void>(() => {});
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const editing = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || !!target.closest(".cm-editor");
      const command = event.ctrlKey || event.metaKey;
      if (command && event.code === "KeyS") {
        event.preventDefault();
        if (event.shiftKey) void saveCurrentAs(); else void saveCurrent();
        return;
      }
      if (editing) return;
      if (command && event.code === "KeyZ") {
        event.preventDefault();
        if (event.shiftKey) redo(); else undo();
      } else if (command && event.code === "KeyY") {
        event.preventDefault(); redo();
      } else if (event.key === "F2") {
        event.preventDefault();
        requestRename(selectionRef.current.at(-1) ?? null);
      } else if (event.altKey && event.code === "ArrowUp") {
        event.preventDefault();
        moveSelected(-1);
      } else if (event.altKey && event.code === "ArrowDown") {
        event.preventDefault();
        moveSelected(1);
      } else if (event.code === "Delete" || event.code === "Backspace") {
        // Delete и Backspace удаляют выделение; в полях ввода до этого места не доходит.
        event.preventDefault();
        deleteRef.current();
      } else if (!command && event.code === "KeyV") setTool("move");
      else if (!command && event.code === "KeyM") setTool("marquee");
      else if (!command && event.code === "KeyL") setTool("lasso");
      else if (!command && event.code === "KeyP") setTool("pivot");
      else if (!command && event.code === "KeyT") setTool("warp");
      else if (!command && event.code === "KeyK") {
        event.preventDefault();
        if (event.shiftKey) stopTimeline(); else togglePause();
      }
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [redo, undo, saveCurrent, saveCurrentAs, stopTimeline, togglePause, requestRename, moveSelected]);


  const updateObject = useCallback((next: RigObject, options: boolean | CommitOptions = true) => {
    // Маска живёт в скрипте объекта (управляемый блок), поэтому правка
    // настроек в инспекторе обязана переписать блок. Сравниваем по JSON:
    // точки — массив, по ссылке он меняется на каждой правке.
    const withMask = (() => {
      const before = JSON.stringify(next.mask ?? null);
      const after = JSON.stringify(parseMaskBlock(next.script) ?? null);
      return before === after ? next : { ...next, script: writeMaskBlock(next.script, next.mask) };
    })();
    commit((current) => {
      const previous = current.objects.find((object) => object.id === withMask.id);
      const objects = current.objects.map((object) => object.id === withMask.id ? withMask : object);
      // Поворот, масштаб и сдвиг родителя тянут за собой потомков — иначе
      // группа «отклеивается» от своих детей.
      const propagated = previous
        ? propagateBase(objects, withMask.id, previous.base, withMask.base)
        : objects;
      return { ...current, objects: propagated };
    }, options);
  }, [commit]);

  /**
   * Настройки текста из вкладки «Поведение»: шрифт, оформление и источник строки.
   * Один шаг истории на всю пачку — Ctrl+Z возвращает все объекты сразу.
   */
  const updateTextObjects = useCallback((next: RigObject[]) => {
    if (!next.length) return;
    commit((current) => {
      const byId = new Map(next.map((object) => [object.id, object]));
      return {
        ...current,
        objects: current.objects.map((object) => byId.get(object.id) ?? object),
      };
    }, { label: next.length > 1 ? `Текст · ${next.length} объектов` : "Текст", coalesce: "text-settings" });
  }, [commit]);

  /**
   * Правка пресета поведения сразу у нескольких объектов: один шаг истории на
   * всех, чтобы Ctrl+Z возвращал всю пачку, а не по одному объекту.
   */
  const updateScripts = useCallback((scripts: Record<string, string>) => {
    const ids = Object.keys(scripts);
    if (!ids.length) return;
    commit((current) => ({
      ...current,
      objects: current.objects.map((object) => (
        scripts[object.id] === undefined || scripts[object.id] === object.script
          ? object
          : { ...object, script: scripts[object.id] }
      )),
    }), { label: ids.length > 1 ? `Поведение · ${ids.length} объектов` : "Поведение", coalesce: "behaviour" });
  }, [commit]);

  /** Абсолютные значения базовой позы для всей выборки (инспектор при мультивыделении). */
  /**
   * Пивот — это база объекта, поэтому здесь не `updateObject`: он тянет детей
   * через `propagateBase`, а при перестановке пивота картинка и дети обязаны
   * остаться на месте. `repivot` сам решает, кого сдвинуть.
   */
  const pivotObject = useCallback((id: string, base: { x: number; y: number }, pivot: { x: number; y: number }) => {
    const frame = engine.snapshot;
    commit((current) => ({
      ...current,
      objects: repivot(current.objects, id, base, pivot, (objectId) => frame?.objects[objectId] ?? null),
    }), { label: "Пивот" });
  }, [commit, engine.snapshot]);

  /**
   * Деформация из сцены. Отдельную запись истории не создаёт: снимок для
   * отмены кладёт начало перетаскивания (`onDragStart`), и весь жест целиком
   * откатывается одним Ctrl+Z.
   */
  const warpObject = useCallback((id: string, warp: WarpSpec) => {
    setPreset((current) => ({
      ...current,
      objects: current.objects.map((object) => (object.id === id ? { ...object, warp } : object)),
    }));
  }, [setPreset]);

  const updateSelectedBases = useCallback((patch: Partial<BasePose>, coalesce = "multi-base") => {
    const current = presetRef.current;
    const ids = new Set(selectionRef.current);
    let objects = current.objects.map((object) => (ids.has(object.id)
      ? { ...object, base: { ...object.base, ...patch } }
      : object));
    // У каждого выделенного родителя потомки едут за его новой базой.
    for (const object of current.objects) {
      if (!ids.has(object.id)) continue;
      const nextBase = { ...object.base, ...patch };
      objects = propagateBase(objects, object.id, object.base, nextBase, ids);
    }
    commit({ ...current, objects }, { label: "Правка выделения", coalesce });
  }, [commit]);

  /** Относительный сдвиг всей выборки. */
  const offsetSelected = useCallback((delta: { x?: number; y?: number }) => {
    const current = presetRef.current;
    const ids = new Set(selectionRef.current);
    const shift = (base: BasePose): BasePose => ({ ...base, x: base.x + (delta.x || 0), y: base.y + (delta.y || 0) });
    let objects = current.objects.map((object) => (ids.has(object.id) ? { ...object, base: shift(object.base) } : object));
    // Сдвиг выделения тянет и потомков — как перетаскивание на сцене.
    for (const object of current.objects) {
      if (!ids.has(object.id)) continue;
      objects = propagateBase(objects, object.id, object.base, shift(object.base), ids);
    }
    commit({ ...current, objects }, { label: "Смещение выделения", coalesce: "multi-offset" });
  }, [commit]);

  const setSelectedLayer = useCallback((layer: number) => {
    const current = presetRef.current;
    const ids = new Set(selectionRef.current);
    commit({
      ...current,
      objects: current.objects.map((object) => (ids.has(object.id)
        ? { ...object, base: { ...object.base, layer }, script: setScriptValue(object.script, "layer", String(layer)) }
        : object)),
    }, { label: "Слой выделения", coalesce: "multi-layer" });
  }, [commit]);

  /** «Показать/скрыть все» в мультивыделении — тоже только флаг enabled. */
  const setSelectedVisible = useCallback((visible: number) => {
    const current = presetRef.current;
    const ids = new Set(selectionRef.current);
    commit({
      ...current,
      objects: current.objects.map((object) => (ids.has(object.id)
        ? { ...object, enabled: visible !== 0 }
        : object)),
    }, { label: visible ? "Показать выделение" : "Скрыть выделение" });
  }, [commit]);

  /** Модули живут в пресете, поэтому их правки попадают в историю. */
  const updateModules = useCallback((modules: ModuleInstance[], label?: string) => {
    const current = presetRef.current;
    commit({ ...current, modules }, { label: label || "Модули" });
  }, [commit]);

  /**
   * Импорт файлов: один вход для картинок, анимаций, видео и звука.
   *
   * Тип объекта определяется по самому файлу (`inspectFile`): обычная картинка
   * становится спрайтом, анимация, видео и звук — медиа-объектом с нужными
   * настройками воспроизведения. Отдельных кнопок «добавить видео» поэтому нет.
   */
  const importFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    pushUndo("Импорт файлов");
    const current = presetRef.current;
    // Все объекты встают в центр холста: раньше каждый следующий сдвигался на
    // 28 px, и пачка картинок уезжала по диагонали.
    const centerX = Math.round(current.canvas.width / 2);
    const centerY = Math.round(current.canvas.height / 2);
    const added: RigObject[] = [];
    const failed: string[] = [];
    try {
      for (const file of Array.from(files)) {
        // Плохой файл не отменяет пачку: остальные импортируются, а про этот
        // пользователь получает строку с причиной.
        const inspected = await inspectFile(file).catch((reason: unknown) => {
          failed.push(reason instanceof Error ? reason.message : `${file.name}: не удалось прочитать файл`);
          return null;
        });
        if (!inspected) continue;
        const id = uniqueId([...current.objects, ...added], inspected.name);
        if (inspected.kind === "media") {
          added.push(makeMedia(
            id, inspected.name,
            {
              src: inspected.src,
              type: inspected.mediaType ?? "image",
              fileName: file.name,
              loop: true,
              // Звук по умолчанию стартует сразу: так его слышно без скрипта,
              // а `pause()`/`stop()` и параметр `play` его останавливают.
              autoplay: inspected.mediaType === "audio",
            },
            inspected.width, inspected.height, centerX, centerY,
          ));
        } else {
          added.push(makeSprite(id, inspected.name, inspected.src, inspected.width, inspected.height, centerX, centerY));
        }
      }
      setPreset({ ...current, objects: parentNewObject([...current.objects, ...added], added, selectionRef.current) });
      const last = added.at(-1);
      setSelection(last ? [last.id] : []);
      const media = added.filter((object) => object.kind === "media").length;
      const summary = media === added.length
        ? `Добавлено медиа: ${media}`
        : `Добавлено объектов: ${added.length} (медиа: ${media})`;
      notify(failed.length ? `${summary} · не принято: ${failed.join("; ")}` : summary);
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "Не удалось импортировать файл");
    }
  };

  /** Текстовый объект: шаблон с подстановками из текстового канала. */
  const addText = () => {
    const current = presetRef.current;
    const id = uniqueId(current.objects, "text");
    const spot = groupSpot(current, selectionRef.current);
    const object = makeText(id, "Новый текст", { template: "Текст" }, 640, 160, spot.x, spot.y);
    const objects = parentNewObject([...current.objects, object], [object], selectionRef.current);
    commit({ ...current, objects }, { label: "Новый текст" });
    setSelection([id]);
  };

  /**
   * Объект-фигура: контуры, которые можно двигать и анимировать, и которыми
   * маскируются другие объекты. Рамка — 320×220, чтобы перо сразу было где
   * развернуться.
   */
  const addShape = () => {
    const current = presetRef.current;
    const id = uniqueId(current.objects, "shape");
    const spot = groupSpot(current, selectionRef.current);
    const object = makeShape(id, "Новая фигура", 320, 220, spot.x, spot.y);
    const objects = parentNewObject([...current.objects, object], [object], selectionRef.current);
    commit({ ...current, objects }, { label: "Новая фигура" });
    setSelection([id]);
  };

  /** Перо на сцене: точки контура правятся без отдельной истории на каждую. */
  const penPoints = useCallback((objectId: string, itemId: string, points: Vec2[]) => {
    const current = presetRef.current;
    const object = current.objects.find((item) => item.id === objectId);
    if (!object?.shape) return;
    const items = object.shape.items.map((item) => (item.id === itemId ? { ...item, points } : item));
    updateObject(
      { ...object, shape: { ...object.shape, items } },
      { label: "Контур фигуры", coalesce: "pen" },
    );
  }, [updateObject]);

  /** Удаление всей выборки: дети удалённых переезжают к ближайшему живому предку. */
  const deleteSelected = () => {
    const current = presetRef.current;
    const ids = selectionRef.current.filter((id) => current.objects.some((object) => object.id === id));
    if (!ids.length) return;
    const doomed = new Set(ids);
    const byId = new Map(current.objects.map((object) => [object.id, object]));
    const replacementOf = new Map<string, string | null>();
    for (const id of ids) {
      let parent = byId.get(id)?.parentId ?? null;
      const seen = new Set<string>();
      while (parent && doomed.has(parent) && !seen.has(parent)) {
        seen.add(parent);
        parent = byId.get(parent)?.parentId ?? null;
      }
      replacementOf.set(id, parent);
    }
    const objects = current.objects.filter((object) => !doomed.has(object.id)).map((object) => {
      let updated = object.parentId && doomed.has(object.parentId)
        ? setParent(object, replacementOf.get(object.parentId) ?? null)
        : object;
      // Маска на удалённую фигуру — ссылка в пустоту: объект снова виден целиком.
      if (updated.mask?.kind === "shape" && doomed.has(updated.mask.shapeId)) {
        updated = { ...updated, mask: undefined };
      }
      let script = updated.script;
      for (const [removed, replacement] of replacementOf) {
        if (!replacement || !script.includes(removed)) continue;
        script = script.replace(new RegExp(`\\b${removed}\\b`, "g"), replacement);
      }
      return script === updated.script ? updated : { ...updated, script };
    });
    pushUndo(ids.length > 1 ? `Удаление ${ids.length} объектов` : "Удаление");
    commit({ ...current, objects }, { record: false });
    const fallback = replacementOf.get(primaryId || "") ?? null;
    setSelection(fallback ? [fallback] : objects[0] ? [objects[0].id] : []);
  };
  // Delete объявлен ниже горячих клавиш, поэтому обработчик берёт его через ref.
  deleteRef.current = deleteSelected;

  /** Дублирование: копируется поддерево каждого корня выборки, копии встают рядом. */
  const duplicateSelected = () => {
    const current = presetRef.current;
    const roots = selectionRoots(current.objects, selectionRef.current);
    if (!roots.length) return;
    const moving = new Set<string>();
    for (const root of roots) for (const id of subtreeIds(current.objects, [root])) moving.add(id);
    let pool = [...current.objects];
    const created: { source: RigObject; copy: RigObject }[] = [];
    for (const object of current.objects) {
      if (!moving.has(object.id)) continue;
      const id = uniqueId(pool, object.id);
      const copy: RigObject = {
        ...object,
        id,
        name: `${object.name} · копия`,
        base: { ...object.base },
        pivot: { ...object.pivot },
        // Контуры и точки маски копируются вглубь: правка копии не должна
        // менять оригинал.
        shape: object.shape
          ? { ...object.shape, items: object.shape.items.map((item) => ({ ...item, points: [...item.points] })) }
          : undefined,
        mask: object.mask ? { ...object.mask, points: [...object.mask.points] } : undefined,
        // Зона и углы деформации — тоже вглубь: копия должна гнуться отдельно.
        warp: object.warp
          ? { ...object.warp, frame: { ...object.warp.frame }, corners: {
            tl: { ...object.warp.corners.tl }, tr: { ...object.warp.corners.tr },
            br: { ...object.warp.corners.br }, bl: { ...object.warp.corners.bl },
          } }
          : undefined,
      };
      pool = [...pool, copy];
      created.push({ source: object, copy });
    }
    const bySource = new Map(created.map((entry) => [entry.source.id, entry.copy]));
    for (const entry of created) {
      if (entry.source.parentId && bySource.has(entry.source.parentId)) {
        entry.copy.parentId = bySource.get(entry.source.parentId)!.id;
      }
    }
    for (const root of roots) {
      const copy = bySource.get(root);
      if (copy) copy.base = { ...copy.base, x: copy.base.x + 24, y: copy.base.y + 24 };
    }
    const objects = [...current.objects, ...created.map((entry) => entry.copy)];
    commit({ ...current, objects }, { label: roots.length > 1 ? "Дублирование выделения" : "Дублирование" });
    setSelection(roots.map((root) => bySource.get(root)!.id));
  };

  /**
   * Вложение и открепление работают со всей выборкой сразу: раньше перетаскивание
   * нескольких строк в группу переносило только последний объект, потому что
   * каждый вызов коммитил из одного и того же старого пресета.
   */
  const reparent = (ids: string[], parentId: string | null) => {
    const current = presetRef.current;
    const moving = new Set(ids.filter((id) => id !== parentId));
    if (moving.size !== ids.length) {
      notify("Нельзя прикрепить объект к себе");
      return;
    }
    for (const id of moving) {
      if (parentId && isDescendant(current.objects, parentId, id)) {
        notify("Нельзя прикрепить объект к своему потомку");
        return;
      }
    }
    let changed = false;
    const objects = current.objects.map((object) => {
      if (!moving.has(object.id) || object.parentId === parentId) return object;
      changed = true;
      return setParent(object, parentId);
    });
    if (!changed) return;
    commit({ ...current, objects }, { label: parentId ? "Вложение в группу" : "Открепление от группы" });
  };

  /** Загрузка файла через input — путь для браузерного режима разработки. */
  const importPreset = async (file: File | undefined) => {
    if (!file) return;
    try {
      const parsed = normalizePreset(JSON.parse(await file.text()));
      if (!parsed) throw new Error("Это не пресет YappyTuberPlus версии 2");
      // Файлы пресета распаковываются в хранилище: редактор работает со ссылками.
      const extracted = await externalizePreset(migrateDemoPreset(parsed));
      applyOpenedPreset(extracted.preset, null);
      notify("Пресет загружен из файла");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "Ошибка загрузки пресета");
    }
  };

  const resize = (key: "leftWidth" | "rightWidth" | "sceneHeight", delta: number) => {
    setLayout((current) => {
      const limits = layoutLimits(current);
      const [min, max] = limits[key];
      // Предел берётся от окна: панель не может вытолкнуть сцену и уехать за край.
      return { ...current, [key]: Math.min(max, Math.max(min, current[key] + delta)) };
    });
  };

  // Окно уменьшили — панели ужимаются вместе с ним, иначе правая уедет за
  // границу экрана и до неё будет не добраться.
  useEffect(() => {
    const fit = () => setLayout((current) => {
      const limits = layoutLimits(current);
      const next = {
        ...current,
        leftWidth: clamp(current.leftWidth, limits.leftWidth[0], limits.leftWidth[1]),
        rightWidth: clamp(current.rightWidth, limits.rightWidth[0], limits.rightWidth[1]),
        sceneHeight: clamp(current.sceneHeight, limits.sceneHeight[0], limits.sceneHeight[1]),
      };
      return next.leftWidth === current.leftWidth
        && next.rightWidth === current.rightWidth
        && next.sceneHeight === current.sceneHeight ? current : next;
    });
    window.addEventListener("resize", fit);
    fit();
    return () => window.removeEventListener("resize", fit);
  }, []);

  // Библиотека модулей читается из папки modules при старте. Ждём её, иначе
  // первый кадр ушёл бы в ядро без входов и завалил диагностику именами.
  if (!library.ready) {
    return (
      <div className="app-loading">
        <span>YappyTuber<span>Plus</span></span>
        <small>Загрузка модулей…</small>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><div className="brand-mark"><Box size={19} /></div><div><b>YappyTuber<span>Plus</span></b><small>RIG STUDIO · MVP</small></div></div>
        <div className="topbar-divider" />
        <div className="preset-identity">
          <input
            value={preset.name}
            onChange={(event) => commit({ ...presetRef.current, name: event.target.value }, { label: "Имя пресета", coalesce: "preset-name" })}
          />
          <span>{preset.objects.length} объектов · v2</span>
        </div>
        <div className="history-actions">
          <button
            className="icon-button"
            title={historyState.undoLabel ? `Отменить: ${historyState.undoLabel} · Ctrl+Z` : "Отменить · Ctrl+Z"}
            disabled={!historyState.canUndo}
            onClick={undo}
          ><Undo2 size={16} /></button>
          <button
            className="icon-button"
            title={historyState.redoLabel ? `Вернуть: ${historyState.redoLabel} · Ctrl+Y` : "Вернуть · Ctrl+Y"}
            disabled={!historyState.canRedo}
            onClick={redo}
          ><Redo2 size={16} /></button>
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
          onChange={(runtime) => commit({ ...presetRef.current, runtime }, { label: "Лимит FPS", coalesce: "fps" })}
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
          <button
            className="icon-button"
            title="Файлы объектов: хранилище картинок, видео и звука вне пресета"
            onClick={() => setFilesOpen(true)}
          >
            <HardDrive size={16} />
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
          selectedIds={selection}
          primaryId={primaryId}
          renamingId={renameId}
          onSelect={selectOnly}
          onToggleSelect={toggleSelection}
          onSelectRange={selectRange}
          onRename={renameObject}
          onRequestRename={requestRename}
          onRenameCancel={() => setRenameId(null)}
          onImport={() => fileInput.current?.click()}
          onAddText={addText}
          onAddShape={addShape}
          onAddGroup={() => {
            const current = presetRef.current;
            const id = uniqueId(current.objects, "group");
            const spot = groupSpot(current, selectionRef.current);
            const group = makeGroup(id, "Новая группа", spot.x, spot.y);
            const objects = parentNewObject([...current.objects, group], [group], selectionRef.current);
            commit({ ...current, objects }, { label: "Новая группа" });
            setSelection([id]);
          }}
          onDelete={deleteSelected}
          onDuplicate={duplicateSelected}
          onToggleVisibility={(id) => {
            const object = presetRef.current.objects.find((item) => item.id === id);
            if (!object) return;
            // Глаз гасит только собственный флаг enabled: видимость из скрипта не переписывается.
            updateObject(
              { ...object, enabled: object.enabled === false },
              { label: (object.enabled === false ? "Показать" : "Скрыть") + ` «${object.name}»` },
            );
          }}
          onReparent={reparent}
          onReorder={reorderSelected}
        /></div>
        <Splitter className="splitter-left" orientation="vertical" onDelta={(delta) => resize("leftWidth", delta)} onReset={() => setLayout((current) => ({ ...current, leftWidth: DEFAULT_LAYOUT.leftWidth }))} label="Ширина дерева объектов" />

        <main className="center-workspace" style={{ gridTemplateRows: `minmax(190px, ${Math.min(layout.sceneHeight, window.innerHeight - 285)}px) 8px minmax(150px, 1fr)` }}>
          <Scene
            preset={preset}
            frameRef={engine.frameRef}
            selectedIds={selection}
            primaryId={primaryId}
            tool={tool}
            showGrid={showGrid}
            ghosts={paused || stopped}
            bounds={layout.showBounds}
            pivots={layout.showPivots}
            texts={engineTexts}
            onDropFiles={(files) => { void importFiles(files); }}
            onTool={setTool}
            onToggleGrid={() => setShowGrid(!showGrid)}
            onCycleBounds={() => setLayout((current) => ({ ...current, showBounds: nextGuideMode(current.showBounds) }))}
            onCyclePivots={() => setLayout((current) => ({ ...current, showPivots: nextGuideMode(current.showPivots) }))}
            onCanvasSize={(width, height) => {
              const current = presetRef.current;
              if (current.canvas.width === width && current.canvas.height === height) return;
              // Окно оверлея по умолчанию равно холсту, поэтому в пресете держим
              // размер оверлея тем же: его видит и ссылка для OBS, и окно захвата.
              const overlay = current.overlay;
              const nextOverlay = overlay && overlay.followCanvas !== false
                ? { ...overlay, followCanvas: true, width, height }
                : overlay;
              commit({ ...current, canvas: { width, height }, overlay: nextOverlay }, { label: `Холст ${width} × ${height}` });
              notify(`Холст: ${width} × ${height}`);
            }}
            onSelect={(id, mode) => {
              if (mode === "toggle") toggleSelection(id!);
              else if (mode === "add") { if (id) selectMany([id], "add"); }
              else selectOnly(id);
            }}
            onSelectMany={selectMany}
            onDragStart={() => pushUndo("Перемещение")}
            onDragObjects={(ids, initial: Record<string, BasePose>, delta) => {
              const moving = new Set(subtreeIds(presetRef.current.objects, ids));
              setPreset((current) => ({
                ...current,
                objects: current.objects.map((object) => (moving.has(object.id) && initial[object.id] ? {
                  ...object,
                  base: { ...object.base, x: initial[object.id].x + delta.x, y: initial[object.id].y + delta.y },
                } : object)),
              }));
            }}
            onPivot={pivotObject}
            onWarp={warpObject}
            pen={pen}
            onPenPoints={penPoints}
          />
          <Splitter orientation="horizontal" onDelta={(delta) => resize("sceneHeight", delta)} onReset={() => setLayout((current) => ({ ...current, sceneHeight: DEFAULT_LAYOUT.sceneHeight }))} label="Высота сцены и инспектора" />
          <Inspector
            object={selected}
            selection={selectedObjects}
            objects={preset.objects}
            frame={engine.snapshot}
            onChange={updateObject}
            onSelect={selectOnly}
            onToggleSelect={toggleSelection}
            onBases={updateSelectedBases}
            onPivot={pivotObject}
            onOffset={offsetSelected}
            onLayer={setSelectedLayer}
            onVisible={setSelectedVisible}
            onDelete={deleteSelected}
            onDuplicate={duplicateSelected}
            pen={pen}
            onPen={setPen}
          />
        </main>

        <Splitter className="splitter-right" orientation="vertical" onDelta={(delta) => resize("rightWidth", -delta)} onReset={() => setLayout((current) => ({ ...current, rightWidth: DEFAULT_LAYOUT.rightWidth }))} label="Ширина панели скрипта" />
        <div className="workspace-panel right-workspace"><RightPanel
          selected={selected}
          selectedCount={selection.length}
          objects={preset.objects}
          globals={globalNames}
          globalScript={preset.globals}
          frame={engine.snapshot}
          engineError={engine.error}
          inputs={moduleInputs.inputs}
          modules={preset.modules}
          audio={moduleInputs.audio}
          manual={moduleInputs.manual}
          auto={moduleInputs.auto}
          devices={moduleInputs.devices}
          monitors={moduleInputs.monitors}
          audioError={moduleInputs.error}
          onObjectScript={(script) => {
            if (!selected) return;
            // Скрипт — истина для маски: правку блока в редакторе переносим
            // в настройки объекта. Нет блока — маски у объекта нет.
            updateObject({ ...selected, script, mask: parseMaskBlock(script) ?? undefined });
          }}
          selectedObjects={selectedObjects}
          onBehaviour={updateScripts}
          onText={updateTextObjects}
          onGlobalScript={(globals) => updateObjectScriptGlobals(globals)}
          onModules={updateModules}
          onManual={moduleInputs.setManual}
          onInsertSnippet={insertEventSnippet}
          checkScript={engine.checkScript}
          onSelectObject={selectOnly}
          calibrate={moduleInputs.calibrate}
          cancelCalibration={moduleInputs.cancelCalibration}
          externalStatuses={moduleInputs.externalStatuses}
          onAuthorizeSource={moduleInputs.authorizeSource}
          onSignOutSource={moduleInputs.signOutSource}
          externalLogs={moduleInputs.externalLogs}
          onProbeSource={moduleInputs.probeSource}
          externalTexts={moduleInputs.externalTexts}
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
          <button onClick={() => { commit(createDemoPreset(), { label: "Демо-риг" }); setSelection(["head"]); notify("Демо-риг восстановлен · Ctrl+Z для отмены"); }}><RotateCcw size={12} /> Демо</button>
          <span>{primaryId ? `${primaryId}${selection.length > 1 ? ` +${selection.length - 1}` : ""}` : "—"}</span><span>Windows · Tauri 2</span><b>MVP 0.1</b>
        </div>
      </footer>

      <input
        ref={fileInput}
        type="file"
        accept=".png,.jpg,.jpeg,.webp,.gif,.apng,.avif,.mp4,.webm,.mov,.mkv,.m4v,.mp3,.wav,.ogg,.m4a,.flac,.opus,.aac,image/*,video/*,audio/*"
        multiple
        hidden
        onChange={(event) => { void importFiles(event.target.files); event.target.value = ""; }}
      />
      <input ref={presetInput} type="file" accept=".json,.yappy.json,application/json" hidden onChange={(event) => { void importPreset(event.target.files?.[0]); event.target.value = ""; }} />
      {pending && <ModuleApplyDialog
        modules={pending.preset.modules}
        onApply={() => resolvePending("apply")}
        onKeep={() => resolvePending("keep")}
        onDisable={() => resolvePending("disable")}
      />}
      {filesOpen && <FilesDialog
        usedIds={usedAssetIds}
        keepIds={keepAssetIds}
        onClose={() => setFilesOpen(false)}
        onNotify={notify}
      />}
      {overlayOpen && <OverlayDialog
        config={overlayConfig}
        canvas={preset.canvas}
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

  /**
   * Вставка готового блока события из панели входов: в скрипт выбранного
   * объекта, а если ничего не выбрано — в глобальный скрипт.
   */
  function insertEventSnippet(snippet: string) {
    if (selected) {
      updateObject({ ...selected, script: appendSnippet(selected.script, snippet) }, { label: "Вставка события" });
    } else {
      updateObjectScriptGlobals(appendSnippet(presetRef.current.globals, snippet));
    }
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

/** Совпадают ли наборы модулей по именам и типам (настройки устройств не важны). */
function sameModules(a: ModuleInstance[], b: ModuleInstance[]): boolean {
  if (a.length !== b.length) return false;
  const key = (module: ModuleInstance) => `${module.name}:${module.type}`;
  const left = a.map(key).sort();
  const right = b.map(key).sort();
  return left.every((value, index) => value === right[index]);
}
