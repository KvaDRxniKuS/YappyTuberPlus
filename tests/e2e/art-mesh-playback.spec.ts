import {test,expect} from "@playwright/test";
import {createDemoPreset} from "../../src/data/demoPreset";
import {generateRegularArt} from "../../src/engine/artDeformation";
import {artStateOffsets,artFramePoints} from "../../src/engine/artMeshPlayback";
import {makeLayer,writeStates,watchNames,readStates} from "../../src/engine/states";
import {neutralFrame} from "../../src/engine/frame";
import {prepareRigMeshes} from "../../src/render/rigCanvas";
function setup(){
 const preset=createDemoPreset();const object={...preset.objects[0],kind:"sprite" as const,width:100,height:100,artMesh:generateRegularArt(2,2,100,100),artPose:{v0:{x:2,y:3}}};
 const states={layers:[{...makeLayer(0,"mouse.x"),normalize:"sum" as const,poses:[{at:0,pose:{},points:{v0:[0,0] as [number,number]}},{at:1,pose:{},points:{v0:[20,8] as [number,number]}}]},
 {...makeLayer(1),normalize:"sum" as const,poses:[{weight:"mouse.y * 2",pose:{},points:{v0:[4,10] as [number,number]}}]}]};
 object.script=writeStates(object.script,states,object).script;
 const project={...preset,objects:[object]},frame=neutralFrame(project);
 frame.vars={[object.id]:{states_art_w0_0:.75,states_art_w0_1:.25,states_art_w1_0:.5}};
 return {object,project,frame};
}
test("vertex-only bound and free poses emit watched weights",()=>{
 const {object}=setup();expect(object.script).toContain("states_art_w0_1 = t0_0");
 expect(object.script).toContain("states_art_w1_0 = w1_0");
 expect(watchNames(readStates(object.script))).toEqual(expect.arrayContaining(["states_art_w0_0","states_art_w0_1","states_art_w1_0"]));
});
test("frame weights animate geometry without an open states panel",()=>{
 const {object,project,frame}=setup();
 expect(artStateOffsets(object,frame).v0).toEqual({x:7,y:7});
 expect(prepareRigMeshes(project,frame)[object.id].targets[0]).toEqual({x:9,y:10});
 expect(artStateOffsets(object,null)).toEqual({});
});
test("preview replaces only selected layer including an empty pose",()=>{
 const {object,project,frame}=setup();
 const preview={id:object.id,pose:{},live:{},pointLayer:0,points:{v0:{x:30,y:40}}};
 expect(artStateOffsets(object,frame,preview).v0).toEqual({x:32,y:45});
 expect(artStateOffsets(object,frame,{...preview,points:{}}).v0).toEqual({x:2,y:5});
 const points=artFramePoints(project,frame,undefined,preview);
 expect(prepareRigMeshes(project,frame,points)[object.id].targets[0]).toEqual({x:34,y:48});
});
test("parent group animation produces serializable prepared overlay geometry",async()=>{
 const {toOverlayScene,scenePreset}=await import("../../src/overlay/protocol");
 const {object,project,frame}=setup();
 const parent={...object,id:"deformer",kind:"group" as const,artPose:{}};
 const child={...object,id:"child",parentId:parent.id,deformParent:true,script:"",artPose:{}};
 const preset={...project,objects:[parent,child]};
 frame.vars={[parent.id]:frame.vars![object.id]};
 frame.objects[parent.id]=frame.objects[object.id];frame.objects[child.id]=frame.objects[object.id];
 const geometry=prepareRigMeshes(preset,frame);
 expect(geometry.child.targets[0]).toEqual({x:7,y:7});
 const overlay=scenePreset(toOverlayScene(preset,1));
 expect(overlay.objects.every(o=>o.script==="")).toBe(true);
 // The host transports prepared meshes atomically with the frame: the viewer
 // intentionally has no scripts and must not recalculate state weights.
 const message=JSON.parse(JSON.stringify({t:"frame",frame,sceneVersion:1,meshes:geometry}));
 expect(message.meshes.child).toEqual(geometry.child);
});

test("average blends neutral and absent vertex poses continuously in runtime and preview",async()=>{
 const {artPosePoints,blendArtLayer}=await import("../../src/engine/artMeshBlend");
 const {object,project,frame}=setup();
 const layer={...makeLayer(0,"mouse.x"),normalize:"average" as const,poses:[
  {at:0,pose:{},points:{v0:[0,0] as [number,number]}},
  {at:1,pose:{},points:{v0:[20,8] as [number,number]}},
 ]};
 object.script=writeStates(object.script,{layers:[layer]},object).script;
 expect(artPosePoints(layer,.25).v0).toEqual({x:5,y:2});
 frame.vars={[object.id]:{states_art_w0_0:.75,states_art_w0_1:.25}};
 expect(artStateOffsets(object,frame).v0).toEqual(artPosePoints(layer,.25).v0);
 expect(prepareRigMeshes(project,frame)[object.id].targets[0]).toEqual({x:7,y:5});
 const sparse={...layer,poses:[{at:0,pose:{}},layer.poses[1]]};
 expect(artPosePoints(sparse,.25).v0).toEqual({x:5,y:2});
 expect(blendArtLayer(layer,[3,1]).v0).toEqual({x:5,y:2});
 expect(blendArtLayer(layer,[0,0]).v0).toEqual({x:0,y:0});
 expect(blendArtLayer(layer,[NaN,Infinity])).toEqual({});
});

test("record between average keys preserves the displayed blend when inserting a key",async()=>{
 const {artPosePoints}=await import("../../src/engine/artMeshBlend");
 const {addKey,toPosePoints,addPoints}=await import("../../src/engine/states");
 const layer={...makeLayer(0,"mouse.x"),normalize:"average" as const,poses:[
  {at:0,pose:{}}, {at:1,pose:{},points:{v0:[20,8] as [number,number]}},
 ]};
 const displayed=artPosePoints(layer,.25),dragDelta={v0:{x:3,y:-2}};
 const points=toPosePoints(addPoints(displayed,dragDelta));
 const inserted=addKey(layer,.25,{});
 const recorded={...inserted,poses:inserted.poses.map(p=>p.at===.25?{...p,points}:p)};
 expect(artPosePoints(recorded,.25).v0).toEqual({x:8,y:0});
 expect(recorded.poses[0]).toEqual(layer.poses[0]);
 expect(recorded.poses[2]).toEqual(layer.poses[1]);
});

test("loading canonicalizes intermediate art state blocks without losing author code",async()=>{
 const {normalizePreset}=await import("../../src/engine/preset");
 const {object,project}=setup();
 object.script=object.script.replace(/^states_art_w\d+_\d+ = .*\n/gm,"")+"\ncustom_value = 42";
 const original=readStates(object.script);
 const normalized=normalizePreset(project)!;
 expect(normalized.objects[0].script).toContain("states_art_w0_1 = t0_0");
 expect(normalized.objects[0].script).toContain("custom_value = 42");
 expect(readStates(normalized.objects[0].script)).toEqual(original);
 expect(normalizePreset(normalized)!.objects[0].script).toBe(normalized.objects[0].script);
});
