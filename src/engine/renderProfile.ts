/** Report-scoped, exclusive wall timings. Only numeric aggregates, never scene refs. */
export type RenderStage = "scene" | "rig" | "plain" | "mask" | "shaded";
const stages: RenderStage[] = ["scene", "rig", "plain", "mask", "shaded"];
interface Counter { calls:number; totalMs:number; maxMs:number }
interface Span { stage:RenderStage; start:number; children:number }
export function createRenderProfile(clock:()=>number=()=>performance.now()) {
  const counters=Object.fromEntries(stages.map(s=>[s,{calls:0,totalMs:0,maxMs:0}])) as Record<RenderStage,Counter>;
  const stack:Span[]=[];
  let running=true;
  return {
    enter(stage:RenderStage) {
      if(!running)return undefined;
      const span:Span={stage,start:clock(),children:0};stack.push(span);
      return ()=>{
        if(!running||stack.at(-1)!==span)return;
        const elapsed=Math.max(0,clock()-span.start);stack.pop();
        if(stack.length)stack[stack.length-1].children+=elapsed;
        const own=Math.max(0,elapsed-span.children),counter=counters[stage];
        counter.calls++;counter.totalMs+=own;counter.maxMs=Math.max(counter.maxMs,own);
      };
    },
    snapshot:()=>Object.fromEntries(stages.map(s=>[s,{...counters[s]}])),
    stop(){running=false;stack.length=0;},
  };
}
let active:ReturnType<typeof createRenderProfile>|undefined;
export function enterRenderStage(stage:RenderStage){return active?.enter(stage);}
export function startRenderProfile(){
  const profile=createRenderProfile();active=profile;
  return {snapshot:profile.snapshot,stop(){profile.stop();if(active===profile)active=undefined;}};
}
