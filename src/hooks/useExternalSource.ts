import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ModuleInstance } from "../types";
import { moduleDefinition } from "../modules/registry";
import { ExternalSourceHost, sourceConfig, type ExternalStatus } from "../modules/sources";

/** Кадр значений: 30 раз в секунду хватает, а поток пакетов не превращается в поток перерисовок. */
const TICK = 33;

export interface ExternalInputsApi {
  /** Готовые значения по имени модуля: `{ bridge: { hr: 72 } }`. */
  values: Record<string, Record<string, number>>;
  /** Состояние каждого источника: подключён, ждёт, ошибка. */
  statuses: Record<string, ExternalStatus>;
  /** Вход в Twitch по коду: кнопка в карточке модуля. */
  authorize: (name: string) => void;
  /** Забыть токен Twitch (он живёт в профиле окна). */
  signOut: (name: string) => void;
}

/**
 * Внешние источники как входы модулей.
 *
 * Один хост на приложение держит сокеты: два модуля с одинаковым адресом делят
 * соединение, выключение модуля закрывает его. Пакеты складываются в хосте, а
 * окно забирает снимок раз в тик — так 120 пакетов в секунду дают 30 обновлений
 * React, а не 120.
 */
export function useExternalSource(modules: ModuleInstance[], libraryVersion = 0): ExternalInputsApi {
  const hostRef = useRef<ExternalSourceHost | null>(null);
  if (!hostRef.current) hostRef.current = new ExternalSourceHost();
  const [values, setValues] = useState<Record<string, Record<string, number>>>({});
  const [statuses, setStatuses] = useState<Record<string, ExternalStatus>>({});

  const active = useMemo(
    () => modules.filter((module) => module.enabled && moduleDefinition(module.type).kind === "external"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [modules, libraryVersion],
  );
  // Ключ — адрес и правила: правка таблицы перезапускает только этот источник.
  const activeKey = JSON.stringify(active.map((module) => [module.name, sourceConfig(module)]));

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.sync(active.map((module) => ({ name: module.name, source: sourceConfig(module) })));
    if (active.length === 0) {
      setValues({});
      setStatuses({});
      return;
    }
    const tick = () => {
      const nextValues: Record<string, Record<string, number>> = {};
      for (const module of active) nextValues[module.name] = host.values(module.name);
      setValues((current) => sameNested(current, nextValues) ? current : nextValues);
      const nextStatuses = host.statuses();
      setStatuses((current) => sameStatuses(current, nextStatuses) ? current : nextStatuses);
    };
    tick();
    const timer = window.setInterval(tick, TICK);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey]);

  useEffect(() => () => hostRef.current?.dispose(), []);

  const authorize = useCallback((name: string) => {
    void hostRef.current?.authorize(name);
    // Состояние придёт событием канала: панель обновится сама.
  }, []);

  const signOut = useCallback((name: string) => {
    hostRef.current?.signOut(name);
  }, []);

  return { values, statuses, authorize, signOut };
}

function sameNested(left: Record<string, Record<string, number>>, right: Record<string, Record<string, number>>): boolean {
  const leftNames = Object.keys(left);
  if (leftNames.length !== Object.keys(right).length) return false;
  return leftNames.every((name) => {
    const a = left[name];
    const b = right[name];
    if (!b) return false;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => a[key] === b[key]);
  });
}

function sameStatuses(left: Record<string, ExternalStatus>, right: Record<string, ExternalStatus>): boolean {
  const names = Object.keys(left);
  if (names.length !== Object.keys(right).length) return false;
  return names.every((name) => {
    const a = left[name];
    const b = right[name];
    return !!b && a.state === b.state && a.message === b.message && a.packets === b.packets;
  });
}
