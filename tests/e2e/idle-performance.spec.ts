import {test,expect} from "@playwright/test";
import {createColorResolver} from "../../src/render/color";
import {countSceneWake,readSceneWakes} from "../../src/engine/meter";
import type {RigPreset} from "../../src/types";

const preset={objects:[{id:"shape",shape:{fill:"#fff"},colors:{fill:{module:"color",channel:"c1"}}}]} as unknown as RigPreset;
const values={"color.c1_r":1,"color.c1_g":0,"color.c1_b":0};
test("unchanged palettes retain identity despite fresh module inputs",()=>{
  const resolve=createColorResolver();
  const a=resolve(preset,values);
  expect(resolve(preset,{...values,"audio.level":.6})).toBe(a);
  const b=resolve(preset,{...values,"color.c1_r":.5});
  expect(b).not.toBe(a);expect(b.shape.fill?.r).toBe(.5);
  expect(a.shape.fill?.r).toBe(1);
  expect(resolve({...preset,objects:[]},{})).toEqual({});
  const empty=resolve(preset,{});
  expect(resolve(preset,{"audio.level":1})).toBe(empty);
});
test("palette removal and alpha changes invalidate",()=>{
  const resolve=createColorResolver();const a=resolve(preset,values);
  expect(resolve(preset,{...values,"color.c1_a":.5})).not.toBe(a);
  expect(resolve(preset,{})).toEqual({});
});
test("scene wake snapshots do not mutate counters",()=>{
  const before=readSceneWakes().colors??0;
  countSceneWake("colors");const snapshot=readSceneWakes();
  expect(snapshot.colors).toBe(before+1);snapshot.colors=0;
  expect(readSceneWakes().colors).toBe(before+1);
});

test("idle audio suspends and restart resumes after suspension",async()=>{
  const {AudioInputEngine}=await import("../../src/modules/audio");
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,"window");
  class Context {
    state="running";
    async suspend(){this.state="suspended";}
    async resume(){this.state="running";}
    async close(){this.state="closed";}
  }
  Object.defineProperty(globalThis,"window",{configurable:true,value:{AudioContext:Context,setInterval,clearInterval}});
  const engine=new AudioInputEngine();
  try {
    await engine.start(()=>{});expect(engine.state).toBe("running");
    engine.stop();
    await engine.start(()=>{});expect(engine.state).toBe("running");
    engine.stop();await Promise.resolve();await Promise.resolve();
    expect(engine.state).toBe("suspended");
  }finally{
    engine.dispose();
    if(descriptor)Object.defineProperty(globalThis,"window",descriptor);else Reflect.deleteProperty(globalThis,"window");
  }
});
