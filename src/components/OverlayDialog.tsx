import { useEffect, useState } from "react";
import { AppWindow, Check, Copy, MonitorPlay, Radio, Settings2, X } from "lucide-react";
import type { OverlayConfig } from "../types";
import {
  applyCaptureWindow, applyOverlayWindow, captureWindowOpen,
  closeCaptureWindow, closeOverlayWindow, isTauri, openCaptureWindow,
  openOverlayWindow, overlayServerUrl, overlayUrl,
} from "../overlay/window";

interface OverlayDialogProps {
  config: OverlayConfig;
  viewers: string[];
  transport: string;
  bridgeReady: boolean;
  bridgeUrl: string | null;
  /** `?transport=` of the editor page, forwarded so the overlay matches it. */
  transportParam?: string;
  onChange: (patch: Partial<OverlayConfig>) => void;
  onClose: () => void;
  onNotify: (message: string) => void;
}

const SCALE_MODES: Array<{ value: OverlayConfig["scaleMode"]; label: string; hint: string }> = [
  { value: "contain", label: "Вписать", hint: "весь холст внутри окна, по центру" },
  { value: "cover", label: "Заполнить", hint: "окно заполнено, края могут обрезаться" },
  { value: "stretch", label: "Растянуть", hint: "неровные пропорции при другом окне" },
  { value: "pixel", label: "1:1", hint: "пиксель в пиксель, слева сверху" },
];

const BACKGROUNDS: Array<{ value: OverlayConfig["background"]; label: string }> = [
  { value: "transparent", label: "Прозрачный" },
  { value: "color", label: "Цвет" },
  { value: "chroma", label: "Хромакей" },
];

export function OverlayDialog(props: OverlayDialogProps) {
  const [copied, setCopied] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  // Встроенный сервер приложения: тот же релей и та же страница, но без
  // отдельного процесса Node. В браузере сервера нет — остаётся ссылка через мост.
  const [serverUrl, setServerUrl] = useState<string | null>(null);
  useEffect(() => { void overlayServerUrl().then(setServerUrl); }, []);

  const url = (() => {
    if (!serverUrl) {
      return overlayUrl(props.config, { transport: props.transportParam, bridge: props.bridgeUrl || undefined });
    }
    const target = new URL(serverUrl);
    target.searchParams.set("overlay", "1");
    if (props.config.showGuide) target.searchParams.set("guide", "1");
    return target.toString();
  })();

  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") props.onClose(); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [props]);

  useEffect(() => {
    void captureWindowOpen().then(setCaptureOpen);
  }, []);

  const openCapture = async () => {
    setBusy(true);
    const result = await openCaptureWindow(props.config);
    setBusy(false);
    setCaptureOpen(result.ok || (await captureWindowOpen()));
    if (!result.ok) {
      props.onNotify(result.error || "Не удалось открыть окно захвата");
      return;
    }
    props.onNotify(result.mode === "tauri"
      ? "Окно захвата открыто — выберите его в OBS как «Захват окна»"
      : "Окно захвата открыто в отдельном окне браузера");
  };

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      props.onNotify("Скопировано в буфер обмена");
      window.setTimeout(() => setCopied(null), 1800);
    } catch {
      props.onNotify("Браузер не дал доступ к буферу обмена — скопируйте вручную");
    }
  };

  const open = async () => {
    setBusy(true);
    const result = await openOverlayWindow(url, props.config);
    setBusy(false);
    if (!result.ok) {
      props.onNotify(result.error || "Не удалось открыть оверлей");
      return;
    }
    props.onNotify(result.mode === "tauri" ? "Окно оверлея открыто" : "Оверлей открыт в отдельном окне");
  };

  const change = (patch: Partial<OverlayConfig>) => {
    props.onChange(patch);
    void applyOverlayWindow({ ...props.config, ...patch });
    void applyCaptureWindow({ ...props.config, ...patch });
  };

  return (
    <div className="dialog-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }}>
      <div className="overlay-dialog" role="dialog" aria-label="Оверлей для OBS">
        <header className="dialog-head">
          <div className="dialog-title">
            <div className="dialog-icon"><MonitorPlay size={17} /></div>
            <div><span className="eyebrow">ВЫВОД В OBS</span><h2>Оверлей</h2></div>
          </div>
          <button className="icon-button" title="Закрыть" onClick={props.onClose}><X size={15} /></button>
        </header>

        <div className={`overlay-state ${props.viewers.length ? "live" : ""}`}>
          <span className="overlay-state-dot" />
          <b>{props.viewers.length ? `Подключено оверлеев: ${props.viewers.length}` : "Оверлей не подключён"}</b>
          <span>транспорт: {props.transport}</span>
          {props.bridgeUrl && <span>{props.bridgeReady ? "WS-мост активен" : "WS-мост не отвечает"}</span>}
        </div>

        <div className="dialog-body">
          <section className="dialog-section">
            <div className="section-title"><span><Settings2 size={12} /> Окно</span><small>СОХРАНЯЕТСЯ В ПРЕСЕТЕ</small></div>
            <div className="overlay-fields">
              <NumberField label="Ширина" unit="px" value={props.config.width} min={120} max={7680} onCommit={(value) => change({ width: value })} />
              <NumberField label="Высота" unit="px" value={props.config.height} min={120} max={4320} onCommit={(value) => change({ height: value })} />
              <label className="select-field">
                <span>Вписывание</span>
                <select value={props.config.scaleMode} onChange={(event) => change({ scaleMode: event.target.value as OverlayConfig["scaleMode"] })}>
                  {SCALE_MODES.map((mode) => <option key={mode.value} value={mode.value} title={mode.hint}>{mode.label}</option>)}
                </select>
              </label>
              <label className="select-field">
                <span>Фон</span>
                <select value={props.config.background} onChange={(event) => change({ background: event.target.value as OverlayConfig["background"] })}>
                  {BACKGROUNDS.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
                </select>
              </label>
              {props.config.background !== "transparent" && (
                <label className="color-field">
                  <span>{props.config.background === "chroma" ? "Ключевой цвет" : "Цвет фона"}</span>
                  <div>
                    <input
                      type="color"
                      value={props.config.background === "chroma" ? props.config.chromaColor : props.config.color}
                      onChange={(event) => change(props.config.background === "chroma" ? { chromaColor: event.target.value } : { color: event.target.value })}
                    />
                    <code>{props.config.background === "chroma" ? props.config.chromaColor : props.config.color}</code>
                  </div>
                </label>
              )}
            </div>
            <div className="overlay-toggles">
              <Toggle label="Поверх всех окон" checked={props.config.alwaysOnTop} onChange={(value) => change({ alwaysOnTop: value })} />
              <Toggle label="Пропускать клики" checked={props.config.clickThrough} onChange={(value) => change({ clickThrough: value })} />
              <Toggle label="Служебная рамка" checked={props.config.showGuide} onChange={(value) => change({ showGuide: value })} />
            </div>
          </section>

          <section className="dialog-section">
            <div className="section-title"><span><Radio size={12} /> Подключение</span><small>ЕДИНЫЙ ДРАЙВЕР КАДРОВ</small></div>
            <p className="dialog-note">
              Оверлей только рисует готовые кадры. Симуляцию продвигает редактор, поэтому stateful-формулы
              не шагают дважды и пауза совпадает с превью.
              {serverUrl
                ? " Ссылка ведёт на встроенный сервер приложения: он отдаёт страницу оверлея и релей, отдельный npm run overlay:bridge не нужен."
                : ""}
            </p>
            <div className="dialog-actions">
              <button className="button primary" disabled={busy} onClick={() => void open()}><MonitorPlay size={14} /> Открыть оверлей</button>
              <button className="button secondary" onClick={() => void copy(url, "url")}>
                {copied === "url" ? <Check size={14} /> : <Copy size={14} />} Ссылка для OBS
              </button>
              {isTauri() && (
                <button className="button secondary" onClick={() => void closeOverlayWindow()}>Закрыть окно</button>
              )}
            </div>
            <input className="overlay-url" value={url} readOnly onFocus={(event) => event.currentTarget.select()} />
          </section>

          <section className="dialog-section">
            <div className="section-title"><span><AppWindow size={12} /> Окно захвата</span><small>ДЛЯ ПРОГРАММ ЗАПИСИ</small></div>
            <p className="dialog-note">
              Отдельное окно без рамки, его видно в списке окон OBS, Discord и «Записи экрана».
              Размер и фон берутся из полей выше. Прозрачный фон сохраняется — в окне приложения
              записывается альфа, как у PNGTuber и Spout2; в браузере прозрачных окон не бывает,
              поэтому там подставляется тёмный фон.
            </p>
            <div className="dialog-actions">
              <button className={`button ${captureOpen ? "secondary" : "primary"}`} disabled={busy} onClick={() => void openCapture()}>
                <AppWindow size={14} /> {captureOpen ? "Показать окно захвата" : "Открыть окно захвата"}
              </button>
              {isTauri() && captureOpen && (
                <button className="button secondary" onClick={() => { void closeCaptureWindow(); setCaptureOpen(false); }}>
                  Закрыть окно захвата
                </button>
              )}
            </div>
          </section>

          <section className="dialog-section">
            <div className="section-title"><span>Как захватить в OBS</span></div>
            <ol className="overlay-steps">
              <li><b>Прозрачное окно.</b> Нажмите «Открыть оверлей» и добавьте в OBS источник «Захват окна» → YappyTuberPlus Overlay. Окно без рамки, с прозрачным фоном и без тени.</li>
              <li><b>Окно захвата.</b> Если «Захват окна» с прозрачного оверлея не работает, нажмите «Открыть окно захвата» и выберите в OBS окно «YappyTuberPlus — окно захвата».</li>
              <li><b>Источник браузера.</b> Запустите <code>npm run overlay:bridge</code>, откройте в OBS «Источник браузера» и вставьте ссылку выше. Мост передаёт кадры в другой процесс.</li>
              <li><b>Проверка.</b> Включите «Служебную рамку», чтобы видеть статус, FPS и границы холста; перед эфиром выключите её.</li>
            </ol>
          </section>
        </div>
      </div>
    </div>
  );
}

function NumberField(props: {
  label: string; unit: string; value: number; min: number; max: number;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(props.value));
  useEffect(() => setDraft(String(props.value)), [props.value]);
  const commit = () => {
    const value = Math.round(Number(draft));
    if (Number.isFinite(value) && value >= props.min && value <= props.max) props.onCommit(value);
    else setDraft(String(props.value));
  };
  return (
    <label className="number-field">
      <span>{props.label}</span>
      <div>
        <input
          value={draft}
          inputMode="numeric"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
        />
        <em>{props.unit}</em>
      </div>
    </label>
  );
}

function Toggle(props: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className={`toggle ${props.checked ? "checked" : ""}`}>
      <input type="checkbox" checked={props.checked} onChange={(event) => props.onChange(event.target.checked)} />
      <span className="toggle-track"><span /></span>
      <span>{props.label}</span>
    </label>
  );
}
