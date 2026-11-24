import {test,expect} from "@playwright/test";
import {sameVisualFrame} from "../../src/render/frameChanges";
import {drawShapeObject} from "../../src/render/rigCanvas";
import {defaultShape,shapeContentBounds} from "../../src/render/shape";
import {makeShape} from "../../src/engine/preset";
import {NEUTRAL_PARAMS} from "../../src/engine/frame";
import type {RigFrame} from "../../src/types";

function frame():RigFrame {
  return {seq:1,time:0,dt:1/60,globals:{},objects:{a:{...NEUTRAL_PARAMS}},order:["a"],diagnostics:[]};
}
test("identical visual output ignores clock/sequence but detects every object channel",()=>{
  const a=frame(),b=structuredClone(a);
  b.seq++;b.time++;b.dt=0;b.order=[];
  expect(sameVisualFrame(a,b)).toBe(true);
  for(const key of Object.keys(b.objects.a)) {
    const c=structuredClone(b);c.objects.a[key as keyof typeof c.objects.a]+=1;
    expect(sameVisualFrame(a,c),key).toBe(false);
  }
  b.objects.b={...NEUTRAL_PARAMS};expect(sameVisualFrame(a,b)).toBe(false);
});
test("visual comparison notices text/global/remove changes",()=>{
  const a=frame(),b=frame();
  b.texts={caption:"hello"};expect(sameVisualFrame(a,b)).toBe(false);
  delete b.texts;b.globals={value:1};expect(sameVisualFrame(a,b)).toBe(false);
  b.globals={};delete b.objects.a;expect(sameVisualFrame(a,b)).toBe(false);
  expect(sameVisualFrame(a,null)).toBe(false);
});
test("bounds reuse survives color edits but not contour/stroke edits",()=>{
  const a=defaultShape(100,50),bounds=shapeContentBounds(a);
  expect(shapeContentBounds({...a,fill:"red"})).toBe(bounds);
  expect(shapeContentBounds({...a,strokeWidth:20})).not.toBe(bounds);
  expect(shapeContentBounds({...a,items:[{...a.items[0],width:200}]} )?.width).toBe(200);
});
test("unchanged shape paths are built once, geometry edits rebuild, paints remain live",()=>{
  const original=globalThis.Path2D;
  let built=0,traced=0,filled=0;
  class FakePath {constructor(){built++;}rect(){traced++;}}
  globalThis.Path2D=FakePath as unknown as typeof Path2D;
  try {
    const object=makeShape("test","test",100,50,0,0);
    object.shape=defaultShape(100,50);
    const ctx={fillStyle:"",fill:()=>{filled++;},stroke:()=>{}} as unknown as CanvasRenderingContext2D;
    for(let i=0;i<100;i++) drawShapeObject(ctx,object);
    expect(built).toBe(1);expect(traced).toBe(1);expect(filled).toBe(100);
    drawShapeObject(ctx,{...object,shape:{...object.shape,fill:"red"}});
    expect(built).toBe(1);expect(ctx.fillStyle).toBe("red");
    drawShapeObject(ctx,{...object,shape:{...object.shape,items:[{...object.shape.items[0],width:200}]}});
    expect(built).toBe(2);
  } finally {globalThis.Path2D=original;}
});

test("media cues and custom mesh variables invalidate the visual frame",()=>{
  const a=frame(),b=frame();
  a.vars={a:{bend:0}};b.vars={a:{bend:1}};
  expect(sameVisualFrame(a,b)).toBe(false);
  b.vars={a:{bend:0}};expect(sameVisualFrame(a,b)).toBe(true);
  b.media={a:{action:"play",arg:0,seq:1}} as RigFrame["media"];
  expect(sameVisualFrame(a,b)).toBe(false);
});
