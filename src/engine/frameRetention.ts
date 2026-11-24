/** Passive sampled reachability, not a leak detector. No strong frame references,
 * finalizers, forced GC, polling timer or application state updates. */
export type FrameStage = "received" | "prepared" | "meshes";
interface Reference {deref(): object | undefined}
type Factory = (value:object)=>Reference;
const stages:FrameStage[]=["received","prepared","meshes"];
const MAX_SAMPLES=120;
const SAMPLE_INTERVAL_MS=1000;

export class FrameRetentionProbe {
  private samples=new Map<FrameStage,Array<{at:number;ref:Reference}>>();
  private last=new Map<FrameStage,number>();
  private stopped=false;
  constructor(private readonly makeRef:Factory|null=typeof WeakRef==="function"?value=>new WeakRef(value):null){}
  observe(stage:FrameStage,value:object,now:number):void {
    if(this.stopped||!this.makeRef)return;
    const previous=this.last.get(stage);
    if(previous!==undefined&&now-previous<SAMPLE_INTERVAL_MS)return;
    this.last.set(stage,now);
    let samples=this.samples.get(stage);
    if(!samples){samples=[];this.samples.set(stage,samples);}
    if(samples.length===MAX_SAMPLES)samples.shift();
    samples.push({at:now,ref:this.makeRef(value)});
  }
  snapshot(now:number){
    return {supported:!!this.makeRef,sampleIntervalMs:SAMPLE_INTERVAL_MS,maxSamplesPerStage:MAX_SAMPLES,
      stages:Object.fromEntries(stages.map(stage=>{
        const samples=this.samples.get(stage)??[];
        let alive=0,aliveOlderThan10s=0,oldestAliveMs:number|null=null;
        for(const sample of samples)if(sample.ref.deref()!==undefined){
          alive++;const age=Math.max(0,now-sample.at);
          if(age>=10000)aliveOlderThan10s++;
          oldestAliveMs=Math.max(oldestAliveMs??0,age);
        }
        return [stage,{sampled:samples.length,alive,collected:samples.length-alive,aliveOlderThan10s,oldestAliveMs}];
      }))};
  }
  stop():void {this.stopped=true;this.samples.clear();this.last.clear();}
}
let active:FrameRetentionProbe|null=null;
/** A newer diagnostic replaces an older probe; cleanup is ownership-safe. */
export function startFrameRetentionProbe(){
  active?.stop();
  const probe=new FrameRetentionProbe();active=probe;
  return {snapshot:()=>probe.snapshot(performance.now()),stop:()=>{probe.stop();if(active===probe)active=null;}};
}
export function observeFrameRetention(stage:FrameStage,value:object):void {
  if(active)active.observe(stage,value,performance.now());
}
