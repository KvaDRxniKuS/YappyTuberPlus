import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, MicOff } from "lucide-react";
import type { ModuleConfig } from "../types";
import type { CalibrationFrame } from "../modules/audio";
import { VISEME_BANDS } from "../modules/viseme";

/** Что нужно панели, чтобы записать эталон: движок звука отдаёт эти две функции. */
export interface CalibrationApi {
  calibrate: (settings: ModuleConfig, onFrame?: (frame: CalibrationFrame) => void) => Promise<number[] | null>;
  cancelCalibration: () => void;
}

export interface RecordingState {
  /** Ключ записи: `модуль.визема` — по нему панель находит нужную строку. */
  key: string;
  progress: number;
  bands: number[];
}

/**
 * Запись эталона: 3 секунды, без кнопки «Стоп». Пока идёт запись, повторный
 * клик игнорируется — длительность фиксированная, чтобы эталоны были
 * сопоставимы между собой.
 */
export function useVisemeRecorder(api: CalibrationApi) {
  const { calibrate, cancelCalibration } = api;
  const [recording, setRecording] = useState<RecordingState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  const start = useCallback(async (key: string, settings: ModuleConfig, onTemplate: (template: number[]) => void) => {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    setRecording({ key, progress: 0, bands: [] });
    try {
      const template = await calibrate(settings, (frame) => {
        setRecording({ key, progress: frame.progress, bands: frame.bands });
      });
      if (template) onTemplate(template);
      else if (!template) setError("Запись не дала звука: проверьте микрофон и говорите громче.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      busy.current = false;
      setRecording(null);
    }
  }, [calibrate]);

  // Размонтирование панели не должно оставлять микрофон включённым. Зависимость
  // — сама функция: объект пропсов меняется каждый рендер и рвал бы запись.
  useEffect(() => () => { if (busy.current) cancelCalibration(); }, [cancelCalibration]);

  return { recording, error, start };
}

/** Полосы спектра: живые во время записи, сохранённые — как напоминание эталона. */
export function SpectrumBars(props: { bands: number[] | null | undefined; active?: boolean; progress?: number; title?: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const bands = props.bands ?? [];

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, width, height);
    if (bands.length === 0) return;
    const gap = Math.max(1, Math.round(ratio));
    const barWidth = Math.max(1, (width - gap * (VISEME_BANDS - 1)) / VISEME_BANDS);
    const peak = Math.max(...bands, 1e-6);
    for (let index = 0; index < VISEME_BANDS; index += 1) {
      const value = Math.max(0, (bands[index] ?? 0) / peak);
      const barHeight = Math.max(ratio, value * (height - 2 * ratio));
      context.fillStyle = props.active ? "#5fd0a8" : "#4a5568";
      context.fillRect(index * (barWidth + gap), height - barHeight, barWidth, barHeight);
    }
  }, [bands, props.active]);

  return (
    <div className={`spectrum ${props.active ? "live" : ""}`} title={props.title}>
      <canvas ref={canvasRef} />
      {props.active && props.progress !== undefined && (
        <span className="spectrum-progress" style={{ width: `${Math.round(props.progress * 100)}%` }} />
      )}
    </div>
  );
}

/** Кнопка-микрофончик: пишет 3 секунды и отдаёт средний спектр. */
export function CalibrateButton(props: {
  title: string;
  recording: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`icon-button viseme-mic ${props.recording ? "recording" : ""}`}
      title={props.recording ? "Идёт запись: 3 секунды" : props.title}
      disabled={props.disabled}
      onClick={(event) => {
        // Кнопка живёт в строке-`label`: без этого клик уходил бы в ползунок.
        event.preventDefault();
        event.stopPropagation();
        props.onClick();
      }}
    >
      {props.recording ? <MicOff size={13} /> : <Mic size={13} />}
    </button>
  );
}
