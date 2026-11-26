import {test,expect} from "@playwright/test";
import {createDemoPreset} from "../../src/data/demoPreset";
import {artDescendants,artGenerationSupported,replaceArtMeshes} from "../../src/engine/artMeshBatch";
import {generateRegularArt} from "../../src/engine/artDeformation";
import {readStates,writeStates,makeLayer} from "../../src/engine/states";
function setup(){
 const preset=createDemoPreset(),base={...preset.objects[0],width:100,height:80};
 const root={...base,id:"root",kind:"group" as const,parentId:undefined};
 const a={...base,id:"a",parentId:"root",deformParent:false,artMesh:generateRegularArt(2,2,100,80),artPose:{v0:{x:3,y:4}}};
 a.script=writeStates(a.script,{layers:[{...makeLayer(0),poses:[{pose:{x:7},points:{v0:[3,4]}}]}]},a).script;
 const b={...base,id:"b",parentId:"a",deformParent:undefined};
 return {...preset,objects:[root,a,b]};
}
test("descendant scopes are explicit and cycles do not hang",()=>{
 const preset=setup();
 expect(artDescendants(preset.objects,"root","direct").map(o=>o.id)).toEqual(["a"]);
 expect(artDescendants(preset.objects,"root","all").map(o=>o.id)).toEqual(["a","b"]);
 const cycle=preset.objects.map(o=>o.id==="root"?{...o,parentId:"b"}:o);
 expect(artDescendants(cycle,"root","all").map(o=>o.id)).toEqual(["a","b"]);
 expect(artGenerationSupported({...preset.objects[0],width:0})).toBe(false);
 expect(artGenerationSupported({...preset.objects[0],kind:"text"})).toBe(false);
});
test("batch replaces geometry and vertex keys only, preserves inheritance by default",()=>{
 const preset=setup(),snapshot=JSON.stringify(preset);
 const meshes=preset.objects.slice(1).map(o=>({id:o.id,mesh:generateRegularArt(3,3,o.width,o.height,0,o.artMesh?.nextId??0)}));
 const changed=replaceArtMeshes(preset,meshes);
 expect(changed.objects[0]).toBe(preset.objects[0]);
 expect(changed.objects[1].artMesh?.vertices[0].id).toBe("v4");
 expect(changed.objects[1].artPose).toEqual({});
 expect(readStates(changed.objects[1].script).layers[0].poses[0]).toEqual({pose:{x:7}});
 expect(changed.objects[1].deformParent).toBe(false);expect(changed.objects[2].deformParent).toBeUndefined();
 const enabled=replaceArtMeshes(preset,meshes,true);
 expect(enabled.objects[1].deformParent).toBe(true);expect(enabled.objects[2].deformParent).toBe(true);
 expect(JSON.stringify(preset)).toBe(snapshot);
});
test("invalid later target rejects whole batch and stale IDs cannot be reused",()=>{
 const preset=setup(),snapshot=JSON.stringify(preset),valid={id:"b",mesh:generateRegularArt(2,2,100,80)};
 expect(()=>replaceArtMeshes(preset,[valid,{...valid,id:"missing"}])).toThrow();
 expect(()=>replaceArtMeshes(preset,[valid,valid])).toThrow();
 expect(()=>replaceArtMeshes(preset,[{...valid,id:"a"}])).toThrow();
 expect(JSON.stringify(preset)).toBe(snapshot);
});
