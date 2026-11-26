import {test,expect,type Page} from "@playwright/test";
import {createDemoPreset,rootScript} from "../../src/data/demoPreset";
import {generateRegularArt} from "../../src/engine/artDeformation";
import {DEFAULT_BASE,type RigPreset} from "../../src/types";
function project(meshed=true):RigPreset{
 const preset=createDemoPreset();
 return {...preset,canvas:{width:400,height:300},modules:[],objects:[{
  ...preset.objects[0],id:"surface",name:"Проверка артмеша",kind:"shape",parentId:null,
  base:{...DEFAULT_BASE,x:100,y:80},pivot:{x:0,y:0},width:160,height:120,script:rootScript(),
  shape:{draw:true,fill:"#ffffff",stroke:"#000000",strokeWidth:0,items:[{id:"rect",kind:"rect",x:0,y:0,width:160,height:120,points:[],closed:true}]},
  artMesh:meshed?generateRegularArt(2,2,160,120):undefined,artPose:{},
 }]};
}
async function open(page:Page,preset:RigPreset){
 await page.addInitScript(value=>localStorage.setItem("yappytuberplus.preset.v2",JSON.stringify(value)),preset);
 await page.goto("/");await expect(page.locator(".tree-row")).toHaveCount(preset.objects.length);
 await page.locator(".tree-row").first().click();
 await page.getByTitle("Деформация артмеша (T)",{exact:true}).click();
}
const stored=(page:Page)=>page.evaluate(()=>JSON.parse(localStorage.getItem("yappytuberplus.preset.v2")!));
async function undo(page:Page){await page.locator(".scene-title").click();await page.keyboard.press("Control+z");}

test("App generation Cancel is inert; Apply replaces once and Ctrl+Z restores the mesh",async({page})=>{
 const preset=project();await open(page,preset);
 await page.getByRole("button",{name:"Сгенерировать артмеш",exact:true}).click();
 let dialog=page.getByRole("dialog",{name:"Генерация артмеша"});
 await dialog.getByLabel("Столбцов").fill("3");
 await dialog.getByRole("button",{name:"Отмена",exact:true}).click();
 expect((await stored(page)).objects[0].artMesh).toEqual(preset.objects[0].artMesh);
 await page.getByRole("button",{name:"Сгенерировать артмеш",exact:true}).click();
 dialog=page.getByRole("dialog",{name:"Генерация артмеша"});
 await dialog.getByLabel("Столбцов").fill("3");await dialog.getByRole("button",{name:"Заменить сетку",exact:true}).click();
 await expect.poll(async()=>(await stored(page)).objects[0].artMesh.vertices.length).toBe(12);
 await undo(page);
 await expect.poll(async()=>(await stored(page)).objects[0].artMesh).toEqual(preset.objects[0].artMesh);
});

test("App pose and rest drags use distinct data and each gesture is one undo",async({page})=>{
 const preset=project();await open(page,preset);
 const canvas=page.locator(".scene-viewport canvas").first();const box=(await canvas.boundingBox())!;
 const viewport=await canvas.evaluate(el=>({width:el.clientWidth,height:el.clientHeight}));
 const zoom=Math.max(.05,Math.min((viewport.width-70)/400,(viewport.height-70)/300,2));
 const x=box.x+(viewport.width-400*zoom)/2+100*zoom,y=box.y+(viewport.height-300*zoom)/2+80*zoom;
 await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+25,y+15,{steps:5});await page.mouse.up();
 await expect.poll(async()=>(await stored(page)).objects[0].artPose.v0?.x??0).toBeGreaterThan(0);
 expect((await stored(page)).objects[0].artMesh).toEqual(preset.objects[0].artMesh);
 await undo(page);await expect.poll(async()=>(await stored(page)).objects[0].artPose).toEqual({});
 await page.getByLabel("Режим артмеша").selectOption("rest");
 await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+20,y+10,{steps:4});await page.mouse.up();
 await expect.poll(async()=>(await stored(page)).objects[0].artMesh.vertices[0].rest.x).toBeGreaterThan(0);
 const changed=(await stored(page)).objects[0];expect(changed.artPose).toEqual({});expect(changed.artMesh.vertices[0].uv).toEqual({x:0,y:0});
 await undo(page);await expect.poll(async()=>(await stored(page)).objects[0].artMesh).toEqual(preset.objects[0].artMesh);
});

test("App copy/paste requires confirmation and replacement is undoable",async({page})=>{
 const preset=project();await open(page,preset);
 await page.getByRole("button",{name:"Копировать артмеш",exact:true}).click();
 await page.getByRole("button",{name:"Вставить артмеш…",exact:true}).click();
 const dialog=page.getByRole("dialog",{name:"Вставить артмеш",exact:true});
 await dialog.getByRole("button",{name:"Отмена",exact:true}).click();
 expect((await stored(page)).objects[0].artMesh).toEqual(preset.objects[0].artMesh);
 await page.getByRole("button",{name:"Вставить артмеш…",exact:true}).click();
 await dialog.getByRole("button",{name:"Заменить артмеш",exact:true}).click();
 await expect.poll(async()=>(await stored(page)).objects[0].artMesh.nextId).toBe(8);
 await undo(page);await expect.poll(async()=>(await stored(page)).objects[0].artMesh).toEqual(preset.objects[0].artMesh);
});

test("App descendant preparation applies explicit scope and inheritance in one undo",async({page})=>{
 const preset=project(),base=preset.objects[0];
 preset.objects=[{...base,id:"root",name:"Деформер",kind:"group",artMesh:undefined},
  {...base,id:"child",name:"Прямой",parentId:"root",artMesh:undefined,deformParent:false},
  {...base,id:"grandchild",name:"Вложенный",parentId:"child",artMesh:undefined,deformParent:false}];
 await open(page,preset);
 await page.getByRole("button",{name:"Подготовить потомков…",exact:true}).click();
 const dialog=page.getByRole("dialog",{name:"Генерация артмеша"});
 await dialog.getByLabel("Область подготовки").selectOption("direct");
 await expect(dialog).toContainText("Будет обработано: 1");
 await dialog.getByLabel("Область подготовки").selectOption("all");
 await expect(dialog).toContainText("Будет обработано: 2");
 await dialog.getByText("Включить наследование деформации у обрабатываемых объектов",{exact:true}).click();
 await dialog.getByRole("button",{name:"Заменить сетку",exact:true}).click();
 await expect.poll(async()=>(await stored(page)).objects.filter((o:any)=>o.artMesh).length).toBe(2);
 const changed=await stored(page);expect(changed.objects[0].artMesh).toBeUndefined();
 expect(changed.objects.slice(1).every((o:any)=>o.deformParent===true)).toBe(true);
 await undo(page);await expect.poll(async()=>(await stored(page)).objects.filter((o:any)=>o.artMesh).length).toBe(0);
 expect((await stored(page)).objects.slice(1).every((o:any)=>o.deformParent===false)).toBe(true);
});

test("App topology insertion is explicit and undo restores IDs UV and triangles",async({page})=>{
 const preset=project();await open(page,preset);
 await page.getByLabel("Режим артмеша").selectOption("rest");
 await page.getByLabel("Выделение вершин артмеша").selectOption("insert");
 const canvas=page.locator(".scene-viewport canvas").first(),box=(await canvas.boundingBox())!;
 const viewport=await canvas.evaluate(el=>({width:el.clientWidth,height:el.clientHeight}));
 const zoom=Math.max(.05,Math.min((viewport.width-70)/400,(viewport.height-70)/300,2));
 await page.mouse.click(box.x+(viewport.width-400*zoom)/2+140*zoom,box.y+(viewport.height-300*zoom)/2+110*zoom);
 await expect.poll(async()=>(await stored(page)).objects[0].artMesh.vertices.length).toBe(5);
 expect((await stored(page)).objects[0].artMesh.vertices.at(-1).id).toBe("v4");
 await undo(page);await expect.poll(async()=>(await stored(page)).objects[0].artMesh).toEqual(preset.objects[0].artMesh);
});

test("rejected legacy file shows the blocking reason and keeps the current scene",async({page})=>{
 const current=project();await open(page,current);
 const old=project(false);Object.assign(old.objects[0],{mesh:{enabled:true}});
 await page.locator('input[type="file"][accept=".json,.yappy.json,application/json"]').setInputFiles({name:"legacy.yappy.json",mimeType:"application/json",buffer:Buffer.from(JSON.stringify(old))});
 const dialog=page.getByRole("dialog",{name:"Версии несовместимы",exact:true});
 await expect(dialog.getByRole("heading",{name:"Пресет не открыт",exact:true})).toBeVisible();
 await expect(dialog).toContainText("Почему пресет не открыт:");
 await expect(dialog).toContainText("Старый деформер: «Проверка артмеша»");
 await expect(dialog).toContainText("автоматического переноса нет");
 await expect(dialog).not.toContainText("Файл записан сборкой, которая знает больше этой");
 expect((await stored(page)).objects[0].artMesh).toEqual(current.objects[0].artMesh);
});

async function surfacePixel(page:Page){
 return page.locator(".scene-viewport canvas").first().evaluate((element)=>{
  const canvas=element as HTMLCanvasElement,w=canvas.clientWidth,h=canvas.clientHeight;
  const zoom=Math.max(.05,Math.min((w-70)/400,(h-70)/300,2));
  const x=(w-400*zoom)/2+130*zoom,y=(h-300*zoom)/2+105*zoom;
  return [...canvas.getContext("2d")!.getImageData(Math.floor(x*canvas.width/w),Math.floor(y*canvas.height/h),1,1).data].slice(0,3);
 });
}
test("structure eye immediately hides and restores pixels in stop and pause",async({page})=>{
 await open(page,project(false));
 await page.getByTitle("Стоп: нейтральная поза для расстановки, состояние анимации сбрасывается · Shift+K",{exact:true}).click();
 await expect(page.locator(".status-stopped")).toBeVisible();
 await expect.poll(()=>surfacePixel(page)).toEqual([255,255,255]);
 const eye=page.locator(".tree-row").first().locator(".tree-eye");
 await eye.click();await expect.poll(async()=>(await surfacePixel(page))[0]).toBeLessThan(200);
 await eye.click();await expect.poll(()=>surfacePixel(page)).toEqual([255,255,255]);
 // Leave stop, then enter ordinary pause; no ticks should be needed for the eye.
 await page.getByTitle("Продолжить · K",{exact:true}).click();
 await page.getByTitle("Пауза · K",{exact:true}).click();
 await eye.click();await expect.poll(async()=>(await surfacePixel(page))[0]).toBeLessThan(200);
 await eye.click();await expect.poll(()=>surfacePixel(page)).toEqual([255,255,255]);
});
test("hidden group children stay fully hidden rather than becoming stop ghosts",async({page})=>{
 const preset=project(false),child=preset.objects[0];
 preset.objects=[{...child,id:"root",kind:"group",name:"Группа"},{...child,parentId:"root"}];
 await open(page,preset);
 await page.getByTitle("Стоп: нейтральная поза для расстановки, состояние анимации сбрасывается · Shift+K",{exact:true}).click();
 await expect.poll(()=>surfacePixel(page)).toEqual([255,255,255]);
 const eye=page.locator(".tree-row").first().locator(".tree-eye");
 await eye.click();await expect.poll(async()=>(await surfacePixel(page))[0]).toBeLessThan(70);
 await eye.click();await expect.poll(()=>surfacePixel(page)).toEqual([255,255,255]);
});
