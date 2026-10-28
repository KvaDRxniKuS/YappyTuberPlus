import { useRef, useState } from "react";
import { ImageUp, Layers, Sparkles, Trash2, Wand2 } from "lucide-react";
import type { ChannelSpec, EnvironmentSpec, MaterialSpec, PackedChannel, RigObject } from "../types";
import { DEFAULT_ENVIRONMENT, DEFAULT_MATERIAL } from "../types";
import { MATERIAL_PRESETS, normalizeEnvironment, normalizeMaterial } from "../render/material";
import { blobToDataUrl, storeFile } from "../engine/assets";
import { fileKind } from "../engine/importFile";
import { useAssetMissing, useAssetUrl } from "../hooks/useAssets";

/**
 * Раздел «Материал» вкладки «Параметры».
 *
 * Порядок полей — от того, что видно сразу, к тому, что настраивают редко:
 * шероховатость и металл, потом окклюзия, потом свечение, потом упаковка.
 * Готовые наборы стоят первыми, чтобы «просто пластик» не требовал понимать,
 * что такое GGX.
 */
export function MaterialSection({ object, material, environment, onChange, onEnvironment }: {
  object: RigObject;
  material: MaterialSpec | undefined;
  environment: EnvironmentSpec | undefined;
  onChange: (object: RigObject) => void;
  onEnvironment: (environment: EnvironmentSpec) => void;
}) {
  const current = material ?? DEFAULT_MATERIAL;
  const env = environment ?? DEFAULT_ENVIRONMENT;
  const enabled = !!material;
  const [error, setError] = useState<string | null>(null);

  const update = (patch: Partial<MaterialSpec>) => {
    const next = normalizeMaterial({ ...current, ...patch }) ?? DEFAULT_MATERIAL;
    onChange({ ...object, material: next });
  };
  const updateChannel = (key: "roughness" | "metallic" | "ao", patch: Partial<ChannelSpec>) =>
    update({ [key]: { ...current[key], ...patch } } as Partial<MaterialSpec>);

  const chooseFile = async (file: File, apply: (src: string) => void) => {
    const kind = await fileKind(file);
    if (kind !== "image") {
      setError(`«${file.name}» — не картинка: карта материала должна быть изображением`);
      return;
    }
    setError(null);
    const src = (await storeFile(file)) ?? (await blobToDataUrl(file));
    apply(src);
  };

  return (
    <div className="property-section compact-section">
      <div className="section-title"><span><Layers size={13} /> Материал</span><small>PBR</small></div>
      <label className="check-line">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => onChange({
            ...object,
            material: event.target.checked ? { ...DEFAULT_MATERIAL } : undefined,
          })}
        />
        <span>Считать поверхность материалом (блики, металл, окклюзия)</span>
      </label>
      {!enabled && (
        <p className="behaviour-hint">
          Без материала объект выглядит как раньше: объём от карты нормалей в пятне света.
        </p>
      )}

      {enabled && (
        <>
          <div className="image-actions material-kinds">
            {MATERIAL_PRESETS.map((preset) => (
              <button
                key={preset.id}
                className="button secondary"
                title={`Поставить значения «${preset.label}»`}
                onClick={() => update(preset.patch)}
              >
                <Wand2 size={13} /> {preset.label}
              </button>
            ))}
          </div>

          <ChannelRow
            label="Шероховатость"
            hint="0 — зеркало, 1 — матовое"
            channel={current.roughness}
            packed={current.packed}
            onChange={(patch) => updateChannel("roughness", patch)}
            onPick={(file) => chooseFile(file, (src) => updateChannel("roughness", { from: "file", file: src }))}
            onClear={() => updateChannel("roughness", { from: "value", file: null })}
          />
          <ChannelRow
            label="Металл"
            hint="1 — металл: блик красится цветом объекта"
            channel={current.metallic}
            packed={current.packed}
            onChange={(patch) => updateChannel("metallic", patch)}
            onPick={(file) => chooseFile(file, (src) => updateChannel("metallic", { from: "file", file: src }))}
            onClear={() => updateChannel("metallic", { from: "value", file: null })}
          />
          <ChannelRow
            label="Окклюзия"
            hint="Гасит диффузную часть: складки, швы, тени в углах"
            channel={current.ao}
            packed={current.packed}
            onChange={(patch) => updateChannel("ao", patch)}
            onPick={(file) => chooseFile(file, (src) => updateChannel("ao", { from: "file", file: src }))}
            onClear={() => updateChannel("ao", { from: "value", file: null })}
          />

          <PackedRow
            packed={current.packed}
            onPick={(file) => chooseFile(file, (src) => update({
              packed: src,
              // Включили упаковку — каналы переключаются на её буквы: иначе файл
              // лежит, а материал его не читает, и это выглядит поломкой.
              // Раскладка ORM: R окклюзия, G шероховатость, B металл.
              roughness: { ...current.roughness, from: "packed", packedChannel: "g" },
              metallic: { ...current.metallic, from: "packed", packedChannel: "b" },
              ao: { ...current.ao, from: "packed", packedChannel: "r" },
            }))}
            onClear={() => update({
              packed: null,
              roughness: { ...current.roughness, from: "value" },
              metallic: { ...current.metallic, from: "value" },
              ao: { ...current.ao, from: "value" },
            })}
          />

          <EmissiveHint file={current.emissive.file} />
          <div className="emissive-row">
            <label className="range-property">
              <span>Свечение <b>{Math.round(current.emissive.strength)}%</b></span>
              <input
                type="range" min="0" max="200" step="1" value={current.emissive.strength}
                onChange={(event) => update({ emissive: { ...current.emissive, strength: Number(event.target.value) } })}
              />
            </label>
            <input
              className="color-input" type="color" value={current.emissive.color.slice(0, 7)}
              onChange={(event) => update({ emissive: { ...current.emissive, color: event.target.value } })}
            />
            <FileButton
              label={current.emissive.file ? "Заменить карту" : "Карта свечения"}
              onPick={(file) => chooseFile(file, (src) => update({ emissive: { ...current.emissive, file: src } }))}
            />
            {current.emissive.file && (
              <button className="button secondary" title="Убрать карту свечения" onClick={() => update({ emissive: { ...current.emissive, file: null } })}>
                <Trash2 size={13} />
              </button>
            )}
          </div>

          <label className="range-property">
            <span>Сила блика <b>{Math.round(current.specular)}%</b></span>
            <input
              type="range" min="0" max="200" step="1" value={current.specular}
              onChange={(event) => update({ specular: Number(event.target.value) })}
            />
          </label>

          <p className="behaviour-hint">
            Блики видны от светов сцены. Металлу нужен свет или окружение: у металла нет
            диффузной части, и без окружения он останется тёмным.
          </p>

          <div className="section-title"><span><Sparkles size={13} /> Окружение сцены</span><small>ОБЩЕЕ</small></div>
          <div className="emissive-row">
            <label className="range-property">
              <span>Уровень <b>{Math.round(env.level)}%</b></span>
              <input
                type="range" min="0" max="200" step="1" value={env.level}
                onChange={(event) => onEnvironment(normalizeEnvironment({ ...env, level: Number(event.target.value) }))}
              />
            </label>
            <input
              className="color-input" type="color" value={env.color.slice(0, 7)}
              onChange={(event) => onEnvironment(normalizeEnvironment({ ...env, color: event.target.value }))}
            />
          </div>
          <p className="behaviour-hint">
            Окружение — свет со всех сторон сразу. Уровень 0 значит «его нет»: так сцена
            выглядит без материала.
          </p>
        </>
      )}
      {error && <p className="inline-error">{error}</p>}
    </div>
  );
}

/** Строка канала: ползунок, источник и свой файл. */
function ChannelRow({ label, hint, channel, packed, onChange, onPick, onClear }: {
  label: string;
  hint: string;
  channel: ChannelSpec;
  packed: string | null;
  onChange: (patch: Partial<ChannelSpec>) => void;
  onPick: (file: File) => void;
  onClear: () => void;
}) {
  // Хуки живут в самом компоненте: в родителе их нельзя звать по условию.
  const preview = useAssetUrl(channel.file);
  const missing = useAssetMissing(channel.file);
  return (
    <div className="material-channel">
      <div className="material-channel-head">
        <span title={hint}>{label}</span>
        <div className="segmented small inline" title="Откуда берётся значение канала">
          <button className={channel.from === "value" ? "active" : ""} onClick={() => onChange({ from: "value" })}>число</button>
          <button className={channel.from === "file" ? "active" : ""} onClick={() => onChange({ from: "file" })}>файл</button>
          {packed && (
            <button className={channel.from === "packed" ? "active" : ""} onClick={() => onChange({ from: "packed" })}>карта</button>
          )}
        </div>
      </div>
      {channel.from === "value" && (
        <label className="range-property">
          <span>{Math.round(channel.value * 100)} %</span>
          <input
            type="range" min="0" max="1" step="0.01" value={channel.value}
            onChange={(event) => onChange({ value: Number(event.target.value) })}
          />
        </label>
      )}
      {channel.from === "file" && (
        <div className="material-file">
          {preview && <img className="normal-thumb" src={preview} alt="" draggable={false} />}
          <FileButton label={channel.file ? "Заменить" : "Выбрать файл"} onPick={onPick} />
          {channel.file && (
            <button className="button secondary" title="Вернуть значение числом" onClick={onClear}>
              <Trash2 size={13} />
            </button>
          )}
        </div>
      )}
      {channel.from === "packed" && (
        <label className="material-packed-channel">
          <span>Канал карты</span>
          <select
            value={channel.packedChannel}
            onChange={(event) => onChange({ packedChannel: event.target.value as PackedChannel })}
          >
            <option value="r">R</option>
            <option value="g">G</option>
            <option value="b">B</option>
            <option value="a">A</option>
          </select>
        </label>
      )}
      {channel.from === "file" && missing && (
        <p className="inline-error">Файл канала не найден — выберите его заново.</p>
      )}
    </div>
  );
}

/** Файл свечения: превью и честное «файл не найден». */
function EmissiveHint({ file }: { file: string | null }) {
  const preview = useAssetUrl(file);
  const missing = useAssetMissing(file);
  if (!file) return null;
  return (
    <div className="material-file">
      {preview && <img className="normal-thumb" src={preview} alt="" draggable={false} />}
      {missing && <p className="inline-error">Файл карты свечения не найден — выберите его заново.</p>}
    </div>
  );
}

/** Упакованная карта: один файл, в котором лежат три канала (ORM). */
function PackedRow({ packed, onPick, onClear }: {
  packed: string | null;
  onPick: (file: File) => void;
  onClear: () => void;
}) {
  const preview = useAssetUrl(packed);
  return (
    <div className="material-packed">
      <div className="material-channel-head">
        <span title="Один файл по стандарту ORM: R — окклюзия, G — шероховатость, B — металл (glTF, Unreal, Godot). Другой порядок букв выбирается в каналах">Упакованная карта</span>
      </div>
      <div className="material-file">
        {preview && <img className="normal-thumb" src={preview} alt="" draggable={false} />}
        <FileButton label={packed ? "Заменить карту" : "Выбрать ORM"} onPick={onPick} />
        {packed && (
          <button className="button secondary" title="Убрать упакованную карту" onClick={onClear}>
            <Trash2 size={13} />
          </button>
        )}
      </div>
    </div>
  );
}

/** Кнопка выбора файла: свой input на каждую строку, иначе файл не отличить. */
function FileButton({ label, onPick }: { label: string; onPick: (file: File) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button className="button secondary" onClick={() => input.current?.click()}>
        <ImageUp size={13} /> {label}
      </button>
      <input
        ref={input}
        type="file"
        accept=".png,.jpg,.jpeg,.webp,.gif,.bmp,image/*"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) onPick(file);
        }}
      />
    </>
  );
}
