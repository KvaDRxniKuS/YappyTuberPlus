import type {Vec2} from "../types";
import type {ArtBinding,ArtDeformation,ArtOffsets} from "./artDeformation";

const MAX_VERTICES=65535;
const MAX_TRIANGLES=131072;
function record(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==="object"&&!Array.isArray(value);}
function point(value:unknown):Vec2 {
  if(!record(value)||typeof value.x!=="number"||typeof value.y!=="number"||!Number.isFinite(value.x)||!Number.isFinite(value.y))throw new Error("Invalid mesh point");
  return {x:value.x,y:value.y};
}
/** Strict new schema: legacy grids are not guessed or silently migrated.
 * Returns owned data so mutations to parsed JSON cannot mutate editor state. */
export function readArtMesh(raw:unknown):ArtDeformation {
  if(!record(raw)||raw.schema!==1||!Number.isSafeInteger(raw.nextId)||Number(raw.nextId)<0
    ||!Array.isArray(raw.vertices)||raw.vertices.length>MAX_VERTICES
    ||!Array.isArray(raw.triangles)||raw.triangles.length>MAX_TRIANGLES)throw new Error("Invalid art mesh schema");
  const ids=new Set<string>();
  const vertices=raw.vertices.map(item=>{
    if(!record(item)||typeof item.id!=="string"||!/^v(0|[1-9]\d*)$/.test(item.id)
      ||ids.has(item.id)||!Number.isSafeInteger(Number(item.id.slice(1)))||Number(item.id.slice(1))>=Number(raw.nextId))throw new Error("Invalid mesh vertex ID");
    ids.add(item.id);return {id:item.id,rest:point(item.rest),uv:point(item.uv)};
  });
  const faces=new Set<string>();
  const triangles=raw.triangles.map(face=>{
    if(!Array.isArray(face)||face.length!==3||!face.every(id=>typeof id==="string"&&ids.has(id))||new Set(face).size!==3)throw new Error("Invalid mesh triangle");
    const key=[...face].sort().join(":");if(faces.has(key))throw new Error("Duplicate mesh triangle");faces.add(key);
    return [...face] as [string,string,string];
  });
  return {schema:1,nextId:Number(raw.nextId),vertices,triangles};
}
export function readArtOffsets(raw:unknown,mesh:ArtDeformation):ArtOffsets {
  if(!record(raw))throw new Error("Invalid vertex pose");
  const ids=new Set(mesh.vertices.map(v=>v.id));const result:ArtOffsets={};
  for(const [id,value] of Object.entries(raw)){
    if(!ids.has(id))throw new Error("Pose references missing mesh vertex");
    result[id]=point(value);
  }
  return result;
}
export interface CompiledArtMesh {
  ids:readonly string[];
  rest:readonly Vec2[];
  uv:Vec2[];
  triangles:number[];
  index:ReadonlyMap<string,number>;
}
/** Compile only when topology/rest changes, not once for each rendered frame. */
export function compileArtMesh(mesh:ArtDeformation):CompiledArtMesh {
  const owned=readArtMesh(mesh);
  const index=new Map(owned.vertices.map((v,i)=>[v.id,i]));
  return {ids:owned.vertices.map(v=>v.id),rest:owned.vertices.map(v=>v.rest),
    uv:owned.vertices.map(v=>v.uv),triangles:owned.triangles.flatMap(t=>t.map(id=>index.get(id)!)),index};
}
export function evaluateArtMesh(mesh:CompiledArtMesh,offsets:ArtOffsets={}):{targets:Vec2[];uv:Vec2[];triangles:number[]} {
  return {targets:mesh.rest.map((p,i)=>({x:p.x+(offsets[mesh.ids[i]]?.x??0),y:p.y+(offsets[mesh.ids[i]]?.y??0)})),
    uv:mesh.uv,triangles:mesh.triangles};
}
/** Pre-bind in the parent's rest-local coordinate system. Bindings retain only
 * triangle indices and weights; each animation frame uses evaluated positions.
 * Rebuild after topology/rest edits. Null means outside or in a hole. */
export function bindArtVertices(parent:CompiledArtMesh,points:readonly Vec2[]):Array<ArtBinding|null> {
  return points.map(p=>{
    for(let i=0;i<parent.triangles.length;i+=3){
      const indices=parent.triangles.slice(i,i+3);const [a,b,c]=indices.map(n=>parent.rest[n]);
      const det=(b.y-c.y)*(a.x-c.x)+(c.x-b.x)*(a.y-c.y);if(Math.abs(det)<1e-12)continue;
      const u=((b.y-c.y)*(p.x-c.x)+(c.x-b.x)*(p.y-c.y))/det;
      const v=((c.y-a.y)*(p.x-c.x)+(a.x-c.x)*(p.y-c.y))/det;
      const weights:[number,number,number]=[u,v,1-u-v];
      if(weights.every(w=>w>=-1e-9&&w<=1+1e-9))return {ids:indices.map(n=>parent.ids[n]) as [string,string,string],weights};
    }
    return null;
  });
}
export function applyArtBindings(parent:CompiledArtMesh,targets:readonly Vec2[],points:readonly Vec2[],bindings:readonly (ArtBinding|null)[]):Vec2[] {
  if(targets.length!==parent.ids.length||points.length!==bindings.length)throw new Error("Mesh binding size mismatch");
  return points.map((p,i)=>{
    const binding=bindings[i];if(!binding)return {...p};
    const result={x:0,y:0};
    for(let j=0;j<3;j++){
      const index=parent.index.get(binding.ids[j]);if(index===undefined)throw new Error("Stale parent mesh binding");
      result.x+=targets[index].x*binding.weights[j];result.y+=targets[index].y*binding.weights[j];
    }
    return result;
  });
}
