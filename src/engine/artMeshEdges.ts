import type {ArtDeformation} from "./artDeformation";
export const artEdgeKey=(a:string,b:string)=>a<b?`${a}:${b}`:`${b}:${a}`;
/** Split at existing vertices, not into overlapping edges/T-junctions. */
export function splitArtEdge(mesh:ArtDeformation,a:string,b:string):Array<[string,string]>{
 const first=mesh.vertices.find(v=>v.id===a),last=mesh.vertices.find(v=>v.id===b);
 if(!first||!last||a===b)throw new Error("Выберите две разные существующие вершины.");
 const dx=last.rest.x-first.rest.x,dy=last.rest.y-first.rest.y,length=dx*dx+dy*dy;
 if(length<1e-14)throw new Error("Нельзя соединить совпадающие точки.");
 const along=mesh.vertices.map(v=>({id:v.id,t:((v.rest.x-first.rest.x)*dx+(v.rest.y-first.rest.y)*dy)/length,d:Math.abs(dx*(v.rest.y-first.rest.y)-dy*(v.rest.x-first.rest.x))})).filter(v=>v.t>=-1e-10&&v.t<=1+1e-10&&v.d<1e-8).sort((a,b)=>a.t-b.t||a.id.localeCompare(b.id));
 const result:Array<[string,string]>=[];
 for(let i=1;i<along.length;i++)if(along[i].t-along[i-1].t>1e-10)result.push([along[i-1].id,along[i].id]);
 return result;
}
export function normalizeArtEdges(mesh:ArtDeformation,edges:ReadonlyArray<readonly [string,string]>):Array<[string,string]>{
 const unique=new Map<string,[string,string]>();
 for(const [a,b] of edges)for(const edge of splitArtEdge(mesh,a,b))unique.set(artEdgeKey(...edge),edge);
 return [...unique.values()];
}
