import {test,expect} from "@playwright/test";
import {generateRegularArt} from "../../src/engine/artDeformation";
import {artSymmetryPairs,mirrorArtDeltas} from "../../src/engine/artMeshSymmetry";
import {editArtVertices} from "../../src/render/artMeshEditor";

test("rest pairs are mutual stable IDs and middle vertices pair with themselves",()=>{
 const mesh=generateRegularArt(3,2,100,100),pairs=artSymmetryPairs(mesh,{axis:"x",at:50});
 expect(pairs.get("v0")).toBe("v2");expect(pairs.get("v2")).toBe("v0");expect(pairs.get("v1")).toBe("v1");
 const deltas=mirrorArtDeltas({v0:{x:10,y:4},v1:{x:8,y:3}},pairs,"x");
 expect(deltas).toEqual({v0:{x:10,y:4},v2:{x:-10,y:4},v1:{x:0,y:3}});
 const changed=editArtVertices(mesh,{v2:{x:2,y:1}},deltas,"pose");
 expect(changed.mesh).toBe(mesh);expect(changed.pose.v2).toEqual({x:-8,y:5});
});
test("both-side brush deltas are reflected once with deterministic priority",()=>{
 const mesh=generateRegularArt(2,2,100,100),pairs=artSymmetryPairs(mesh,{axis:"x",at:50});
 expect(mirrorArtDeltas({v0:{x:10,y:4},v1:{x:2,y:1}},pairs,"x")).toEqual({v0:{x:10,y:4},v1:{x:-10,y:4}});
 const input={v0:{x:5,y:0},v1:{x:5,y:0}};
 expect(mirrorArtDeltas(input,pairs,"x")).toEqual(mirrorArtDeltas(input,new Map([...pairs].reverse()),"x"));
 expect(input.v1).toEqual({x:5,y:0});
});
test("horizontal symmetry and rest editing preserve UV and topology",()=>{
 const mesh=generateRegularArt(2,2,100,100),pairs=artSymmetryPairs(mesh,{axis:"y",at:50});
 const deltas=mirrorArtDeltas({v0:{x:3,y:7}},pairs,"y");
 expect(deltas.v2).toEqual({x:3,y:-7});
 const result=editArtVertices(mesh,{},deltas,"rest");
 expect(result.mesh.vertices[2].rest).toEqual({x:3,y:93});
 expect(result.mesh.vertices[2].uv).toBe(mesh.vertices[2].uv);expect(result.mesh.triangles).toBe(mesh.triangles);
});
test("missing/asymmetric counterparts do not create hidden geometry",()=>{
 const mesh=generateRegularArt(2,2,100,100);
 const asymmetric={...mesh,vertices:mesh.vertices.filter(v=>v.id!=="v1")};
 const pairs=artSymmetryPairs(asymmetric,{axis:"x",at:50});
 expect(pairs.has("v0")).toBe(false);
 expect(mirrorArtDeltas({v0:{x:4,y:8}},pairs,"x")).toEqual({v0:{x:4,y:8}});
 expect(asymmetric.vertices).toHaveLength(3);
 expect(()=>artSymmetryPairs(mesh,{axis:"x",at:NaN})).toThrow();
});
