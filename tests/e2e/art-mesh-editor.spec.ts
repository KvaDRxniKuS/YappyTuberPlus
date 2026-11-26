import {test,expect} from "@playwright/test";
import {generateRegularArt} from "../../src/engine/artDeformation";
import {artEditorPoint,editArtVertex} from "../../src/render/artMeshEditor";
import {createDemoPreset} from "../../src/data/demoPreset";
import {readFileSync} from "node:fs";
test("base edits preserve UV/relative poses; pose edits preserve base and topology",()=>{
 const mesh=generateRegularArt(2,2,100,100),pose={v0:{x:4,y:7}};
 const rest=editArtVertex(mesh,pose,"v0",{x:20,y:30},{x:25,y:28},"rest");
 expect(rest.mesh.vertices[0].rest).toEqual({x:5,y:-2});expect(rest.mesh.vertices[0].uv).toEqual({x:0,y:0});
 expect(rest.pose).toBe(pose);
 const moved=editArtVertex(mesh,pose,"v0",{x:20,y:30},{x:25,y:28},"pose");
 expect(moved.mesh).toBe(mesh);expect(moved.pose.v0).toEqual({x:9,y:5});expect(pose.v0).toEqual({x:4,y:7});
});
test("pointer coordinates respect object pivot and camera-space transform",()=>{
 const object={...createDemoPreset().objects[0],width:100,height:80,pivot:{x:.5,y:.5}};
 expect(artEditorPoint(object,{x:40,y:60},{a:2,b:0,c:0,d:2,e:20,f:40})).toEqual({x:60,y:50});
});
test("generator is draft-only until explicit apply and exposes preview counts",()=>{
 const source=readFileSync("src/components/ArtMeshGenerator.tsx","utf8");
 expect(source).toContain('aria-label="Предпросмотр сетки"');
 expect(source).toContain('onApply(mesh)');expect(source).toContain('disabled={!mesh}');
 expect(source).toContain('onClick={onClose}');
});

test("inverse dragging follows scaled/skewed parent surface, not screen delta",async()=>{
 const {inverseArtEditorPoint}=await import("../../src/render/artMeshEditor");
 const deform=(p:{x:number;y:number})=>({x:2*p.x+.5*p.y+10,y:.25*p.x+1.5*p.y-7});
 const start={x:20,y:30},end={x:28,y:24},target=deform(end);
 const local=inverseArtEditorPoint(target,start,deform)!;
 expect(local.x).toBeCloseTo(end.x,5);expect(local.y).toBeCloseTo(end.y,5);
 const mesh=generateRegularArt(2,2,100,100),pose={v0:{x:20,y:30}};
 const edited=editArtVertex(mesh,pose,"v0",start,local,"pose");
 expect(edited.pose.v0.x).toBeCloseTo(28,5);expect(edited.pose.v0.y).toBeCloseTo(24,5);
 expect(edited.mesh).toBe(mesh);
});

test("actual nested group sampler roundtrips and matches prepared child vertices",async()=>{
 const {inverseArtEditorPoint}=await import("../../src/render/artMeshEditor");
 const {createParentMeshTransforms}=await import("../../src/render/bend");
 const {prepareRigMeshes}=await import("../../src/render/rigCanvas");
 const {neutralFrame}=await import("../../src/engine/frame");
 const preset=createDemoPreset(),source=preset.objects[0],mesh=generateRegularArt(2,2,100,100);
 const group={...source,id:"parent",kind:"group" as const,width:100,height:100,artMesh:mesh,artPose:Object.fromEntries(mesh.vertices.map(v=>[v.id,{x:v.rest.x*.2+2,y:v.rest.y*.1+3}]))};
 const outer={...group,id:"outer",artPose:Object.fromEntries(mesh.vertices.map(v=>[v.id,{x:1,y:2}]))};
 const parent={...group,parentId:outer.id,deformParent:true};
 const child={...group,id:"child",kind:"sprite" as const,parentId:parent.id,deformParent:true,artPose:{}};
 const project={...preset,objects:[outer,parent,child]},frame=neutralFrame(project);
 const deform=createParentMeshTransforms(project,frame)!(child)!;
 const start={x:20,y:20},destination={x:35,y:40};
 const inverse=inverseArtEditorPoint(deform(destination),start,deform)!;
 expect(inverse.x).toBeCloseTo(35,5);expect(inverse.y).toBeCloseTo(40,5);
 expect(prepareRigMeshes(project,frame).child.targets[0]).toEqual(deform(mesh.vertices[0].rest));
 const off={...child,deformParent:false};
 expect(createParentMeshTransforms({...project,objects:[outer,parent,off]},frame)!(off)).toBeUndefined();
});

test("singular or invalid parent surfaces reject drag without nonfinite pose data",async()=>{
 const {inverseArtEditorPoint}=await import("../../src/render/artMeshEditor");
 expect(inverseArtEditorPoint({x:3,y:4},{x:0,y:0},()=>({x:1,y:1}))).toBeNull();
 expect(inverseArtEditorPoint({x:3,y:4},{x:0,y:0},()=>({x:NaN,y:1}))).toBeNull();
 expect(inverseArtEditorPoint({x:3,y:4},{x:0,y:0})).toEqual({x:3,y:4});
});

test("multi-vertex edits preserve stable topology UV and non-selected pose",async()=>{
 const {editArtVertices}=await import("../../src/render/artMeshEditor");
 const mesh=generateRegularArt(2,2,100,100),pose={v0:{x:2,y:3},v3:{x:7,y:9}},deltas={v0:{x:5,y:-2},v1:{x:1,y:4}};
 const rest=editArtVertices(mesh,pose,deltas,"rest");
 expect(rest.pose).toBe(pose);expect(rest.mesh.triangles).toBe(mesh.triangles);
 expect(rest.mesh.vertices[0].rest).toEqual({x:5,y:-2});
 expect(rest.mesh.vertices[0].uv).toBe(mesh.vertices[0].uv);
 expect(rest.mesh.vertices[2]).toBe(mesh.vertices[2]);
 const moved=editArtVertices(mesh,pose,deltas,"pose");
 expect(moved.mesh).toBe(mesh);expect(moved.pose).toEqual({v0:{x:7,y:1},v1:{x:1,y:4},v3:{x:7,y:9}});
 expect(editArtVertices(mesh,pose,deltas,"pose")).toEqual(moved);
 expect(pose.v0).toEqual({x:2,y:3});
 expect(()=>editArtVertices(mesh,pose,{v0:{x:Infinity,y:0}},"pose")).toThrow();
});

test("soft move brush has smooth bounded influence and ignores invalid radius",async()=>{
 const {artBrushWeight,editArtVertices}=await import("../../src/render/artMeshEditor");
 expect(artBrushWeight(0,100)).toBe(1);expect(artBrushWeight(50,100)).toBe(.5);
 expect(artBrushWeight(100,100)).toBe(0);expect(artBrushWeight(150,100)).toBe(0);
 expect(artBrushWeight(0,0)).toBe(0);expect(artBrushWeight(NaN,100)).toBe(0);
 const mesh=generateRegularArt(2,2,100,100);
 const next=editArtVertices(mesh,{},Object.fromEntries([0,1].map((index)=>[`v${index}`,{x:20*artBrushWeight(index*50,100),y:0}])),"pose");
 expect(next.pose.v0.x).toBe(20);expect(next.pose.v1.x).toBe(10);
 expect(next.pose.v2).toBeUndefined();
});
test("rest authoring reprojects UV while deformation retains it",async()=>{
 const {editArtVertices}=await import("../../src/render/artMeshEditor");
 const mesh=generateRegularArt(2,2,160,120),pose={v0:{x:3,y:4}};
 const rest=editArtVertices(mesh,pose,{v0:{x:16,y:24}},"rest",{width:160,height:120});
 expect(rest.mesh.vertices[0].uv).toEqual({x:.1,y:.2});expect(rest.pose).toBe(pose);
 const deformation=editArtVertices(mesh,pose,{v0:{x:16,y:24}},"pose",{width:160,height:120});
 expect(deformation.mesh).toBe(mesh);expect(deformation.pose.v0).toEqual({x:19,y:28});
});
