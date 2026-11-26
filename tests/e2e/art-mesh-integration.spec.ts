import {test,expect} from "@playwright/test";
import {createDemoPreset} from "../../src/data/demoPreset";
import {normalizePreset} from "../../src/engine/preset";
import {generateRegularArt} from "../../src/engine/artDeformation";
import {prepareRigMeshes} from "../../src/render/rigCanvas";
import {neutralFrame} from "../../src/engine/frame";
import {toOverlayScene,scenePreset,structureSignature} from "../../src/overlay/protocol";
function project(){
 const preset=createDemoPreset();const object={...preset.objects.find(o=>o.kind==="sprite")!,width:100,height:100,
  artMesh:generateRegularArt(2,2,100,100),artPose:{v0:{x:5,y:7}},mesh:{enabled:true}};
 return {...preset,objects:[object]};
}
test("project load/save retains authoritative art mesh and removes obsolete controls",()=>{
 const preset=project();const normalized=normalizePreset(JSON.parse(JSON.stringify(preset)))!;
 expect(normalized.objects[0].artMesh).toEqual(preset.objects[0].artMesh);
 expect(normalized.objects[0].artPose).toEqual(preset.objects[0].artPose);
 expect(normalized.objects[0].mesh).toBeUndefined();expect(normalized.objects[0].warp).toBeUndefined();
 expect(prepareRigMeshes(normalized,neutralFrame(normalized))[normalized.objects[0].id].targets[0]).toEqual({x:5,y:7});
});
test("overlay scene and prepared payload use identical new topology and pose",()=>{
 const preset=project();const scene=toOverlayScene(preset,1);
 const overlay=scenePreset(scene,null,preset.overlay);
 const editor=prepareRigMeshes(preset,neutralFrame(preset));const receiver=prepareRigMeshes(overlay,neutralFrame(overlay));
 expect(receiver).toEqual(editor);
 expect(structureSignature({...preset,objects:[{...preset.objects[0],artPose:{v0:{x:15,y:7}}}]})).not.toBe(structureSignature(preset));
});
test("group art deformer only affects explicitly opted-in meshed children",()=>{
 const preset=project();const base=preset.objects[0];
 const parent={...base,id:"parent",kind:"group" as const,mesh:undefined,artPose:Object.fromEntries(base.artMesh.vertices.map(v=>[v.id,{x:10,y:0}]))};
 const child={...base,id:"child",parentId:parent.id,mesh:undefined,artPose:undefined,base:{...parent.base},deformParent:true};
 const p={...preset,objects:[parent,child]};
 const enabled=prepareRigMeshes(p,neutralFrame(p)).child;
 const off={...p,objects:[parent,{...child,deformParent:false}]};
 const disabled=prepareRigMeshes(off,neutralFrame(off)).child;
 expect(enabled.targets[0].x-disabled.targets[0].x).toBeCloseTo(10);
 const unmeshed={...p,objects:[parent,{...child,artMesh:undefined}]};
 expect(prepareRigMeshes(unmeshed,neutralFrame(unmeshed)).child).toBeUndefined();
});

test("malformed unified data rejects the project rather than falling back to grid",()=>{
 const preset=project();const bad={...preset,objects:[{...preset.objects[0],artPose:{v999:{x:1,y:1}}}]};
 expect(normalizePreset(bad)).toBeNull();
});
