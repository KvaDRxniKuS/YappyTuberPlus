import { useEffect, useRef, useState } from "react";
import { ImageUp } from "lucide-react";
import type { MaskSpec, RigObject } from "../types";
import { defaultMask, formatPoints, parsePoints } from "../render/shape";
import { assetRef, blobToDataUrl, listAssets, type AssetUsage } from "../engine/assets";
import { isVideoSource } from "../render/media";
import { useAssetUrl } from "../hooks/useAssets";

/**
 * Источник маски.
 *
 * Пять вариантов вместо прежних трёх: «нет», «набор точек», «фигура»,
 * «внутренний файл» (из файлов проекта) и «внешний файл» (с диска). Разделение
 * файлов на внутренние и внешние важно на практике: внутренний едет вместе с
 * пресетом в ZIP, внешний остаётся ссылкой на диск.
 */
type Source = "none" | "points" | "shape" | "project" | "external";

const SOURCES: Array<{ id: Source; label: string }> = [
  { id: "none", label: "Нет" },
  { id: "points", label: "Набор точек" },
  { id: "shape", label: "Фигура" },
  { id: "project", label: "Внутренний файл" },
  { id: "external", label: "Внешний файл" },
];

/** Источник из настроек: по нему выбирается строка в списке. */
function sourceOf(mask: MaskSpec | undefined): Source {
  if (!mask) return "none";
  if (mask.kind === "points") return "points";
  if (mask.kind === "shape") return "shape";
  return mask.origin === "external" ? "external" : "project";
}

/** Поиск без регистра: «кот» находит «Кот_улыбка.png». */
function matches(query: string, text: string): boolean {
  const clean = query.trim().toLowerCase();
  return !clean || text.toLowerCase().includes(clean);
}

export function MaskSection({ object, mask, objects, onChange }: {
  object: RigObject;
  mask: MaskSpec | undefined;
  objects: RigObject[];
  onChange: (object: RigObject) => void;
}) {
  const shapes = objects.filter((item) => item.kind === "shape" && item.id !== object.id);
  const fileInput = useRef<HTMLInputElement>(null);
  const preview = useAssetUrl(mask?.kind === "file" && !isVideoSource(mask.file) ? mask.file : null);
  const [draft, setDraft] = useState(() => formatPoints(mask?.points ?? []));
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Поиск по именам: и по фигурам, и по файлам проекта. Списки бывают длинные,
  // и «пролистать глазами» — не способ найти нужный файл.
  const [shapeQuery, setShapeQuery] = useState("");
  const [fileQuery, setFileQuery] = useState("");
  const [files, setFiles] = useState<AssetUsage[]>([]);
  // Пока поле в фокусе, текст не переписываем: иначе курсор прыгал бы на
  // каждый коммит.
  useEffect(() => { if (!focused) setDraft(formatPoints(mask?.points ?? [])); }, [mask?.points, focused]);

  const source = sourceOf(mask);

  // Список файлов проекта нужен только для «Внутреннего файла»: грузим по
  // первому открытию этого источника, а не при каждом выборе объекта.
  useEffect(() => {
    if (source !== "project") return;
    let alive = true;
    void listAssets().then((list) => { if (alive) setFiles(list); });
    return () => { alive = false; };
  }, [source]);

  const update = (patch: Partial<MaskSpec>) => {
    onChange({ ...object, mask: { ...defaultMask(), ...mask, ...patch } });
  };
  const setSource = (next: Source) => {
    if (next === "none") {
      onChange({ ...object, mask: undefined });
      return;
    }
    const base = mask ?? defaultMask();
    if (next === "project" || next === "external") {
      update({
        kind: "file",
        origin: next,
        // Смена источника не должна оставлять ссылку из другого места: путь с
        // диска во внутреннем файле не резолвится и наоборот.
        file: base.kind === "file" && base.origin === next ? base.file : null,
      });
      return;
    }
    update({ kind: next, shapeId: next === "shape" ? (base.kind === "shape" && base.shapeId ? base.shapeId : shapes[0]?.id || "") : base.shapeId });
  };

  const commitPoints = () => {
    const points = parsePoints(draft);
    setDraft(formatPoints(points));
    update({ points });
  };

  const replaceFile = async (file: File) => {
    if (!file.type.startsWith("image/") && !file.type.startsWith("video/")) {
      setError(`«${file.name}» — не картинка и не видео: маской может быть только изображение или фильм.`);
      return;
    }
    setError(null);
    // Внешний файл остаётся снаружи: в пресет попадает его содержимое, но в
    // хранилище проекта он не кладётся — так и задумано.
    const source = (await blobToDataUrl(file));
    update({ file: source, kind: "file", origin: "external" });
  };

  const pickedShape = shapes.find((item) => item.id === mask?.shapeId) ?? null;
  const visibleFiles = files.filter((entry) => matches(fileQuery, entry.name));
  const visibleShapes = shapes.filter((entry) => matches(shapeQuery, entry.name));

  return (
    <div className="property-section compact-section">
      <div className="section-title"><span>Маска</span><small>ЧТО ВИДНО</small></div>
      <label className="select-property">
        <span>Источник</span>
        <select value={source} onChange={(event) => setSource(event.target.value as Source)}>
          {SOURCES.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
        </select>
      </label>

      {source === "shape" && (
        <>
          <input
            className="mask-search"
            type="search"
            placeholder="Поиск фигуры по имени"
            value={shapeQuery}
            onChange={(event) => setShapeQuery(event.target.value)}
          />
          <label className="select-property">
            <span>Фигура</span>
            <select value={mask?.shapeId ?? ""} onChange={(event) => update({ shapeId: event.target.value })}>
              <option value="">— выберите фигуру —</option>
              {visibleShapes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          {pickedShape && (
            <p className="behaviour-hint">
              Берутся контуры фигуры с её текущей позой: если фигуру двигают или
              анимируют скриптом, маска едет вместе с ней.
            </p>
          )}
          {!shapes.length && <p className="behaviour-hint">В пресете нет фигур: создайте её кнопкой «Фигура» в структуре.</p>}
        </>
      )}

      {source === "points" && (
        <>
          <label className="mask-points">
            <span>Точки</span>
            <textarea
              rows={3}
              value={draft}
              placeholder="10,20; 120,20; 120,140"
              title="Точки многоугольника в координатах объекта: «x,y; x,y…». Enter — применить"
              onChange={(event) => setDraft(event.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => { setFocused(false); commitPoints(); }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.blur(); }
              }}
            />
          </label>
          <p className="behaviour-hint">
            Координаты — в рамке объекта: (0, 0) — левый верхний угол, дальше
            ширина и высота объекта. Меньше трёх точек — маска выключена.
          </p>
        </>
      )}

      {source === "project" && (
        <>
          <input
            className="mask-search"
            type="search"
            placeholder="Поиск файла по имени"
            value={fileQuery}
            onChange={(event) => setFileQuery(event.target.value)}
          />
          <div className="mask-file-list">
            {visibleFiles.length === 0 && (
              <p className="behaviour-hint">
                {files.length ? "Ничего не нашлось — измените запрос." : "В проекте пока нет файлов: они появляются при импорте картинок и видео."}
              </p>
            )}
            {visibleFiles.map((entry) => {
              const active = mask?.file === assetRef(entry.id);
              return (
                <button
                  key={entry.id}
                  className={`mask-file-row ${active ? "active" : ""}`}
                  title={entry.mime}
                  onClick={() => update({ kind: "file", origin: "project", file: assetRef(entry.id) })}
                >
                  <span>{entry.name}</span>
                  <small>{entry.mime.startsWith("video/") ? "видео" : entry.mime === "image/gif" || entry.mime === "image/webp" ? "анимация" : "картинка"}</small>
                </button>
              );
            })}
          </div>
          <p className="behaviour-hint">
            Подходят картинки, анимации и видео: у видео маской становится текущий
            кадр, поэтому прозрачный ролик даёт живое «окно».
          </p>
        </>
      )}

      {source === "external" && (
        <>
          <div className="image-actions">
            <button className="button secondary" onClick={() => fileInput.current?.click()}>
              <ImageUp size={14} /> {mask?.file ? "Заменить файл" : "Выбрать файл"}
            </button>
          </div>
          {mask?.file && (
            <p className="behaviour-hint">
              {isVideoSource(mask.file) ? "Видео-маска: берётся текущий кадр." : "Картинка-маска: видимость решает альфа."}
            </p>
          )}
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/avif,image/gif,video/mp4,video/webm,video/quicktime,.png,.jpg,.jpeg,.webp,.avif,.gif,.mp4,.webm,.mov"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void replaceFile(file);
            }}
          />
        </>
      )}

      {source !== "none" && source !== "points" && preview && <img className="mask-preview" src={preview} alt="" />}

      {source !== "none" && (
        <>
          <label className="check-line">
            <input type="checkbox" checked={mask?.invert === true} onChange={(event) => update({ invert: event.target.checked })} />
            <span>Инвертировать: показать то, что снаружи</span>
          </label>
          <MaskFeather mask={mask} onCommit={(feather) => update({ feather })} />
          <p className="behaviour-hint">
            Настройки пишутся в скрипт объекта блоком «маска», рядом стоит
            формула <code>mask = 1</code>: ноль показывает объект целиком, дробь
            проявляет маску плавно.
          </p>
        </>
      )}
      {error && <p className="inline-error">{error}</p>}
    </div>
  );
}

/** Мягкий край: отдельным компонентом, чтобы не тянуть в него лишний импорт. */
function MaskFeather({ mask, onCommit }: { mask: MaskSpec | undefined; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState(String(mask?.feather ?? 0));
  useEffect(() => { setDraft(String(mask?.feather ?? 0)); }, [mask?.feather]);
  const commit = () => {
    const parsed = Number(draft.replace(",", "."));
    onCommit(Number.isFinite(parsed) ? Math.max(0, parsed) : 0);
  };
  return (
    <label className="number-field">
      <span className="number-label">Мягкий край</span>
      <div className="number-stepper">
        <input
          type="number"
          min={0}
          step={1}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
        />
        <em>px</em>
      </div>
    </label>
  );
}
