import {useMemo,useState} from "react";
import {createPortal} from "react-dom";
import {generateRegularArt,type ArtDeformation} from "../engine/artDeformation";

/** Draft-only preview. Project is updated once, on explicit Apply. */
export function ArtMeshGenerator({width,height,nextId,onApply,onClose}:{width:number;height:number;nextId:number;onApply:(mesh:ArtDeformation)=>void;onClose:()=>void}){
 const [cols,setCols]=useState(4),[rows,setRows]=useState(4),[inset,setInset]=useState(0);
 const result=useMemo(()=>{try{return {mesh:generateRegularArt(cols,rows,width,height,inset,nextId),error:""};}catch{return {mesh:null,error:"Проверьте размеры: 2–32 узла; отступ меньше половины меньшей стороны объекта."};}},[cols,rows,width,height,inset,nextId]);
 const mesh=result.mesh;
 return createPortal(<div className="dialog-backdrop" onKeyDown={e=>{e.stopPropagation();if(e.key==="Escape")onClose();}}>
  <section className="module-dialog" role="dialog" aria-modal="true" aria-label="Генерация артмеша">
   <header className="dialog-head"><h3>Сгенерировать артмеш</h3><button onClick={onClose} autoFocus>Отмена</button></header>
   <div className="dialog-body">
    <p>Регулярная сетка. Создаются вершины и треугольники самого артмеша, не отдельный деформер.</p>
    <div className="property-grid two-columns">
     <label>Столбцов <input type="number" min={2} max={32} step={1} value={cols} onChange={e=>setCols(Number(e.target.value))}/></label>
     <label>Строк <input type="number" min={2} max={32} step={1} value={rows} onChange={e=>setRows(Number(e.target.value))}/></label>
     <label>Отступ, px <input type="number" min={0} value={inset} onChange={e=>setInset(Number(e.target.value))}/></label>
    </div>
    {mesh&&<><svg role="img" aria-label="Предпросмотр сетки" viewBox={`0 0 ${width} ${height}`} style={{width:"100%",height:260,background:"#171b20"}}>
     {mesh.triangles.map((face,i)=><polygon key={i} points={face.map(id=>{const v=mesh.vertices.find(v=>v.id===id)!;return `${v.rest.x},${v.rest.y}`;}).join(" ")} fill="none" stroke="#82d5c1" vectorEffect="non-scaling-stroke"/>)}
    </svg><p>{mesh.vertices.length} вершин · {mesh.triangles.length} треугольников</p></>}
    {result.error&&<p role="alert">{result.error}</p>}
    <p>Заменит существующий меш и очистит смещения его вершин во всех состояниях. Остальные параметры состояний сохранятся. Вся операция отменяется Ctrl+Z.</p>
    <button className="button" disabled={!mesh} onClick={()=>{if(mesh)onApply(mesh);}}>Заменить сетку</button>
   </div>
  </section>
 </div>,document.body);
}
