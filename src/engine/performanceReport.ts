import {startRenderProfile} from "./renderProfile";
import {startFrameRetentionProbe} from "./frameRetention";
import {nativeProbeAvailable,nativePerformanceSnapshot,summarizeNative,type NativePoint} from "./nativePerformance";
import {readWorkTotals,readCapture,readResources,readSceneWakes} from "./meter";
import {readMemory} from "./memory";
import {meshRenderBackend} from "../render/mesh";

export function workDelta(start:ReturnType<typeof readWorkTotals>,end:ReturnType<typeof readWorkTotals>,seconds:number) {
  const draws=end.draws-start.draws,deliveries=end.deliveries-start.deliveries;
  return {seconds,appCommits:end.appCommits-start.appCommits,
    prepareMs:end.prepareMs-start.prepareMs,sinkMs:end.sinkMs-start.sinkMs,draws,frames:end.frames-start.frames,arrivals:end.arrivals-start.arrivals,
    drawsPerSecond:draws/seconds,framesPerSecond:(end.frames-start.frames)/seconds,
    drawTotalMs:end.drawMs-start.drawMs,drawMeanMs:draws?(end.drawMs-start.drawMs)/draws:0,
    deliveryTotalMs:end.deliveryMs-start.deliveryMs,deliveryMeanMs:deliveries?(end.deliveryMs-start.deliveryMs)/deliveries:0};
}
export function summarizeDelays(samples:number[]) {
  const sorted=[...samples].sort((a,b)=>a-b);
  return {samples:sorted.length,meanMs:sorted.length?sorted.reduce((a,b)=>a+b,0)/sorted.length:0,
    p95Ms:sorted.length?sorted[Math.ceil(sorted.length*.95)-1]:0,maxMs:sorted.at(-1)??0};
}
/** Passive 15s observation, not a synthetic stress test. Timer only while running. */
export async function collectPerformanceReport(context:()=>object,signal:AbortSignal,duration=15000):Promise<string> {
  const startContext=context(),start=readWorkTotals(),memoryStart=readMemory(),began=performance.now();
  const wakeStart=readSceneWakes();
  const delays:number[]=[];
  const nativePoints:NativePoint[]=[];
  const nativeErrors:string[]=[];
  const workTimeline:Array<{atMs:number;heapUsed:number|null;work:ReturnType<typeof readWorkTotals>}>=[];
  let nativeBusy=false,nativePending:Promise<void>|undefined;
  let collecting=true;
  const sampleNative=()=>{
    if(!collecting||nativeBusy||!nativeProbeAvailable()||nativeErrors.length) return;
    nativeBusy=true;
    nativePending=nativePerformanceSnapshot().then(data=>{
      if(collecting) nativePoints.push({atMs:performance.now()-began,data});
    },()=>{if(collecting)nativeErrors.push("Нативные счётчики недоступны: пересоберите приложение с новым Rust-кодом или проверьте поддержку ОС.");}).finally(()=>{nativeBusy=false;});
  };
  sampleNative();
  const nativeTimer=window.setInterval(()=>{
    workTimeline.push({atMs:performance.now()-began,
      heapUsed:(performance as unknown as {memory?:{usedJSHeapSize:number}}).memory?.usedJSHeapSize??null,
      work:readWorkTotals()});
    sampleNative();
  },1000);
  let hidden=document.hidden,visibilityChanges=0,longTasks=0,longTaskMs=0;
  const visibility=()=>{hidden ||= document.hidden;visibilityChanges++;};
  document.addEventListener("visibilitychange",visibility);
  let observer:PerformanceObserver|undefined;
  const longTasksSupported=typeof PerformanceObserver!=="undefined"&&PerformanceObserver.supportedEntryTypes?.includes("longtask");
  if(longTasksSupported) {
    observer=new PerformanceObserver(list=>{for(const entry of list.getEntries()){longTasks++;longTaskMs+=entry.duration;}});
    observer.observe({entryTypes:["longtask"]});
  }
  let due=performance.now()+100;
  const timer=window.setInterval(()=>{const now=performance.now();delays.push(Math.max(0,now-due));due=now+100;},100);
  const retention=startFrameRetentionProbe();
  const renderProfile=startRenderProfile();
  try {
    await new Promise<void>((resolve,reject)=>{
      const abort=()=>{clearTimeout(timeout);reject(new DOMException("Отменено","AbortError"));};
      const timeout=setTimeout(()=>{signal.removeEventListener("abort",abort);resolve();},duration);
      signal.addEventListener("abort",abort,{once:true});
      if(signal.aborted) {signal.removeEventListener("abort",abort);abort();}
    });
    // Do not await a native IPC during cancellation; one in-flight probe may
    // finish but cannot install timers or change UI after cleanup.
    clearInterval(nativeTimer);
    sampleNative();
    if(nativePending) await Promise.race([nativePending,new Promise<void>(resolve=>setTimeout(resolve,250))]);
    if(signal.aborted) throw new DOMException("Отменено","AbortError");
    const seconds=(performance.now()-began)/1000;
    return "YappyTuberPlus · диагностика производительности v2\n"+JSON.stringify({
      date:new Date().toISOString(),contextStart:startContext,contextEnd:context(),
      environment:{userAgent:navigator.userAgent,logicalCores:navigator.hardwareConcurrency??null,
        dpr:window.devicePixelRatio,viewport:[window.innerWidth,window.innerHeight],meshBackend:meshRenderBackend()},
      native:{available:nativeProbeAvailable(),
        status:!nativeProbeAvailable()?"browser-unavailable":nativeErrors.length?"unavailable":nativePoints.length<2?"insufficient-samples":"measured",
        errors:nativeErrors,...summarizeNative(nativePoints)},
      sceneWakeRequests:Object.fromEntries(Object.entries(readSceneWakes()).map(([reason,count])=>[reason,count-(wakeStart[reason]??0)])),
      workTimeline,work:workDelta(start,readWorkTotals(),seconds),mainThreadTimerDelay:summarizeDelays(delays),
      longTasks:{supported:!!longTasksSupported,count:longTasks,totalMs:longTaskMs},
      validity:{hiddenDuringTest:hidden,visibilityChanges},
      renderStages:renderProfile.snapshot(),
      frameRetention:retention.snapshot(),
      capture:readCapture(),memoryStart,memoryEnd:readMemory(),resources:readResources(),
      animations:document.getAnimations?.().filter(a=>a.playState==="running").length??null,
      playingMedia:Array.from(document.querySelectorAll("audio,video")).filter(e=>!(e as HTMLMediaElement).paused).length,
      limitations:["CPU: 100% = заняты все логические ядра. Сумма дерева приложения; неполное покрытие указано в cpuCoverage. Не сравнивать с одноядерной шкалой 100%.",
        "GPU utilization/time и чистое IPC-время недоступны. Rust callMs — wall time call_json (включая JSON), не CPU time потока; emitMs — отправка события, не получение JS.",
        "Рабочие наборы процессов могут включать общие страницы: их сумма не равна уникальной физической памяти. Private bytes Windows — private commit, не private working set.",
        "Короткоживущие/завершённые между пробами процессы и процессы вне дерева не включены. Доступ и частота семплов ограничивают точность.",
        "drawMs — CPU-время отправки команд сцены, не GPU-время; deliveryMs — JS-подготовка и синхронная доставка, не Rust/IPC.",
        "renderStages — исключающее вложенные проходы wall time в этом окне: scene = остальная работа редактора, rig = подготовка/выбор прохода, plain = обвязка обычного прохода, mask = обвязка маски, shaded = освещение без вложенных mask/plain; sprite/text/light/shape/media = содержимое по типу, вычтенное из родителей; image = прямой drawImage спрайта, warp/mesh = общие функции деформации (также media/shape), вычтены из типов содержимого; mesh-upload/mesh-submit/mesh-composite/mesh-geometry/mesh-surface вычтены из mesh; surface включает bounds/resize/viewport/clear. Не GPU, не время OBS; maxMs относится к исключающему времени вызова.",
        "Память — доступная JS-куча и оценки ресурсов, не вся память процесса. 0 heapLimit означает недоступность счётчика.",
        "frameRetention — слабые ссылки на выборку кадров только за этот тест, не объём памяти. Живой кадр не доказывает утечку: GC мог ещё не запускаться; collected подтверждает освобождение выбранного объекта. Canvas/GPU и объекты до теста не охвачены.",
        "Таймер 100 мс создаёт небольшую нагрузку только во время теста. Замер не меняет режим воспроизведения."]
    },(_key,value:unknown)=>typeof value==="number"?Math.round(value*100)/100:value,2);
  } finally {renderProfile.stop();retention.stop();collecting=false;clearInterval(nativeTimer);clearInterval(timer);observer?.disconnect();document.removeEventListener("visibilitychange",visibility);}
}
