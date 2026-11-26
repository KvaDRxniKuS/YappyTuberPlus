import type {ArtDeformation} from "./artDeformation";
import type {Vec2} from "../types";
const EPS=1e-8;
const cross=(a:Vec2,b:Vec2,c:Vec2)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
function inside(p:Vec2,t:Vec2[]){const signs=t.map((a,i)=>cross(a,t[(i+1)%3],p));return signs.every(v=>v>EPS)||signs.every(v=>v<-EPS);}
function onSegment(p:Vec2,a:Vec2,b:Vec2){return Math.abs(cross(a,b,p))<EPS&&p.x>=Math.min(a.x,b.x)-EPS&&p.x<=Math.max(a.x,b.x)+EPS&&p.y>=Math.min(a.y,b.y)-EPS&&p.y<=Math.max(a.y,b.y)+EPS;}
const key=(ids:readonly string[])=>[...ids].sort().join(":");
/** Explicit face authoring, not an automatic hole triangulator. Existing points,
 * UV and poses are untouched. Reject overlap, T-junctions and third edge faces. */
export function addArtFace(mesh:ArtDeformation,ids:readonly string[]):ArtDeformation {
 if(ids.length!==3||new Set(ids).size!==3)throw new Error("Выберите ровно три разные вершины.");
 const byId=new Map(mesh.vertices.map(v=>[v.id,v.rest]));
 const p=ids.map(id=>byId.get(id));if(p.some(v=>!v))throw new Error("Вершина не найдена.");
 const points=p as Vec2[];
 if(Math.abs(cross(points[0],points[1],points[2]))<EPS)throw new Error("Вершины лежат на одной прямой.");
 if(mesh.triangles.length>=131072)throw new Error("Достигнут лимит треугольников.");
 const face=[...ids] as [string,string,string];if(cross(points[0],points[1],points[2])<0)[face[1],face[2]]=[face[2],face[1]];
 for(const vertex of mesh.vertices)if(!ids.includes(vertex.id)){
  if(inside(vertex.rest,points)||points.some((a,i)=>onSegment(vertex.rest,a,points[(i+1)%3])))throw new Error("Внутри грани или на её ребре есть другая вершина.");
 }
 for(const old of mesh.triangles){
  if(key(old)===key(ids))throw new Error("Такой треугольник уже существует.");
  const other=old.map(id=>byId.get(id)!);
  if(points.some(v=>inside(v,other))||other.some(v=>inside(v,points)))throw new Error("Треугольники перекрываются.");
  const center={x:(points[0].x+points[1].x+points[2].x)/3,y:(points[0].y+points[1].y+points[2].y)/3};
  if(inside(center,other))throw new Error("Треугольники перекрываются.");
  for(let i=0;i<3;i++)for(let j=0;j<3;j++){
   const a=points[i],b=points[(i+1)%3],c=other[j],d=other[(j+1)%3];
   if(cross(a,b,c)*cross(a,b,d)<-EPS&&cross(c,d,a)*cross(c,d,b)<-EPS)throw new Error("Рёбра пересекаются.");
  }
 }
 for(let i=0;i<3;i++)if(mesh.triangles.filter(t=>t.includes(ids[i])&&t.includes(ids[(i+1)%3])).length>=2)throw new Error("Ребро уже соединяет две грани.");
 return {...mesh,triangles:[...mesh.triangles,face]};
}
export function removeArtFace(mesh:ArtDeformation,ids:readonly string[]):ArtDeformation {
 if(ids.length!==3||new Set(ids).size!==3)throw new Error("Выберите три вершины одной грани.");
 const triangles=mesh.triangles.filter(t=>key(t)!==key(ids));
 if(triangles.length===mesh.triangles.length)throw new Error("Грань с этими вершинами не найдена.");
 return {...mesh,triangles};
}
