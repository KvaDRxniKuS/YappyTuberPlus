import {test,expect} from "@playwright/test";
import {generateRegularArt} from "../../src/engine/artDeformation";
import {insertArtStateVertex,removeArtStateVertex,replaceArtStateMesh,artRecordDelta} from "../../src/engine/artMeshStates";
import {makeLayer,readStates,writeStates,posePoints,type States} from "../../src/engine/states";
import {createDemoPreset} from "../../src/data/demoPreset";
const mesh=()=>generateRegularArt(2,2,100,100);
function states():States {return {layers:[{...makeLayer(0,"manual.value"),poses:[
 {at:0,pose:{x:5,opacity:-.5},points:{v0:[0,0],v1:[0,0],v3:[0,0]}},
 {at:1,pose:{x:10},points:{v0:[10,5],v1:[10,5],v3:[10,5]}},
]}]};}
test("stable vertex poses survive script serialization and weighted interpolation",()=>{
 const object=createDemoPreset().objects[0];const original=states();
 const saved=writeStates("custom = 42\n",original,object).script;
 expect(saved).toContain("custom = 42");
 const loaded=readStates(saved);expect(loaded.layers[0].poses[1].points?.v3).toEqual([10,5]);
 expect(posePoints(loaded.layers[0],.5).v3).toEqual({x:5,y:2.5});
});
test("topology edits interpolate every key and remove only deleted vertex data",()=>{
 const before=states();const snapshot=JSON.stringify(before);
 const inserted=insertArtStateVertex(mesh(),before,{x:75,y:25});
 expect(inserted.states.layers[0].poses[1].points?.v4).toEqual([10,5]);
 const removed=removeArtStateVertex(inserted.mesh,inserted.states,"v1");
 expect(removed.states.layers[0].poses[1].points?.v1).toBeUndefined();
 expect(removed.states.layers[0].poses[1].points?.v4).toEqual([10,5]);
 expect(removed.states.layers[0].poses[0].pose).toEqual({x:5,opacity:-.5});
 expect(JSON.stringify(before)).toBe(snapshot);
});
test("regeneration clears only vertex channels; offset recording is independent of rest",()=>{
 const before=states();const next=replaceArtStateMesh(generateRegularArt(3,3,100,100,0,4),before);
 expect(next.states.layers[0].poses.every(p=>p.points===undefined)).toBe(true);
 expect(next.states.layers[0].poses[0]).toEqual({at:0,pose:{x:5,opacity:-.5}});
 expect(before.layers[0].poses[1].points).toBeDefined();
 expect(artRecordDelta(mesh(),null,{})).toBeNull();expect(artRecordDelta(mesh(),{},{})).toBeNull();
 expect(artRecordDelta(mesh(),{v0:{x:5,y:0}},{})).toEqual({});
 expect(artRecordDelta(mesh(),{},{v3:{x:2,y:3}})).toEqual({v3:{x:2,y:3}});
 expect(()=>artRecordDelta(mesh(),{},{v999:{x:2,y:3}})).toThrow();
});
