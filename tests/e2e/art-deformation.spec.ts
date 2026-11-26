import {test,expect} from "@playwright/test";
import {artPosition,bindArtPoint,boundArtPosition,deformArtPoint,generateRegularArt,insertArtVertex,moveArtRest,removeArtVertex} from "../../src/engine/artDeformation";
test("one topology generates local rest positions and fixed UVs",()=>{
 const mesh=generateRegularArt(3,4,200,100,10);
 expect(mesh.vertices).toHaveLength(12);expect(mesh.triangles).toHaveLength(12);
 expect(mesh.vertices[0]).toEqual({id:"v0",rest:{x:10,y:10},uv:{x:.05,y:.1}});
 const moved=moveArtRest(mesh,"v0",{x:20,y:30});
 expect(moved.vertices[0].uv).toEqual(mesh.vertices[0].uv);
 expect(artPosition(moved.vertices[0],{v0:{x:5,y:-2}})).toEqual({x:25,y:28});
 expect(mesh.vertices[0].rest).toEqual({x:10,y:10});
});
test("barycentric parent deformation works inside, leaves exterior and holes unchanged",()=>{
 const mesh=generateRegularArt(2,2,100,100);
 const binding=bindArtPoint(mesh,{x:75,y:25})!;
 expect(boundArtPosition(mesh,binding,{v0:{x:10,y:20},v1:{x:10,y:20},v2:{x:10,y:20},v3:{x:10,y:20}})).toEqual({x:85,y:45});
 expect(deformArtPoint(mesh,{x:-5,y:10},{v0:{x:50,y:20}})).toEqual({x:-5,y:10});
 const hole={...mesh,triangles:[mesh.triangles[1]]};
 expect(bindArtPoint(hole,{x:75,y:25})).toBeNull();
 const reversed={...mesh,triangles:mesh.triangles.map(([a,b,c])=>[c,b,a] as [string,string,string])};
 expect(bindArtPoint(reversed,{x:75,y:25})).not.toBeNull();
});
test("insertion interpolates poses, deletion keeps other IDs and never reuses them",()=>{
 const mesh=generateRegularArt(2,2,100,100);
 const pose={v0:{x:10,y:5},v1:{x:10,y:5},v3:{x:10,y:5}};
 const next=insertArtVertex(mesh,{x:75,y:25},[pose]);
 expect(next.mesh.vertices.at(-1)!.id).toBe("v4");
 expect(next.poses[0].v4).toEqual({x:10,y:5});
 expect(next.mesh.triangles).toHaveLength(4);
 const removed=removeArtVertex(next.mesh,"v1",next.poses);
 expect(removed.poses[0].v1).toBeUndefined();expect(removed.poses[0].v4).toEqual({x:10,y:5});
 expect(removed.mesh.nextId).toBe(5);expect(removed.mesh.triangles.every(t=>!t.includes("v1"))).toBe(true);
 expect(generateRegularArt(2,2,100,100,0,removed.mesh.nextId).vertices[0].id).toBe("v5");
 expect(pose.v1).toEqual({x:10,y:5});
});
test("reject invalid sizes and duplicate vertex insertion",()=>{
 for(const cols of [1,33,2.5,NaN])expect(()=>generateRegularArt(cols,2,100,100)).toThrow();
 expect(()=>generateRegularArt(2,2,100,100,50)).toThrow();
 expect(()=>insertArtVertex(generateRegularArt(2,2,100,100),{x:0,y:0},[])).toThrow();
});
