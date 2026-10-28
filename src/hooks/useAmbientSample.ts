import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ModuleInstance } from "../types";
import { moduleDefinition } from "../modules/registry";
import {
  ambientConnection, ambientPoints, ambientRate, resetAmbientState, type AmbientPoint,
} from "../modules/ambient";
import { ObsClient, areaOnFrame, areaOnScene, obsPassword, type ObsStatus, type ObsVideoSettings } from "../modules/obs";
import { sceneSampler, type SampleArea } from "../render/sceneSample";
import { sampleImage } from "../render/obsSample";
import type { Rgba } from "../render/color";

/** Нижняя граница такта замеров: чаще 30 раз в секунду смысла нет. */
const AMBIENT_TICK = 16;

export interface ObsModuleInfo {
  status: ObsStatus;
  scenes: string[];
  items: string[];
}

export interface AmbientSampleApi {
  /** Последние замеры: `{ ambient_1: { spot_1: { r, g, b, a } } }`. */
  samples: Record<string, Record<string, Rgba>>;
  /** Состояние OBS по имени модуля: строка для человека и списки имён. */
  obs: Record<string, ObsModuleInfo>;
  /** «Проверить»: переподключиться и рассказать, что видно. */
  probe: (moduleName: string) => void;
}

/**
 * Замеры для модуля «Свет из экрана».
 *
 * Два источника, один результат:
 *
 * - **своя сцена** — `Scene` по просьбе рисует маленькую копию кадра, отсюда её
 *   только усредняем (интерфейс редактора в замер не попадает);
 * - **OBS** — одно соединение на модуль и один скриншот на источник за такт: из
 *   одной картинки берутся все точки, которые на неё смотрят.
 *
 * Сглаживание сюда не входит: оно живёт в `composeValues`, чтобы цвет считался
 * по тому же `dt`, что и остальные значения.
 */
export function useAmbientSample(modules: ModuleInstance[], libraryVersion = 0): AmbientSampleApi {
  const ambientModules = useMemo(
    () => modules.filter((module) => module.enabled && moduleDefinition(module.type).kind === "ambient"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [modules, libraryVersion],
  );
  const active = ambientModules.length > 0;
  // Ключ описывает всё, что влияет на замеры: смена точки или адреса OBS
  // пересобирает такт, а не ждёт перезапуска приложения.
  const key = JSON.stringify(ambientModules.map((module) => [
    module.name,
    ambientRate(module),
    ambientConnection(module),
    ambientPoints(module).map((point) => [point.name, point.source, point.area, point.blur, point.follow]),
  ]));

  const [samples, setSamples] = useState<Record<string, Record<string, Rgba>>>({});
  const [obs, setObs] = useState<Record<string, ObsModuleInfo>>({});
  const samplesRef = useRef(samples);
  samplesRef.current = samples;
  const clients = useRef(new Map<string, ObsClient>());
  const reconnect = useRef(new Set<string>());

  /** «Проверить»: забыть соединение и попробовать снова с чистого листа. */
  const probe = useCallback((moduleName: string) => {
    const client = clients.current.get(moduleName);
    client?.close();
    clients.current.delete(moduleName);
    reconnect.current.add(moduleName);
  }, []);

  useEffect(() => {
    if (!active) {
      sceneSampler.stop();
      resetAmbientState();
      for (const client of clients.current.values()) client.close();
      clients.current.clear();
      setSamples((current) => (Object.keys(current).length ? {} : current));
      return undefined;
    }

    const plans = ambientModules.map((module) => ({
      module,
      points: ambientPoints(module),
      period: 1000 / ambientRate(module),
      next: 0,
    }));
    let busy = false;
    let disposed = false;

    const setStatus = (name: string, status: ObsStatus, patch: Partial<ObsModuleInfo> = {}) => {
      if (disposed) return;
      setObs((current) => ({
        ...current,
        [name]: { ...current[name], scenes: [], items: [], ...patch, status },
      }));
    };

    /** Соединение с OBS: одно на модуль, с ленивым подключением. */
    const connect = async (module: ModuleInstance): Promise<ObsClient | null> => {
      const existing = clients.current.get(module.name);
      if (existing?.connected) return existing;
      const client = existing ?? new ObsClient();
      clients.current.set(module.name, client);
      setStatus(module.name, { text: "Подключаюсь к OBS…", ok: false });
      try {
        const { host, port } = ambientConnection(module);
        await client.connect(host, port, obsPassword());
        const scenes = await client.scenes();
        const wanted = ambientPoints(module).find((point) => point.source.kind === "obs")?.source.scene;
        const scene = wanted || scenes[0] || "";
        const items = scene ? await client.items(scene) : [];
        setStatus(module.name, { text: `OBS подключён: сцен ${scenes.length}`, ok: true }, { scenes, items });
        return client;
      } catch (reason) {
        setStatus(module.name, { text: describe(reason), ok: false });
        client.close();
        clients.current.delete(module.name);
        return null;
      }
    };

    /**
     * Что просит точка у OBS.
     *
     * Без `follow` — сам источник: точка задана в долях его картинки, и
     * двигать её незачем. С `follow` — сцена целиком и область по
     * трансформации: окно уехало, точка уехала вместе с ним.
     */
    const askOf = (point: AmbientPoint): { follow: boolean; target: string } => {
      const follow = point.follow && !!point.source.item;
      const target = follow
        ? point.source.scene
        : point.source.item || point.source.scene;
      return { follow, target };
    };

    const areaOf = async (
      client: ObsClient,
      point: AmbientPoint,
      video: ObsVideoSettings,
    ): Promise<SampleArea> => {
      if (!point.follow || !point.source.item) return areaOnFrame(point.area);
      const transform = await client.transform(point.source.scene, point.source.item);
      // Источник пропал из сцены (переименовали) — смотрим туда, куда просили.
      return transform ? areaOnScene(point.area, transform, video) : areaOnFrame(point.area);
    };

    const tick = async () => {
      if (busy || disposed) return;
      busy = true;
      try {
        const now = typeof performance === "undefined" ? Date.now() : performance.now();
        const next: Record<string, Record<string, Rgba>> = {};
        let changed = false;
        for (const plan of plans) {
          const previous = samplesRef.current[plan.module.name] ?? {};
          const perModule: Record<string, Rgba> = { ...previous };

          // Своя сцена: просим кадр на каждом такте, читаем ближайший готовый.
          if (plan.points.some((point) => point.source.kind === "scene")) sceneSampler.request();

          const due = now >= plan.next || reconnect.current.has(plan.module.name);
          if (!due) {
            if (Object.keys(perModule).length) next[plan.module.name] = perModule;
            continue;
          }
          plan.next = now + plan.period;

          for (const point of plan.points) {
            if (point.source.kind !== "scene") continue;
            const color = sceneSampler.sample(point.area, point.blur);
            if (!color) continue;
            perModule[point.name] = color;
            changed = true;
          }

          const obsPoints = plan.points.filter((point) => point.source.kind === "obs");
          if (obsPoints.length) {
            const client = await connect(plan.module);
            if (client) {
              reconnect.current.delete(plan.module.name);
              const video = await client.video();
              // Точки, которым нужна одна и та же картинка, делят один скриншот.
              const groups = new Map<string, { target: string; points: Array<{ point: AmbientPoint; area: SampleArea }> }>();
              for (const point of obsPoints) {
                const { follow, target } = askOf(point);
                const key = `${follow ? "scene" : "item"}:${target}`;
                const group = groups.get(key) ?? { target, points: [] };
                group.points.push({ point, area: await areaOf(client, point, video) });
                groups.set(key, group);
              }
              for (const group of groups.values()) {
                const url = await client.screenshot(group.target);
                if (!url) continue;
                for (const item of group.points) {
                  const color = await sampleImage(url, item.area, item.point.blur);
                  if (!color) continue;
                  perModule[item.point.name] = color;
                  changed = true;
                }
              }
            }
          }

          if (Object.keys(perModule).length) next[plan.module.name] = perModule;
        }
        if (changed && !disposed) setSamples(next);
      } catch {
        // Один неудачный такт не должен останавливать замеры: соединение
        // переподключится на следующем.
      } finally {
        busy = false;
      }
    };

    void tick();
    const step = Math.max(AMBIENT_TICK, Math.round(Math.min(...plans.map((plan) => plan.period)) / 2));
    const timer = window.setInterval(() => void tick(), step);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      sceneSampler.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, active]);

  useEffect(() => () => {
    for (const client of clients.current.values()) client.close();
    clients.current.clear();
  }, []);

  return { samples, obs, probe };
}

function describe(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return String(reason);
}
