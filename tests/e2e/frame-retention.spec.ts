import {test,expect} from "@playwright/test";
import {FrameRetentionProbe} from "../../src/engine/frameRetention";

test("retention samples are throttled, stage-separated and bounded",()=>{
  const probe=new FrameRetentionProbe(value=>({deref:()=>value}));
  const value={};
  for(let now=0;now<200000;now+=10)probe.observe("received",value,now);
  probe.observe("prepared",value,199999);
  const snapshot=probe.snapshot(200000);
  expect(snapshot.stages.received).toMatchObject({sampled:120,alive:120,collected:0,aliveOlderThan10s:111,oldestAliveMs:120000});
  expect(snapshot.stages.prepared.sampled).toBe(1);
  expect(snapshot.stages.meshes.sampled).toBe(0);
});
test("collected references and unsupported runtimes are explicit",()=>{
  const probe=new FrameRetentionProbe(()=>({deref:()=>undefined}));
  probe.observe("prepared",{},0);
  expect(probe.snapshot(20000).stages.prepared).toMatchObject({sampled:1,collected:1,alive:0,oldestAliveMs:null});
  const unsupported=new FrameRetentionProbe(null);unsupported.observe("prepared",{},0);
  expect(unsupported.snapshot(1).supported).toBe(false);
});
test("stop releases diagnostic samples and disallows further observation",()=>{
  const probe=new FrameRetentionProbe(value=>({deref:()=>value}));
  probe.observe("meshes",{},0);probe.stop();probe.observe("meshes",{},2000);
  expect(probe.snapshot(5000).stages.meshes.sampled).toBe(0);
});
