import { useRef, useState } from "react";
import { ImageUp, Lightbulb, Sparkles, Trash2 } from "lucide-react";
import type { LightShape, LightSpec, NormalMapSpec, RigObject } from "../types";
import { DEFAULT_LIGHT } from "../types";
import {
  LIGHT_SHAPES, alphaOf, lightBounds, normalizeLight, solidOf, withAlpha,
} from "../render/light";
import { blobToDataUrl, storeFile } from "../engine/assets";
import { fileKind } from "../engine/importFile";
import { useAssetUrl } from "../hooks/useAssets";
// Поле с подписью и шагом живёт в общем компоненте: им пользуются и вкладка
// «Объект», и вкладка «Фигура».
import { LabeledNumberField as NumberField } from "./NumberField";

/**
 * Освещение во вкладке «Объект».
 *
 * Здесь только то, что описывает пятно: форма, радиус, цвета и наложение.
 * Позиция, слой, прозрачность, маска и всё «Поведение» — обычные, как у любого
 * объекта, поэтому мерцание и «свет только когда говорю» — это формулы в
 * скрипте, а не отдельный набор полей.
 */
export function LightSection({ object, light, canvas, onChange }: {
  object: RigObject;
  light: LightSpec;
  canvas: { width: number; height: number };
  onChange: (object: RigObject) => void;
}) {
  /**
   * Правка пятна меняет и рамку объекта: ширина с высотой всегда равны
   * диаметру, иначе выделение, поворот и маска жили бы отдельно от света.
   */
  const update = (patch: Partial<LightSpec>) => {
    const next = normalizeLight({ ...light, ...patch });
    const bounds = lightBounds(next, canvas);
    onChange({ ...object, light: next, width: bounds.width, height: bounds.height });
  };

  const shapeLabel = LIGHT_SHAPES.find((entry) => entry.id === light.shape)?.label ?? "Круг";

  return (
    <>
      <div className="property-section compact-section">
        <div className="section-title"><span><Lightbulb size={13} /> Свет</span><small>{shapeLabel.toUpperCase()}</small></div>
        <div className="property-grid two-columns">
          <NumberField label="Радиус" value={light.radius} step={1} suffix="px"
            onCommit={(radius) => update({ radius: Math.max(1, radius) })} />
          {light.shape === "sector" && (
            <NumberField label="Угол" value={light.angle} step={1} suffix="°"
              onCommit={(angle) => update({ angle: Math.min(360, Math.max(1, angle)) })} />
          )}
        </div>

        <label className="select-property">
          <span>Форма</span>
          <select value={light.shape} onChange={(event) => update({ shape: event.target.value as LightShape })}>
            {LIGHT_SHAPES.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
          </select>
        </label>
        <p className="behaviour-hint">
          {LIGHT_SHAPES.find((entry) => entry.id === light.shape)?.hint}
        </p>

        <label className="range-property">
          <span>Яркость <b>{Math.round(light.brightness)}%</b></span>
          <input
            type="range" min="0" max="200" step="1" value={light.brightness}
            onChange={(event) => update({ brightness: Number(event.target.value) })}
          />
        </label>
        <label className="range-property">
          <span>Мягкость края <b>{Math.round(light.softness)}%</b></span>
          <input
            type="range" min="0" max="100" step="1" value={light.softness}
            onChange={(event) => update({ softness: Number(event.target.value) })}
          />
        </label>

        <div className="segmented small dense" title="Обычное наложение работает и светом, и тенью; аддитивное — только свечением">
          <button className={light.blend === "normal" ? "active" : ""} onClick={() => update({ blend: "normal" })}>обычное</button>
          <button className={light.blend === "add" ? "active" : ""} onClick={() => update({ blend: "add" })}>свечение</button>
        </div>
        <p className="behaviour-hint">
          Обычное наложение: тёмный цвет — тень, светлый — подсветка. «Свечение» складывает
          цвет со сценой, поэтому тёмный цвет в нём не виден — это режим для ламп и искр.
        </p>
      </div>

      <div className="property-section compact-section">
        <div className="section-title"><span>Градиент</span><small>ЦЕНТР → КРАЙ</small></div>
        <LightColor
          label="В центре" value={light.colorStart} fallback={DEFAULT_LIGHT.colorStart}
          onChange={(colorStart) => update({ colorStart })}
        />
        <LightColor
          label="У края" value={light.colorEnd} fallback={DEFAULT_LIGHT.colorEnd}
          onChange={(colorEnd) => update({ colorEnd })}
        />
        <p className="behaviour-hint">
          Обычно свет идёт от цвета к прозрачности: тогда край пятна растворяется. Если у края
          тоже цвет — получится кольцо или ровное пятно без мягкого спада.
        </p>
      </div>
    </>
  );
}

/** Цвет свечения: палитра задаёт оттенок, второе поле — его прозрачность. */
function LightColor({ label, value, fallback, onChange }: {
  label: string;
  value: string;
  fallback: string;
  onChange: (value: string) => void;
}) {
  const alpha = Math.round(alphaOf(value) * 100);
  const hex = solidOf(value, solidOf(fallback));
  return (
    <div className="property-grid two-columns">
      <label className="number-field">
        <span className="number-label">{label}</span>
        <div>
          <input
            type="color" value={hex}
            onChange={(event) => onChange(withAlpha(event.target.value, alpha / 100))}
          />
        </div>
      </label>
      <NumberField label="Прозрачность" value={alpha} step={1} suffix="%"
        onCommit={(next) => onChange(withAlpha(hex, Math.min(99, Math.max(0, next)) / 100))} />
    </div>
  );
}

/**
 * Карта нормалей.
 *
 * Нормали — направление поверхности в каждой точке: по ним свет сцены считает
 * объём, поэтому одна и та же картинка под лампой выглядит выпуклой. Карта
 * бывает видео — тогда объём живой (вода, ткань, мимика). Сила своя у каждого
 * объекта: на плоской заливке объём не нужен, а на лице — наоборот.
 */
export function NormalSection({ object, normal, onChange }: {
  object: RigObject;
  normal: NormalMapSpec | undefined;
  onChange: (object: RigObject) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const preview = useAssetUrl(normal?.src);
  const update = (patch: Partial<NormalMapSpec>) => onChange({
    ...object,
    normal: { strength: 100, animate: true, ...normal, src: normal?.src ?? null, ...patch },
  });

  /** Замена карты: байты — в хранилище webview, в объекте остаётся ссылка. */
  const replace = async (file: File) => {
    const kind = await fileKind(file);
    if (kind !== "image" && kind !== "video") {
      setError(`«${file.name}» — не картинка и не видео: карта нормалей должна быть изображением`);
      return;
    }
    setError(null);
    const src = (await storeFile(file)) ?? (await blobToDataUrl(file));
    update({ src, animate: kind === "video" });
  };

  return (
    <div className="property-section compact-section">
      <div className="section-title"><span><Sparkles size={13} /> Карта нормалей</span><small>ОБЪЁМ</small></div>
      <div className="normal-file">
        {preview && <img className="normal-thumb" src={preview} alt="" draggable={false} />}
        <p className="behaviour-hint media-file" title={normal?.src || "файл не выбран"}>
          {normal?.src ? (object.normal?.animate ? "Карта: картинка или видео" : "Карта: картинка") : "Без карты объект плоский"}
        </p>
      </div>
      <div className="image-actions">
        <button className="button secondary" onClick={() => fileInput.current?.click()}>
          <ImageUp size={14} /> {normal?.src ? "Заменить карту" : "Выбрать карту"}
        </button>
        {normal?.src && (
          <button className="button secondary" title="Убрать карту нормалей" onClick={() => onChange({ ...object, normal: undefined })}>
            <Trash2 size={14} />
          </button>
        )}
      </div>
      {error && <p className="inline-error">{error}</p>}
      <input
        ref={fileInput}
        type="file"
        accept=".png,.jpg,.jpeg,.webp,.gif,.apng,.avif,.bmp,.mp4,.webm,.mov,.mkv,.m4v,image/*,video/*"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void replace(file);
        }}
      />
      {normal?.src && (
        <>
          <label className="range-property">
            <span>Сила объёма <b>{Math.round(normal.strength)}%</b></span>
            <input
              type="range" min="0" max="200" step="1" value={normal.strength}
              onChange={(event) => update({ strength: Number(event.target.value) })}
            />
          </label>
          <label className="check-line">
            <input type="checkbox" checked={normal.animate} onChange={(event) => update({ animate: event.target.checked })} />
            <span>Карта играет (видео и анимация)</span>
          </label>
          <p className="behaviour-hint">
            Объём виден от светов сцены: добавьте объект «Свет» и поставьте его рядом.
            Сила 0 — поверхность плоская, 100 — как нарисовано на карте.
          </p>
        </>
      )}
    </div>
  );
}
