import {readWorkTotals,readCapture,readResources} from "./meter";
import {readMemory} from "./memory";
import {meshRenderBackend} from "../render/mesh";

export function workDelta(start:ReturnType<typeof readWorkTotals>,end:ReturnType<typeof readWorkTotals>,seconds:number) {
  const draws=end.draws-start.draws,deliveries=end.deliveries-start.deliveries;
  return {seconds,draws,frames:end.frames-start.frames,arrivals:end.arrivals-start.arrivals,
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
  const delays:number[]=[];
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
  try {
    await new Promise<void>((resolve,reject)=>{
      const abort=()=>{clearTimeout(timeout);reject(new DOMException("Отменено","AbortError"));};
      const timeout=setTimeout(()=>{signal.removeEventListener("abort",abort);resolve();},duration);
      signal.addEventListener("abort",abort,{once:true});
      if(signal.aborted) {signal.removeEventListener("abort",abort);abort();}
    });
    const seconds=(performance.now()-began)/1000;
    return "YappyTuberPlus · диагностика производительности v1\n"+JSON.stringify({
      date:new Date().toISOString(),contextStart:startContext,contextEnd:context(),
      environment:{userAgent:navigator.userAgent,logicalCores:navigator.hardwareConcurrency??null,
        dpr:window.devicePixelRatio,viewport:[window.innerWidth,window.innerHeight],meshBackend:meshRenderBackend()},
      work:workDelta(start,readWorkTotals(),seconds),mainThreadTimerDelay:summarizeDelays(delays),
      longTasks:{supported:!!longTasksSupported,count:longTasks,totalMs:longTaskMs},
      validity:{hiddenDuringTest:hidden,visibilityChanges},
      capture:readCapture(),memoryStart,memoryEnd:readMemory(),resources:readResources(),
      animations:document.getAnimations?.().filter(a=>a.playState==="running").length??null,
      playingMedia:Array.from(document.querySelectorAll("audio,video")).filter(e=>!(e as HTMLMediaElement).paused).length,
      limitations:["CPU процесса, GPU time, время Rust и IPC этим отчётом не измеряются.",
        "drawMs — CPU-время отправки команд сцены, не GPU-время; deliveryMs — JS-подготовка и синхронная доставка, не Rust/IPC.",
        "Память — доступная JS-куча и оценки ресурсов, не вся память процесса. 0 heapLimit означает недоступность счётчика.",
        "Таймер 100 мс создаёт небольшую нагрузку только во время теста. Замер не меняет режим воспроизведения."]
    },(_key,value:unknown)=>typeof value==="number"?Math.round(value*100)/100:value,2);
  } finally {clearInterval(timer);observer?.disconnect();document.removeEventListener("visibilitychange",visibility);}
}
