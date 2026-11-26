import type {Vec2} from "../types";
import {pointInPolygon} from "./selection";
export interface ArtSelectionPoint {id:string;world:Vec2}
/** Region and points share scene coordinates, including parent deformation.
 * No project mutations: selection is editor-only and cancellation discards draft. */
export function selectArtRegion(points:readonly ArtSelectionPoint[],path:Vec2[],shape:"rect"|"lasso",previous:ReadonlySet<string>,mode:"replace"|"add"|"subtract"):Set<string>{
 const result=mode==="replace"?new Set<string>():new Set(previous);
 if(path.length<2)return result;
 const first=path[0],last=path[path.length-1];
 const minX=Math.min(first.x,last.x),maxX=Math.max(first.x,last.x),minY=Math.min(first.y,last.y),maxY=Math.max(first.y,last.y);
 const onEdge=(p:Vec2,a:Vec2,b:Vec2)=>{
  const dx=b.x-a.x,dy=b.y-a.y,length=dx*dx+dy*dy;
  const t=length?Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/length)):0;
  return Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy)<1e-7;
 };
 const bounds=shape==="lasso"?path.reduce((b,p)=>({minX:Math.min(b.minX,p.x),minY:Math.min(b.minY,p.y),maxX:Math.max(b.maxX,p.x),maxY:Math.max(b.maxY,p.y)}),{minX:Infinity,minY:Infinity,maxX:-Infinity,maxY:-Infinity}):{minX,minY,maxX,maxY};
 for(const {id,world:p} of points){
  if(p.x<bounds.minX||p.x>bounds.maxX||p.y<bounds.minY||p.y>bounds.maxY)continue;
  const inside=shape==="rect"?p.x>=minX&&p.x<=maxX&&p.y>=minY&&p.y<=maxY:
   path.length>=3&&(pointInPolygon(p,path)||path.some((a,i)=>onEdge(p,a,path[(i+1)%path.length])));
  if(inside){if(mode==="subtract")result.delete(id);else result.add(id);}
 }
 return result;
}
