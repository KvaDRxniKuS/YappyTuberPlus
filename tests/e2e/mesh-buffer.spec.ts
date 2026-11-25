import {test,expect} from "@playwright/test";
import {meshBufferSize,meshMatrix,drawMeshImage} from "../../src/render/mesh";
import {createDemoPreset} from "../../src/data/demoPreset";
test("mesh storage grows in buckets, never exceeds viewport, shrinks with it",()=>{
  expect(meshBufferSize(1,70,1000)).toBe(128);
  expect(meshBufferSize(128,65,1000)).toBe(128);
  expect(meshBufferSize(128,140,1000)).toBe(192);
  expect(meshBufferSize(192,60,100)).toBe(100);
});
test("bucket storage preserves top-left pixel placement and reuses backing store",()=>{
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,"document");
  let width=1,height=1,resizes=0;const copies:unknown[][]=[];const matrices:number[][]=[];
  const gl=new Proxy({
    getShaderParameter:()=>true,getProgramParameter:()=>true,getAttribLocation:()=>0,
    uniformMatrix3fv:(_a:unknown,_b:unknown,m:Float32Array)=>matrices.push([...m]),
  } as Record<string,unknown>,{get(target,key:string){return key in target?target[key]:()=>({});}});
  const canvas={get width(){return width;},set width(v:number){width=v;resizes++;},
    get height(){return height;},set height(v:number){height=v;resizes++;},getContext:()=>gl};
  Object.defineProperty(globalThis,"document",{configurable:true,value:{createElement:()=>canvas}});
  const ctx={canvas:{width:1000,height:1000},getTransform:()=>({a:1,b:0,c:0,d:1,e:20,f:30}),
    save(){},restore(){},setTransform(){},drawImage:(...args:unknown[])=>copies.push(args)};
  const object=createDemoPreset().objects[0];const image={naturalWidth:100,naturalHeight:100,src:"a"};
  const geometry=(size:number)=>({targets:[{x:0,y:0},{x:size,y:0},{x:0,y:size}],uv:[{x:0,y:0},{x:1,y:0},{x:0,y:1}],triangles:[0,1,2]});
  try{
    const draw=(size:number)=>drawMeshImage(ctx as any,image as any,object,100,100,undefined,undefined,undefined,geometry(size));
    draw(70);const afterFirst=resizes;draw(65);draw(70);
    expect(resizes).toBe(afterFirst);expect([width,height]).toEqual([128,128]);
    const [,sx,sy,w,h,x,y,dw,dh]=copies[0];
    expect([sx,sy,x,y]).toEqual([0,0,19,29]);expect([w,h]).toEqual([dw,dh]);
    expect(matrices[0]).toEqual([...meshMatrix(ctx.getTransform(),{left:19,top:29,width:128,height:128})]);
    draw(140);expect(resizes).toBe(afterFirst+2);
  } finally{
    if(descriptor)Object.defineProperty(globalThis,"document",descriptor);else Reflect.deleteProperty(globalThis,"document");
  }
});
