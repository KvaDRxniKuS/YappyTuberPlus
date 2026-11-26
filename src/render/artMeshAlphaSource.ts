import type {RigObject} from "../types";
import type {AlphaRaster} from "../engine/artMeshAlpha";
import {drawShapeObject} from "./rigCanvas";
/** Undeformed authored content only: no runtime opacity, masks or parent mesh.
 * Media source is a caller-provided current frame, never a hidden new player. */
export function captureArtAlpha(object:RigObject,source?:CanvasImageSource|null):AlphaRaster {
 if(!Number.isFinite(object.width)||!Number.isFinite(object.height)||object.width<=0||object.height<=0)throw new Error("Для alpha-маски нужны положительные размеры объекта.");
 if(object.kind!=="shape"&&!source)throw new Error("Alpha-источник ещё не загружен или отсутствует. Для группы используйте регулярную сетку.");
 const scale=Math.min(1,256/Math.max(object.width,object.height));
 const width=Math.max(1,Math.round(object.width*scale)),height=Math.max(1,Math.round(object.height*scale));
 const canvas=document.createElement("canvas");canvas.width=width;canvas.height=height;
 const ctx=canvas.getContext("2d",{willReadFrequently:true});if(!ctx)throw new Error("Не удалось создать alpha-маску.");
 try{
  if(object.kind==="shape"){ctx.scale(width/object.width,height/object.height);drawShapeObject(ctx,object);}
  else ctx.drawImage(source!,0,0,width,height);
  const rgba=ctx.getImageData(0,0,width,height).data,alpha=new Uint8Array(width*height);
  for(let i=0;i<alpha.length;i++)alpha[i]=rgba[i*4+3];
  return {width,height,alpha,rgba,objectWidth:object.width,objectHeight:object.height};
 }catch{throw new Error("Не удалось прочитать alpha: источник недоступен или запрещает чтение пикселей (CORS).");}
 finally{canvas.width=canvas.height=1;}
}
