import {useMemo,useState} from "react";
import {createPortal} from "react-dom";
import type {RigObject} from "../types";
import {pasteArtMesh,type ArtMeshClip,type ArtMeshPasteScale} from "../engine/artMeshClipboard";
export function ArtMeshPasteDialog({object,clip,onApply,onClose}:{object:RigObject;clip:ArtMeshClip;onApply:(scale:ArtMeshPasteScale,pose:boolean)=>void;onClose:()=>void}){
 const [scale,setScale]=useState<ArtMeshPasteScale>("fit"),[pose,setPose]=useState(false);
 const error=useMemo(()=>{try{pasteArtMesh(object,clip,scale,pose);return "";}catch(e){return e instanceof Error?e.message:"Ошибка вставки артмеша.";}},[object,clip,scale,pose]);
 return createPortal(<div className="dialog-backdrop" onKeyDown={e=>{e.stopPropagation();if(e.key==="Escape")onClose();}}><section className="module-dialog" role="dialog" aria-modal="true" aria-label="Вставить артмеш">
  <header className="dialog-head"><h3>Вставить артмеш</h3><button autoFocus onClick={onClose}>Отмена</button></header>
  <div className="dialog-body">
   <p>{clip.mesh.vertices.length} вершин · {clip.mesh.triangles.length} треугольников. Источник {clip.width}×{clip.height}, цель {object.width}×{object.height}.</p>
   <label>Размер <select value={scale} onChange={e=>setScale(e.target.value as ArtMeshPasteScale)}><option value="fit">Масштабировать под размеры объекта</option><option value="local">Сохранить локальные размеры источника</option></select></label>
   <label className="check-line"><input type="checkbox" checked={pose} onChange={e=>setPose(e.target.checked)}/>Перенести авторскую деформацию источника</label>
   <p>Существующий меш будет заменён. Смещения вершин во всех состояниях цели очистятся; остальные параметры состояний сохранятся. UV переносятся из источника. Наследование деформации не меняется. Операция отменяется одним Ctrl+Z.</p>
   {error&&<p role="alert">{error}</p>}
   <button disabled={!!error} onClick={()=>onApply(scale,pose)}>Заменить артмеш</button>
  </div>
 </section></div>,document.body);
}
