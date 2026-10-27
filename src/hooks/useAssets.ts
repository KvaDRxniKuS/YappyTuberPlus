import { useEffect, useMemo, useState } from "react";
import { assetMissing, assetUrl, onAssetsChanged } from "../engine/assets";

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

/**
 * Файла точно нет: его искали и не нашли.
 *
 * Отличается от «ещё грузится»: пока ссылка не разрешилась, превью тоже пустое,
 * и путать эти два состояния нельзя — иначе честное «файл не найден» мелькало
 * бы на каждом открытии панели.
 */
export function useAssetMissing(source: string | null | undefined): boolean {
  const version = useAssetsVersion();
  return useMemo(() => assetMissing(source), [source, version]);
}
