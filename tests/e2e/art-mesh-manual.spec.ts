import {test,expect} from "@playwright/test";
import {generateRegularArt,bindArtPoint} from "../../src/engine/artDeformation";
import {editArtTopology} from "../../src/engine/artMeshTopology";
import {rebuildArtTriangles} from "../../src/engine/artMeshQuality";
import {readArtMesh} from "../../src/engine/artMeshRuntime";
import {createDemoPreset} from "../../src/data/demoPreset";
import {mirrorStateKey,pasteStateKey} from "../../src/engine/stateKeyActions";
import {artBrushWeight} from "../../src/render/artMeshEditor";
test("manual diagonal overrides auto shortest route and survives rebuild/save/paste",()=>{
 const mesh=generateRegularArt(2,2,100,100),object={...createDemoPreset().objects[0],artMesh:mesh};
 const pinned=editArtTopology(object,{type:"addFace",ids:["v0","v1","v2"]}).artMesh!;
 expect(pinned.triangles.some(f=>f.includes("v1")&&f.includes("v2"))).toBe(true);
 expect(pinned.triangles.some(f=>f.includes("v0")&&f.includes("v3"))).toBe(false);
 const saved=readArtMesh(JSON.parse(JSON.stringify(pinned)));
 expect(rebuildArtTriangles(saved).triangles).toEqual(pinned.triangles);
});
test("removed face remains a hole after movement and rebuild",()=>{
 let object={...createDemoPreset().objects[0],artMesh:generateRegularArt(2,2,100,100)};
 object=editArtTopology(object,{type:"removeFace",ids:["v0","v1","v3"]}) as typeof object;
 expect(bindArtPoint(object.artMesh,{x:80,y:20})).toBeNull();
 const rebuilt=rebuildArtTriangles(readArtMesh(JSON.parse(JSON.stringify(object.artMesh))));
 expect(bindArtPoint(rebuilt,{x:80,y:20})).toBeNull();expect(bindArtPoint(rebuilt,{x:20,y:80})).not.toBeNull();
});
test("hardness controls brush falloff and mirror key remaps stable vertices",()=>{
 expect(artBrushWeight(50,100,1)).toBe(1);expect(artBrushWeight(50,100,0)).toBe(.5);expect(artBrushWeight(110,100,1)).toBe(0);
 const key={at:0,pose:{x:10,rotation:15},points:{v0:[10,3] as [number,number]}},mesh=generateRegularArt(2,2,100,100);
 const reflected=mirrorStateKey(key,mesh,100,100,0);
 expect(reflected.points?.v1).toEqual([-10,3]);expect(reflected.pose.x).toBe(-10);expect(reflected.pose.rotation).toBe(-15);
 const pasted=pasteStateKey(key,{at:1,pose:{},weight:"a"});expect(pasted.at).toBe(1);expect(pasted.weight).toBe("a");expect(pasted.points).toEqual(key.points);
});
test("deformation sources select only named surfaces including unrelated roots",async()=>{
 const {parentMeshTransform}=await import("../../src/render/bend");
 const {staticValues}=await import("../../src/render/rigCanvas");
 const base={...createDemoPreset().objects[0],parentId:null,pivot:{x:0,y:0},width:100,height:100,artMesh:generateRegularArt(2,2,100,100)};
 const uniform=(x:number,y:number)=>Object.fromEntries(base.artMesh.vertices.map(v=>[v.id,{x,y}]));
 const face={...base,id:"face",artPose:uniform(10,0)},mask={...base,id:"mask",parentId:"face",artPose:uniform(0,20)},other={...base,id:"other",artPose:uniform(3,4)};
 const child={...base,id:"eye",parentId:"mask",deformParent:true,deformSources:["face"],artPose:{}};
 const objects=[face,mask,other,child],preset={...createDemoPreset(),objects};
 expect(parentMeshTransform(preset,child,null)?.({x:20,y:20})).toEqual({x:30,y:20});
 const external={...child,parentId:null,deformSources:["other"]};
 expect(parentMeshTransform({...preset,objects:[face,mask,other,external]},external,null)?.({x:20,y:20})).toEqual({x:23,y:24});
 expect(parentMeshTransform(preset,{...child,deformSources:[]},null)).toBeUndefined();
 expect(parentMeshTransform(preset,{...child,deformParent:false},null)).toBeUndefined();
});
test("erased diagonal can be replaced by a manually chosen triangle without filling the other half",()=>{
 const mesh=generateRegularArt(2,2,100,100),object={...createDemoPreset().objects[0],artMesh:mesh};
 const erased=editArtTopology(object,{type:"removeEdge",ids:["v0","v3"]});expect(erased.artMesh!.triangles).toHaveLength(0);
 const drawn=editArtTopology(erased,{type:"addFace",ids:["v0","v1","v2"]});
 expect(drawn.artMesh!.triangles).toHaveLength(1);expect(bindArtPoint(drawn.artMesh!,{x:20,y:20})).not.toBeNull();expect(bindArtPoint(drawn.artMesh!,{x:80,y:80})).toBeNull();
 expect(rebuildArtTriangles(readArtMesh(JSON.parse(JSON.stringify(drawn.artMesh)))).triangles).toHaveLength(1);
});
test("manual constraints remap through mesh clipboard and invalid references are rejected",async()=>{
 const {holdArtMesh,heldArtMesh,pasteArtMesh}=await import("../../src/engine/artMeshClipboard");
 const object={...createDemoPreset().objects[0],width:100,height:100,artMesh:generateRegularArt(2,2,100,100)};
 const pinned=editArtTopology(object,{type:"addFace",ids:["v0","v1","v2"]});
 holdArtMesh(pinned);const pasted=pasteArtMesh(object,heldArtMesh()!,"local",false);
 expect(pasted.artMesh!.manualFaces).toEqual([["v4","v5","v6"]]);
 expect(rebuildArtTriangles(pasted.artMesh!).triangles.some(f=>f.includes("v5")&&f.includes("v6"))).toBe(true);
 expect(()=>readArtMesh({...pinned.artMesh,excludedFaces:[["v0","v1","v99"]]})).toThrow();
});
