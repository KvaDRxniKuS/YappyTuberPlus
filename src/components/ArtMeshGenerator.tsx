import {generateAlphaArt,type AlphaRaster} from "../engine/artMeshAlpha";
import type {RigObject} from "../types";
import {artDescendants,artGenerationSupported,type ArtMeshReplacement} from "../engine/artMeshBatch";
import {useEffect,useMemo,useRef,useState} from "react";
import {createPortal} from "react-dom";
import {generateRegularArt,type ArtDeformation} from "../engine/artDeformation";

/** Draft-only preview. Project is updated once, on explicit Apply. */
export function ArtMeshGenerator({width:sourceWidth,height:sourceHeight,nextId,onApply,onClose,batch,object,captureAlpha}:{width:number;height:number;nextId:number;onApply:(mesh:ArtDeformation,dimensions?:{width:number;height:number})=>void;onClose:()=>void;object?:RigObject;captureAlpha?:(object:RigObject)=>AlphaRaster;batch?:{root:string;objects:RigObject[];onApply:(meshes:ArtMeshReplacement[],inherit:boolean)=>void}}){
 const explicitGroup=!batch&&object?.kind==="group";
 const [groupWidth,setGroupWidth]=useState(sourceWidth>0?sourceWidth:400),[groupHeight,setGroupHeight]=useState(sourceHeight>0?sourceHeight:400);
 const width=explicitGroup?groupWidth:sourceWidth,height=explicitGroup?groupHeight:sourceHeight;
 const [cols,setCols]=useState(4),[rows,setRows]=useState(4),[inset,setInset]=useState(0);
 const [scope,setScope]=useState<"direct"|"all">("all"),[onlyMissing,setOnlyMissing]=useState(true),[inherit,setInherit]=useState(false),[previewId,setPreviewId]=useState("");
 const descendants=useMemo(()=>batch?artDescendants(batch.objects,batch.root,scope):[],[batch?.objects,batch?.root,scope]);
 const targets=descendants.filter(o=>artGenerationSupported(o)&&(!onlyMissing||!o.artMesh));
 const [mode,setMode]=useState<"regular"|"alpha">("regular");
 const [threshold,setThreshold]=useState(128),[padding,setPadding]=useState(0),[contourSpacing,setContourSpacing]=useState(20),[interiorSpacing,setInteriorSpacing]=useState(30),[simplification,setSimplification]=useState(1),[refresh,setRefresh]=useState(0);
 const sourceTargets=batch?targets:object?[object]:[];
 const sourceKey=JSON.stringify([refresh,sourceTargets.map(o=>[o.id,o.width,o.height,o.kind,o.image,o.media?.src,o.shape])]);
 const captureRef=useRef(captureAlpha);captureRef.current=captureAlpha;
 const sourcesRef=useRef(sourceTargets);sourcesRef.current=sourceTargets;
 const [snapshot,setSnapshot]=useState<{key:string;rasters:Map<string,AlphaRaster>;error:string}>({key:"",rasters:new Map(),error:""});
 useEffect(()=>{
  if(mode!=="alpha")return;
  let cancelled=false;
  setSnapshot({key:"",rasters:new Map(),error:""});
  const timer=window.setTimeout(()=>{
   const rasters=new Map<string,AlphaRaster>();
   try{
    if(!captureRef.current)throw new Error("Alpha-источник недоступен.");
    let pixels=0;
    for(const o of sourcesRef.current){
     try{const raster=captureRef.current(o);pixels+=raster.width*raster.height;if(pixels>2097152)throw new Error("Слишком большая пачка alpha-масок. Подготовьте меньшую область.");rasters.set(o.id,raster);}
     catch(error){throw new Error(`${o.name||o.id}: ${error instanceof Error?error.message:"Ошибка alpha-источника"}`);}
    }
    if(!cancelled)setSnapshot({key:sourceKey,rasters,error:""});
   }catch(error){if(!cancelled)setSnapshot({key:sourceKey,rasters:new Map(),error:error instanceof Error?error.message:"Ошибка alpha-маски."});}
  },0);
  return ()=>{cancelled=true;window.clearTimeout(timer);};
 },[mode,sourceKey,refresh]);
 const result=useMemo(()=>{try{
  if(mode==="alpha"&&(snapshot.key!==sourceKey||snapshot.error))return {mesh:null,meshes:[],error:snapshot.error||"Чтение alpha-масок…"};
  const generate=(o?:RigObject)=>{
   if(mode==="regular")return generateRegularArt(cols,rows,!batch?width:o?.width??width,!batch?height:o?.height??height,inset,o?(o.artMesh?.nextId??0):nextId);
   const raster=o?snapshot.rasters.get(o.id):undefined;if(!raster)throw new Error("Нет alpha-маски объекта.");
   return generateAlphaArt(raster,{threshold,padding,contourSpacing,interiorSpacing,simplification,nextId:o?(o.artMesh?.nextId??0):nextId});
  };
  if(batch){
   const meshes=targets.map(o=>{try{return {id:o.id,mesh:generate(o)};}catch(error){throw new Error(`${o.name||o.id}: ${error instanceof Error?error.message:"Ошибка генерации"}`);}});
   return {mesh:meshes.find(m=>m.id===previewId)?.mesh??meshes[0]?.mesh??null,meshes,error:meshes.length?"":"Нет подходящих потомков в выбранной области."};
  }
  return {mesh:generate(object),meshes:[],error:""};
 }catch(error){return {mesh:null,meshes:[],error:mode==="alpha"?(error instanceof Error?error.message:"Ошибка alpha-генерации."):"Проверьте размеры: 2–32 узла; отступ меньше половины меньшей стороны каждого объекта."};}},[cols,rows,width,height,inset,nextId,batch?.objects,batch?.root,scope,onlyMissing,previewId,mode,snapshot,sourceKey,threshold,padding,contourSpacing,interiorSpacing,simplification,object]);
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
    {explicitGroup&&<>
      <p>Явная нетекстурированная поверхность группы. Размеры сохранятся только при применении. Позиция, пивот и параметры потомков не меняются; сетка не подгоняется под них автоматически.</p>
      <div className="property-grid two-columns">
        <label>Ширина поверхности группы<input aria-label="Ширина поверхности группы" type="number" min={1} value={groupWidth} onChange={e=>setGroupWidth(Number(e.target.value))}/></label>
        <label>Высота поверхности группы<input aria-label="Высота поверхности группы" type="number" min={1} value={groupHeight} onChange={e=>setGroupHeight(Number(e.target.value))}/></label>
      </div>
    </>}
    <label>Способ <select aria-label="Способ генерации" value={mode} onChange={e=>setMode(e.target.value as "regular"|"alpha")}><option value="regular">Регулярная N×M</option><option value="alpha" disabled={explicitGroup}>По alpha-форме</option></select></label>
    {mode==="alpha"&&<>
     <p>Форма исходного содержимого без деформации, масок и кадровой прозрачности. Видео — снимок текущего кадра; группы не имеют собственного alpha-источника. Растр до 256×256, отступ приближённый.</p>
     <div className="property-grid two-columns">
      <label>Порог alpha (0–255)<input type="number" min={0} max={255} value={threshold} onChange={e=>setThreshold(Number(e.target.value))}/></label>
      <label>Внешний отступ, px<input type="number" min={0} value={padding} onChange={e=>setPadding(Number(e.target.value))}/></label>
      <label>Шаг контура, px<input type="number" min={.1} value={contourSpacing} onChange={e=>setContourSpacing(Number(e.target.value))}/></label>
      <label>Внутренний шаг, px<input type="number" min={.1} value={interiorSpacing} onChange={e=>setInteriorSpacing(Number(e.target.value))}/></label>
      <label>Упрощение, px<input type="number" min={0} value={simplification} onChange={e=>setSimplification(Number(e.target.value))}/></label>
     </div>
     <button onClick={()=>setRefresh(v=>v+1)}>Обновить alpha-снимок</button>
    </>}
    {mode==="regular"&&<>
    <p>Регулярная сетка. Создаются вершины и треугольники самого артмеша, не отдельный деформер.</p>
    <div className="property-grid two-columns">
     <label>Столбцов <input type="number" min={2} max={32} step={1} value={cols} onChange={e=>setCols(Number(e.target.value))}/></label>
     <label>Строк <input type="number" min={2} max={32} step={1} value={rows} onChange={e=>setRows(Number(e.target.value))}/></label>
     <label>Отступ, px <input type="number" min={0} value={inset} onChange={e=>setInset(Number(e.target.value))}/></label>
    </div>
    </>}
    {mesh&&<><svg role="img" aria-label="Предпросмотр сетки" viewBox={mode==="alpha"?`${-padding} ${-padding} ${previewWidth+2*padding} ${previewHeight+2*padding}`:`0 0 ${previewWidth} ${previewHeight}`} style={{width:"100%",height:260,background:"#171b20"}}>
     {mesh.triangles.map((face,i)=><polygon key={i} points={face.map(id=>{const v=vertices.get(id)!;return `${v.rest.x},${v.rest.y}`;}).join(" ")} fill="none" stroke="#82d5c1" vectorEffect="non-scaling-stroke"/>)}
    </svg><p>{mesh.vertices.length} вершин · {mesh.triangles.length} треугольников</p></>}
    {batch&&<p>Всего: {result.meshes.reduce((n,m)=>n+m.mesh.vertices.length,0)} вершин · {result.meshes.reduce((n,m)=>n+m.mesh.triangles.length,0)} треугольников</p>}
    {result.error&&<p role="alert">{result.error}</p>}
    <p>Заменит существующий меш и очистит смещения его вершин во всех состояниях. Остальные параметры состояний сохранятся. Вся операция отменяется Ctrl+Z.</p>
    <button className="button" disabled={!mesh} onClick={()=>{if(mesh){if(batch)batch.onApply(result.meshes,inherit);else if(explicitGroup)onApply(mesh,{width,height});else onApply(mesh);}}}>Заменить сетку</button>
   </div>
  </section>
 </div>,document.body);
}
