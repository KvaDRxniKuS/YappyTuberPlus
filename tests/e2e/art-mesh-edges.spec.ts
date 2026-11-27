import {test,expect} from "@playwright/test";
import {emptyArtDeformation,generateRegularArt,type ArtDeformation} from "../../src/engine/artDeformation";
import {editArtTopology} from "../../src/engine/artMeshTopology";
import {rebuildArtTriangles} from "../../src/engine/artMeshQuality";
import {readArtMesh} from "../../src/engine/artMeshRuntime";
import {createDemoPreset} from "../../src/data/demoPreset";
import {holdArtMesh,heldArtMesh,pasteArtMesh} from "../../src/engine/artMeshClipboard";
const object=(mesh:ArtDeformation)=>({...createDemoPreset().objects[0],width:100,height:100,artMesh:mesh});
const has=(mesh:ArtDeformation,a:string,b:string)=>mesh.triangles.some(f=>f.includes(a)&&f.includes(b));
test("two points constrain a longer diagonal while automatic neighbours rebuild on movement",()=>{
 const mesh:ArtDeformation={schema:1,nextId:4,vertices:[{x:0,y:0},{x:100,y:0},{x:80,y:100},{x:0,y:30}].map((rest,i)=>({id:`v${i}`,rest,uv:{x:rest.x/100,y:rest.y/100}})),triangles:[]};
 const auto=rebuildArtTriangles(mesh);expect(has(auto,"v1","v3")).toBe(true);
 const result=editArtTopology(object(auto),{type:"addEdges",ids:["v0","v2"]});
 expect(has(result.artMesh!,"v0","v2")).toBe(true);expect(has(result.artMesh!,"v1","v3")).toBe(false);
 expect(result.artMesh!.manualFaces).toBeUndefined();expect(result.artMesh!.vertices).toBe(auto.vertices);
 const moved=rebuildArtTriangles({...result.artMesh!,vertices:result.artMesh!.vertices.map(v=>v.id==="v2"?{...v,rest:{x:70,y:90}}:v)});
 expect(has(moved,"v0","v2")).toBe(true);
});
test("ordered series creates only consecutive edges, deduplicates and splits at intermediate vertices",()=>{
 const mesh=generateRegularArt(3,2,100,100);
 const result=editArtTopology(object(mesh),{type:"addEdges",ids:["v0","v2","v5"]});
 expect(result.artMesh!.manualEdges).toEqual([["v0","v1"],["v1","v2"],["v2","v5"]]);
 const repeated=editArtTopology(result,{type:"addEdges",ids:["v5","v2","v0"]});
 expect(repeated.artMesh!.manualEdges).toHaveLength(3);
 expect(has(repeated.artMesh!,"v0","v5")).toBe(false);
});
test("manual edges survive JSON and clipboard remapping without touching poses",()=>{
 const source=editArtTopology({...object(generateRegularArt(2,2,100,100)),artPose:{v0:{x:3,y:4}}},{type:"addEdges",ids:["v1","v2"]});
 expect(source.artPose).toEqual({v0:{x:3,y:4}});
 const saved=readArtMesh(JSON.parse(JSON.stringify(source.artMesh)));expect(saved.manualEdges).toEqual([["v1","v2"]]);
 holdArtMesh(source);const pasted=pasteArtMesh(object(generateRegularArt(2,2,100,100)),heldArtMesh()!,"local",true);
 expect(pasted.artMesh!.manualEdges).toEqual([["v5","v6"]]);expect(has(rebuildArtTriangles(pasted.artMesh!),"v5","v6")).toBe(true);
 expect(()=>readArtMesh({...saved,manualEdges:[["v0","v99"]]})).toThrow();
 expect(()=>readArtMesh({...saved,manualEdges:[["v1","v2"],["v2","v1"]]})).toThrow();
});
test("edge-only meshes support a wire and deletion; removing endpoints clears references",()=>{
 const mesh={...emptyArtDeformation(),nextId:2,vertices:[{id:"v0",rest:{x:0,y:0},uv:{x:0,y:0}},{id:"v1",rest:{x:100,y:0},uv:{x:1,y:0}}]};
 const wire=editArtTopology(object(mesh),{type:"addEdges",ids:["v0","v1"]});expect(wire.artMesh!.manualEdges).toHaveLength(1);expect(wire.artMesh!.triangles).toEqual([]);
 const erased=editArtTopology(wire,{type:"removeEdge",ids:["v0","v1"]});expect(erased.artMesh!.manualEdges).toEqual([]);
 const deleted=editArtTopology(wire,{type:"remove",ids:["v0"],rebuild:true});expect(deleted.artMesh!.manualEdges).toEqual([]);expect(()=>readArtMesh(deleted.artMesh)).not.toThrow();
});
test("crossing manual constraints reject atomically instead of corrupting the graph",()=>{
 const source=editArtTopology(object(generateRegularArt(2,2,100,100)),{type:"addEdges",ids:["v0","v3"]});
 const before=JSON.stringify(source);
 expect(()=>editArtTopology(source,{type:"addEdges",ids:["v1","v2"]})).toThrow(/пересекаются/);
 expect(JSON.stringify(source)).toBe(before);
});
