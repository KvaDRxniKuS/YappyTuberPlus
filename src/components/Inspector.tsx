import { useEffect, useRef, useState } from "react";
import {
  ChevronLeft, ChevronRight, Crosshair, Eye, EyeOff, ImageUp, Layers, Link2, Music, PenTool,
  RotateCcw, Shapes, Trash2, Type,
} from "lucide-react";
import type {
  BasePose, MaskKind, MaskSpec, MediaRepeat, MediaSpec, RigFrame, RigObject, ShapeItem,
  ShapeItemKind, ShapeSpec, TextSpec, Vec2, WarpCorner, WarpFrame, WarpSpec,
} from "../types";
import { MEDIA_REPEAT_LABEL } from "../render/media";
import { mediaTypeOf, normalizeMedia, normalizeText } from "../engine/preset";
import {
  defaultMask, defaultShape, formatPoints, makeItem, parsePoints, uniqueItemId,
} from "../render/shape";
import { setScriptValue } from "../engine/preset";
import { groupBounds } from "../render/bounds";
import { WARP_CORNERS, WARP_CORNER_LABEL, WARP_LIMIT, defaultWarp } from "../render/warp";
import { pivotBaseShift } from "../engine/structure";
import { useAssetUrl } from "../hooks/useAssets";
import { assetUrl, blobToDataUrl, storeFile } from "../engine/assets";
import { fileKind } from "../engine/importFile";
import { MaskSection } from "./MaskSection";
// Поле с подписью и шагом живёт в общем компоненте: им пользуются и вкладка
// «Объект», и вкладка «Фигура».
import { LabeledNumberField as NumberField } from "./NumberField";

interface InspectorProps {
  object: RigObject | null;
  selection: RigObject[];
  objects: RigObject[];
  frame: RigFrame | null;
  onChange: (object: RigObject) => void;
  onSelect: (id: string) => void;
  onToggleSelect: (id: string) => void;
  onBases: (patch: Partial<BasePose>, coalesce?: string) => void;
  /** Пивот — это база объекта: она переезжает, картинка и дети остаются на месте. */
  onPivot: (id: string, base: { x: number; y: number }, pivot: { x: number; y: number }) => void;
  onOffset: (delta: { x?: number; y?: number }) => void;
  onLayer: (layer: number) => void;
  onVisible: (visible: number) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  /** Перо: какой контур фигуры рисуется на сцене. */
  pen?: { objectId: string; itemId: string } | null;
  onPen?: (pen: { objectId: string; itemId: string } | null) => void;
}

/** Поле относительного сдвига: значение применяется по Enter и сразу очищается. */
function DeltaField({ label, onApply }: { label: string; onApply: (value: number) => void }) {
  const [draft, setDraft] = useState("");
  const apply = () => {
    const parsed = Number(draft);
    if (Number.isFinite(parsed) && parsed !== 0) onApply(parsed);
    setDraft("");
  };
  return (
    <label className="number-field">
      <span>{label}</span>
      <div><input
        type="number" value={draft} step={1} placeholder="0"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); apply(); } }}
        onBlur={apply}
      /><em>±</em></div>
    </label>
  );
}

export function Inspector(props: InspectorProps) {
  const { object, selection, objects, frame, onChange } = props;
  // Превью берёт готовый URL из хранилища файлов: ссылка `asset:<id>` читается
  // асинхронно, поэтому хуки стоят до ранних выходов и вызываются всегда.
  const preview = useAssetUrl(object?.image);
  const mediaPreview = useAssetUrl(object?.media?.src);
  // Понятная ошибка вместо исключения в консоли: «не тот файл» — обычный промах
  // мышью, а не повод ломать объект.
  const [imageError, setImageError] = useState<string | null>(null);
  // Поля замены картинки: хуки обязаны вызываться в каждом рендере, поэтому
  // стоят здесь, до ранних выходов «ничего не выбрано» и «выбрано несколько».
  // Ниже они читаются обработчиками уже с готовым объектом.
  const imageInput = useRef<HTMLInputElement>(null);
  const imageFit = useRef(false);

  if (selection.length > 1) return <MultiInspector {...props} />;

  if (!object) {
    return <section className="inspector panel-surface empty-state"><Crosshair size={25} /><p>Выберите объект на сцене или в дереве</p></section>;
  }
  const updateBase = (patch: Partial<BasePose>) => onChange({ ...object, base: { ...object.base, ...patch } });
  const parent = objects.find((item) => item.id === object.parentId);
  const dynamic = frame?.objects[object.id];

  /**
   * Пивот — это `base.x/base.y` у любого объекта, поэтому ввод в поля двигает
   * базу ровно настолько, чтобы картинка не дёрнулась: спрайт — на
   * `M · Δpivot · размер` (M — его матрица поворота/скоса/масштаба), группа — в
   * точку, которую задаёт доля 0..1 в её габаритах. Дети переставляются
   * отдельно (`repivot`), поэтому их картинка тоже остаётся на месте.
   */
  const groupBox = object.kind === "group" ? groupBounds({ objects }, object.id) : null;
  const groupRect = ((): { left: number; top: number; width: number; height: number } | null => {
    if (!groupBox) return null;
    const xs = groupBox.map((corner) => corner.x);
    const ys = groupBox.map((corner) => corner.y);
    const left = Math.min(...xs);
    const top = Math.min(...ys);
    return { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
  })();
  const groupFraction = groupRect && groupRect.width > 0 && groupRect.height > 0
    ? {
      x: (object.base.x - groupRect.left) / groupRect.width,
      y: (object.base.y - groupRect.top) / groupRect.height,
    }
    : object.pivot;
  const shownPivot = object.kind === "group" ? groupFraction : object.pivot;

  /**
   * Замена картинки у существующего спрайта.
   *
   * Без этого сломанный или устаревший PNG приходилось лечить «удалить и
   * импортировать заново», а вместе с объектом пропадали его скрипт, дети,
   * пивот и поведение. Здесь меняется только `image` — идентификатор, скрипты
   * и иерархия остаются прежними. Второй режим подгоняет `width/height` под
   * натуральный размер новой картинки: пивот при этом пересчитывается так,
   * чтобы прежняя точка привязки осталась на том же месте картинки.
   */
  /**
   * Замена картинки: файл уходит в хранилище webview, а в объекте остаётся
   * ссылка `asset:<id>`. При недоступном хранилище — data URL, как раньше.
   */
  const replaceImage = async (file: File) => {
    // Спрайт — только картинка. Видео и звук — это медиа-объект, у него свои
    // настройки, поэтому файл не подменяет картинку молча.
    if (await fileKind(file) !== "image") {
      setImageError(`«${file.name}» — не картинка. Видео, звук и анимацию добавляйте кнопкой «Файл» в структуре: получится медиа-объект.`);
      return;
    }
    const source = (await storeFile(file)) ?? (await blobToDataUrl(file));
    const probe = new Image();
    probe.onload = () => {
      setImageError(null);
      if (!imageFit.current || !probe.naturalWidth || !probe.naturalHeight) {
        onChange({ ...object, image: source });
        return;
      }
      const anchor = { x: object.pivot.x * object.width, y: object.pivot.y * object.height };
      onChange({
        ...object,
        image: source,
        width: probe.naturalWidth,
        height: probe.naturalHeight,
        pivot: { x: anchor.x / probe.naturalWidth, y: anchor.y / probe.naturalHeight },
      });
    };
    probe.onerror = () => {
      setImageError(`Не удалось прочитать картинку «${file.name}»: формат не поддерживается.`);
    };
    probe.src = assetUrl(source) ?? source;
  };

  const commitPivot = (next: { x: number; y: number }) => {
    // Фигура устроена как спрайт: контуры рисуются со сдвигом −pivot × размер,
    // поэтому пивот двигает базу ровно так же.
    if (object.kind === "sprite" || object.kind === "shape") {
      // Картинка спрайта рисуется со сдвигом −pivot × размер, поэтому база
      // уезжает на M · Δpivot · размер: пивот переезжает, картинка стоит.
      const shift = pivotBaseShift(object, dynamic, next);
      props.onPivot(object.id, { x: object.base.x + shift.x, y: object.base.y + shift.y }, next);
      return;
    }
    if (!groupRect || groupRect.width <= 0 || groupRect.height <= 0) {
      props.onPivot(object.id, { x: object.base.x, y: object.base.y }, next);
      return;
    }
    props.onPivot(object.id, {
      x: groupRect.left + next.x * groupRect.width,
      y: groupRect.top + next.y * groupRect.height,
    }, next);
  };

  return (
    <section className="inspector panel-surface">
      <div className="inspector-header">
        <div className={`inspector-preview ${object.kind}`}>
          {object.kind === "text" ? <Type size={20} />
            : object.kind === "shape" ? <Shapes size={20} />
            : object.kind === "media" ? (object.media?.type === "image" && mediaPreview
              ? <img src={mediaPreview} alt="" />
              : object.media?.type === "audio" ? <Music size={20} /> : <Link2 size={20} />)
            : preview ? <img src={preview} alt="" /> : <Link2 size={20} />}
        </div>
        <div className="inspector-title">
          <input
            value={object.name}
            title="F2 — переименовать"
            onChange={(event) => onChange({ ...object, name: event.target.value })}
          />
          <span>
            {object.id} · {object.kind === "group" ? "группа"
              : object.kind === "shape" ? `фигура · контуров ${object.shape?.items.length ?? 0}`
              : object.kind === "text" ? "текст"
              : object.kind === "media" ? `медиа · ${object.media?.type === "video" ? "видео" : object.media?.type === "audio" ? "звук" : "картинка"}`
              : `${object.width}×${object.height}`}
          </span>
        </div>
        <button className="icon-button" title="Сбросить трансформацию" onClick={() => updateBase({ rotation: 0, sizeX: 1, sizeY: 1, skewX: 0, skewY: 0 })}><RotateCcw size={15} /></button>
      </div>

      <div className="inspector-scroll">
        <div className="property-section">
          <div className="section-title"><span>Базовая поза</span><small>PIXELS</small></div>
          <div className="property-grid">
            <NumberField label="Позиция X" value={object.base.x} step={1} onCommit={(x) => updateBase({ x })} />
            <NumberField label="Позиция Y" value={object.base.y} step={1} onCommit={(y) => updateBase({ y })} />
            <NumberField label="Поворот" value={object.base.rotation} step={1} suffix="°" onCommit={(rotation) => updateBase({ rotation })} />
            {/* Порядок в сетке: позиция, поворот, масштаб — и «Слой» третьим в
                своей строке. Сетка трёхколоночная, поэтому масштаб встаёт
                ровно под позицией, а слой — под поворотом. */}
            <NumberField label="Масштаб X" value={object.base.sizeX} step={0.05} onCommit={(sizeX) => updateBase({ sizeX })} />
            <NumberField label="Масштаб Y" value={object.base.sizeY} step={0.05} onCommit={(sizeY) => updateBase({ sizeY })} />
            <NumberField
              className="field-layer"
              label="Слой"
              value={object.base.layer}
              step={1}
              onCommit={(layer) => {
                onChange({ ...object, base: { ...object.base, layer }, script: setScriptValue(object.script, "layer", String(layer)) });
              }}
            />
          </div>
          <label className="range-property">
            <span>Непрозрачность <b>{Math.round(object.base.opacity * 100)}%</b></span>
            <input type="range" min="0" max="1" step="0.01" value={object.base.opacity} onChange={(event) => updateBase({ opacity: Number(event.target.value) })} />
          </label>
        </div>

        {object.kind === "sprite" && (
          <div className="property-section compact-section">
            <div className="section-title"><span>Картинка</span><small>PNG / WEBP</small></div>
            <div className="image-actions">
              <button
                className="button secondary"
                title="Заменить картинку, сохранив размеры и точку привязки"
                onClick={() => { imageFit.current = false; imageInput.current?.click(); }}
              >
                <ImageUp size={14} /> Заменить
              </button>
              <button
                className="button secondary"
                title="Заменить картинку и взять её натуральный размер; прежняя точка привязки останется на месте"
                onClick={() => { imageFit.current = true; imageInput.current?.click(); }}
              >
                Заменить и подогнать размер
              </button>
            </div>
            <input
              ref={imageInput}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/avif,.png,.jpg,.jpeg,.webp,.avif"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void replaceImage(file);
              }}
            />
            {imageError && <p className="inline-error">{imageError}</p>}
          </div>
        )}

        {object.kind === "media" && (
          <MediaSection
            object={object}
            media={object.media ?? normalizeMedia(undefined)}
            onChange={onChange}
          />
        )}

        {object.kind === "text" && (
          <TextSection
            object={object}
            text={object.text ?? normalizeText(undefined)}
            onChange={onChange}
          />
        )}

        {(object.kind === "sprite" || object.kind === "media") && (
          <WarpSection object={object} warp={object.warp} onChange={onChange} />
        )}

        {object.kind !== "group" && object.kind !== "shape" && (
          <MaskSection object={object} mask={object.mask} objects={objects} onChange={onChange} />
        )}

        <div className="property-section compact-section">
          <div className="section-title">
            <span>Пивот</span>
            <small>{object.kind === "group" ? "ТОЧКА ВРАЩЕНИЯ" : "UV"}</small>
          </div>
          <div className="property-grid two-columns">
            <NumberField label="Pivot X" value={shownPivot.x} step={0.01} onCommit={(x) => commitPivot({ ...shownPivot, x })} />
            <NumberField label="Pivot Y" value={shownPivot.y} step={0.01} onCommit={(y) => commitPivot({ ...shownPivot, y })} />
          </div>
          {object.kind === "group" && (
            <p className="behaviour-hint">
              У группы нет картинки, её «картинка» — дети, поэтому пивот группы и есть точка
              вращения: числа задают её место внутри габаритов группы (0.5 / 0.5 — центр), дети при
              этом остаются на месте, а вращение и «Физика поворота» считаются от неё. То же самое
              делает инструмент <b>Пивот (P)</b> кликом по группе.
            </p>
          )}
        </div>

        <div className="runtime-readout">
          <div><span>Родитель</span><b>{parent?.name || "Корень сцены"}</b></div>
          {dynamic && <div><span>Кадр</span><b>x {dynamic.x.toFixed(2)} · y {dynamic.y.toFixed(2)} · r {dynamic.rotation.toFixed(2)}°</b></div>}
        </div>
      </div>
    </section>
  );
}

const MEDIA_REPEATS: MediaRepeat[] = ["restart", "fade", "overlay", "finish"];
const MEDIA_ACCEPT = ".png,.jpg,.jpeg,.webp,.gif,.apng,.avif,.mp4,.webm,.mov,.mkv,.m4v,.mp3,.wav,.ogg,.m4a,.flac,.opus,.aac,image/*,video/*,audio/*";

/** Медиа-объект: файл, повтор, громкость, скорость и политика повтора. */
function MediaSection({ object, media, onChange }: {
  object: RigObject;
  media: MediaSpec;
  onChange: (object: RigObject) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const update = (patch: Partial<MediaSpec>) => onChange({ ...object, media: { ...media, ...patch } });
  /** Замена файла: байты — в хранилище webview, в объекте остаётся ссылка. */
  const replace = async (file: File) => {
    const kind = await fileKind(file);
    if (!kind) {
      setError(`«${file.name}» — не картинка, не видео и не звук`);
      return;
    }
    setError(null);
    const src = (await storeFile(file)) ?? (await blobToDataUrl(file));
    update({ src, type: kind, fileName: file.name });
  };
  return (
    <>
      <div className="property-section compact-section">
        <div className="section-title"><span>Файл</span><small>{media.type === "video" ? "ВИДЕО" : media.type === "audio" ? "ЗВУК" : "КАРТИНКА"}</small></div>
        <p className="behaviour-hint media-file" title={media.fileName || "файл не выбран"}>
          {media.fileName || "Файл не выбран: добавьте картинку, видео или звук"}
        </p>
        <div className="image-actions">
          <button className="button secondary" onClick={() => fileInput.current?.click()}>
            <ImageUp size={14} /> {media.src ? "Заменить файл" : "Выбрать файл"}
          </button>
        </div>
        {error && <p className="inline-error">{error}</p>}
        <input
          ref={fileInput}
          type="file"
          accept={MEDIA_ACCEPT}
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void replace(file);
          }}
        />
        <div className="property-grid two-columns">
          <NumberField label="Ширина" value={object.width} step={1} onCommit={(width) => onChange({ ...object, width: Math.max(1, width) })} />
          <NumberField label="Высота" value={object.height} step={1} onCommit={(height) => onChange({ ...object, height: Math.max(1, height) })} />
        </div>
        <label className="check-line">
          <input type="checkbox" checked={media.loop} onChange={(event) => update({ loop: event.target.checked })} />
          <span>Зациклить</span>
        </label>
        <label className="check-line">
          <input type="checkbox" checked={media.autoplay} onChange={(event) => update({ autoplay: event.target.checked })} />
          <span>Играть сразу после запуска</span>
        </label>
        {media.type === "video" && (
          <label className="check-line">
            <input type="checkbox" checked={media.muted} onChange={(event) => update({ muted: event.target.checked })} />
            <span>Без звука</span>
          </label>
        )}
      </div>

      <div className="property-section compact-section">
        <div className="section-title"><span>Воспроизведение</span><small>ОСНОВА</small></div>
        <label className="range-property">
          <span>Громкость <b>{Math.round(media.volume * 100)}%</b></span>
          <input
            type="range" min="0" max="1" step="0.01" value={media.volume}
            onChange={(event) => update({ volume: Number(event.target.value) })}
          />
        </label>
        <div className="property-grid two-columns">
          <NumberField label="Скорость" value={media.speed} step={0.1} suffix="×" onCommit={(speed) => update({ speed: Math.min(4, Math.max(0.1, speed)) })} />
        </div>
        <label className="select-property">
          <span>При повторной активации</span>
          <select value={media.repeat} onChange={(event) => update({ repeat: event.target.value as MediaRepeat })}>
            {MEDIA_REPEATS.map((value) => <option key={value} value={value}>{MEDIA_REPEAT_LABEL[value]}</option>)}
          </select>
        </label>
        {media.repeat === "fade" && (
          <NumberField label="Затухание" value={media.fade} step={0.05} suffix="с" onCommit={(fade) => update({ fade: Math.min(10, Math.max(0, fade)) })} />
        )}
        {media.repeat === "overlay" && (
          <NumberField label="Копий звука" value={media.voices} step={1} onCommit={(voices) => update({ voices: Math.min(8, Math.max(1, Math.round(voices))) })} />
        )}
        <p className="behaviour-hint">
          В скрипте: <b>play()</b> — с начала, <b>seek(сек)</b> — перемотка,
          <b> pause()</b>, <b>stop()</b>, <b>rate(×)</b>, <b>volume(0..1)</b>; чужой объект
          указывается первым аргументом: <b>play("дождь")</b>. Параметры <b>play</b>,
          <b> speed</b> и <b>volume</b> — обычные формулы.
        </p>
      </div>
    </>
  );
}

/**
 * Деформация крайних точек.
 *
 * Зона — прямоугольник внутри картинки: его можно повернуть и сузить, чтобы
 * гнуть не всю картинку, а нужный кусок. Углы задаются процентами размера
 * зоны, поэтому при смене размера объекта перспектива остаётся такой же.
 */
function WarpSection({ object, warp, onChange }: {
  object: RigObject;
  warp: WarpSpec | undefined;
  onChange: (object: RigObject) => void;
}) {
  const spec = warp ?? defaultWarp();
  const update = (patch: Partial<WarpSpec>) => onChange({ ...object, warp: { ...spec, ...patch } });
  const setFrame = (patch: Partial<WarpFrame>) => update({ frame: { ...spec.frame, ...patch } });
  const setCorner = (corner: WarpCorner, patch: Partial<Vec2>) => update({
    corners: { ...spec.corners, [corner]: { ...spec.corners[corner], ...patch } },
  });
  // Доли картинки показываем процентами: так числа читаются без калькулятора.
  const percent = (value: number) => Math.round(value * 1000) / 10;
  const fromPercent = (value: number) => Math.round((value / 100) * 10000) / 10000;
  const reset = () => onChange({ ...object, warp: { ...defaultWarp(), enabled: spec.enabled } });

  return (
    <div className="property-section compact-section">
      <div className="section-title">
        <span>Деформация</span>
        <small>{spec.enabled ? "ПЕРСПЕКТИВА" : "ВЫКЛ"}</small>
      </div>
      <label className="check-line">
        <input type="checkbox" checked={spec.enabled} onChange={(event) => update({ enabled: event.target.checked })} />
        <span>Гнуть крайние точки</span>
      </label>

      {spec.enabled && (
        <>
          <div className="section-title"><span>Зона деформации</span><small>% КАРТИНКИ</small></div>
          <div className="property-grid two-columns">
            <NumberField label="Зона X" value={percent(spec.frame.x)} step={1} suffix="%" onCommit={(value) => setFrame({ x: fromPercent(value) })} />
            <NumberField label="Зона Y" value={percent(spec.frame.y)} step={1} suffix="%" onCommit={(value) => setFrame({ y: fromPercent(value) })} />
            <NumberField label="Ширина" value={percent(spec.frame.width)} step={1} suffix="%" onCommit={(value) => setFrame({ width: Math.max(0.01, fromPercent(value)) })} />
            <NumberField label="Высота" value={percent(spec.frame.height)} step={1} suffix="%" onCommit={(value) => setFrame({ height: Math.max(0.01, fromPercent(value)) })} />
            <NumberField label="Поворот" value={Math.round(spec.frame.rotation * 10) / 10} step={1} suffix="°" onCommit={(rotation) => setFrame({ rotation })} />
          </div>
          <p className="behaviour-hint">
            Зона — часть картинки, которую гнём: остальное остаётся ровным.
            Границы удобнее править в сцене: инструмент «Границы текстуры» (T).
          </p>

          <div className="section-title"><span>Углы</span><small>% ЗОНЫ</small></div>
          <div className="property-grid two-columns">
            {WARP_CORNERS.map((corner) => (
              <div key={corner} className="warp-corner">
                <span className="warp-corner-label">{WARP_CORNER_LABEL[corner]}</span>
                <NumberField
                  label={`${corner.toUpperCase()} X`}
                  value={Math.round(spec.corners[corner].x * 10) / 10}
                  step={1}
                  suffix="%"
                  onCommit={(x) => setCorner(corner, { x: Math.max(-WARP_LIMIT, Math.min(WARP_LIMIT, x)) })}
                />
                <NumberField
                  label={`${corner.toUpperCase()} Y`}
                  value={Math.round(spec.corners[corner].y * 10) / 10}
                  step={1}
                  suffix="%"
                  onCommit={(y) => setCorner(corner, { y: Math.max(-WARP_LIMIT, Math.min(WARP_LIMIT, y)) })}
                />
              </div>
            ))}
          </div>
          <div className="image-actions">
            <button className="button secondary" onClick={reset}><RotateCcw size={14} /> Сбросить углы</button>
          </div>
          <p className="behaviour-hint">
            Углы можно анимировать: параметры `warpTLx`, `warpTLy`, `warpTRx`…
            читаются в скрипте объекта так же, как `x` или `rotation`.
          </p>
        </>
      )}
    </div>
  );
}

/** Текстовый объект: шаблон, шрифт и подстановки из чата. */
function TextSection({ object, text, onChange }: {
  object: RigObject;
  text: TextSpec;
  onChange: (object: RigObject) => void;
}) {
  const update = (patch: Partial<TextSpec>) => onChange({ ...object, text: { ...text, ...patch } });
  return (
    <div className="property-section compact-section">
      <div className="section-title"><span>Текст</span><small>{"{МОДУЛЬ}.MESSAGE / .USER"}</small></div>
      <label className="text-property">
        <span>Шаблон</span>
        <textarea
          rows={3}
          value={text.template}
          placeholder="{twitch.chat.user}: {twitch.chat.message}"
          onChange={(event) => update({ template: event.target.value })}
        />
      </label>
      <div className="property-grid two-columns">
        <NumberField label="Размер" value={text.size} step={2} suffix="px" onCommit={(size) => update({ size: Math.min(400, Math.max(4, size)) })} />
        <NumberField label="Ширина рамки" value={object.width} step={10} onCommit={(width) => onChange({ ...object, width: Math.max(1, width) })} />
      </div>
      <div className="property-grid two-columns">
        <label className="number-field">
          <span>Шрифт</span>
          <div><input value={text.font} onChange={(event) => update({ font: event.target.value })} /></div>
        </label>
        <label className="number-field">
          <span>Цвет</span>
          <div><input type="color" value={text.color} onChange={(event) => update({ color: event.target.value })} /></div>
        </label>
      </div>
      <label className="select-property">
        <span>Выравнивание</span>
        <select value={text.align} onChange={(event) => update({ align: event.target.value as TextSpec["align"] })}>
          <option value="left">по левому краю</option>
          <option value="center">по центру</option>
          <option value="right">по правому краю</option>
        </select>
      </label>
      <label className="check-line">
        <input type="checkbox" checked={text.bold} onChange={(event) => update({ bold: event.target.checked })} />
        <span>Полужирный</span>
      </label>
      <label className="check-line">
        <input type="checkbox" checked={text.italic} onChange={(event) => update({ italic: event.target.checked })} />
        <span>Курсив</span>
      </label>
      <div className="property-grid two-columns">
        <NumberField label="Обводка" value={text.strokeWidth} step={1} suffix="px" onCommit={(strokeWidth) => update({ strokeWidth: Math.min(24, Math.max(0, strokeWidth)) })} />
        <label className="number-field">
          <span>Цвет обводки</span>
          <div><input type="color" value={text.strokeColor} onChange={(event) => update({ strokeColor: event.target.value })} /></div>
        </label>
      </div>
      <p className="behaviour-hint">
        Шаблон — текст по умолчанию, пока скрипт не задал свой. Скрипт объекта пишет
        переменную <b>{'text = "привет"'}</b> — это база: считается каждый кадр, поэтому годится
        формула <b>{"text = text(mic.db)"}</b>. Присваивание внутри блока события
        (<b>{'on mic.db.change { text = "пока" }'}</b>) переопределяет текст до «Стопа» — после
        него снова видна база. Подстановки чата работают в шаблоне и в скриптовой строке:
        <b>{"{twitch.chat.message}"}</b>, <b>{"{twitch.chat.user}"}</b>; чтобы скобки были видны
        буквально, оберните ссылку в одинарные кавычки — <b>{"'{twitch.chat.user}'"}</b>.
      </p>
    </div>
  );
}

/** Инспектор при мультивыделении: список, относительный сдвиг и общие свойства. */
function MultiInspector(props: InspectorProps) {
  const { selection, onBases, onOffset, onLayer, onVisible, onSelect, onToggleSelect } = props;
  const primary = selection[selection.length - 1];
  return (
    <section className="inspector panel-surface">
      <div className="inspector-header">
        <div className="inspector-preview group"><Layers size={20} /></div>
        <div className="inspector-title">
          <b className="inspector-title-static">Выделено {selection.length}</b>
          <span>Ctrl+клик — убрать, F2 — переименовать основной</span>
        </div>
      </div>

      <div className="inspector-scroll">
        <div className="property-section">
          <div className="section-title"><span>Выделение</span><small>ОСНОВНОЙ — ПОСЛЕДНИЙ</small></div>
          <div className="multi-list">
            {selection.map((item) => (
              <button
                key={item.id}
                className={`multi-item ${item.id === primary.id ? "primary" : ""}`}
                title="Сделать основным · Ctrl+клик — убрать из выборки"
                onClick={(event) => {
                  if (event.ctrlKey || event.metaKey) onToggleSelect(item.id);
                  else onSelect(item.id);
                }}
              >
                <span className={`multi-dot ${item.kind}`} />
                <span className="multi-name">{item.name}</span>
                <i>{item.kind === "group" ? "группа" : item.kind === "shape" ? "фигура" : `${item.width}×${item.height}`}</i>
              </button>
            ))}
          </div>
        </div>

        <div className="property-section">
          <div className="section-title"><span>Смещение</span><small>ОТНОСИТЕЛЬНО</small></div>
          <div className="property-grid two-columns">
            <DeltaField label="Сдвиг X" onApply={(x) => onOffset({ x })} />
            <DeltaField label="Сдвиг Y" onApply={(y) => onOffset({ y })} />
          </div>
          <p className="hint">Введите значение и нажмите Enter — сдвинутся все выделенные.</p>
        </div>

        <div className="property-section">
          <div className="section-title"><span>Общие свойства</span><small>ДЛЯ ВСЕХ</small></div>
          <div className="property-grid">
            <NumberField label="Слой" value={primary.base.layer} step={1} onCommit={onLayer} />
            <NumberField label="Масштаб X" value={primary.base.sizeX} step={0.05} onCommit={(sizeX) => onBases({ sizeX })} />
            <NumberField label="Масштаб Y" value={primary.base.sizeY} step={0.05} onCommit={(sizeY) => onBases({ sizeY })} />
            <NumberField label="Поворот" value={primary.base.rotation} step={1} suffix="°" onCommit={(rotation) => onBases({ rotation })} />
          </div>
          <label className="range-property">
            <span>Непрозрачность <b>{Math.round(primary.base.opacity * 100)}%</b></span>
            <input
              type="range" min="0" max="1" step="0.01" value={primary.base.opacity}
              onChange={(event) => onBases({ opacity: Number(event.target.value) }, "multi-opacity")}
            />
          </label>
          <div className="multi-actions">
            <button onClick={() => onVisible(1)}><Eye size={14} /> Показать все</button>
            <button onClick={() => onVisible(0)}><EyeOff size={14} /> Скрыть все</button>
          </div>
        </div>

        <div className="runtime-readout">
          <div><span>Выделено</span><b>{selection.length}</b></div>
          <div><span>Основной</span><b>{primary.id}</b></div>
        </div>
      </div>
    </section>
  );
}
