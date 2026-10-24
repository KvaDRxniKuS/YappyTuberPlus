import { useEffect, useState } from "react";
import {
  libraryStatus, moduleLibrary, onLibraryChange, refreshLibrary, type ModuleDefinition,
} from "../modules/registry";

export interface ModuleLibraryState {
  definitions: ModuleDefinition[];
  /** Папка `modules` прочитана: до этого шаблоны ещё неизвестны. */
  ready: boolean;
  error: string | null;
  /** Счётчик обновлений: им подписываются расчёты входов. */
  version: number;
}

/**
 * Библиотека шаблонов модулей из папки `modules`.
 *
 * Читается во время работы приложения, поэтому новый JSON подхватывается без
 * пересборки. Возвращает счётчик версий: по нему пересчитываются входы, когда
 * шаблоны наконец загрузились.
 */
export function useModuleLibrary(): ModuleLibraryState {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const off = onLibraryChange(() => setVersion((current) => current + 1));
    if (!libraryStatus().ready) void refreshLibrary();
    return off;
  }, []);
  const status = libraryStatus();
  return { definitions: moduleLibrary(), ready: status.ready, error: status.error, version };
}
