import type {RigObject} from "../types";
import {artDescendants,artGenerationSupported,type ArtMeshReplacement} from "../engine/artMeshBatch";
import {useMemo,useState} from "react";
import {createPortal} from "react-dom";
import {generateRegularArt,type ArtDeformation} from "../engine/artDeformation";

/** Draft-only preview. Project is updated once, on explicit Apply. */
export function ArtMeshGenerator({width,height,nextId,onApply,onClose,batch}:{width:number;height:number;nextId:number;onApply:(mesh:ArtDeformation)=>void;onClose:()=>void;batch?:{root:string;objects:RigObject[];onApply:(meshes:ArtMeshReplacement[],inherit:boolean)=>void}}){
 const [cols,setCols]=useState(4),[rows,setRows]=useState(4),[inset,setInset]=useState(0);
 const [scope,setScope]=useState<"direct"|"all">("all"),[onlyMissing,setOnlyMissing]=useState(true),[inherit,setInherit]=useState(false),[previewId,setPreviewId]=useState("");
 const descendants=useMemo(()=>batch?artDescendants(batch.objects,batch.root,scope):[],[batch?.objects,batch?.root,scope]);
 const targets=descendants.filter(o=>artGenerationSupported(o)&&(!onlyMissing||!o.artMesh));
 const result=useMemo(()=>{try{
  if(batch){
   const meshes=targets.map(o=>({id:o.id,mesh:generateRegularArt(cols,rows,o.width,o.height,inset,o.artMesh?.nextId??0)}));
   return {mesh:meshes.find(m=>m.id===previewId)?.mesh??meshes[0]?.mesh??null,meshes,error:meshes.length?"":"Нет подходящих потомков в выбранной области."};
  }
  return {mesh:generateRegularArt(cols,rows,width,height,inset,nextId),meshes:[],error:""};
 }catch{return {mesh:null,meshes:[],error:"Проверьте размеры: 2–32 узла; отступ меньше половины меньшей стороны каждого объекта."};}},[cols,rows,width,height,inset,nextId,batch?.objects,batch?.root,scope,onlyMissing,previewId]);
 const mesh=result.mesh;
 const previewTarget=targets.find(o=>o.id===previewId)??targets[0];
 const previewWidth=batch?previewTarget?.width??width:width,previewHeight=batch?previewTarget?.height??height:height;
 const vertices=new Map(mesh?.vertices.map(v=>[v.id,v]));

 return createPortal(<div className="dialog-backdrop" onKeyDown={e=>{e.stopPropagation();if(e.key==="Escape")onClose();}}>
  <section className="module-dialog" role="dialog" aria-modal="true" aria-label="Генерация артмеша">
   <header className="dialog-head"><h3>{batch?"Подготовить потомков к деформации":"Сгенерировать артмеш"}</h3><button onClick={onClose} autoFocus>Отмена</button></header>
   <div className="dialog-body">
    {batch&&<>
     <label>Область <select aria-label="Область подготовки" value={scope} onChange={e=>setScope(e.target.value as "direct"|"all")}><option value="direct">Прямые потомки</option><option value="all">Все вложенные потомки</option></select></label>
     <label className="check-line"><input type="checkbox" checked={onlyMissing} onChange={e=>setOnlyMissing(e.target.checked)}/>Только без нового артмеша</label>
     <label className="check-line"><input type="checkbox" checked={inherit} onChange={e=>setInherit(e.target.checked)}/>Включить наследование деформации у обрабатываемых объектов</label>
     <p>Будет обработано: {targets.length}. Существующие сетки будут заменены у {targets.filter(o=>o.artMesh||o.mesh||o.warp).length} объектов. Неподдерживаемые типы и нулевые размеры: {descendants.filter(o=>!artGenerationSupported(o)).length}. Настройки наследования без галочки не меняются.</p>
     <label>Предпросмотр объекта <select aria-label="Объект предпросмотра" value={previewTarget?.id??""} onChange={e=>setPreviewId(e.target.value)}>{targets.map(o=><option key={o.id} value={o.id}>{o.name||o.id}</option>)}</select></label>
    </>}
    <p>Регулярная сетка. Создаются вершины и треугольники самого артмеша, не отдельный деформер.</p>
    <div className="property-grid two-columns">
     <label>Столбцов <input type="number" min={2} max={32} step={1} value={cols} onChange={e=>setCols(Number(e.target.value))}/></label>
     <label>Строк <input type="number" min={2} max={32} step={1} value={rows} onChange={e=>setRows(Number(e.target.value))}/></label>
     <label>Отступ, px <input type="number" min={0} value={inset} onChange={e=>setInset(Number(e.target.value))}/></label>
    </div>
    {mesh&&<><svg role="img" aria-label="Предпросмотр сетки" viewBox={`0 0 ${previewWidth} ${previewHeight}`} style={{width:"100%",height:260,background:"#171b20"}}>
     {mesh.triangles.map((face,i)=><polygon key={i} points={face.map(id=>{const v=vertices.get(id)!;return `${v.rest.x},${v.rest.y}`;}).join(" ")} fill="none" stroke="#82d5c1" vectorEffect="non-scaling-stroke"/>)}
    </svg><p>{mesh.vertices.length} вершин · {mesh.triangles.length} треугольников</p></>}
    {batch&&<p>Всего: {result.meshes.reduce((n,m)=>n+m.mesh.vertices.length,0)} вершин · {result.meshes.reduce((n,m)=>n+m.mesh.triangles.length,0)} треугольников</p>}
    {result.error&&<p role="alert">{result.error}</p>}
    <p>Заменит существующий меш и очистит смещения его вершин во всех состояниях. Остальные параметры состояний сохранятся. Вся операция отменяется Ctrl+Z.</p>
    <button className="button" disabled={!mesh} onClick={()=>{if(mesh){if(batch)batch.onApply(result.meshes,inherit);else onApply(mesh);}}}>Заменить сетку</button>
   </div>
  </section>
 </div>,document.body);
}
