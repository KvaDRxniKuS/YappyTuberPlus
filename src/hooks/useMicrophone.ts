import { useCallback, useEffect, useRef, useState } from "react";
import type { InputValues } from "../types";

export function useMicrophone(onValues: (patch: Partial<InputValues>) => void) {
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const valuesRef = useRef(onValues);
  valuesRef.current = onValues;

  const stop = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    setActive(false);
    valuesRef.current({ speak: 0, loudness: 0, db: -60, talking: 0 });
  }, []);

  const start = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
      });
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.35;
      context.createMediaStreamSource(stream).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      let smoothed = 0;
      const timer = window.setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        let peak = 0;
        for (const sample of samples) {
          sum += sample * sample;
          peak = Math.max(peak, Math.abs(sample));
        }
        const rms = Math.sqrt(sum / samples.length);
        const db = rms > 0.000001 ? Math.max(-80, 20 * Math.log10(rms)) : -80;
        const target = Math.min(1, Math.max(0, (db + 52) / 34));
        smoothed += (target - smoothed) * (target > smoothed ? 0.45 : 0.16);
        valuesRef.current({
          speak: smoothed,
          loudness: Math.min(1, peak),
          db,
          talking: db > -43 ? 1 : 0,
        });
      }, 40);
      cleanupRef.current = () => {
        window.clearInterval(timer);
        stream.getTracks().forEach((track) => track.stop());
        void context.close();
      };
      setActive(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Микрофон недоступен");
      setActive(false);
    }
  }, []);

  useEffect(() => () => cleanupRef.current?.(), []);

  return { active, error, start, stop };
}
