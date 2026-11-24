import {test,expect} from "@playwright/test";
import {processInterval,summarizeNative,type NativePoint,type ProcessSample} from "../../src/engine/nativePerformance";
const proc=(pid:number,cpu:number|null,extra:Partial<ProcessSample>={}):ProcessSample=>({pid,parentPid:1,name:"test",identity:`${pid}:creation`,cpuSeconds:cpu,residentBytes:100,privateBytes:50,error:null,...extra});
function point(atMs:number,processes:ProcessSample[]):NativePoint{return {atMs,data:{rootPid:1,logicalCores:4,platform:"windows",processes,calls:2,callMs:3,emits:1,emitMs:1,responseBytes:100,probeMs:2}};}

test("tree CPU is normalized by cores; children have separate timings",()=>{
  const a=point(0,[proc(1,10),proc(2,20)]),b=point(1000,[proc(1,11),proc(2,22)]);
  const interval=processInterval(a,b);
  expect(interval.cpuPercent).toBe(75);
  expect(interval.processes.map(p=>p.cpuPercent)).toEqual([25,50]);
  expect(interval.residentBytes).toBe(200);expect(interval.privateBytes).toBe(100);
});
test("PID reuse, newly started and inaccessible processes are unknown not zero",()=>{
  const a=point(0,[proc(1,10),proc(2,20)]);
  const b=point(1000,[proc(1,0,{identity:"1:new"}),proc(3,null,{residentBytes:null,privateBytes:null,error:"denied"})]);
  const interval=processInterval(a,b);
  expect(interval.cpuPercent).toBeNull();expect(interval.cpuCoverage).toEqual({measured:0,current:2,exited:2});
  expect(interval.processes.every(p=>p.cpuPercent===null)).toBe(true);
});
test("weighted CPU means tolerate uneven polling and report sampled peaks",()=>{
  const report=summarizeNative([point(0,[proc(1,0)]),point(1000,[proc(1,1)]),point(3000,[proc(1,1)])]);
  expect(report.meanCpuPercent).toBeCloseTo(25/3);expect(report.peakSampleCpuPercent).toBe(25);
  expect(report.timeline).toHaveLength(2);
  expect(summarizeNative([]).meanCpuPercent).toBeNull();
});
test("absent memory remains unknown; no division by zero",()=>{
  const a=point(0,[proc(1,0,{residentBytes:null,privateBytes:null})]);
  const interval=processInterval(a,a);
  expect(interval.cpuPercent).toBeNull();expect(interval.residentBytes).toBeNull();expect(interval.privateBytes).toBeNull();
});
