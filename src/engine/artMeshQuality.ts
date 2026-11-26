import cdt2d from "cdt2d";
import Delaunator from "delaunator";
import type {ArtDeformation} from "./artDeformation";
import type {Vec2} from "../types";
const cross=(a:Vec2,b:Vec2,c:Vec2)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
const edgeKey=(a:string,b:string)=>a<b?`${a}:${b}`:`${b}:${a}`;
/** Worst cosine = smallest angle. Edge flips improve local triangle quality
 * without moving rest/UV or changing the covered domain, boundary or holes. */
function worst(points:Vec2[]){return Math.max(...points.map((p,i)=>{
 const a=points[(i+1)%3],b=points[(i+2)%3],ux=a.x-p.x,uy=a.y-p.y,vx=b.x-p.x,vy=b.y-p.y;
 return (ux*vx+uy*vy)/(Math.hypot(ux,uy)*Math.hypot(vx,vy));
}));}
export function improveArtTriangles(mesh:ArtDeformation):ArtDeformation{
 const points=new Map(mesh.vertices.map(v=>[v.id,v.rest]));
 const triangles=mesh.triangles.map(t=>[...t] as [string,string,string]);
 const oriented=(a:string,b:string,c:string):[string,string,string]=>cross(points.get(a)!,points.get(b)!,points.get(c)!)>0?[a,b,c]:[a,c,b];
 for(let pass=0;pass<96;pass++){
  const edges=new Map<string,{a:string;b:string;faces:number[]}>();
  triangles.forEach((face,i)=>face.forEach((a,j)=>{const b=face[(j+1)%3],key=edgeKey(a,b),edge=edges.get(key);if(edge)edge.faces.push(i);else edges.set(key,{a,b,faces:[i]});}));
  const touched=new Set<number>();let flips=0;
  for(const {a,b,faces} of edges.values()){
   if(faces.length!==2||faces.some(i=>touched.has(i)))continue;
   const [i,j]=faces,c=triangles[i].find(v=>v!==a&&v!==b)!,d=triangles[j].find(v=>v!==a&&v!==b)!;
   if(c===d||edges.has(edgeKey(c,d)))continue;
   const pa=points.get(a)!,pb=points.get(b)!,pc=points.get(c)!,pd=points.get(d)!;
   if(cross(pa,pb,pc)*cross(pa,pb,pd)>=-1e-12||cross(pc,pd,pa)*cross(pc,pd,pb)>=-1e-12)continue;
   const before=Math.max(worst([pa,pb,pc]),worst([pb,pa,pd]));
   const after=Math.max(worst([pc,pd,pa]),worst([pd,pc,pb]));
   if(after>=before-1e-10)continue;
   triangles[i]=oriented(c,d,a);triangles[j]=oriented(d,c,b);touched.add(i);touched.add(j);flips++;
  }
  if(!flips)break;
 }
 return {...mesh,triangles};
}

/** Explicit action for a new point-only mesh. Never fills holes in an existing
 * surface. The convex outline and all original vertex IDs/UV are retained. */
export function artPointHull(mesh:ArtDeformation):string[]{
 const sorted=[...mesh.vertices].sort((a,b)=>a.rest.x-b.rest.x||a.rest.y-b.rest.y);
 const half=(vertices:typeof sorted)=>{const result:typeof sorted=[];for(const v of vertices){while(result.length>1&&cross(result.at(-2)!.rest,result.at(-1)!.rest,v.rest)<=1e-10)result.pop();result.push(v);}return result;};
 return [...half(sorted).slice(0,-1),...half([...sorted].reverse()).slice(0,-1)].map(v=>v.id);
}

/** Automatic editing topology: Delaunay over the current authored points,
 * constrained by manually pinned faces and intentional cut regions.
 * Stable IDs, UV, offsets and vertex order are never regenerated. Collinear
 * point sets have no surface; coincident points are retained for the editor. */
export function rebuildArtTriangles(mesh:ArtDeformation):ArtDeformation{
 const ids=new Map(mesh.vertices.map((v,i)=>[v.id,i]));
 const valid=(face:string[])=>face.every(id=>ids.has(id));
 const manualFaces=mesh.manualFaces?.filter(valid),excludedFaces=mesh.excludedFaces?.filter(valid);
 if(manualFaces?.length||excludedFaces?.length){
  const edges=new Map<string,[number,number]>();
  const cutEdges=new Map<string,{edge:[number,number];count:number}>();
  for(const face of excludedFaces??[])for(let i=0;i<3;i++){const a=ids.get(face[i])!,b=ids.get(face[(i+1)%3])!,key=a<b?`${a}:${b}`:`${b}:${a}`,old=cutEdges.get(key);if(old)old.count++;else cutEdges.set(key,{edge:[a,b],count:1});}
  // Only the cut region's union boundary is constrained, never diagonals
  // between two erased faces. New manual faces can fill it using another edge.
  for(const [key,{edge,count}] of cutEdges)if(count===1)edges.set(key,edge);
  for(const face of manualFaces??[])for(let i=0;i<3;i++){const a=ids.get(face[i])!,b=ids.get(face[(i+1)%3])!;edges.set(a<b?`${a}:${b}`:`${b}:${a}`,[a,b]);}
  const segments=[...edges.values()];
  for(let i=0;i<segments.length;i++)for(let j=i+1;j<segments.length;j++){
   const [a,b]=segments[i],[c,d]=segments[j];if(a===c||a===d||b===c||b===d)continue;
   const [pa,pb,pc,pd]=[a,b,c,d].map(k=>mesh.vertices[k].rest);
   if(cross(pa,pb,pc)*cross(pa,pb,pd)<-1e-12&&cross(pc,pd,pa)*cross(pc,pd,pb)<-1e-12)throw new Error("Закреплённые рёбра пересекаются. Удалите конфликтующую грань перед перемещением.");
  }
  const splitEdges:Array<[number,number]>=[];
  for(const [a,b] of segments){
   const pa=mesh.vertices[a].rest,pb=mesh.vertices[b].rest,dx=pb.x-pa.x,dy=pb.y-pa.y,length=dx*dx+dy*dy;
   if(length<1e-16)continue;
   const along=mesh.vertices.map((v,i)=>({i,t:((v.rest.x-pa.x)*dx+(v.rest.y-pa.y)*dy)/length,p:v.rest})).filter(v=>v.t>=0&&v.t<=1&&Math.abs(cross(pa,pb,v.p))<1e-8).sort((a,b)=>a.t-b.t);
   for(let i=1;i<along.length;i++)if(along[i].t-along[i-1].t>1e-10)splitEdges.push([along[i-1].i,along[i].i]);
  }
  const indices=cdt2d(mesh.vertices.map(v=>[v.rest.x,v.rest.y]),splitEdges);
  const inside=(p:Vec2,face:string[])=>{const [a,b,c]=face.map(id=>mesh.vertices[ids.get(id)!].rest),d=[cross(a,b,p),cross(b,c,p),cross(c,a,p)];if(Math.abs(cross(a,b,c))<1e-10)return false;return d.every(x=>x>=-1e-8)||d.every(x=>x<=1e-8);};
  const triangles=indices.filter(face=>{const p=face.map(i=>mesh.vertices[i].rest),center={x:(p[0].x+p[1].x+p[2].x)/3,y:(p[0].y+p[1].y+p[2].y)/3};return manualFaces?.some(f=>inside(center,f))||!excludedFaces?.some(f=>inside(center,f));}).map(face=>face.map(i=>mesh.vertices[i].id) as [string,string,string]);
  return {...mesh,manualFaces,excludedFaces,triangles};
 }
 const delaunay=Delaunator.from(mesh.vertices,v=>v.rest.x,v=>v.rest.y);
 const triangles:Array<[string,string,string]>=[];
 for(let i=0;i<delaunay.triangles.length;i+=3){
  const vertices=[0,1,2].map(j=>mesh.vertices[delaunay.triangles[i+j]]);
  const area=cross(vertices[0].rest,vertices[1].rest,vertices[2].rest);
  if(Math.abs(area)<1e-10)continue;
  const ids=vertices.map(v=>v.id) as [string,string,string];
  triangles.push(area>0?ids:[ids[0],ids[2],ids[1]]);
 }
 return {...mesh,triangles};
}
