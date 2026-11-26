import {test,expect} from "@playwright/test";
import {generateRegularArt,insertArtVertex} from "../../src/engine/artDeformation";
import {editArtTopology} from "../../src/engine/artMeshTopology";
import {createDemoPreset} from "../../src/data/demoPreset";
import {makeLayer,readStates,writeStates} from "../../src/engine/states";
test("shared edge splits both neighbours and interpolates UV and poses",()=>{
 const mesh=generateRegularArt(2,2,100,100),pose={v0:{x:10,y:2},v3:{x:30,y:6}};
 const result=insertArtVertex(mesh,{x:50,y:50},[pose]);
 expect(result.mesh.triangles).toHaveLength(4);
 expect(result.mesh.triangles.every(t=>!(t.includes("v0")&&t.includes("v3")))).toBe(true);
 expect(result.mesh.vertices.at(-1)).toEqual({id:"v4",rest:{x:50,y:50},uv:{x:.5,y:.5}});
 expect(result.poses[0].v4).toEqual({x:20,y:4});
 for(const face of result.mesh.triangles){const [a,b,c]=face.map(id=>result.mesh.vertices.find(v=>v.id===id)!.rest);expect((b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x)).toBeGreaterThan(0);}
 expect(mesh.triangles).toHaveLength(2);
 const boundary=insertArtVertex(mesh,{x:50,y:0},[]);expect(boundary.mesh.triangles).toHaveLength(3);
});
test("topology transaction updates authored pose and all state keys without renumbering",()=>{
 const object={...createDemoPreset().objects[0],artMesh:generateRegularArt(2,2,100,100),artPose:{v0:{x:10,y:2},v3:{x:30,y:6}}};
 const states={layers:[{...makeLayer(0),poses:[{pose:{x:7},points:{v0:[2,4] as [number,number],v3:[6,8] as [number,number]}},{pose:{opacity:.5},points:{v3:[10,12] as [number,number]}}]}]};
 object.script=writeStates(object.script,states,object).script;
 const inserted=editArtTopology(object,{type:"insert",point:{x:50,y:50}});
 expect(inserted.artPose?.v4).toEqual({x:20,y:4});
 const keys=readStates(inserted.script).layers[0].poses;
 expect(keys[0].points?.v4).toEqual([4,6]);expect(keys[1].points?.v4).toEqual([5,6]);expect(keys[0].pose.x).toBe(7);
 const removed=editArtTopology(inserted,{type:"remove",ids:["v0","v4"]});
 expect(removed.artMesh?.vertices.map(v=>v.id)).toEqual(["v1","v2","v3"]);
 expect(removed.artMesh?.nextId).toBe(5);expect(removed.artPose?.v4).toBeUndefined();
 expect(readStates(removed.script).layers[0].poses[0].points?.v4).toBeUndefined();
 expect(object.artMesh.vertices).toHaveLength(4);
 expect(()=>editArtTopology(object,{type:"insert",point:{x:-20,y:-20}})).toThrow();
});
