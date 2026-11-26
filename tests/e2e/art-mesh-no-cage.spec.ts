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
