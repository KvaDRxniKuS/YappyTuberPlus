import { useCallback, useEffect, useState } from "react";

const FAVORITES_KEY = "yappytuberplus.favorites.v1";

function load(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(FAVORITES_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

/**
 * Избранные команды скрипта: список имён функций, помеченных звёздочкой.
 *
 * Живут в браузере, а не в пресете: это привычка автора, а не часть рига,
 * поэтому один и тот же пресет на другой машине не тащит чужие закладки.
 */
export function useFavorites() {
  const [favorites, setFavorites] = useState<string[]>(load);

  useEffect(() => {
    try {
      localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites));
    } catch {
      /* приватный режим: закладки просто не переживут перезагрузку */
    }
  }, [favorites]);

  const toggle = useCallback((name: string) => {
    setFavorites((current) => (current.includes(name)
      ? current.filter((item) => item !== name)
      : [...current, name]));
  }, []);

  return { favorites, toggle };
}
