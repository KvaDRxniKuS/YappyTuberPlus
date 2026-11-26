import {test,expect} from "@playwright/test";
import {holdArtMesh,heldArtMesh,pasteArtMesh} from "../../src/engine/artMeshClipboard";
import {generateRegularArt} from "../../src/engine/artDeformation";
import {createDemoPreset} from "../../src/data/demoPreset";
import {makeLayer,writeStates,readStates} from "../../src/engine/states";
function object(){return {...createDemoPreset().objects[0],width:100,height:50,artMesh:generateRegularArt(2,2,100,50),artPose:{v0:{x:3,y:4}}};}
test("clipboard owns topology UV and authored offsets in both directions",()=>{
 const source=object();holdArtMesh(source);
 source.artMesh.vertices[0].uv.x=9;source.artPose.v0.x=99;
 const clip=heldArtMesh()!;expect(clip.mesh.vertices[0].uv.x).toBe(0);expect(clip.pose.v0.x).toBe(3);
 clip.mesh.vertices[0].rest.x=99;clip.pose.v0.x=77;
 expect(heldArtMesh()!.mesh.vertices[0].rest.x).toBe(0);expect(heldArtMesh()!.pose.v0.x).toBe(3);
});
test("fit scales local rest and optional pose but preserves normalized UV",()=>{
 const source=object();holdArtMesh(source);const clip=heldArtMesh()!;
 const target={...object(),width:200,height:25,deformParent:false};
 const result=pasteArtMesh(target,clip,"fit",true);
 expect(result.artMesh?.vertices.map(v=>v.id)).toEqual(["v4","v5","v6","v7"]);
 expect(result.artMesh?.vertices[3].rest).toEqual({x:200,y:25});
 expect(result.artMesh?.vertices[3].uv).toEqual({x:1,y:1});
 expect(result.artPose).toEqual({v4:{x:6,y:2}});expect(result.deformParent).toBe(false);
 expect(result.artMesh?.nextId).toBe(8);expect(target.artMesh.nextId).toBe(4);
});
test("local paste clears only target vertex channels and preserves all other state data",()=>{
 const target=object();target.script=writeStates(target.script,{layers:[{...makeLayer(0),poses:[{pose:{x:8,opacity:.4},points:{v0:[2,3]}}]}]},target).script;
 const original=readStates(target.script);holdArtMesh(object());
 const result=pasteArtMesh({...target,width:300},heldArtMesh()!,"local",false);
 expect(result.artMesh?.vertices[3].rest).toEqual({x:100,y:50});expect(result.artPose).toEqual({});
 const states=readStates(result.script);expect(states.layers[0].poses[0].points).toBeUndefined();
 expect(states.layers[0].poses[0].pose).toEqual(original.layers[0].poses[0].pose);
 expect(readStates(target.script)).toEqual(original);
});
test("invalid clipboard cannot partially mutate target",()=>{
 const target=object(),before=JSON.stringify(target);holdArtMesh(object());const clip=heldArtMesh()!;
 expect(()=>pasteArtMesh({...target,width:0},clip,"fit",false)).toThrow();
 expect(()=>pasteArtMesh(target,{...clip,width:NaN},"fit",false)).toThrow();
 expect(()=>pasteArtMesh(target,{...clip,pose:{missing:{x:2,y:3}}},"fit",true)).toThrow();
 expect(JSON.stringify(target)).toBe(before);
});
