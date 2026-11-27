import {editArtTopology} from "../../src/engine/artMeshTopology";
import {makeLayer,writeStates,readStates} from "../../src/engine/states";
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
 await page.getByTitle("Вписать сцену",{exact:true}).click();
}
const stored=(page:Page)=>page.evaluate(()=>JSON.parse(localStorage.getItem("yappytuberplus.preset.v2")!));
async function undo(page:Page){await page.locator(".scene-title").click();await page.keyboard.press("Control+z");}

test("App generation Cancel is inert; Apply replaces once and Ctrl+Z restores the mesh",async({page})=>{
 const preset=project();await open(page,preset);
 await page.getByRole("tab",{name:"Сетка",exact:true}).click();
 await page.getByRole("button",{name:"Сгенерировать артмеш",exact:true}).click();
 let dialog=page.getByRole("dialog",{name:"Генерация артмеша"});
 await dialog.getByLabel("Столбцов").fill("3");
 await dialog.getByRole("button",{name:"Отмена",exact:true}).click();
 expect((await stored(page)).objects[0].artMesh).toEqual(preset.objects[0].artMesh);
 await page.getByRole("tab",{name:"Сетка",exact:true}).click();
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
 await page.getByTitle("Правка базы и топологии артмеша (R)",{exact:true}).click();
 await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+20,y+10,{steps:4});await page.mouse.up();
 await expect.poll(async()=>(await stored(page)).objects[0].artMesh.vertices[0].rest.x).toBeGreaterThan(0);
 const changed=(await stored(page)).objects[0];expect(changed.artPose).toEqual({});expect(changed.artMesh.vertices[0].uv).toEqual({x:changed.artMesh.vertices[0].rest.x/160,y:changed.artMesh.vertices[0].rest.y/120});
 await undo(page);await expect.poll(async()=>(await stored(page)).objects[0].artMesh).toEqual(preset.objects[0].artMesh);
});

test("App copy/paste requires confirmation and replacement is undoable",async({page})=>{
 const preset=project();await open(page,preset);
 await page.getByRole("tab",{name:"Сетка",exact:true}).click();
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
 await page.getByRole("tab",{name:"Сетка",exact:true}).click();
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
 await page.getByTitle("Правка базы и топологии артмеша (R)",{exact:true}).click();

 const canvas=page.locator(".scene-viewport canvas").first(),box=(await canvas.boundingBox())!;
 const viewport=await canvas.evaluate(el=>({width:el.clientWidth,height:el.clientHeight}));
 const zoom=Math.max(.05,Math.min((viewport.width-70)/400,(viewport.height-70)/300,2));
 await page.mouse.click(box.x+(viewport.width-400*zoom)/2+140*zoom,box.y+(viewport.height-300*zoom)/2+110*zoom);
 await expect.poll(async()=>(await stored(page)).objects[0].artMesh?.vertices.length).toBe(5);
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
test("manual tracing starts empty, creates points and connects without losing vertices",async({page})=>{
 await open(page,project(false));
 await page.getByRole("button",{name:"Создать вручную",exact:true}).click();
 await expect(page.getByLabel("Выделение вершин артмеша")).toHaveCount(0);
 const canvas=page.locator(".scene-viewport canvas").first(),box=(await canvas.boundingBox())!;
 for(const [x,y] of [[.4,.4],[.6,.4],[.6,.6],[.4,.6],[.5,.5]])await page.mouse.click(box.x+box.width*x,box.y+box.height*y);
 await expect.poll(async()=>(await stored(page)).objects[0].artMesh?.vertices.length).toBe(5);

 await expect.poll(async()=>(await stored(page)).objects[0].artMesh.triangles.length).toBe(4);
 const mesh=(await stored(page)).objects[0].artMesh;expect(new Set(mesh.triangles.flat()).size).toBe(5);
 await undo(page);await expect.poll(async()=>(await stored(page)).objects[0].artMesh.vertices.length).toBe(4);
 await page.getByRole("button",{name:"Закрыть панель артмеша"}).click();await expect(page.getByRole("complementary",{name:"Редактор артмеша"})).toHaveCount(0);
 await page.getByRole("button",{name:"Панель артмеша",exact:true}).click();await expect(page.getByRole("complementary",{name:"Редактор артмеша"})).toBeVisible();
});
test("mesh editing keeps V M L inside editor, moves a new point with UV and erases via Alt",async({page})=>{
 await open(page,project());await page.keyboard.press("KeyR");
 const canvas=page.locator(".scene-viewport canvas").first(),box=(await canvas.boundingBox())!;
 const w=box.width,h=box.height,z=Math.max(.05,Math.min((w-70)/400,(h-70)/300,2));
 const point=(x:number,y:number)=>({x:box.x+(w-400*z)/2+x*z,y:box.y+(h-300*z)/2+y*z});
 const p=point(140,110);
 await page.mouse.click(p.x,p.y);
 await expect.poll(async()=>(await stored(page)).objects[0].artMesh.vertices.length).toBe(5);
 for(const code of ["KeyM","KeyL","KeyV"]){
  await page.keyboard.press(code);
  await expect(page.getByTitle("Правка базы и топологии артмеша (R)",{exact:true})).toHaveClass("active");
  await expect(page.getByRole("complementary",{name:"Редактор артмеша"})).toBeVisible();
 }
 await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(p.x+15,p.y+10,{steps:5});await page.mouse.up();
 await expect.poll(async()=>(await stored(page)).objects[0].artMesh.vertices[4].rest.x).toBeGreaterThan(40);
 const changed=(await stored(page)).objects[0],v=changed.artMesh.vertices[4];
 expect(v.uv.x).toBeCloseTo(v.rest.x/160);expect(v.uv.y).toBeCloseTo(v.rest.y/120);expect(Object.values(changed.artPose).every((p:any)=>p.x===0&&p.y===0)).toBe(true);
 await page.keyboard.down("Alt");await page.mouse.click(p.x+15,p.y+10);await page.keyboard.up("Alt");
 await expect.poll(async()=>(await stored(page)).objects[0].artMesh.vertices.length).toBe(4);
 await undo(page);await expect.poll(async()=>(await stored(page)).objects[0].artMesh.vertices.length).toBe(5);
});
test("rest edits rebuild edges and angled symmetry reflects movement with one undo",async({page})=>{
 const preset=project();preset.objects[0].height=160;preset.objects[0].artMesh=generateRegularArt(2,2,160,160);
 await open(page,preset);await page.keyboard.press("KeyR");
 await page.getByRole("button",{name:"Симметрия артмеша",exact:true}).click();
 await page.getByRole("button",{name:"Симметрия артмеша",exact:true}).hover();
 await page.getByLabel("Угол симметрии артмеша").fill("45");await page.getByLabel("Угол симметрии артмеша").blur();
 const canvas=page.locator(".scene-viewport canvas").first(),box=(await canvas.boundingBox())!;
 const z=Math.max(.05,Math.min((box.width-70)/400,(box.height-70)/300,2));
 const x=box.x+(box.width-400*z)/2+100*z,y=box.y+(box.height-300*z)/2+80*z;
 await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+20,y+10,{steps:6});await page.mouse.up();
 await expect.poll(async()=>(await stored(page)).objects[0].artMesh.vertices[0].rest.x).toBeGreaterThan(5);
 const mesh=(await stored(page)).objects[0].artMesh,a=mesh.vertices[0].rest,b=mesh.vertices[3].rest;
 expect(b.x).toBeCloseTo(160-a.y);expect(b.y).toBeCloseTo(160-a.x);
 expect(new Set(mesh.triangles.flat()).size).toBe(4);
 await undo(page);await expect.poll(async()=>(await stored(page)).objects[0].artMesh).toEqual(preset.objects[0].artMesh);
});
test("Alt edge deletion creates a persistent excluded surface",async({page})=>{
 const preset=project();await open(page,preset);await page.keyboard.press("KeyR");
 const canvas=page.locator(".scene-viewport canvas").first(),box=(await canvas.boundingBox())!;
 const z=Math.max(.05,Math.min((box.width-70)/400,(box.height-70)/300,2));
 const x=box.x+(box.width-400*z)/2+180*z,y=box.y+(box.height-300*z)/2+140*z;
 await page.keyboard.down("Alt");await page.mouse.click(x,y);await page.keyboard.up("Alt");
 await expect.poll(async()=>(await stored(page)).objects[0].artMesh.triangles).not.toEqual(preset.objects[0].artMesh!.triangles);
 await expect.poll(async()=>(await stored(page)).objects[0].artMesh.triangles.length).toBe(0);
 const mesh=(await stored(page)).objects[0].artMesh;expect(mesh.vertices).toHaveLength(4);expect(mesh.excludedFaces).toHaveLength(2);
});
test("mesh panel preserves panned zoomed camera and mesh modes can be exited",async({page})=>{
 await open(page,project());
 const canvas=page.locator(".scene-viewport canvas").first(),box=(await canvas.boundingBox())!;
 await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.wheel(0,150);
 await page.mouse.move(box.x+80,box.y+80);await page.mouse.down({button:"middle"});await page.mouse.move(box.x+105,box.y+100,{steps:4});await page.mouse.up({button:"middle"});
 const zoom=await page.locator(".zoom-control b").innerText();
 const whiteOrigin=()=>canvas.evaluate(el=>{
  const c=el as HTMLCanvasElement,ctx=c.getContext("2d")!,data=ctx.getImageData(0,0,c.width,c.height).data;
  let x=c.width,y=c.height;
  for(let row=0;row<c.height;row++)for(let col=0;col<c.width;col++){const i=(row*c.width+col)*4;if(data[i]===255&&data[i+1]===255&&data[i+2]===255){x=Math.min(x,col);y=Math.min(y,row);}}
  return {x,y};
 });
 const before=await whiteOrigin();
 await page.getByRole("button",{name:"Панель артмеша",exact:true}).click();
 await expect(page.getByRole("complementary",{name:"Редактор артмеша"})).toHaveCount(0);
 await expect.poll(whiteOrigin).toEqual(before);await expect(page.locator(".zoom-control b")).toHaveText(zoom);
 await page.getByRole("button",{name:"Панель артмеша",exact:true}).click();
 await expect(page.getByRole("complementary",{name:"Редактор артмеша"})).toBeVisible();
 await expect.poll(whiteOrigin).toEqual(before);await expect(page.locator(".zoom-control b")).toHaveText(zoom);
 await page.keyboard.press("Escape");await expect(page.getByRole("complementary",{name:"Редактор артмеша"})).toHaveCount(0);
 await page.keyboard.press("KeyR");await expect(page.getByRole("complementary",{name:"Редактор артмеша"})).toBeVisible();
 await page.keyboard.press("KeyR");await expect(page.getByRole("complementary",{name:"Редактор артмеша"})).toHaveCount(0);
 await page.keyboard.press("KeyT");await page.getByRole("button",{name:"Выйти из артмеша (Esc)",exact:true}).click();
 await expect(page.getByRole("complementary",{name:"Редактор артмеша"})).toHaveCount(0);
});
test("brush has mirrored static strokes, dynamic pickup and one-step undo",async({page})=>{
 const preset=project();preset.objects[0].artMesh=generateRegularArt(5,2,160,120);
 await open(page,preset);
 await page.keyboard.press("KeyM");await page.keyboard.press("KeyB");
 const brush=page.getByRole("button",{name:"Кисть артмеша",exact:true});await expect(brush).toHaveClass("active");await brush.hover();
 await page.getByLabel("Радиус кисти артмеша").fill("25");await page.getByLabel("Жёсткость кисти артмеша").fill("1");
 await page.getByRole("button",{name:"Симметрия артмеша",exact:true}).click();
 const canvas=page.locator(".scene-viewport canvas").first(),box=(await canvas.boundingBox())!;
 const z=Math.max(.05,Math.min((box.width-70)/400,(box.height-70)/300,2));
 const x=box.x+(box.width-400*z)/2+100*z,y=box.y+(box.height-300*z)/2+80*z;
 await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+10*z,y+5*z,{steps:4});await page.mouse.up();
 await expect.poll(async()=>(await stored(page)).objects[0].artPose.v0?.x??0).toBeGreaterThan(5);
 const first=(await stored(page)).objects[0].artPose;expect(first.v4.x).toBeCloseTo(-first.v0.x);expect(first.v4.y).toBeCloseTo(first.v0.y);
 expect(first.v2).toBeUndefined();await undo(page);await expect.poll(async()=>(await stored(page)).objects[0].artPose).toEqual({});
 await page.getByRole("button",{name:"Симметрия артмеша",exact:true}).click();
 await brush.hover();await page.getByLabel("Режим кисти артмеша").selectOption("dynamic");
 await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+85*z,y,{steps:20});await page.mouse.up();
 await expect.poll(async()=>(await stored(page)).objects[0].artPose.v2?.x??0).toBeGreaterThan(0);
 await undo(page);await expect.poll(async()=>(await stored(page)).objects[0].artPose).toEqual({});
});
test("brush recording in layer key is undone in one step and key context menu copies replaces mirrors",async({page})=>{
 test.setTimeout(60000);
 const preset=project(),object=preset.objects[0],layer=makeLayer(0,"test");layer.poses=[{at:0,pose:{}},{at:1,pose:{}}];
 object.script=writeStates(object.script,{layers:[layer]},object).script;
 await open(page,preset);await page.getByRole("button",{name:"Состояния",exact:true}).click();
 await expect(page.locator(".states-key")).toHaveCount(2);
 const brush=page.getByRole("button",{name:"Кисть артмеша",exact:true});await brush.click();await brush.hover();await page.getByLabel("Радиус кисти артмеша").fill("25");
 const canvas=page.locator(".scene-viewport canvas").first(),box=(await canvas.boundingBox())!;
 const z=Math.max(.05,Math.min((box.width-70)/400,(box.height-70)/300,2)),x=box.x+(box.width-400*z)/2+100*z,y=box.y+(box.height-300*z)/2+80*z;
 await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+15*z,y+10*z,{steps:5});await page.mouse.up();
 const points=async()=>readStates((await stored(page)).objects[0].script).layers[0].poses[0].points;
 await expect.poll(async()=>(await points())?.v0?.[0]??0).toBeGreaterThan(0);
 await expect.poll(async()=>(await stored(page)).objects[0].artPose).toEqual({});
 const recorded=await points();await undo(page);
 await expect.poll(points).toBeUndefined();
 await page.keyboard.press("Control+Shift+z");await expect.poll(points).toEqual(recorded);
 await page.locator(".states-key").first().click({button:"right",timeout:5000});await page.getByRole("button",{name:"Копировать ключ",exact:true}).click({timeout:5000});
 await page.locator(".states-key").last().click({button:"right",timeout:5000});await page.getByRole("button",{name:"Вставить ключ (заменить)",exact:true}).click();
 await expect.poll(async()=>readStates((await stored(page)).objects[0].script).layers[0].poses[1].points).toEqual(recorded);
 await page.locator(".states-key").last().click({button:"right",timeout:5000});await page.getByRole("button",{name:"Отразить ключ: вертикаль",exact:true}).click();
 await expect.poll(async()=>readStates((await stored(page)).objects[0].script).layers[0].poses[1].points?.v1?.[0]??0).toBeLessThan(0);
 const track=page.locator(".states-track"),trackBox=(await track.boundingBox())!;
 await track.click({button:"right",position:{x:trackBox.width*.5,y:8}});
 await page.getByRole("button",{name:"Вставить ключ сюда",exact:true}).click();
 await expect.poll(async()=>readStates((await stored(page)).objects[0].script).layers[0].poses.length).toBe(3);
 const inserted=readStates((await stored(page)).objects[0].script).layers[0].poses.find(p=>p.at===.5);expect(inserted?.points).toEqual(recorded);

});
test("source picker selects individual ancestors or unrelated surfaces",async({page})=>{
 const preset=project(),base=preset.objects[0];
 preset.objects=[{...base,id:"face",name:"Лицо",kind:"group"},{...base,id:"mask",name:"Маска",kind:"group",parentId:"face"},{...base,id:"eye",name:"Глаз",parentId:"mask",deformParent:true,deformSources:["face"]},{...base,id:"other",name:"Другой",kind:"group"}];
 await open(page,preset);await page.locator(".tree-row").filter({hasText:"Глаз"}).click();await page.getByRole("button",{name:"Параметры",exact:true}).click();
 const sources=page.getByRole("group",{name:"Источники деформации"});
 await expect(sources.getByRole("button",{name:"Лицо",exact:true})).toHaveAttribute("aria-pressed","true");
 await expect(sources.getByRole("button",{name:"Маска",exact:true})).toHaveAttribute("aria-pressed","false");
 await page.getByLabel("Показать все слои",{exact:true}).check();await sources.getByRole("button",{name:"Другой",exact:true}).click();
 await expect.poll(async()=>(await stored(page)).objects.find((o:any)=>o.id==="eye").deformSources).toEqual(["face","other"]);
 await undo(page);await expect.poll(async()=>(await stored(page)).objects.find((o:any)=>o.id==="eye").deformSources).toEqual(["face"]);
});
test("manual face choice and deletion persist through a rest drag and undo",async({page})=>{
 await open(page,project());await page.keyboard.press("KeyR");
 const canvas=page.locator(".scene-viewport canvas").first(),box=(await canvas.boundingBox())!;
 const z=Math.max(.05,Math.min((box.width-70)/400,(box.height-70)/300,2));
 const p=(x:number,y:number)=>({x:box.x+(box.width-400*z)/2+x*z,y:box.y+(box.height-300*z)/2+y*z});
 const center=p(180,140);await page.keyboard.down("Alt");await page.mouse.click(center.x,center.y);await page.keyboard.up("Alt");
 await expect.poll(async()=>(await stored(page)).objects[0].artMesh.triangles.length).toBe(0);
 await page.keyboard.down("Shift");for(const [x,y] of [[100,80],[260,80],[100,200]]){const q=p(x,y);await page.mouse.click(q.x,q.y);}await page.keyboard.up("Shift");
 await expect.poll(async()=>(await stored(page)).objects[0].artMesh.triangles.length).toBe(1);
 await expect.poll(async()=>(await stored(page)).objects[0].artMesh.manualFaces.length).toBe(1);
 await page.getByRole("button",{name:"Снять",exact:true}).click();const start=p(100,80);
 await page.mouse.move(start.x,start.y);await page.mouse.down();await page.mouse.move(start.x+5*z,start.y+5*z,{steps:4});await page.mouse.up();
 await expect.poll(async()=>(await stored(page)).objects[0].artMesh.vertices[0].rest.x).toBeGreaterThan(0);
 expect((await stored(page)).objects[0].artMesh.triangles).toHaveLength(1);
 await undo(page);await expect.poll(async()=>(await stored(page)).objects[0].artMesh.vertices[0].rest.x).toBe(0);
});
test("rest surface matches base vertices and tracing shows a root with an empty mesh and zero opacity",async({page})=>{
 const preset=project();preset.objects[0].artPose={v0:{x:60,y:50}};
 await open(page,preset);await page.keyboard.press("KeyR");
 const pixel=()=>page.locator(".scene-viewport canvas").first().evaluate(el=>{
  const c=el as HTMLCanvasElement,w=c.clientWidth,h=c.clientHeight,z=Math.max(.05,Math.min((w-70)/400,(h-70)/300,2));
  const x=(w-400*z)/2+110*z,y=(h-300*z)/2+85*z;
  return [...c.getContext("2d")!.getImageData(Math.floor(x*c.width/w),Math.floor(y*c.height/h),1,1).data].slice(0,3);
 });
 await expect.poll(async()=>(await pixel())[0]).toBeGreaterThan(240);
 const hidden=project();hidden.objects[0].base.opacity=0;hidden.objects[0].artMesh={schema:1,nextId:0,vertices:[],triangles:[]};
 await page.evaluate(value=>localStorage.setItem("yappytuberplus.preset.v2",JSON.stringify(value)),hidden);
 // open() init script restores its input on reload, so install the new source explicitly.
 await page.addInitScript(value=>localStorage.setItem("yappytuberplus.preset.v2",JSON.stringify(value)),hidden);
 await page.reload();await page.locator(".tree-row").first().click();await page.keyboard.press("KeyR");await page.getByTitle("Вписать сцену",{exact:true}).click();
 const check=page.getByLabel("Показывать исходник для обводки",{exact:true});await expect(check).toBeChecked();
 const shown=(await pixel())[0];await check.uncheck();await expect.poll(async()=>(await pixel())[0]).toBeLessThan(shown-20);
});
test("Ctrl vertex series builds ordered priority edges, survives drag and supports erase undo",async({page})=>{
 await open(page,project());await page.keyboard.press("KeyR");
 const canvas=page.locator(".scene-viewport canvas").first(),box=(await canvas.boundingBox())!;
 const z=Math.max(.05,Math.min((box.width-70)/400,(box.height-70)/300,2));
 const p=(x:number,y:number)=>({x:box.x+(box.width-400*z)/2+(100+x)*z,y:box.y+(box.height-300*z)/2+(80+y)*z});
 const click=async(x:number,y:number)=>{const q=p(x,y);await page.mouse.click(q.x,q.y);};
 await page.keyboard.down("Control");await click(160,0);await click(0,120);await click(0,0);await page.keyboard.up("Control");
 const mesh=async()=>(await stored(page)).objects[0].artMesh;
 await expect.poll(async()=>(await mesh()).manualEdges).toEqual([["v1","v2"],["v2","v0"]]);
 expect((await mesh()).manualFaces).toBeUndefined();expect((await mesh()).triangles.some((f:string[])=>f.includes("v1")&&f.includes("v2"))).toBe(true);
 await undo(page);await expect.poll(async()=>(await mesh()).manualEdges).toEqual([["v1","v2"]]);
 await page.keyboard.press("Control+Shift+z");await expect.poll(async()=>(await mesh()).manualEdges.length).toBe(2);
 // New modifier series must start a new path, not connect back to the old anchor.
 await page.keyboard.down("Control");await click(160,120);await click(160,0);await page.keyboard.up("Control");
 await expect.poll(async()=>(await mesh()).manualEdges.length).toBe(3);
 expect((await mesh()).manualEdges.some((e:string[])=>e.includes("v0")&&e.includes("v3"))).toBe(false);
 await page.getByRole("button",{name:"Снять",exact:true}).click();
 const start=p(160,0);await page.mouse.move(start.x,start.y);await page.mouse.down();await page.mouse.move(start.x-10*z,start.y+5*z,{steps:4});await page.mouse.up();
 await expect.poll(async()=>(await mesh()).vertices[1].rest.x).toBeLessThan(160);
 expect((await mesh()).triangles.some((f:string[])=>f.includes("v1")&&f.includes("v2"))).toBe(true);
 await page.keyboard.down("Alt");await click(75,62.5);await page.keyboard.up("Alt");
 await expect.poll(async()=>(await mesh()).manualEdges.some((e:string[])=>e.includes("v1")&&e.includes("v2"))).toBe(false);
 await undo(page);await expect.poll(async()=>(await mesh()).manualEdges.some((e:string[])=>e.includes("v1")&&e.includes("v2"))).toBe(true);
});
test("new point inside a deleted triangle reconnects immediately and one undo restores the cut",async({page})=>{
 const preset=project();preset.objects[0]=editArtTopology(preset.objects[0],{type:"removeFace",ids:["v0","v1","v3"]});
 await open(page,preset);await page.keyboard.press("KeyR");
 const canvas=page.locator(".scene-viewport canvas").first(),box=(await canvas.boundingBox())!;
 const z=Math.max(.05,Math.min((box.width-70)/400,(box.height-70)/300,2));
 await page.mouse.click(box.x+(box.width-400*z)/2+200*z,box.y+(box.height-300*z)/2+100*z);
 await expect.poll(async()=>(await stored(page)).objects[0].artMesh.vertices.length).toBe(5);
 const mesh=(await stored(page)).objects[0].artMesh;
 expect(mesh.triangles.some((f:string[])=>f.includes("v4"))).toBe(true);expect(mesh.excludedFaces).toEqual([]);
 await undo(page);await expect.poll(async()=>(await stored(page)).objects[0].artMesh).toEqual(preset.objects[0].artMesh);
});
test("auto-lines button uses marquee-selected points and then all points when deselected",async({page})=>{
 const preset=project();let object=editArtTopology(preset.objects[0],{type:"removeEdge",ids:["v0","v3"]});
 object=editArtTopology(object,{type:"create",point:{x:100,y:20}});preset.objects[0]=object;
 await open(page,preset);await page.keyboard.press("KeyR");await page.keyboard.press("KeyM");
 const canvas=page.locator(".scene-viewport canvas").first(),box=(await canvas.boundingBox())!;
 const z=Math.max(.05,Math.min((box.width-70)/400,(box.height-70)/300,2));
 const p=(x:number,y:number)=>({x:box.x+(box.width-400*z)/2+(100+x)*z,y:box.y+(box.height-300*z)/2+(80+y)*z});
 const a=p(95,15),b=p(105,25);await page.mouse.move(a.x,a.y);await page.mouse.down();await page.mouse.move(b.x,b.y,{steps:4});await page.mouse.up();
 const button=page.getByRole("button",{name:"Создать автолинии",exact:true});await button.click();
 await expect.poll(async()=>(await stored(page)).objects[0].artMesh.excludedFaces.length).toBe(1);
 let mesh=(await stored(page)).objects[0].artMesh;expect(mesh.triangles.some((f:string[])=>f.includes("v4"))).toBe(true);
 await page.getByRole("button",{name:"Снять",exact:true}).click();await button.click();
 await expect.poll(async()=>(await stored(page)).objects[0].artMesh.excludedFaces.length).toBe(0);
 mesh=(await stored(page)).objects[0].artMesh;expect(new Set(mesh.triangles.flat()).size).toBe(5);
 await undo(page);await expect.poll(async()=>(await stored(page)).objects[0].artMesh.excludedFaces.length).toBe(1);
});

test("independent brush stays outside mesh editor and preserves rest mode",async({page})=>{
 const preset=project();await open(page,preset);
 await page.getByTitle("Деформация артмеша (T)",{exact:true}).click();
 const brush=page.getByRole("button",{name:"Кисть артмеша",exact:true});await expect(brush).toBeVisible();
 await page.keyboard.press("KeyB");await expect(brush).toHaveClass("active");
 await expect(page.getByTitle("Деформация артмеша (T)",{exact:true})).not.toHaveClass("active");
 await page.getByTitle("Вписать сцену",{exact:true}).click();
 const canvas=page.locator(".scene-viewport canvas").first(),box=(await canvas.boundingBox())!;
 const z=Math.max(.05,Math.min((box.width-70)/400,(box.height-70)/300,2));
 const x=box.x+(box.width-400*z)/2+100*z,y=box.y+(box.height-300*z)/2+80*z;
 await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+12*z,y+6*z,{steps:4});await page.mouse.up();
 await expect.poll(async()=>(await stored(page)).objects[0].artPose.v0?.x??0).toBeGreaterThan(0);
 expect((await stored(page)).objects[0].artMesh).toEqual(preset.objects[0].artMesh);
 await undo(page);await expect.poll(async()=>(await stored(page)).objects[0].artPose).toEqual({});
 await page.keyboard.press("KeyR");await page.keyboard.press("KeyB");
 await page.getByRole("button",{name:"Панель артмеша",exact:true}).click();
 await expect(page.getByTitle("Правка базы и топологии артмеша (R)",{exact:true})).toHaveClass("active");
 await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+12*z,y+6*z,{steps:4});await page.mouse.up();
 await expect.poll(async()=>(await stored(page)).objects[0].artMesh.vertices[0].rest.x).toBeGreaterThan(0);
 expect((await stored(page)).objects[0].artPose).toEqual({});
 await undo(page);await expect.poll(async()=>(await stored(page)).objects[0].artMesh).toEqual(preset.objects[0].artMesh);
});

test("independent brush edits shape path without generating a mesh and undoes one stroke",async({page})=>{
 const preset=project(false);preset.objects[0].shape!.items=[{id:"path",kind:"path",points:[{x:0,y:0},{x:160,y:0},{x:160,y:120},{x:0,y:120}],closed:true}];
 await open(page,preset);await page.getByTitle("Деформация артмеша (T)",{exact:true}).click();await page.keyboard.press("KeyB");
 await page.getByTitle("Вписать сцену",{exact:true}).click();
 const before=(await stored(page)).objects[0].shape;
 const canvas=page.locator(".scene-viewport canvas").first(),box=(await canvas.boundingBox())!;
 const z=Math.max(.05,Math.min((box.width-70)/400,(box.height-70)/300,2));
 const x=box.x+(box.width-400*z)/2+100*z,y=box.y+(box.height-300*z)/2+80*z;
 await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+12*z,y+6*z,{steps:4});await page.mouse.up();
 await expect.poll(async()=>(await stored(page)).objects[0].shape.items[0].points[0].x).toBeGreaterThan(0);
 expect((await stored(page)).objects[0].artMesh).toBeUndefined();
 await undo(page);await expect.poll(async()=>(await stored(page)).objects[0].shape).toEqual(before);
});

test("deleting the last state layer clears its preview without closing the panel",async({page})=>{
 const preset=project(),object=preset.objects[0],layer=makeLayer(0,"test");
 layer.poses=[{at:0,pose:{x:45},points:{v0:[30,20]}}];
 object.script=writeStates(object.script,{layers:[layer]},object).script;
 preset.objects.push({...structuredClone(object),id:"child",name:"Дочерняя поверхность",parentId:object.id,deformParent:true,deformSources:[object.id],script:rootScript(),base:{...object.base,x:120,y:100},width:80,height:60,artMesh:generateRegularArt(2,2,80,60)});
 await open(page,preset);
 const canvas=page.locator(".scene-viewport canvas").first();
 await page.mouse.move(0,0);
 const box=(await canvas.boundingBox())!;
 const shot=()=>page.screenshot({clip:{...box,height:Math.min(box.height,500)}});
 const before=await shot();
 await page.getByRole("button",{name:"Состояния",exact:true}).click();
 await expect(page.locator(".states-key")).toHaveCount(1);
 await expect.poll(async()=>(await shot()).equals(before)).toBe(false);
 await page.getByTitle("Удалить слой",{exact:true}).click();
 await expect(page.locator(".states-key")).toHaveCount(0);
 await expect.poll(async()=>(await shot()).equals(before)).toBe(true);
});

test("Delete in object tree removes objects even with mesh tool active",async({page})=>{
 await open(page,project());await page.locator(".tree-row").first().click();await page.keyboard.press("Delete");
 await expect(page.locator(".tree-row")).toHaveCount(0);
 await undo(page);await expect(page.locator(".tree-row")).toHaveCount(1);
});
test("transform scales base and edits Ctrl zone separately with one undo",async({page})=>{
 const preset=project();await open(page,preset);await page.keyboard.press("KeyG");
 await page.getByTitle("Вписать сцену",{exact:true}).click();
 const canvas=page.locator(".scene-viewport canvas").first(),box=(await canvas.boundingBox())!,z=Math.max(.05,Math.min((box.width-70)/400,(box.height-70)/300,2));
 const x=box.x+(box.width-400*z)/2+260*z,y=box.y+(box.height-300*z)/2+200*z;
 await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+25*z,y+15*z,{steps:4});await page.mouse.up();
 await expect.poll(async()=>(await stored(page)).objects[0].base.sizeX).toBeGreaterThan(1);
 expect((await stored(page)).objects[0].artMesh).toEqual(preset.objects[0].artMesh);
 await undo(page);await expect.poll(async()=>(await stored(page)).objects[0].base).toEqual(preset.objects[0].base);
 await page.keyboard.down("Control");await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+25*z,y+15*z,{steps:4});await page.mouse.up();await page.keyboard.up("Control");
 await expect.poll(async()=>(await stored(page)).objects[0].transformFrame?.a??160).toBeGreaterThan(160);
 expect((await stored(page)).objects[0].base).toEqual(preset.objects[0].base);
 await undo(page);await expect.poll(async()=>(await stored(page)).objects[0].transformFrame).toBeUndefined();
});

test("base transform records scale in selected state key without changing mesh",async({page})=>{
 const preset=project(),object=preset.objects[0],layer=makeLayer(0,"test");layer.poses=[{at:0,pose:{}}];object.script=writeStates(object.script,{layers:[layer]},object).script;
 await open(page,preset);await page.getByRole("button",{name:"Состояния",exact:true}).click();await expect(page.locator(".states-key")).toHaveCount(1);
 await page.keyboard.press("KeyG");await page.getByTitle("Вписать сцену",{exact:true}).click();
 const canvas=page.locator(".scene-viewport canvas").first(),box=(await canvas.boundingBox())!,z=Math.max(.05,Math.min((box.width-70)/400,(box.height-70)/300,2));
 const x=box.x+(box.width-400*z)/2+260*z,y=box.y+(box.height-300*z)/2+200*z;
 await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+25*z,y+15*z,{steps:5});await page.mouse.up();
 await expect.poll(async()=>readStates((await stored(page)).objects[0].script).layers[0].poses[0].pose.sizeX??1).toBeGreaterThan(1);
 await expect.poll(async()=>(await stored(page)).objects[0].base).toEqual(object.base);
 expect((await stored(page)).objects[0].artMesh).toEqual(object.artMesh);
 await undo(page);await expect.poll(async()=>readStates((await stored(page)).objects[0].script).layers[0].poses[0].pose.sizeX??1).toBe(1);
});
