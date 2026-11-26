import {test,expect} from "@playwright/test";
import {readFileSync} from "node:fs";
import {meshGeometry} from "../../src/render/mesh";
import {prepareDeformOffset} from "../../src/render/bend";
import {staticValues} from "../../src/render/rigCanvas";
import type {RigObject} from "../../src/types";
test("legacy fields cannot enable a render surface or parent sampler",()=>{
 const object={id:"old",width:100,height:100,pivot:{x:0,y:0},base:{x:0,y:0},mesh:{enabled:true},warp:{enabled:true}} as unknown as RigObject;
 expect(meshGeometry(object)).toBeNull();
 expect(prepareDeformOffset(object,staticValues(object))).toBeUndefined();
});
test("production rendering has no cage fallback or synthetic child geometry",()=>{
 for(const file of ["mesh","bend","bounds","rigCanvas"]){
  const source=readFileSync(`src/render/${file}.ts`,"utf8");
  for(const old of ["engine/mesh","meshOf(","defaultMesh(","warpEnabled(","warpQuad(","drawWarpedImage(","sampleDeform(","zoneGeometry("])expect(source).not.toContain(old);
 }
});
test("active legacy-only projects are rejected, not silently opened without deformation",async()=>{
 const {normalizePreset}=await import("../../src/engine/preset");
 const {createDemoPreset}=await import("../../src/data/demoPreset");
 const preset=createDemoPreset();
 for(const field of ["mesh","warp"]){
  const old={...preset,objects:[{...preset.objects[0],[field]:{enabled:true}}]};
  expect(normalizePreset(old)).toBeNull();
  const inactive=normalizePreset({...old,objects:[{...old.objects[0],[field]:{enabled:false}}]})!;
  expect(inactive.objects[0]).not.toHaveProperty(field);
 }
});
