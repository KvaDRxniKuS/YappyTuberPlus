import {test,expect} from "@playwright/test";
import {CompositeBus,type OverlayBus,type BusKind} from "../../src/overlay/bus";
import {OverlayHost} from "../../src/overlay/host";
import {OVERLAY_PROTOCOL,type WireMessage} from "../../src/overlay/protocol";
import {createDemoPreset} from "../../src/data/demoPreset";
import {neutralFrame} from "../../src/engine/frame";
function wire(kind:BusKind){
  const sent:WireMessage[]=[];
  let listener:Parameters<OverlayBus["subscribe"]>[0]=()=>{};
  return {kind,label:kind,ready:true,sent,post(message:WireMessage){sent.push(message);},
    subscribe(fn:typeof listener){listener=fn;return ()=>{listener=()=>{};};},close(){},
    hello(id:string){listener({t:"hello",sender:id,protocol:OVERLAY_PROTOCOL,sceneVersion:0} as WireMessage,kind);},
    frames:()=>sent.filter(m=>m.t==="frame").length};
}
test("OBS-only frames do not enter native or BroadcastChannel transports",()=>{
  const ws=wire("websocket"),tauri=wire("tauri"),bc=wire("broadcast");
  const host=new OverlayHost(new CompositeBus([ws,tauri,bc]),{hostName:"test"});
  const preset=createDemoPreset();host.start();host.setPreset(preset);
  try{ws.hello("obs");host.pushFrame(neutralFrame(preset,1));
    expect(ws.frames()).toBe(1);expect(tauri.frames()).toBe(0);expect(bc.frames()).toBe(0);
    tauri.hello("native");host.pushFrame(neutralFrame(preset,2));
    expect(ws.frames()).toBe(2);expect(tauri.frames()).toBe(1);expect(bc.frames()).toBe(0);
  }finally{host.dispose();}
});
test("old transport routes expire even while viewer heartbeats on a new route",()=>{
  let now=0;const ws=wire("websocket"),tauri=wire("tauri");
  const host=new OverlayHost(new CompositeBus([ws,tauri]),{hostName:"test",now:()=>now,viewerTimeoutMs:100});
  const preset=createDemoPreset();host.start();host.setPreset(preset);
  try{tauri.hello("viewer");now=101;ws.hello("viewer");host.pushFrame(neutralFrame(preset,1));
    expect(ws.frames()).toBe(1);expect(tauri.frames()).toBe(0);
  }finally{host.dispose();}
});
