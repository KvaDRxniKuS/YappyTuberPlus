import {test,expect} from "@playwright/test";
import {createDemoPreset} from "../../src/data/demoPreset";
import {DEFAULT_BASE} from "../../src/types";
import {worldZone,transformGesture} from "../../src/engine/transformTool";
import {staticValues,objectMatrix,transformPoint} from "../../src/render/rigCanvas";
const object=()=>({...createDemoPreset().objects[0],width:100,height:80,pivot:{x:.2,y:.3},base:{...DEFAULT_BASE,x:200,y:150}});
const close=(a:{x:number;y:number},b:{x:number;y:number})=>{expect(a.x).toBeCloseTo(b.x,6);expect(a.y).toBeCloseTo(b.y,6);};
for(const options of [{ctrl:false,alt:false,shift:false},{ctrl:false,alt:true,shift:false},{ctrl:false,alt:false,shift:true}]){
 test(`scale uses opposite/pivot/center anchor ${JSON.stringify(options)}`,()=>{
  const o=object(),v=staticValues(o),z=worldZone(o,v),start=transformPoint(z,1,1),end={x:start.x+20,y:start.y+20};
  const result=transformGesture(o,v,z,{kind:"scale",x:1,y:1},start,end,options);
  const anchor=options.alt?{x:.2,y:.3}:options.shift?{x:.5,y:.5}:{x:0,y:0};
  close(transformPoint(worldZone({...o,base:result.base!},v),anchor.x,anchor.y),transformPoint(z,anchor.x,anchor.y));
  expect(result.base!.sizeX).toBeGreaterThan(1);expect(result.base!.sizeY).toBeGreaterThan(1);
 });
}
test("edge skew fixes opposite edge; rotation fixes center and Ctrl edits zone only",()=>{
 const o=object(),v=staticValues(o),z=worldZone(o,v),start=transformPoint(z,.3,0);
 const r=transformGesture(o,v,z,{kind:"skew",x:.5,y:0},start,{x:start.x+25,y:start.y},{ctrl:false,alt:false,shift:false});
 const next=worldZone({...o,base:r.base!},v);close(transformPoint(next,0,1),transformPoint(z,0,1));close(transformPoint(next,1,1),transformPoint(z,1,1));expect(r.base!.skewX).not.toBe(0);
 const center=transformPoint(z,.5,.5),s={x:center.x,y:center.y-60},e={x:center.x+60,y:center.y};
 const rotation=transformGesture(o,v,z,{kind:"rotate",x:.5,y:0},s,e,{ctrl:false,alt:false,shift:false});
 expect(rotation.base!.rotation).toBeCloseTo(90);close(transformPoint(worldZone({...o,base:rotation.base!},v),.5,.5),center);
 const zone=transformGesture(o,v,z,{kind:"rotate",x:.5,y:0},s,e,{ctrl:true,alt:false,shift:false});expect(zone.base).toBeUndefined();expect(zone.frame).toBeDefined();expect(objectMatrix(o,v)).toEqual(objectMatrix({...o,transformFrame:zone.frame},v));
});

for(const alt of [false,true])for(const shift of [false,true]){
 test(`side scaling and edge skew preserve anchor with alt=${alt} shift=${shift}`,()=>{
  const o=object();o.base={...o.base,rotation:32,skewX:17,skewY:9,sizeX:1.3,sizeY:.7};
  const v=staticValues(o),z=worldZone(o,v),anchor=alt?{x:.2,y:.3}:shift?{x:.5,y:.5}:{x:0,y:.5};
  const start=transformPoint(z,1,.5),end=transformPoint(z,1.2,.65);
  for(const kind of ["scale","skew"] as const){
   const r=transformGesture(o,v,z,{kind,x:1,y:.5},start,end,{ctrl:false,alt,shift});
   close(transformPoint(worldZone({...o,base:r.base!},v),anchor.x,anchor.y),transformPoint(z,anchor.x,anchor.y));
   const ctrl=transformGesture(o,v,z,{kind,x:1,y:.5},start,end,{ctrl:true,alt,shift});
   const normal=worldZone({...o,base:r.base!},v),edited=worldZone({...o,transformFrame:ctrl.frame},v);
   for(const [x,y] of [[0,0],[1,0],[1,1],[0,1]])close(transformPoint(edited,x,y),transformPoint(normal,x,y));
  }
 });
}
