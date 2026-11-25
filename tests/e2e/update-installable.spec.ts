import {test,expect} from "@playwright/test";
import {installableUpdate,type UpdateManifest} from "../../src/engine/update";
const app={path:"app.exe",size:100,sha256:"a".repeat(64)};
const manifest=(extra:Partial<UpdateManifest>={}):UpdateManifest=>({version:"1.1.26.7.2.5.21",...extra});
test("native updates without a valid or different binary remain silent",async()=>{
  expect(await installableUpdate("app",null,manifest())).toBe(false);
  expect(await installableUpdate("app",null,manifest({app:{...app,size:0}}))).toBe(false);
  expect(await installableUpdate("app",null,manifest({app:{...app,sha256:"bad"}}))).toBe(false);
  expect(await installableUpdate("app",{version:"1.1",app},manifest({app}))).toBe(false);
  expect(await installableUpdate("manual",null,manifest())).toBe(true);
  expect(await installableUpdate("agent",null,manifest())).toBe(true);
});
test("native offer requires downloadable binary; failed or partial publication is hidden",async()=>{
  const original=globalThis.fetch;let status=404,length:string|null="100";
  globalThis.fetch=async(url,init)=>{
    expect(url).toBe("https://example.com/dist/app.exe");expect(init?.method).toBe("HEAD");
    return new Response(null,{status,headers:length===null?{}:{"content-length":length}});
  };
  try {
    const check=()=>installableUpdate("app",null,manifest({app}),"https://example.com/dist/");
    expect(await check()).toBe(false);
    status=200;expect(await check()).toBe(true);
    length="12";expect(await check()).toBe(false);
    length=null;expect(await check()).toBe(true);
    globalThis.fetch=async()=>{throw new Error("offline");};expect(await check()).toBe(false);
  } finally {globalThis.fetch=original;}
});
