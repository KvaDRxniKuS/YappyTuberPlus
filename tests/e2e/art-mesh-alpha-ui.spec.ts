import {test,expect} from "@playwright/test";
test("alpha generator captures authored shape, previews and applies only on explicit click",async({page})=>{
 await page.goto("/");
 await page.evaluate(async()=>{
  const reactPath="/node_modules/.vite/deps/react.js",rootPath="/node_modules/.vite/deps/react-dom_client.js";
  const componentPath="/src/components/ArtMeshGenerator.tsx",capturePath="/src/render/artMeshAlphaSource.ts",demoPath="/src/data/demoPreset.ts";
  const [React,{createRoot},{ArtMeshGenerator},{captureArtAlpha},{createDemoPreset}]=await Promise.all([import(reactPath),import(rootPath),import(componentPath),import(capturePath),import(demoPath)]);
  const object={...createDemoPreset().objects[0],id:"alpha-test",kind:"shape",width:40,height:40,shape:{draw:true,fill:"#fff",strokeWidth:0,items:[{id:"rect",kind:"rect",x:5,y:5,width:30,height:30,points:[],closed:true}]}};
  const container=document.createElement("div");document.body.append(container);
  (window as any).artApplied=null;
  createRoot(container).render(React.createElement(ArtMeshGenerator,{width:40,height:40,nextId:0,object,captureAlpha:captureArtAlpha,onClose:()=>{},onApply:(mesh:unknown)=>{(window as any).artApplied=mesh;}}));
 });
 const dialog=page.getByRole("dialog",{name:"Генерация артмеша"});
 await dialog.getByLabel("Способ генерации").selectOption("alpha");
 await expect(dialog.getByRole("img",{name:"Предпросмотр сетки"})).toBeVisible();
 await expect(dialog.getByRole("button",{name:"Заменить сетку"})).toBeEnabled();
 expect(await page.evaluate(()=>(window as any).artApplied)).toBeNull();
 await dialog.getByRole("button",{name:"Заменить сетку"}).click();
 const mesh=await page.evaluate(()=>(window as any).artApplied);
 expect(mesh.vertices.length).toBeGreaterThan(0);expect(mesh.triangles.length).toBeGreaterThan(0);
 expect(mesh.vertices.every((v:any)=>v.rest.x>=5&&v.rest.x<=35&&v.rest.y>=5&&v.rest.y<=35)).toBe(true);
});
