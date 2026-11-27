import type {Vec2} from "../types";

/** One topology shared by editing, rendering, poses and parent deformation.
 * Coordinates are local object units. UV does not move when the rest shape moves.
 * IDs are monotonic within the mesh and never reused after deletion. */
export interface ArtVertex {id:string;rest:Vec2;uv:Vec2}
export interface ArtDeformation {
  schema:1;
  nextId:number;
  vertices:ArtVertex[];
  triangles:Array<[string,string,string]>;
  manualEdges?:Array<[string,string]>;
  manualFaces?:Array<[string,string,string]>;
  excludedFaces?:Array<[string,string,string]>;
}
export type ArtOffsets=Record<string,Vec2>;
export interface ArtBinding {ids:[string,string,string];weights:[number,number,number]}
const copy=(p:Vec2):Vec2=>({x:p.x,y:p.y});
export function emptyArtDeformation():ArtDeformation {
  return {schema:1,nextId:0,vertices:[],triangles:[]};
}
export function artPosition(vertex:ArtVertex,offsets:ArtOffsets={}):Vec2 {
  const delta=offsets[vertex.id];
  return {x:vertex.rest.x+(delta?.x??0),y:vertex.rest.y+(delta?.y??0)};
}
function weights(p:Vec2,a:Vec2,b:Vec2,c:Vec2):[number,number,number]|null {
  const det=(b.y-c.y)*(a.x-c.x)+(c.x-b.x)*(a.y-c.y);
  if(Math.abs(det)<1e-12)return null;
  const u=((b.y-c.y)*(p.x-c.x)+(c.x-b.x)*(p.y-c.y))/det;
  const v=((c.y-a.y)*(p.x-c.x)+(a.x-c.x)*(p.y-c.y))/det;
  const result:[number,number,number]=[u,v,1-u-v];
  return result.every(n=>n>=-1e-9&&n<=1+1e-9)?result:null;
}
/** Outside covered triangles (including holes), there is no deformation. */
export function bindArtPoint(mesh:ArtDeformation,p:Vec2):ArtBinding|null {
  const vertices=new Map(mesh.vertices.map(v=>[v.id,v]));
  for(const ids of mesh.triangles){
    const [a,b,c]=ids.map(id=>vertices.get(id));
    if(!a||!b||!c)continue;
    const w=weights(p,a.rest,b.rest,c.rest);
    if(w)return {ids:[...ids],weights:w};
  }
  return null;
}
export function boundArtPosition(mesh:ArtDeformation,binding:ArtBinding,offsets:ArtOffsets={}):Vec2|null {
  const vertices=new Map(mesh.vertices.map(v=>[v.id,v]));
  const result={x:0,y:0};
  for(let i=0;i<3;i++){
    const vertex=vertices.get(binding.ids[i]);if(!vertex)return null;
    const p=artPosition(vertex,offsets);result.x+=p.x*binding.weights[i];result.y+=p.y*binding.weights[i];
  }
  return result;
}
export function deformArtPoint(mesh:ArtDeformation,p:Vec2,offsets:ArtOffsets={}):Vec2 {
  const binding=bindArtPoint(mesh,p);
  return binding?boundArtPosition(mesh,binding,offsets)??copy(p):copy(p);
}
/** Square grids are a generator, never an additional control surface.
 * A fresh generator starts at the previous nextId so stale pose IDs cannot match.
 * Caller must clear old vertex poses on regeneration after user confirmation. */
export function generateRegularArt(cols:number,rows:number,width:number,height:number,inset=0,nextId=0):ArtDeformation {
  if(![cols,rows,width,height,inset,nextId].every(Number.isFinite)
    || !Number.isInteger(cols)||!Number.isInteger(rows)||cols<2||rows<2||cols>32||rows>32
    || width<=0||height<=0||inset<0||inset*2>=Math.min(width,height)
    || !Number.isSafeInteger(nextId)||nextId<0||!Number.isSafeInteger(nextId+cols*rows))throw new Error("Invalid art generation dimensions");
  const mesh=emptyArtDeformation();mesh.nextId=nextId;
  for(let y=0;y<rows;y++)for(let x=0;x<cols;x++){
    const rest={x:inset+(width-2*inset)*x/(cols-1),y:inset+(height-2*inset)*y/(rows-1)};
    mesh.vertices.push({id:`v${mesh.nextId++}`,rest,uv:{x:rest.x/width,y:rest.y/height}});
  }
  const id=(x:number,y:number)=>mesh.vertices[y*cols+x].id;
  for(let y=0;y<rows-1;y++)for(let x=0;x<cols-1;x++){
    mesh.triangles.push([id(x,y),id(x+1,y),id(x+1,y+1)],[id(x,y),id(x+1,y+1),id(x,y+1)]);
  }
  return mesh;
}
/** Rest editing preserves relative pose offsets and fixed texture coordinates. */
export function moveArtRest(mesh:ArtDeformation,id:string,rest:Vec2):ArtDeformation {
  if(!Number.isFinite(rest.x)||!Number.isFinite(rest.y))throw new Error("Invalid rest position");
  return {...mesh,vertices:mesh.vertices.map(v=>v.id===id?{...v,rest:copy(rest)}:v)};
}
export function removeArtVertex(mesh:ArtDeformation,id:string,poses:ArtOffsets[]):{mesh:ArtDeformation;poses:ArtOffsets[]} {
  return {mesh:{...mesh,vertices:mesh.vertices.filter(v=>v.id!==id),triangles:mesh.triangles.filter(t=>!t.includes(id))},
    poses:poses.map(pose=>Object.fromEntries(Object.entries(pose).filter(([key])=>key!==id)))};
}
/** Insert into a face or split every face incident to an edge. UV and all
 * poses interpolate from the same rest-space barycentric binding. */
export function insertArtVertex(mesh:ArtDeformation,p:Vec2,poses:ArtOffsets[]):{mesh:ArtDeformation;poses:ArtOffsets[]} {
  if(!Number.isFinite(p.x)||!Number.isFinite(p.y)||!Number.isSafeInteger(mesh.nextId+1)||mesh.vertices.length>=65535||mesh.triangles.length+2>131072)throw new Error("Invalid art insertion");
  if(mesh.vertices.some(v=>Math.hypot(v.rest.x-p.x,v.rest.y-p.y)<1e-7))throw new Error("Vertex already exists");
  const binding=bindArtPoint(mesh,p);
  if(!binding)throw new Error("Point must be inside the mesh");
  const zeros=binding.weights.map((w,i)=>w<=1e-9?i:-1).filter(i=>i>=0);
  if(zeros.length>1)throw new Error("Vertex already exists");
  const vertices=new Map(mesh.vertices.map(v=>[v.id,v]));
  const uv={x:0,y:0};
  binding.ids.forEach((id,i)=>{const v=vertices.get(id)!;uv.x+=v.uv.x*binding.weights[i];uv.y+=v.uv.y*binding.weights[i];});
  const id=`v${mesh.nextId}`;const [a,b,c]=binding.ids;
  const triangle=mesh.triangles.findIndex(t=>t.every((v,i)=>v===binding.ids[i]));
  const edge=zeros.length?binding.ids.filter((_,i)=>i!==zeros[0]):null;
  const triangles=mesh.triangles.flatMap((t,i):Array<[string,string,string]>=>{
    if(edge){
      for(let j=0;j<3;j++){
        const u=t[j],v=t[(j+1)%3],w=t[(j+2)%3];
        if((u===edge[0]&&v===edge[1])||(u===edge[1]&&v===edge[0]))return [[u,id,w],[id,v,w]];
      }
      return [t];
    }
    return i===triangle?[[a,b,id],[b,c,id],[c,a,id]]:[t];
  });
  return {mesh:{...mesh,nextId:mesh.nextId+1,vertices:[...mesh.vertices,{id,rest:copy(p),uv}],
    triangles},
    poses:poses.map(pose=>{
      const delta={x:0,y:0};binding.ids.forEach((key,i)=>{delta.x+=(pose[key]?.x??0)*binding.weights[i];delta.y+=(pose[key]?.y??0)*binding.weights[i];});
      return {...pose,[id]:delta};
    })};
}
