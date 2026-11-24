import {test,expect} from "@playwright/test";
import {readWorkTotals,countDraw,countFrame,countDelivery,takeWork,resetMeter} from "../../src/engine/meter";
import {workDelta,summarizeDelays,collectPerformanceReport} from "../../src/engine/performanceReport";

test("diagnostic totals survive status polling and resets",()=>{
  const before=readWorkTotals();countDraw(3);countDraw(5);countFrame();countDelivery(2);
  takeWork();resetMeter();
  const delta=workDelta(before,readWorkTotals(),2);
  expect(delta).toMatchObject({draws:2,frames:1,drawsPerSecond:1,framesPerSecond:.5,drawMeanMs:4,deliveryMeanMs:2});
  const snapshot=readWorkTotals();snapshot.draws=0;
  expect(readWorkTotals().draws).not.toBe(0);
});
test("delay summary has deterministic p95 and handles no samples",()=>{
  expect(summarizeDelays([])).toEqual({samples:0,meanMs:0,p95Ms:0,maxMs:0});
  expect(summarizeDelays([100,0,10,5])).toEqual({samples:4,meanMs:28.75,p95Ms:100,maxMs:100});
});
test("no draws/deliveries produces finite zero means",()=>{
  const totals=readWorkTotals();const result=workDelta(totals,totals,15);
  expect(result.drawMeanMs).toBe(0);expect(result.deliveryMeanMs).toBe(0);
});

async function withEnvironment(run:(events:EventTarget)=>Promise<void>) {
  const originalWindow=Object.getOwnPropertyDescriptor(globalThis,"window");
  const originalDocument=Object.getOwnPropertyDescriptor(globalThis,"document");
  const events=new EventTarget();
  Object.defineProperty(globalThis,"window",{configurable:true,value:{setInterval,devicePixelRatio:1,innerWidth:1000,innerHeight:700}});
  Object.defineProperty(globalThis,"document",{configurable:true,value:Object.assign(events,{
    hidden:false,querySelectorAll:()=>[],getElementsByTagName:()=>[],getAnimations:()=>[],
  })});
  try {await run(events);} finally {
    if(originalWindow)Object.defineProperty(globalThis,"window",originalWindow);else Reflect.deleteProperty(globalThis,"window");
    if(originalDocument)Object.defineProperty(globalThis,"document",originalDocument);else Reflect.deleteProperty(globalThis,"document");
  }
}
test("collector produces copyable report, detects visibility, excludes project data",async()=>{
  await withEnvironment(async events=>{
    let mode="playing";
    const promise=collectPerformanceReport(()=>({mode,objects:2}),new AbortController().signal,120);
    mode="paused";events.dispatchEvent(new Event("visibilitychange"));
    const text=await promise;
    const report=JSON.parse(text.slice(text.indexOf("\n")+1));
    expect(report.contextStart.mode).toBe("playing");expect(report.contextEnd.mode).toBe("paused");
    expect(report.validity.visibilityChanges).toBe(1);
    expect(report.work.seconds).toBeGreaterThan(0);
    expect(report.mainThreadTimerDelay.samples).toBeGreaterThan(0);
    expect(report.longTasks.supported).toBe(false);
    expect(text).not.toContain("presetPath");expect(report.limitations.length).toBeGreaterThan(0);
  });
});
test("collector can be cancelled without waiting for the measurement",async()=>{
  await withEnvironment(async()=>{
    const abort=new AbortController();
    const promise=collectPerformanceReport(()=>({}),abort.signal,15000);
    abort.abort();await expect(promise).rejects.toMatchObject({name:"AbortError"});
  });
});
