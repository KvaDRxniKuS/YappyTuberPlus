import {test,expect} from "@playwright/test";
import {generateRegularArt,bindArtPoint} from "../../src/engine/artDeformation";
import {editArtTopology} from "../../src/engine/artMeshTopology";
import {createDemoPreset} from "../../src/data/demoPreset";
import {makeLayer,readStates,writeStates} from "../../src/engine/states";
function cutObject(){
 let object={...createDemoPreset().objects[0],width:100,height:100,artMesh:generateRegularArt(3,2,100,100)};
 object=editArtTopology(object,{type:"removeFace",ids:["v0","v4","v3"]}) as typeof object;
 return editArtTopology(object,{type:"removeFace",ids:bindArtPoint(object.artMesh!,{x:90,y:10})!.ids});
}
test("creating a point in a cut restores only its region and interpolates pose and state",()=>{
 let object=cutObject();const layer=makeLayer(0);
 object.artPose=Object.fromEntries(object.artMesh!.vertices.map(v=>[v.id,{x:10,y:20}]));
 layer.poses[0].points=Object.fromEntries(object.artMesh!.vertices.map(v=>[v.id,[4,6]]));
 object.script=writeStates(object.script,{layers:[layer]},object).script;
 const before=JSON.stringify(object),result=editArtTopology(object,{type:"create",connect:true,point:{x:10,y:80}});
 expect(result.artMesh!.vertices.at(-1)!.id).toBe("v6");
 expect(result.artMesh!.triangles.some(f=>f.includes("v6"))).toBe(true);
 expect(result.artMesh!.excludedFaces).toHaveLength(1);
 expect(bindArtPoint(result.artMesh!,{x:90,y:10})).toBeNull();
 expect(result.artPose!.v6.x).toBeCloseTo(10);expect(result.artPose!.v6.y).toBeCloseTo(20);
 const point=readStates(result.script).layers[0].poses[0].points!.v6;
 expect(point[0]).toBeCloseTo(4);expect(point[1]).toBeCloseTo(6);
 expect(JSON.stringify(object)).toBe(before);
});
test("selected auto-lines connect loose vertices to their surroundings without reopening other cuts",()=>{
 let object=editArtTopology(cutObject(),{type:"create",point:{x:10,y:80}});
 expect(object.artMesh!.triangles.some(f=>f.includes("v6"))).toBe(false);
 object=editArtTopology(object,{type:"addEdges",ids:["v2","v5"]});
 const result=editArtTopology(object,{type:"autoEdges",ids:["v6"]});
 expect(result.artMesh!.triangles.some(f=>f.includes("v6")&&f.some(id=>id!=="v6"))).toBe(true);
 expect(result.artMesh!.excludedFaces).toHaveLength(1);expect(bindArtPoint(result.artMesh!,{x:90,y:10})).toBeNull();
 expect(result.artMesh!.manualEdges).toEqual(object.artMesh!.manualEdges);
 const all=editArtTopology(result,{type:"autoEdges",ids:[]});expect(all.artMesh!.excludedFaces).toEqual([]);
 expect(bindArtPoint(all.artMesh!,{x:90,y:10})).not.toBeNull();
 expect(new Set(all.artMesh!.triangles.flat()).size).toBe(all.artMesh!.vertices.length);
});
test("selection by an existing cut vertex reopens its adjacent region and invalid IDs reject atomically",()=>{
 const object=cutObject(),before=JSON.stringify(object);
 const result=editArtTopology(object,{type:"autoEdges",ids:["v0"]});
 expect(bindArtPoint(result.artMesh!,{x:10,y:80})).not.toBeNull();expect(bindArtPoint(result.artMesh!,{x:90,y:10})).toBeNull();
 expect(()=>editArtTopology(object,{type:"autoEdges",ids:["missing"]})).toThrow();expect(JSON.stringify(object)).toBe(before);
});
