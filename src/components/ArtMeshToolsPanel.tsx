import {useState,type ReactNode} from "react";
import {X,MousePointer2,Layers3} from "lucide-react";
export function ArtMeshToolsPanel({name,onClose,tools,mesh}:{name:string;onClose:()=>void;tools:ReactNode;mesh:ReactNode}){
 const [tab,setTab]=useState<"tools"|"mesh">("tools");
 return <aside className="artmesh-panel" aria-label="Редактор артмеша">
  <header><div><span className="eyebrow">ГЕОМЕТРИЯ</span><h3>Артмеш</h3></div><button aria-label="Закрыть панель артмеша" onClick={onClose}><X size={16}/></button></header>
  <p className="artmesh-object" title={name}>{name}</p>
  <div className="artmesh-tabs" role="tablist" aria-label="Разделы артмеша">
   <button role="tab" aria-selected={tab==="tools"} onClick={()=>setTab("tools")}><MousePointer2 size={14}/>Инструменты</button>
   <button role="tab" aria-selected={tab==="mesh"} onClick={()=>setTab("mesh")}><Layers3 size={14}/>Сетка</button>
  </div>
  <div className="artmesh-panel-body" role="tabpanel">{tab==="tools"?tools:mesh}</div>
  <footer>Shift + клик — выбор вершин<br/>Ctrl + Z — отменить действие</footer>
 </aside>;
}
