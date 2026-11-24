/**
 * Счётчики живой работы окна: отрисовки сцены и кадры движка.
 *
 * Нужны, чтобы отвечать на вопрос «кто греет процессор» фактом, а не догадкой:
 * в паузе и в стопе счётчики обязаны стоять на нуле. Считаем дёшево — по
 * инкременту на событие, без таймеров и без состояния React.
 */

const totals={draws:0,frames:0,arrivals:0,drawMs:0,deliveryMs:0,deliveries:0};
/** Non-destructive counters: status polling/reset cannot disturb a diagnostic run. */
export function readWorkTotals(){return {...totals};}
export function countDelivery(ms:number){totals.deliveryMs+=ms;totals.deliveries++;}
const counters = { draws: 0, frames: 0, arrivals: 0 };
let drawTime=0,drawPeak=0;
let since = typeof performance === "undefined" ? Date.now() : performance.now();

/** Кадр отрисовки сцены (редактор или оверлей). */
export function countDraw(milliseconds=0): void {
  totals.draws++;totals.drawMs+=milliseconds;
  counters.draws += 1;
  drawTime+=milliseconds;drawPeak=Math.max(drawPeak,milliseconds);
}

/** Кадр, доехавший до окон: движок его посчитал и отдал. */
export function countFrame(): void {
  totals.frames++;
  counters.frames += 1;
}

/** Кадр, пришедший в окно от планировщика, — даже если он потом отброшен. */
export function countArrival(): void {
  totals.arrivals++;
  counters.arrivals += 1;
}

export interface WorkRates {
  drawMs: number;
  drawPeak: number;
  /** Отрисовок сцены в секунду. */
  draws: number;
  /** Кадров движка в секунду. */
  frames: number;
  /** Кадров, пришедших от планировщика, в секунду. */
  arrivals: number;
}

/** Средние частоты с прошлого вызова (окно — фактическое время между вызовами). */
export function takeWork(): WorkRates {
  const now = typeof performance === "undefined" ? Date.now() : performance.now();
  const seconds = Math.max(0.2, (now - since) / 1000);
  const rates: WorkRates = {
    drawMs:Math.round(drawTime/Math.max(1,counters.draws)*10)/10,
    drawPeak:Math.round(drawPeak*10)/10,
    draws: Math.round(counters.draws / seconds),
    frames: Math.round(counters.frames / seconds),
    arrivals: Math.round(counters.arrivals / seconds),
  };
  drawTime=0;drawPeak=0;
  counters.draws = 0;
  counters.frames = 0;
  counters.arrivals = 0;
  since = now;
  return rates;
}

/**
 * Захват звука: сколько микрофонов подключено и в каком состоянии контекст.
 *
 * Это единственная живая работа, которую не видно ни по кадрам, ни по
 * отрисовкам: `AudioContext` с анализаторами тянет данные сам, поэтому и в
 * паузе, и в стопе он греет процессор. Счётчик показывает его прямо в строке
 * статуса.
 */
let capture = { streams: 0, state: "closed" };

export function setCapture(streams: number, state: string): void {
  capture = { streams, state };
}

export function readCapture(): { streams: number; state: string } {
  return capture;
}

/** Мгновенный сброс метки времени: при смене состояния не мерить «старое» окно. */
export function resetMeter(): void {
  drawTime=0;drawPeak=0;
  counters.draws = 0;
  counters.frames = 0;
  counters.arrivals = 0;
  since = typeof performance === "undefined" ? Date.now() : performance.now();
}

/** Известные декодированные кадры и GPU-хранилища, не вся память процесса. */
export interface ResourceEstimate {
  images: number;
  imageBytes: number;
  videos: number;
  videoBytes: number;
  textures: number;
  textureBytes: number;
  bufferBytes: number;
  offscreenCanvases: number;
  offscreenCanvasBytes: number;
}

const EMPTY_RESOURCES: ResourceEstimate = {
  images: 0, imageBytes: 0, videos: 0, videoBytes: 0,
  textures: 0, textureBytes: 0, bufferBytes: 0,
  offscreenCanvases: 0, offscreenCanvasBytes: 0,
};
const resourceOwners = new Map<object, ResourceEstimate>();

/** Опубликовать оценку одного владельца кеша; вызывается при изменении ресурсов. */
export function reportResources(owner: object, estimate: Partial<ResourceEstimate>): void {
  resourceOwners.set(owner, { ...EMPTY_RESOURCES, ...estimate });
}

/** Удалить оценку при размонтировании владельца. */
export function forgetResources(owner: object): void {
  resourceOwners.delete(owner);
}

/** Сумма только известных RGBA-ресурсов всех живых подсистем окна. */
export function readResources(): ResourceEstimate {
  const total = { ...EMPTY_RESOURCES };
  for (const estimate of resourceOwners.values()) {
    total.images += estimate.images;
    total.imageBytes += estimate.imageBytes;
    total.videos += estimate.videos;
    total.videoBytes += estimate.videoBytes;
    total.textures += estimate.textures;
    total.textureBytes += estimate.textureBytes;
    total.bufferBytes += estimate.bufferBytes;
    total.offscreenCanvases += estimate.offscreenCanvases;
    total.offscreenCanvasBytes += estimate.offscreenCanvasBytes;
  }
  return total;
}
