import {test,expect} from "@playwright/test";
import {generateRegularArt} from "../../src/engine/artDeformation";
import {addArtFace,removeArtFace} from "../../src/engine/artMeshFaces";
import {editArtTopology} from "../../src/engine/artMeshTopology";
import {createDemoPreset} from "../../src/data/demoPreset";
test("manual face creation restores a hole, normalizes winding and preserves vertex data",()=>{
 const mesh=generateRegularArt(2,2,100,100);
 const removed=removeArtFace(mesh,["v3","v1","v0"]);
 expect(removed.triangles).toHaveLength(1);
 const restored=addArtFace(removed,["v3","v1","v0"]);
 expect(restored.triangles).toHaveLength(2);expect(restored.vertices).toBe(mesh.vertices);
 expect(restored.nextId).toBe(mesh.nextId);
 const face=restored.triangles[1].map(id=>mesh.vertices.find(v=>v.id===id)!.rest);
 expect((face[1].x-face[0].x)*(face[2].y-face[0].y)-(face[1].y-face[0].y)*(face[2].x-face[0].x)).toBeGreaterThan(0);
 expect(mesh.triangles).toHaveLength(2);
});
test("invalid duplicate and overlapping faces are rejected",()=>{
 const mesh=generateRegularArt(2,2,100,100);
 expect(()=>addArtFace(mesh,["v0","v1","v3"])).toThrow();
 expect(()=>addArtFace(mesh,["v0","v1","v2"])).toThrow();
 expect(()=>addArtFace(mesh,["v0","v0","v1"])).toThrow();
 expect(()=>addArtFace(mesh,["v0","missing","v1"])).toThrow();
 expect(()=>removeArtFace(mesh,["v0","v1","v2"])).toThrow();
});
test("collinear vertices and T-junctions cannot be turned into faces",()=>{
 const mesh=generateRegularArt(3,3,100,100),empty={...mesh,triangles:[]};
 expect(()=>addArtFace(empty,["v0","v1","v2"])).toThrow();
 expect(()=>addArtFace(empty,["v0","v2","v8"])).toThrow();
 expect(addArtFace(empty,["v0","v1","v4"]).triangles).toHaveLength(1);
});
test("face-only transaction keeps authored pose and state script byte-for-byte",()=>{
 const object={...createDemoPreset().objects[0],artMesh:generateRegularArt(2,2,100,100),artPose:{v0:{x:3,y:4}}};
 const removed=editArtTopology(object,{type:"removeFace",ids:["v0","v1","v3"]});
 expect(removed.artPose).toBe(object.artPose);expect(removed.script).toBe(object.script);
 expect(removed.artMesh?.vertices).toBe(object.artMesh.vertices);
 const restored=editArtTopology(removed,{type:"addFace",ids:["v0","v1","v3"]});
 expect(restored.artMesh?.triangles).toHaveLength(2);expect(restored.script).toBe(object.script);
});
