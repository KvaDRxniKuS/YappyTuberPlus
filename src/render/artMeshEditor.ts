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
export function drawArtEditor(ctx:CanvasRenderingContext2D,object:RigObject,values:Parameters<typeof objectMatrix>[1],zoom:number,rest:boolean){
 const mesh=object.artMesh;if(!mesh)return;
 const matrix=objectMatrix(object,values);
 const points=new Map(mesh.vertices.map(v=>{const p=rest?v.rest:artPosition(v,object.artPose);return [v.id,transformPoint(matrix,p.x-object.pivot.x*object.width,p.y-object.pivot.y*object.height)] as const;}));
 ctx.save();ctx.lineWidth=1/zoom;ctx.strokeStyle=rest?"#82d5c1":"#f0d77a";ctx.fillStyle=ctx.strokeStyle;
 for(const face of mesh.triangles){ctx.beginPath();face.forEach((id,i)=>{const p=points.get(id)!;if(i)ctx.lineTo(p.x,p.y);else ctx.moveTo(p.x,p.y);});ctx.closePath();ctx.stroke();}
 for(const p of points.values()){ctx.beginPath();ctx.arc(p.x,p.y,3/zoom,0,Math.PI*2);ctx.fill();}ctx.restore();
}
