import {normalizeArtEdges,artEdgeKey} from "./artMeshEdges";
import {artPointHull,improveArtTriangles,rebuildArtTriangles} from "./artMeshQuality";
import {addArtFace} from "./artMeshFaces";
import type {RigObject,Vec2} from "../types";
import {emptyArtDeformation,bindArtPoint,insertArtVertex} from "./artDeformation";
import {insertArtStateVertex,removeArtStateVertex} from "./artMeshStates";
import {readStates,writeStates} from "./states";
export type ArtTopologyCommand={type:"start"}|{type:"triangulate"}|{type:"create";point:Vec2;connect?:boolean}|{type:"insert";point:Vec2}|{type:"remove";ids:string[];rebuild?:boolean}|{type:"addEdges"|"addFace"|"removeFace"|"removeEdge";ids:string[];rebuild?:boolean};
/** Full object transaction: geometry, authored pose and every state key are
 * committed by the caller together. Failure leaves the source untouched. */
export function editArtTopology(object:RigObject,command:ArtTopologyCommand):RigObject {
 if(command.type==="start"){
  if(object.artMesh)return object;
  return {...object,artMesh:emptyArtDeformation(),artPose:{}};
 }
 if(!object.artMesh)throw new Error("Object has no art mesh");
 let mesh=object.artMesh,states=readStates(object.script),pose=object.artPose??{};
 if(command.type==="triangulate"){
  if(mesh.triangles.length)throw new Error("Автосоединение доступно только для свободных точек без граней.");
  const hull=artPointHull(mesh);if(hull.length<3)throw new Error("Нужны три точки не на одной прямой.");
  const hullIds=new Set(hull);
  let built={...mesh,vertices:mesh.vertices.filter(v=>hullIds.has(v.id)),triangles:hull.slice(1,-1).map((id,i)=>[hull[0],id,hull[i+2]] as [string,string,string])};
  for(const vertex of mesh.vertices.filter(v=>!hullIds.has(v.id))){
   const result=insertArtVertex(built,vertex.rest,[]).mesh,newId=`v${built.nextId}`;
   built={...built,vertices:[...built.vertices,vertex],triangles:result.triangles.map(t=>t.map(id=>id===newId?vertex.id:id) as [string,string,string])};
  }
  return {...object,artMesh:improveArtTriangles({...mesh,triangles:built.triangles})};
 }
 if(command.type==="addEdges"){
  if(command.ids.length<2||command.ids.length>65535)throw new Error("Выберите не менее двух вершин по порядку.");
  const path=command.ids.slice(1).map((id,i)=>[command.ids[i],id] as [string,string]);
  const manualEdges=normalizeArtEdges(mesh,[...mesh.manualEdges??[],...path]);
  if(manualEdges.length>131072)throw new Error("Достигнут лимит ручных рёбер.");
  return {...object,artMesh:rebuildArtTriangles({...mesh,manualEdges})};
 }
 if(command.type==="removeEdge"||command.type==="removeFace"){
  const removed=mesh.triangles.filter(face=>command.ids.every(id=>face.includes(id)));
  const removeKeys=command.type==="removeEdge"?new Set(normalizeArtEdges(mesh,[command.ids as [string,string]]).map(edge=>artEdgeKey(...edge))):new Set<string>();
  const manualEdges=mesh.manualEdges?.filter(edge=>!removeKeys.has(artEdgeKey(...edge)));
  if(!removed.length){if(manualEdges?.length===mesh.manualEdges?.length)return object;return {...object,artMesh:rebuildArtTriangles({...mesh,manualEdges})};}
  const key=(face:string[])=>[...face].sort().join(":");
  const removedIds=new Set(removed.map(key));
  const next={...mesh,...(manualEdges?{manualEdges}:{}),manualFaces:mesh.manualFaces?.filter(f=>!removedIds.has(key(f))),excludedFaces:[...new Map([...mesh.excludedFaces??[],...removed].map(f=>[key(f),f])).values()]};
  return {...object,artMesh:rebuildArtTriangles(next)};
 }
 if(command.type==="addFace"){
  addArtFace({...mesh,triangles:mesh.manualFaces??[]},command.ids);
  const next={...mesh,manualFaces:[...mesh.manualFaces??[],command.ids as [string,string,string]],excludedFaces:mesh.excludedFaces};
  return {...object,artMesh:rebuildArtTriangles(next)};
 }
 if(command.type==="create"&&!bindArtPoint(mesh,command.point)){
  const p=command.point;
  if(!Number.isFinite(p.x)||!Number.isFinite(p.y)||object.width<=0||object.height<=0||!Number.isSafeInteger(mesh.nextId+1)||mesh.vertices.length>=65535)throw new Error("Некорректная точка или размер объекта.");
  if(mesh.vertices.some(v=>Math.hypot(v.rest.x-p.x,v.rest.y-p.y)<1e-7))throw new Error("Вершина уже существует.");
  const id=`v${mesh.nextId}`;
  let created={...mesh,nextId:mesh.nextId+1,vertices:[...mesh.vertices,{id,rest:{...p},uv:{x:p.x/object.width,y:p.y/object.height}}]};
  if(command.connect)created=rebuildArtTriangles(created);
  return {...object,artMesh:created};
 }
 if(command.type==="insert"||command.type==="create"){
  const result=insertArtStateVertex(mesh,states,command.point);
  const authored=insertArtVertex(mesh,command.point,[pose]);
  mesh=command.type==="create"&&command.connect?rebuildArtTriangles(result.mesh):result.mesh;states=result.states;pose=authored.poses[0];
 }else{
  const ids=new Set(command.ids);
  if(!mesh.vertices.some(v=>ids.has(v.id)))return object;
  mesh={...mesh,manualEdges:mesh.manualEdges?.filter(f=>!f.some(id=>ids.has(id))),manualFaces:mesh.manualFaces?.filter(f=>!f.some(id=>ids.has(id))),excludedFaces:mesh.excludedFaces?.filter(f=>!f.some(id=>ids.has(id)))};
  for(const id of ids){const result=removeArtStateVertex(mesh,states,id);mesh=result.mesh;states=result.states;}
  pose=Object.fromEntries(Object.entries(pose).filter(([id])=>!ids.has(id)));
 }
 if(command.type==="remove"&&command.rebuild)mesh=rebuildArtTriangles(mesh);
 const next={...object,artMesh:mesh,artPose:pose};
 return {...next,script:writeStates(object.script,states,next).script};
}
