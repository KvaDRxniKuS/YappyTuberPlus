import type {RigObject,RigPreset} from "../types";
import type {ArtDeformation} from "./artDeformation";
import {readArtMesh} from "./artMeshRuntime";
import {readStates,writeStates} from "./states";
import {replaceArtStateMesh} from "./artMeshStates";
export interface ArtMeshReplacement {id:string;mesh:ArtDeformation}
export function artDescendants(objects:readonly RigObject[],root:string,scope:"direct"|"all"):RigObject[]{
 const children=new Map<string,RigObject[]>();
 for(const object of objects)if(object.parentId){const list=children.get(object.parentId)??[];list.push(object);children.set(object.parentId,list);}
 const seen=new Set([root]),result:RigObject[]=[],queue=[...(children.get(root)??[])];
 for(let i=0;i<queue.length;i++){const object=queue[i];if(seen.has(object.id))continue;seen.add(object.id);result.push(object);if(scope==="all")queue.push(...(children.get(object.id)??[]));}
 return result;
}
export function artGenerationSupported(object:RigObject){return ["sprite","media","shape","group"].includes(object.kind??"sprite")&&Number.isFinite(object.width)&&Number.isFinite(object.height)&&object.width>0&&object.height>0;}
/** Validate every replacement before producing any project result. Caller uses
 * one commit, so errors and cancellation cannot leave half a prepared subtree. */
export function replaceArtMeshes(preset:RigPreset,replacements:readonly ArtMeshReplacement[],enableInheritance=false):RigPreset {
 const byId=new Map<string,ArtDeformation>(),objects=new Map(preset.objects.map(o=>[o.id,o]));
 for(const item of replacements){
  const object=objects.get(item.id);
  if(byId.has(item.id)||!object||!artGenerationSupported(object))throw new Error("Invalid batch mesh target");
  const mesh=readArtMesh(item.mesh);
  if(mesh.nextId<(object.artMesh?.nextId??0)||mesh.vertices.some(v=>Number(v.id.slice(1))<(object.artMesh?.nextId??0)))throw new Error("Batch reuses vertex IDs");
  byId.set(item.id,mesh);
 }
 return {...preset,objects:preset.objects.map(object=>{
  const artMesh=byId.get(object.id);if(!artMesh)return object;
  const next={...object,artMesh,artPose:{},mesh:undefined,warp:undefined,...(enableInheritance&&object.parentId?{deformParent:true}:{})};
  const states=replaceArtStateMesh(artMesh,readStates(object.script)).states;
  return {...next,script:writeStates(object.script,states,next).script};
 })};
}
