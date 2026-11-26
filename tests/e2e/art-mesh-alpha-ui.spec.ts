import {test,expect,type Page} from "@playwright/test";
async function mount(page:Page){
 await page.goto("/");
 await page.evaluate(async()=>{
  const reactPath="/node_modules/.vite/deps/react.js",rootPath="/node_modules/.vite/deps/react-dom_client.js";
  const componentPath="/src/components/ArtMeshGenerator.tsx",capturePath="/src/render/artMeshAlphaSource.ts",demoPath="/src/data/demoPreset.ts";
  const [ReactModule,RootModule,{ArtMeshGenerator},{captureArtAlpha},{createDemoPreset}]=await Promise.all([import(reactPath),import(rootPath),import(componentPath),import(capturePath),import(demoPath)]);
  const React=ReactModule.default??ReactModule;const {createRoot}=RootModule.default??RootModule;
  const object={...createDemoPreset().objects[0],id:"alpha-test",kind:"shape",width:40,height:40,shape:{draw:true,fill:"#fff",strokeWidth:0,items:[{id:"rect",kind:"rect",x:5,y:5,width:30,height:30,points:[],closed:true}]}};
  const container=document.createElement("div");document.body.append(container);
  (window as any).artApplied=null;
  createRoot(container).render(React.createElement(ArtMeshGenerator,{width:40,height:40,nextId:0,object,captureAlpha:captureArtAlpha,onClose:()=>{},onApply:(mesh:unknown)=>{(window as any).artApplied=mesh;}}));
 });
}
test("alpha generator captures authored shape, previews and applies only on explicit click",async({page})=>{
 await mount(page);
 const dialog=page.getByRole("dialog",{name:"Генерация артмеша"});
 await dialog.getByLabel("Способ генерации").selectOption("alpha");
 await expect(dialog.getByRole("img",{name:"Предпросмотр сетки"})).toBeVisible();
 await expect(dialog.getByRole("button",{name:"Заменить сетку"})).toBeEnabled();
 await dialog.getByLabel("Раскладка альфа-сетки").selectOption("radial");
 await expect(dialog.getByRole("button",{name:"Заменить сетку"})).toBeEnabled();
 expect(await page.evaluate(()=>(window as any).artApplied)).toBeNull();
 await dialog.getByRole("button",{name:"Заменить сетку"}).click();
 const mesh=await page.evaluate(()=>(window as any).artApplied);
 expect(mesh.vertices.length).toBeGreaterThan(0);expect(mesh.triangles.length).toBeGreaterThan(0);
 expect(mesh.vertices.every((v:any)=>v.rest.x>=5&&v.rest.x<=35&&v.rest.y>=5&&v.rest.y<=35)).toBe(true);
});

test("numeric drafts commit on Enter, blur or five seconds, with integer arrow steps",async({page})=>{
 test.setTimeout(60000);
 await page.clock.install();
 await mount(page);
 const dialog=page.getByRole("dialog",{name:"Генерация артмеша"}),cols=dialog.getByLabel("Столбцов");
 const counts=dialog.locator(".artmesh-preview-counts b").first();
 await expect(counts).toHaveText("16");
 await cols.fill("2");await expect(counts).toHaveText("16");
 await cols.press("Enter");await expect(counts).toHaveText("8");
 await cols.fill("5");await expect(counts).toHaveText("8");
 await cols.blur();await expect(counts).toHaveText("20");
 await cols.fill("6");await expect(counts).toHaveText("20");
 await page.clock.fastForward(4900);await expect(counts).toHaveText("20");
 await page.clock.fastForward(100);await expect(counts).toHaveText("24");
 await dialog.getByLabel("Способ генерации").selectOption("alpha");
 const spacing=dialog.getByLabel("Внутренний шаг, px");
 await spacing.fill("100");await spacing.press("Enter");
 await spacing.press("ArrowUp");await expect(spacing).toHaveValue("101");
 await spacing.press("ArrowDown");await expect(spacing).toHaveValue("100");
 await spacing.press("ArrowDown");await expect(spacing).toHaveValue("99");
 await spacing.press("Enter");
 const polygons=await dialog.locator("polygon").count();
 await spacing.fill("5");await expect(dialog.locator("polygon")).toHaveCount(polygons);
 await spacing.fill("500");await expect(dialog.locator("polygon")).toHaveCount(polygons);
 await spacing.blur();await expect(dialog.getByRole("button",{name:"Заменить сетку"})).toBeEnabled();
});
test("regular grid displays source pixels and applies the latest blurred draft",async({page})=>{
 await mount(page);
 const dialog=page.getByRole("dialog",{name:"Генерация артмеша"});
 const image=dialog.locator('image[aria-label="Исходное изображение объекта"]');
 await expect(image).toHaveCount(1);await expect(image).toHaveAttribute("href",/^data:image\/png/);
 const pixel=await image.evaluate(async element=>{
  const img=new Image();img.src=element.getAttribute("href")!;await img.decode();
  const c=document.createElement("canvas");c.width=img.width;c.height=img.height;const ctx=c.getContext("2d")!;ctx.drawImage(img,0,0);
  return [...ctx.getImageData(10,10,1,1).data];
 });
 expect(pixel).toEqual([255,255,255,255]);
 await dialog.getByLabel("Столбцов").fill("5");
 await dialog.getByRole("button",{name:"Заменить сетку"}).click();
 const mesh=await page.evaluate(()=>(window as any).artApplied);expect(mesh.vertices).toHaveLength(20);
});
