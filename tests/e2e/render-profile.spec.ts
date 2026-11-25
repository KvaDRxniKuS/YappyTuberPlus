import {test,expect} from "@playwright/test";
import {createRenderProfile,enterRenderStage,startRenderProfile} from "../../src/engine/renderProfile";
test("nested render timings are exclusive, including recursive masks",()=>{
  let now=0;const probe=createRenderProfile(()=>now);
  const scene=probe.enter("scene");now=1;const rig=probe.enter("rig");
  now=3;const shade=probe.enter("shaded");now=6;const mask=probe.enter("mask");
  now=10;mask?.();now=11;shade?.();now=13;rig?.();now=15;scene?.();
  expect(probe.snapshot()).toEqual({
    scene:{calls:1,totalMs:3,maxMs:3},rig:{calls:1,totalMs:4,maxMs:4},
    shaded:{calls:1,totalMs:4,maxMs:4},mask:{calls:1,totalMs:4,maxMs:4},
    plain:{calls:0,totalMs:0,maxMs:0},
  });
});
test("snapshot is detached; stop clears pending spans and disables sampling",()=>{
  let now=0;const probe=createRenderProfile(()=>now);const end=probe.enter("mask");
  const copy=probe.snapshot();now=2;end?.();expect(copy.mask.totalMs).toBe(0);
  const pending=probe.enter("plain");probe.stop();now=10;pending?.();
  expect(probe.snapshot().plain.calls).toBe(0);expect(probe.enter("scene")).toBeUndefined();
});
test("stopping an older report cannot disable a newer report",()=>{
  const old=startRenderProfile(),current=startRenderProfile();old.stop();
  const end=enterRenderStage("plain");end?.();expect(current.snapshot().plain.calls).toBe(1);
  current.stop();expect(enterRenderStage("plain")).toBeUndefined();
});
