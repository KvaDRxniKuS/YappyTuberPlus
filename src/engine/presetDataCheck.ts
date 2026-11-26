import {readArtMesh,readArtOffsets} from "./artMeshRuntime";

export interface PresetDataIssue {label:string;detail:string}
/** Shared blocking checks: the loader and its explanation must agree. */
export function presetObjectDataIssues(objects:readonly unknown[]):PresetDataIssue[]{
 const issues:PresetDataIssue[]=[];
 objects.forEach((raw,index)=>{
  if(!raw||typeof raw!=="object"||Array.isArray(raw)){
   issues.push({label:`Некорректный объект №${index+1}`,detail:"Вместо описания объекта записано другое значение. Исправьте данные объекта в файле."});return;
  }
  const object=raw as Record<string,unknown>;
  const name=typeof object.name==="string"&&object.name?object.name:typeof object.id==="string"?object.id:`№${index+1}`;
  const enabled=(value:unknown)=>!!value&&typeof value==="object"&&(value as {enabled?:unknown}).enabled===true;
  if(!object.artMesh&&(enabled(object.mesh)||enabled(object.warp))){
   issues.push({label:`Старый деформер: «${name}»`,detail:"У объекта включена старая mesh/warp-сетка без единого артмеша. Эта система удалена, автоматического переноса нет. Файл не открыт, чтобы не потерять форму молча. Сохраните исходник отдельно; для переноса потребуется заново создать артмеш и его позы. Обновление редактора само по себе старую сетку не восстановит."});
  }
  if(object.artMesh){
   try{const mesh=readArtMesh(object.artMesh);if(object.artPose)readArtOffsets(object.artPose,mesh);}
   catch(error){issues.push({label:`Некорректный артмеш: «${name}»`,detail:`Нарушена структура вершин, UV, треугольников или позы (${error instanceof Error?error.message:"ошибка данных"}). Файл не открыт, чтобы не потерять геометрию. Нужна исправленная копия файла или резервная копия.`});}
  }
 });
 return issues;
}
