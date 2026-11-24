/** Headless retained-frame probe. Not a WebView/Canvas or native IPC profiler.
 * node --expose-gc scripts/profile-frame-memory.mjs [local-preset.json]
 * Optional: FRAMES_PER_BATCH=3600 BATCHES=5. No project data is written/logged.
 * GC is used ONLY in this offline probe, never in the application.
 */
import {readFileSync} from "node:fs";
import {setImmediate as yieldTurn} from "node:timers/promises";
import {createServer} from "vite";

if (typeof global.gc !== "function") throw new Error("Run node with --expose-gc");
const integer=(name,fallback,max)=>{
  const value=Number(process.env[name]??fallback);
  if(!Number.isInteger(value)||value<1||value>max)throw new Error(`Invalid ${name}`);
  return value;
};
const perBatch=integer("FRAMES_PER_BATCH",3600,36000);
const batches=integer("BATCHES",5,20);
const server=await createServer({configFile:false,server:{middlewareMode:true,watch:null},appType:"custom",logLevel:"error"});
let previous=null;
try {
  const {normalizePreset}=await server.ssrLoadModule("/src/engine/preset.ts");
  const {PRESET_FORMAT}=await server.ssrLoadModule("/src/version.ts");
  const {defaultMesh}=await server.ssrLoadModule("/src/engine/mesh.ts");
  const {neutralFrame,prepareFrame}=await server.ssrLoadModule("/src/engine/frame.ts");
  const {prepareRigMeshes}=await server.ssrLoadModule("/src/render/rigCanvas.ts");
  const {sameVisualFrame}=await server.ssrLoadModule("/src/render/frameChanges.ts");
  const base={x:0,y:0,rotation:0,sizeX:1,sizeY:1,skewX:0,skewY:0,opacity:1,visible:1,layer:0};
  const mesh=defaultMesh();mesh.enabled=true;
  const raw=process.argv[2]?JSON.parse(readFileSync(process.argv[2],"utf8")):{
    version:PRESET_FORMAT,canvas:{width:1000,height:2000},objects:Array.from({length:36},(_,i)=>({
      id:`item_${i}`,name:"",kind:"sprite",image:null,base:{...base},width:200,height:100,
      pivot:{x:.5,y:.5},script:"x = sin(time)",parentId:i>0&&i<8?"item_0":null,
      ...(i===0?{mesh}:{}),
    })),
  };
  const preset=normalizePreset(raw);
  if(!preset)throw new Error("Unsupported preset");
  const refs=[];
  let produced=0;
  function batch(count,track){
    for(let i=0;i<count;i++){
      const frame=neutralFrame(preset,++produced);
      for(const values of Object.values(frame.objects))values.x=Math.sin(produced/60);
      const prepared=prepareFrame(preset,frame,undefined,{values:{},signals:{},previous});
      const meshes=prepareRigMeshes(preset,prepared);
      if(prepareRigMeshes(preset,prepared)!==meshes)throw new Error("Mesh cache identity changed");
      sameVisualFrame(previous,prepared);
      previous=prepared;
      if(track&&i%60===0){refs.push(new WeakRef(prepared),new WeakRef(meshes));}
    }
  }
  async function collect(){
    // WeakRef targets survive the current JS job; yield before testing reachability.
    for(let i=0;i<3;i++){await yieldTurn();global.gc();}
  }
  batch(600,false);await collect();
  const baseline=process.memoryUsage().heapUsed;
  console.log(JSON.stringify({scope:"neutral animated snapshots + prepareFrame + prepared meshes + visual comparison; no Canvas/React/native IPC",objects:preset.objects.length,baselineHeapBytes:baseline,framesPerBatch:perBatch}));
  for(let b=1;b<=batches;b++){
    batch(perBatch,true);await collect();
    const heap=process.memoryUsage().heapUsed;
    console.log(JSON.stringify({batch:b,frames:produced,heapUsed:heap,heapDelta:heap-baseline,tracked:refs.length,reachable:refs.filter(ref=>ref.deref()!==undefined).length}));
  }
  previous=null;await collect();
  const reachable=refs.filter(ref=>ref.deref()!==undefined).length;
  console.log(JSON.stringify({afterReleaseReachable:reachable,heapUsed:process.memoryUsage().heapUsed}));
  if(reachable!==0)throw new Error("Old sampled frames/mesh results remain reachable");
}finally{
  previous=null;
  await server.close();
}
