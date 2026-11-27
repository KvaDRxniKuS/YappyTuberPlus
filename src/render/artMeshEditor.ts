import type {RigObject,Vec2} from "../types";
import type {ArtDeformation,ArtOffsets} from "../engine/artDeformation";
import {artPosition,moveArtRest} from "../engine/artDeformation";
import {objectMatrix,transformPoint,invertAffine,type Affine} from "./rigCanvas";

export function artEditorPoint(object:RigObject,world:Vec2,matrix:Affine):Vec2 {
 const p=transformPoint(invertAffine(matrix),world.x,world.y);
 return {x:p.x+object.pivot.x*object.width,y:p.y+object.pivot.y*object.height};
}
export function editArtVertex(mesh:ArtDeformation,pose:ArtOffsets,id:string,start:Vec2,current:Vec2,mode:"rest"|"pose"):{mesh:ArtDeformation;pose:ArtOffsets}{
 const vertex=mesh.vertices.find(v=>v.id===id);if(!vertex)throw new Error("Missing art vertex");
 const delta={x:current.x-start.x,y:current.y-start.y};
 if(mode==="rest")return {mesh:moveArtRest(mesh,id,{x:vertex.rest.x+delta.x,y:vertex.rest.y+delta.y}),pose};
 const before=pose[id]??{x:0,y:0};return {mesh,pose:{...pose,[id]:{x:before.x+delta.x,y:before.y+delta.y}}};
}
export function drawArtEditor(ctx:CanvasRenderingContext2D,object:RigObject,values:Parameters<typeof objectMatrix>[1],zoom:number,rest:boolean,deform?:ArtEditorDeform,selected?:ReadonlySet<string>){
 const mesh=object.artMesh;if(!mesh)return;
 const matrix=objectMatrix(object,values);
 const points=new Map(mesh.vertices.map(v=>{const source=rest?v.rest:artPosition(v,object.artPose);const p=deform?deform(source):source;return [v.id,transformPoint(matrix,p.x-object.pivot.x*object.width,p.y-object.pivot.y*object.height)] as const;}));
 ctx.save();ctx.lineWidth=1/zoom;ctx.strokeStyle=rest?"#82d5c1":"#f0d77a";ctx.fillStyle=ctx.strokeStyle;
 for(const face of mesh.triangles){ctx.beginPath();face.forEach((id,i)=>{const p=points.get(id)!;if(i)ctx.lineTo(p.x,p.y);else ctx.moveTo(p.x,p.y);});ctx.closePath();ctx.stroke();}
 if(rest&&mesh.manualEdges?.length){
  ctx.save();ctx.strokeStyle="#f0b878";ctx.lineWidth=2/zoom;
  for(const [a,b] of mesh.manualEdges){const p=points.get(a),q=points.get(b);if(!p||!q)continue;ctx.beginPath();ctx.moveTo(p.x,p.y);ctx.lineTo(q.x,q.y);ctx.stroke();}ctx.restore();
 }
 for(const [id,p] of points){ctx.fillStyle=selected?.has(id)?"#ffffff":ctx.strokeStyle;ctx.beginPath();ctx.arc(p.x,p.y,(selected?.has(id)?4.5:3)/zoom,0,Math.PI*2);ctx.fill();}ctx.restore();
}

export type ArtEditorDeform=(point:Vec2)=>Vec2;
/** Locally invert the actual parent sampler, seeded by the grabbed vertex.
 * A folded surface has no unique global inverse. Follow the nearby branch and
 * reject singular/non-converging steps rather than writing an arbitrary pose. */
export function inverseArtEditorPoint(target:Vec2,seed:Vec2,deform?:ArtEditorDeform):Vec2|null {
 const finite=(p:Vec2)=>Number.isFinite(p.x)&&Number.isFinite(p.y);
 if(!finite(target)||!finite(seed))return null;
 if(!deform)return {...target};
 let point={...seed};
 for(let iteration=0;iteration<24;iteration++){
  const shown=deform(point);if(!finite(shown))return null;
  const dx=target.x-shown.x,dy=target.y-shown.y,error=Math.hypot(dx,dy);
  if(error<1e-5)return point;
  const h=1e-3;
  const px=deform({x:point.x+h,y:point.y}),py=deform({x:point.x,y:point.y+h});
  const a=(px.x-shown.x)/h,b=(px.y-shown.y)/h,c=(py.x-shown.x)/h,d=(py.y-shown.y)/h;
  const determinant=a*d-b*c;
  if(!Number.isFinite(determinant)||Math.abs(determinant)<1e-10)return null;
  const step={x:(d*dx-c*dy)/determinant,y:(a*dy-b*dx)/determinant};
  let accepted=false;
  for(let scale=1;scale>=1/128;scale/=2){
   const candidate={x:point.x+step.x*scale,y:point.y+step.y*scale},mapped=deform(candidate);
   if(finite(mapped)&&Math.hypot(target.x-mapped.x,target.y-mapped.y)<error){point=candidate;accepted=true;break;}
  }
  if(!accepted)return null;
 }
 return null;
}

/** One immutable update for a multi-vertex gesture. All deltas refer to the
 * gesture's original mesh/pose, so repeated pointer events never accumulate. */
export function editArtVertices(mesh:ArtDeformation,pose:ArtOffsets,deltas:ArtOffsets,mode:"rest"|"pose",size?:{width:number;height:number}){
 for(const delta of Object.values(deltas))if(!Number.isFinite(delta.x)||!Number.isFinite(delta.y))throw new Error("Invalid art edit delta");
 if(mode==="rest")return {mesh:{...mesh,vertices:mesh.vertices.map(v=>{
  const d=deltas[v.id];if(!d)return v;
  const rest={x:v.rest.x+d.x,y:v.rest.y+d.y};
  return {...v,rest,uv:size?{x:rest.x/size.width,y:rest.y/size.height}:v.uv};
 })},pose};
 const next={...pose};for(const v of mesh.vertices){const d=deltas[v.id];if(!d)continue;
  const p=pose[v.id]??{x:0,y:0};next[v.id]={x:p.x+d.x,y:p.y+d.y};}
 return {mesh,pose:next};
}
export function artBrushWeight(distance:number,radius:number,hardness=0):number {
 if(!Number.isFinite(distance)||!Number.isFinite(radius)||radius<=0||distance>=radius)return 0;
 const inner=Math.max(0,Math.min(1,hardness));
 if(distance<=radius*inner)return 1;
 const t=Math.max(0,(1-distance/radius)/(1-inner));return t*t*(3-2*t);
}
