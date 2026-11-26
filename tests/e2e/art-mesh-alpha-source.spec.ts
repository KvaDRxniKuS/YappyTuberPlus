import {test,expect} from "@playwright/test";
import {captureArtAlpha} from "../../src/render/artMeshAlphaSource";
import {createDemoPreset} from "../../src/data/demoPreset";
test("capture bounds raster and copies alpha independently of runtime pose",()=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,"document");
 const canvas={width:0,height:0,getContext:()=>({drawImage:()=>{},getImageData:()=>({data:Uint8ClampedArray.from({length:256*128*4},(_,i)=>i%4===3?123:0)})})};
 Object.defineProperty(globalThis,"document",{configurable:true,value:{createElement:()=>canvas}});
 try{
  const object={...createDemoPreset().objects[0],kind:"sprite" as const,width:1000,height:500};
  const raster=captureArtAlpha(object,{} as CanvasImageSource);
  expect(raster.width).toBe(256);expect(raster.height).toBe(128);
  expect(raster.objectWidth).toBe(1000);expect(raster.objectHeight).toBe(500);
  expect(raster.alpha.every(a=>a===123)).toBe(true);
  expect(canvas.width).toBe(1);expect(canvas.height).toBe(1);
  expect(()=>captureArtAlpha({...object,kind:"group"})).toThrow();
 }finally{if(previous)Object.defineProperty(globalThis,"document",previous);else delete (globalThis as any).document;}
});
test("pixel read failure is surfaced and temporary canvas is released",()=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,"document");
 const canvas={width:0,height:0,getContext:()=>({drawImage:()=>{},getImageData:()=>{throw new Error("SecurityError");}})};
 Object.defineProperty(globalThis,"document",{configurable:true,value:{createElement:()=>canvas}});
 try{expect(()=>captureArtAlpha({...createDemoPreset().objects[0],kind:"sprite"},{} as CanvasImageSource)).toThrow(/CORS/);expect(canvas.width).toBe(1);}
 finally{if(previous)Object.defineProperty(globalThis,"document",previous);else delete (globalThis as any).document;}
});
