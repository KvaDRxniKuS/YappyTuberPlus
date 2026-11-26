import {test,expect} from "@playwright/test";
import {rebuildArtTriangles} from "../../src/engine/artMeshQuality";
import {generateRegularArt,type ArtDeformation} from "../../src/engine/artDeformation";
import {editArtTopology} from "../../src/engine/artMeshTopology";
import {createDemoPreset} from "../../src/data/demoPreset";
const edge=(mesh:ArtDeformation,a:string,b:string)=>mesh.triangles.some(t=>t.includes(a)&&t.includes(b));
test("rest rebuild changes the local diagonal after movement without changing IDs UV or order",()=>{
 const mesh:ArtDeformation={schema:1,nextId:4,vertices:[{x:0,y:0},{x:100,y:0},{x:80,y:100},{x:0,y:30}].map((rest,i)=>({id:`v${i}`,rest,uv:{x:rest.x/100,y:rest.y/100}})),triangles:[]};
 const first=rebuildArtTriangles(mesh);expect(edge(first,"v1","v3")).toBe(true);expect(edge(first,"v0","v2")).toBe(false);
 const moved={...first,vertices:first.vertices.map(v=>v.id==="v3"?{...v,rest:{x:0,y:100}}:v)};
 const second=rebuildArtTriangles(moved);expect(edge(second,"v0","v2")).toBe(true);expect(edge(second,"v1","v3")).toBe(false);
 expect(second.vertices).toBe(moved.vertices);expect(second.nextId).toBe(4);expect(mesh.triangles).toHaveLength(0);
});
test("edge and vertex erasure rebuild all surviving noncollinear points without orphans",()=>{
 const mesh=generateRegularArt(4,4,100,100),object={...createDemoPreset().objects[0],artMesh:mesh};
 const removed=editArtTopology(object,{type:"removeEdge",ids:mesh.triangles[0].slice(0,2),rebuild:true});
 expect(new Set(removed.artMesh!.triangles.flat()).size).toBe(16);
 expect(removed.artMesh!.vertices).toBe(mesh.vertices);
 const next=editArtTopology(removed,{type:"remove",ids:["v5","v6"],rebuild:true});
 expect(next.artMesh!.vertices).toHaveLength(14);expect(new Set(next.artMesh!.triangles.flat()).size).toBe(14);
});
test("rebuild handles empty and collinear sets without zero area triangles",()=>{
 expect(rebuildArtTriangles({schema:1,nextId:0,vertices:[],triangles:[]}).triangles).toEqual([]);
 const mesh=generateRegularArt(2,2,100,100);
 expect(rebuildArtTriangles({...mesh,vertices:mesh.vertices.map((v,i)=>({...v,rest:{x:i,y:0}}))}).triangles).toEqual([]);
});
