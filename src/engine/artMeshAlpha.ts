import {improveArtTriangles} from "./artMeshQuality";
import earcut,{deviation} from "earcut";
import type {Vec2} from "../types";
import {emptyArtDeformation,insertArtVertex,bindArtPoint,type ArtDeformation} from "./artDeformation";
import {pointInPolygon} from "./selection";
export interface AlphaRaster {width:number;height:number;alpha:Uint8Array;objectWidth:number;objectHeight:number}
export interface AlphaMeshOptions {threshold:number;padding:number;contourSpacing:number;interiorSpacing:number;simplification:number;nextId?:number}
const MAX_POINTS=8192;
const area=(loop:Vec2[])=>loop.reduce((sum,p,i)=>{const q=loop[(i+1)%loop.length];return sum+p.x*q.y-q.x*p.y;},0)/2;
function distance(p:Vec2,a:Vec2,b:Vec2){const dx=b.x-a.x,dy=b.y-a.y,l=dx*dx+dy*dy,t=l?Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/l)):0;return Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy);}
function simplifyOpen(points:Vec2[],epsilon:number):Vec2[]{
 const keep=new Set([0,points.length-1]),stack=[[0,points.length-1]];
 while(stack.length){const [a,b]=stack.pop()!;let index=-1,max=epsilon;
  for(let i=a+1;i<b;i++){const d=distance(points[i],points[a],points[b]);if(d>max){max=d;index=i;}}
  if(index>=0){keep.add(index);stack.push([a,index],[index,b]);}
 }
 return [...keep].sort((a,b)=>a-b).map(i=>points[i]);
}
function simplifyLoop(loop:Vec2[],epsilon:number):Vec2[]{
 let opposite=1;for(let i=2;i<loop.length;i++)if(Math.hypot(loop[i].x-loop[0].x,loop[i].y-loop[0].y)>Math.hypot(loop[opposite].x-loop[0].x,loop[opposite].y-loop[0].y))opposite=i;
 const result=[...simplifyOpen(loop.slice(0,opposite+1),epsilon).slice(0,-1),...simplifyOpen([...loop.slice(opposite),loop[0]],epsilon).slice(0,-1)];
 return result.length>=3&&area(result)*area(loop)>0?result:loop;
}
function validateContourCrossings(loops:Vec2[][]){
 const segments=loops.flatMap((loop,k)=>loop.map((a,i)=>({a,b:loop[(i+1)%loop.length],loop:k,index:i,count:loop.length})));
 if(segments.length>MAX_POINTS)throw new Error("Alpha contour exceeds vertex budget; increase simplification");
 const cross=(a:Vec2,b:Vec2,c:Vec2)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
 for(let i=0;i<segments.length;i++)for(let j=i+1;j<segments.length;j++){
  const a=segments[i],b=segments[j];
  if(a.loop===b.loop&&(Math.abs(a.index-b.index)===1||Math.abs(a.index-b.index)===a.count-1))continue;
  if(Math.max(a.a.x,a.b.x)<Math.min(b.a.x,b.b.x)||Math.max(b.a.x,b.b.x)<Math.min(a.a.x,a.b.x)||Math.max(a.a.y,a.b.y)<Math.min(b.a.y,b.b.y)||Math.max(b.a.y,b.b.y)<Math.min(a.a.y,a.b.y))continue;
  if(cross(a.a,a.b,b.a)*cross(a.a,a.b,b.b)<-1e-12&&cross(b.a,b.b,a.a)*cross(b.a,b.b,a.b)<-1e-12)throw new Error("Simplified alpha contours intersect; reduce simplification");
 }
}
/** Trace clockwise occupied cell boundaries; holes have opposite winding.
 * Right turns split diagonally touching pixels into separate components. */
export function traceAlphaContours(mask:Uint8Array,width:number,height:number):Vec2[][]{
 if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||mask.length!==width*height)throw new Error("Invalid alpha mask");
 type Edge={a:Vec2;b:Vec2;used:boolean};const edges:Edge[]=[],out=new Map<string,Edge[]>();
 const key=(p:Vec2)=>`${p.x},${p.y}`;
 const add=(ax:number,ay:number,bx:number,by:number)=>{if(edges.length>=65536)throw new Error("Alpha contour complexity exceeds tracing budget");const edge={a:{x:ax,y:ay},b:{x:bx,y:by},used:false};edges.push(edge);const k=key(edge.a),list=out.get(k)??[];list.push(edge);out.set(k,list);};
 const on=(x:number,y:number)=>x>=0&&y>=0&&x<width&&y<height&&mask[y*width+x]!==0;
 for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(on(x,y)){
  if(!on(x,y-1))add(x,y,x+1,y);if(!on(x+1,y))add(x+1,y,x+1,y+1);
  if(!on(x,y+1))add(x+1,y+1,x,y+1);if(!on(x-1,y))add(x,y+1,x,y);
 }
 const loops:Vec2[][]=[];
 for(const start of edges){if(start.used)continue;const loop:Vec2[]=[];let edge=start;
  while(!edge.used){edge.used=true;loop.push(edge.a);if(key(edge.b)===key(start.a))break;
   const choices=(out.get(key(edge.b))??[]).filter(e=>!e.used);if(!choices.length)throw new Error("Open alpha contour");
   const dx=edge.b.x-edge.a.x,dy=edge.b.y-edge.a.y;
   choices.sort((a,b)=>{const rank=(e:Edge)=>{const ex=e.b.x-e.a.x,ey=e.b.y-e.a.y,c=dx*ey-dy*ex,d=dx*ex+dy*ey;return c>0?0:d>0?1:c<0?2:3;};return rank(a)-rank(b);});edge=choices[0];
  }
  if(loop.length>=3)loops.push(loop);
 }
 return loops;
}
/** Pure alpha-to-mesh pipeline. Padding uses an anisotropic 8-neighbour distance
 * transform (octile approximation), in local object units. No browser or project
 * state is involved. Raster resolution and mesh budgets are explicitly bounded. */
export function generateAlphaArt(raster:AlphaRaster,options:AlphaMeshOptions):ArtDeformation{
 const {width:w,height:h,objectWidth:ow,objectHeight:oh,alpha}=raster;
 const {threshold,padding,contourSpacing,interiorSpacing,simplification}=options;
 const nextId=options.nextId??0;
 if(!Number.isInteger(w)||!Number.isInteger(h)||w<1||h<1||w>512||h>512||alpha.length!==w*h||![ow,oh,threshold,padding,contourSpacing,interiorSpacing,simplification].every(Number.isFinite)||ow<=0||oh<=0||threshold<0||threshold>255||padding<0||contourSpacing<=0||interiorSpacing<=0||simplification<0||!Number.isSafeInteger(nextId)||nextId<0)throw new Error("Invalid alpha generation parameters");
 const sx=ow/w,sy=oh/h,px=Math.ceil(padding/sx),py=Math.ceil(padding/sy),width=w+2*px,height=h+2*py;
 if(width>1024||height>1024)throw new Error("Alpha padding exceeds raster budget");
 const dist=new Float64Array(width*height);dist.fill(Infinity);
 for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(alpha[y*w+x]>0&&alpha[y*w+x]>=threshold)dist[(y+py)*width+x+px]=0;
 const diagonal=Math.hypot(sx,sy);
 const pass=(reverse:boolean)=>{for(let row=0;row<height;row++)for(let col=0;col<width;col++){
  const x=reverse?width-1-col:col,y=reverse?height-1-row:row,index=y*width+x;
  const neighbors=reverse?[[1,0,sx],[0,1,sy],[1,1,diagonal],[-1,1,diagonal]]:[[-1,0,sx],[0,-1,sy],[-1,-1,diagonal],[1,-1,diagonal]];
  for(const [dx,dy,cost] of neighbors){const nx=x+dx,ny=y+dy;if(nx>=0&&ny>=0&&nx<width&&ny<height)dist[index]=Math.min(dist[index],dist[ny*width+nx]+cost);}
 }};pass(false);pass(true);
 const mask=Uint8Array.from(dist,d=>d<=padding?1:0);
 const loops=traceAlphaContours(mask,width,height).map(loop=>simplifyLoop(loop.map(p=>({x:(p.x-px)*sx,y:(p.y-py)*sy})),simplification));
 if(!loops.length)throw new Error("Alpha mask has no opaque area");
 validateContourCrossings(loops);
 const outers=loops.filter(l=>area(l)>0).map(loop=>({loop,holes:[] as Vec2[][]}));
 for(const hole of loops.filter(l=>area(l)<0)){
  const owner=outers.filter(o=>pointInPolygon(hole[0],o.loop)).sort((a,b)=>area(a.loop)-area(b.loop))[0];
  if(!owner)throw new Error("Alpha hole has no enclosing contour");owner.holes.push(hole);
 }
 let mesh=emptyArtDeformation();mesh.nextId=nextId;
 for(const outer of outers){
  const points:Vec2[]=[],holes:number[]=[];
  for(const [index,loop] of [outer.loop,...outer.holes].entries()){
   if(index)holes.push(points.length);
   loop.forEach((p,i)=>{const q=loop[(i+1)%loop.length],steps=Math.max(1,Math.ceil(Math.hypot(q.x-p.x,q.y-p.y)/contourSpacing));
    if(points.length+steps+mesh.vertices.length>MAX_POINTS)throw new Error("Alpha contour exceeds vertex budget");
    for(let j=0;j<steps;j++)points.push({x:p.x+(q.x-p.x)*j/steps,y:p.y+(q.y-p.y)*j/steps});
   });
  }
  const coordinates=points.flatMap(p=>[p.x,p.y]);
  const base=mesh.vertices.length,indices=earcut(coordinates,holes);
  const error=deviation(coordinates,holes,2,indices);
  if(!Number.isFinite(error)||error>1e-6)throw new Error("Alpha contour cannot be triangulated safely; reduce simplification");
  for(const rest of points){if(!Number.isSafeInteger(mesh.nextId+1))throw new Error("Unsafe alpha vertex ID");mesh.vertices.push({id:`v${mesh.nextId++}`,rest,uv:{x:rest.x/ow,y:rest.y/oh}});}
  for(let i=0;i<indices.length;i+=3)mesh.triangles.push(indices.slice(i,i+3).map(n=>mesh.vertices[base+n].id) as [string,string,string]);
 }
 // Earcut may discard collinear contour samples. Reinsert them as edge splits
 // so contourSpacing actually controls the deformable boundary, not orphan IDs.
 const referenced=new Set(mesh.triangles.flat());
 const omitted=mesh.vertices.filter(v=>!referenced.has(v.id));
 mesh={...mesh,vertices:mesh.vertices.filter(v=>referenced.has(v.id))};
 for(const vertex of omitted){
  if(mesh.vertices.some(v=>Math.hypot(v.rest.x-vertex.rest.x,v.rest.y-vertex.rest.y)<1e-7))continue;
  mesh=insertArtVertex(mesh,vertex.rest,[]).mesh;
 }
 // Staggered triangular lattice, with clearance from boundary samples. Unlike
 // repeated face-fan insertion alone, a final constrained edge-flip pass removes
 // long spokes and improves the minimum angles without filling holes.
 const dy=interiorSpacing*Math.sqrt(3)/2;
 if(Math.ceil(ow/interiorSpacing)*Math.ceil(oh/dy)>MAX_POINTS)throw new Error("Alpha interior spacing exceeds sampling budget");
 for(let row=0,y=dy/2;y<oh;y+=dy,row++)for(let x=interiorSpacing*(row%2?.75:.25);x<ow;x+=interiorSpacing){
  const p={x,y},clearance=Math.min(contourSpacing,interiorSpacing)*.55;
  if(mesh.vertices.some(v=>Math.hypot(v.rest.x-x,v.rest.y-y)<clearance)||!bindArtPoint(mesh,p))continue;
  if(mesh.vertices.length>=MAX_POINTS)throw new Error("Alpha mesh exceeds vertex budget");mesh=insertArtVertex(mesh,p,[]).mesh;
 }
 if(!mesh.triangles.length)throw new Error("Alpha mesh contains no triangles");
 return improveArtTriangles(mesh);
}
