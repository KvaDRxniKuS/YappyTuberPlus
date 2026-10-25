/**
 * Сигнал «готов новый кадр».
 *
 * Раньше и редактор, и оверлей крутили постоянный `requestAnimationFrame` и
 * каждый кадр спрашивали `frameRef.current.seq` — «не появилось ли нового».
 * Пустой, но вечный rAF заставляет WebView собирать композитный кадр 60 раз в
 * секунду даже когда картинка не менялась: именно это и давало лишние
 * проценты процессора в простое.
 *
 * Теперь отрисовка идёт по требованию: движок после каждого готового кадра
 * зовёт `frameProduced()`, а окна планируют один кадр отрисовки на ближайший
 * `requestAnimationFrame`. Нет новых кадров и нет правок — нет и работы.
 */

type Listener = () => void;

const listeners = new Set<Listener>();

/** Подписка на новые кадры. Возвращает функцию отписки. */
export function onFrameProduced(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Вызывается движком один раз на каждый готовый кадр. */
export function frameProduced(): void {
  for (const listener of listeners) listener();
}

/**
 * Отрисовка по требованию: не больше одного кадра на `requestAnimationFrame`,
 * и ни одного кадра, пока не попросили.
 */
export function createOnDemandLoop(draw: () => void): { request: () => void; stop: () => void } {
  let scheduled = 0;
  let stopped = false;
  const run = () => {
    scheduled = 0;
    if (!stopped) draw();
  };
  return {
    request() {
      if (stopped || scheduled) return;
      scheduled = requestAnimationFrame(run);
    },
    stop() {
      stopped = true;
      if (scheduled) cancelAnimationFrame(scheduled);
      scheduled = 0;
    },
  };
}
