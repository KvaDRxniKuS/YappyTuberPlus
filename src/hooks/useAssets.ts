import { useEffect, useMemo, useState } from "react";
import { assetUrl, onAssetsChanged } from "../engine/assets";

/**
 * Счётчик изменений хранилища файлов.
 *
 * Файл читается из IndexedDB асинхронно, поэтому `assetUrl()` до готовности
 * возвращает `null`. Этот счётчик заставляет React перерисовать превью в
 * инспекторе и дереве, когда файл наконец появился.
 */
export function useAssetsVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => onAssetsChanged(() => setVersion((value) => value + 1)), []);
  return version;
}

/** Готовый URL картинки объекта (или медиа) для превью. */
export function useAssetUrl(source: string | null | undefined): string | null {
  const version = useAssetsVersion();
  return useMemo(() => assetUrl(source), [source, version]);
}
