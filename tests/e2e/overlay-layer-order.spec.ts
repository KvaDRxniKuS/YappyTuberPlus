import {test,expect} from "@playwright/test";
import {createDemoPreset,rootScript,childScript} from "../../src/data/demoPreset";
import {NEUTRAL_PARAMS,applyTreeOrder,neutralFrame} from "../../src/engine/frame";
import {orderedObjects} from "../../src/render/rigCanvas";
import {scenePreset,toOverlayScene} from "../../src/overlay/protocol";
import type {RigFrame} from "../../src/types";
function fixture(){
 const preset=createDemoPreset(),source=preset.objects[0];
 preset.objects=[
  {...source,kind:"sprite",id:"neighbor",parentId:null,base:{...source.base,layer:0},script:rootScript()},
  {...source,kind:"sprite",id:"parent",parentId:null,base:{...source.base,layer:-1},script:rootScript({layer:"-1"})},
  {...source,kind:"sprite",id:"child",parentId:"parent",base:{...source.base,layer:0},script:childScript()},
 ];preset.objects=[preset.objects[1],preset.objects[2],preset.objects[0]];return preset;
}
const ids=(objects:ReturnType<typeof orderedObjects>)=>objects.map(object=>object.id);
for(const dynamic of [false,true])test(`script-free overlay honors host layer order, dynamic=${dynamic}`,()=>{
 const preset=fixture();if(dynamic)preset.objects[1].script=childScript({layer:"manual.value"});
 const raw:RigFrame={seq:1,time:0,dt:0,globals:{},diagnostics:[],order:["neighbor","parent","child"],objects:{neighbor:{...NEUTRAL_PARAMS},parent:{...NEUTRAL_PARAMS,layer:-1},child:{...NEUTRAL_PARAMS,layer:dynamic?-2:-1}}};
 const frame=applyTreeOrder(preset,raw),editor=ids(orderedObjects(preset,frame));
 const viewer=scenePreset(toOverlayScene(preset,1),null,preset.overlay);
 expect(viewer.objects.every(object=>object.script==="")).toBe(true);
 // This was the bug: base.layer cannot reconstruct inherit/formula results.
 expect(ids(orderedObjects(viewer,frame))).not.toEqual(editor);
 expect(ids(orderedObjects(viewer,frame,frame.order))).toEqual(editor);
});
test("neutral viewer order matches editor and tolerates removed duplicate and new IDs",()=>{
 const preset=fixture(),frame=neutralFrame(preset),viewer=scenePreset(toOverlayScene(preset,1),null,preset.overlay);
 expect(ids(orderedObjects(viewer,frame,frame.order))).toEqual(ids(orderedObjects(preset,frame)));
 const order=orderedObjects(viewer,frame,["removed","neighbor","neighbor"]);
 expect(ids(order)).toEqual(["neighbor","parent","child"]);
 expect(ids(orderedObjects(viewer,frame,[]))).toEqual(ids(orderedObjects(viewer,frame)));
});
