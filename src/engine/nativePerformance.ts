export interface ProcessSample {
  pid:number;parentPid:number;name:string;identity:string;cpuSeconds:number|null;
  residentBytes:number|null;privateBytes:number|null;error:string|null;
}
export interface NativeSnapshot {
  rootPid:number;logicalCores:number;platform:string;processes:ProcessSample[];
  calls:number;callMs:number;emits:number;emitMs:number;responseBytes:number;probeMs:number;
}
export interface NativePoint {atMs:number;data:NativeSnapshot}

/** CPU normalized like total-machine usage: 100% = all logical cores busy.
 * Only matching process identities count: never attribute a recycled PID. */
export function processInterval(a:NativePoint,b:NativePoint) {
  const elapsed=(b.atMs-a.atMs)/1000;
  const previous=new Map(a.data.processes.map(p=>[p.identity,p]));
  const processes=b.data.processes.map(p=>{
    const old=previous.get(p.identity);
    const cpu=old?.cpuSeconds!=null&&p.cpuSeconds!=null&&p.cpuSeconds>=old.cpuSeconds&&elapsed>0
      ? (p.cpuSeconds-old.cpuSeconds)/elapsed*100/Math.max(1,b.data.logicalCores):null;
    return {pid:p.pid,parentPid:p.parentPid,name:p.name,cpuPercent:cpu,residentBytes:p.residentBytes,privateBytes:p.privateBytes,error:p.error};
  });
  const known=processes.filter(p=>p.cpuPercent!==null);
  const sum=(key:"residentBytes"|"privateBytes")=>{
    const available=processes.filter(p=>p[key]!==null);
    return available.length?available.reduce((s,p)=>s+(p[key]??0),0):null;
  };
  return {elapsedSeconds:elapsed,atMs:b.atMs,cpuPercent:known.length?known.reduce((s,p)=>s+(p.cpuPercent??0),0):null,
    cpuCoverage:{measured:known.length,current:processes.length,exited:a.data.processes.filter(p=>!b.data.processes.some(n=>n.identity===p.identity)).length},
    residentBytes:sum("residentBytes"),privateBytes:sum("privateBytes"),
    memoryCoverage:{resident:processes.filter(p=>p.residentBytes!==null).length,private:processes.filter(p=>p.privateBytes!==null).length,current:processes.length},processes,
    rust:{calls:b.data.calls-a.data.calls,callMs:b.data.callMs-a.data.callMs,
      emits:b.data.emits-a.data.emits,emitMs:b.data.emitMs-a.data.emitMs,responseBytes:b.data.responseBytes-a.data.responseBytes},
    probeMs:b.data.probeMs};
}
export function summarizeNative(points:NativePoint[]) {
  const timeline=points.slice(1).map((p,i)=>processInterval(points[i],p));
  const measured=timeline.filter(p=>p.cpuPercent!==null&&p.elapsedSeconds>0);
  const time=measured.reduce((s,p)=>s+p.elapsedSeconds,0);
  return {samples:points.length,platform:points[0]?.data.platform??null,
    logicalCores:points[0]?.data.logicalCores??null,
    meanCpuPercent:time?measured.reduce((s,p)=>s+p.cpuPercent!*p.elapsedSeconds,0)/time:null,
    peakSampleCpuPercent:measured.length?Math.max(...measured.map(p=>p.cpuPercent!)):null,
    peakPrivateBytes:timeline.some(p=>p.privateBytes!==null)?Math.max(...timeline.map(p=>p.privateBytes??0)):null,
    peakResidentBytes:timeline.some(p=>p.residentBytes!==null)?Math.max(...timeline.map(p=>p.residentBytes??0)):null,
    timeline};
}

export function nativeProbeAvailable():boolean {
  return typeof window!=="undefined"&&"__TAURI_INTERNALS__" in window;
}
export async function nativePerformanceSnapshot():Promise<NativeSnapshot> {
  const {invoke}=await import("@tauri-apps/api/core");
  return invoke<NativeSnapshot>("performance_snapshot");
}
