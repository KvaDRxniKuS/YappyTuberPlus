import {test,expect} from "@playwright/test";
import {maskBufferSize} from "../../src/render/rigCanvas";
test("mask scratch storage follows bounded crop high-water size",()=>{
  expect(maskBufferSize(1,100,2000)).toBe(128);
  expect(maskBufferSize(128,90,2000)).toBe(128);
  expect(maskBufferSize(128,129,2000)).toBe(192);
  expect(maskBufferSize(192,91,100)).toBe(100);
  expect(maskBufferSize(1,2000,2000)).toBe(2000);
});

test("cropped mask preserves camera translation and composites at original pixels",async()=>{
  const {drawRig}=await import("../../src/render/rigCanvas");
  const {DEFAULT_BASE}=await import("../../src/types");
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,"document");
  const transforms:unknown[][]=[],composites:unknown[][]=[];
  const scratch={width:300,height:150,getContext:()=>layer};
  const layer={canvas:scratch,setTransform:(...args:unknown[])=>transforms.push(args),
    clearRect(){},save(){},restore(){},transform(){},translate(){},drawImage(){},beginPath(){},moveTo(){},lineTo(){},closePath(){},fill(){}};
  const main={canvas:{width:2000,height:1600},getTransform:()=>({a:2,b:0,c:0,d:2,e:30,f:40}),
    save(){},restore(){},setTransform(){},drawImage:(...args:unknown[])=>composites.push(args)};
  const object={id:"sprite",name:"",kind:"sprite",image:"asset",parentId:null,enabled:true,
    base:{...DEFAULT_BASE,x:100,y:100},pivot:{x:0,y:0},width:100,height:50,script:"",
    mask:{kind:"points",points:[{x:0,y:0},{x:100,y:0},{x:0,y:50}],feather:0,invert:false}};
  Object.defineProperty(globalThis,"document",{configurable:true,value:{createElement:()=>scratch}});
  try{
    drawRig(main as any,{objects:[object]} as any,null,{get:()=>({complete:true,naturalWidth:100})} as any);
    expect(scratch.width).toBeLessThan(2000);expect(scratch.height).toBeLessThan(1600);
    expect(composites).toHaveLength(1);
    const [,sx,sy,w,h,x,y,dw,dh]=composites[0] as number[];
    expect([sx,sy]).toEqual([0,0]);expect([w,h]).toEqual([dw,dh]);
    expect(x).toBeGreaterThan(0);expect(y).toBeGreaterThan(0);
    expect(transforms).toContainEqual([2,0,0,2,30-x,40-y]);
  }finally{
    if(descriptor)Object.defineProperty(globalThis,"document",descriptor);else Reflect.deleteProperty(globalThis,"document");
  }
});
