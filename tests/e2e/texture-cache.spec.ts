import {test,expect} from "@playwright/test";
import {TextureCache} from "../../src/render/textureCache";
test("texture LRU reuses two alternating images and deletes evicted GPU entries",()=>{
  const released:number[]=[];const cache=new TextureCache<string,number>(v=>released.push(v),2,10);
  cache.set("a",1,4);cache.set("b",2,4);
  for(let i=0;i<60;i++){expect(cache.get("a")).toBe(1);expect(cache.get("b")).toBe(2);}
  cache.get("a");cache.set("c",3,4);expect(released).toEqual([2]);expect(cache.bytes).toBe(8);
  expect(cache.set("large",4,11)).toBe(false);expect(cache.size).toBe(2);
  cache.clear();expect(released).toEqual([2,1,3]);expect(cache.bytes).toBe(0);
});
test("byte budget and replacing a changed source release old textures",()=>{
 const released:number[]=[];const cache=new TextureCache<string,number>(v=>released.push(v),4,10);
 cache.set("a",1,6);cache.set("b",2,6);expect(released).toEqual([1]);
 cache.set("b",3,5);expect(released).toEqual([1,2]);expect(cache.bytes).toBe(5);
});
