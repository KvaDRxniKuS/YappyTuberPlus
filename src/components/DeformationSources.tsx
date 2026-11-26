import {useState} from "react";
import type {RigObject} from "../types";
export function DeformationSources({object,objects,onChange}:{object:RigObject;objects:RigObject[];onChange:(object:RigObject)=>void}){
 const [all,setAll]=useState(false);
 const ancestors:string[]=[],seen=new Set<string>([object.id]);let id=object.parentId;
 while(id&&!seen.has(id)){seen.add(id);ancestors.push(id);id=objects.find(o=>o.id===id)?.parentId??null;}
 const selected=object.deformSources??(object.deformParent?ancestors:[]);
 const depth=(o:RigObject)=>{let n=0,p=o.parentId;const seen=new Set([o.id]);while(p&&!seen.has(p)){seen.add(p);n++;p=objects.find(v=>v.id===p)?.parentId??null;}return Math.min(n,12);};
 const ordered:RigObject[]=[],visited=new Set<string>();
 const visit=(parent:string|null)=>{for(const item of objects)if(item.parentId===parent&&!visited.has(item.id)){visited.add(item.id);ordered.push(item);visit(item.id);}};
 visit(null);for(const item of objects)if(!visited.has(item.id)){visited.add(item.id);ordered.push(item);visit(item.id);}
 const candidates=ordered.filter(o=>o.id!==object.id&&(all||ancestors.includes(o.id)||selected.includes(o.id)));
 return <div className="deformation-sources"><label className="check-line"><input type="checkbox" checked={object.deformParent===true} onChange={e=>onChange({...object,deformParent:e.target.checked})}/>Наследовать деформацию</label>
 <label className="check-line"><input type="checkbox" checked={all} onChange={e=>setAll(e.target.checked)}/>Показать все слои</label>
 <div role="group" aria-label="Источники деформации">{candidates.map(o=><button key={o.id} disabled={!o.artMesh} title={o.artMesh?"Источник деформации":"Нет артмеша"} className={object.deformParent&&selected.includes(o.id)?"selected":""} style={{paddingLeft:8+depth(o)*10}} aria-pressed={object.deformParent&&selected.includes(o.id)} onClick={()=>{
  const next=selected.includes(o.id)?selected.filter(id=>id!==o.id):[...selected,o.id];onChange({...object,deformParent:true,deformSources:next});
 }}>{o.name||o.id}</button>)}</div>
 {!candidates.length&&<p className="behaviour-hint">В дереве родителей нет артмешей. Включите «Показать все слои».</p>}
 </div>;
}
