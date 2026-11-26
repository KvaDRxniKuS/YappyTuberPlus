import type {RigObject,Vec2} from "../types";
import {insertArtVertex} from "./artDeformation";
import {insertArtStateVertex,removeArtStateVertex} from "./artMeshStates";
import {readStates,writeStates} from "./states";
export type ArtTopologyCommand={type:"insert";point:Vec2}|{type:"remove";ids:string[]};
/** Full object transaction: geometry, authored pose and every state key are
 * committed by the caller together. Failure leaves the source untouched. */
export function editArtTopology(object:RigObject,command:ArtTopologyCommand):RigObject {
 if(!object.artMesh)throw new Error("Object has no art mesh");
 let mesh=object.artMesh,states=readStates(object.script),pose=object.artPose??{};
 if(command.type==="insert"){
  const result=insertArtStateVertex(mesh,states,command.point);
  const authored=insertArtVertex(mesh,command.point,[pose]);
  mesh=result.mesh;states=result.states;pose=authored.poses[0];
 }else{
  const ids=new Set(command.ids);
  if(!mesh.vertices.some(v=>ids.has(v.id)))return object;
  for(const id of ids){const result=removeArtStateVertex(mesh,states,id);mesh=result.mesh;states=result.states;}
  pose=Object.fromEntries(Object.entries(pose).filter(([id])=>!ids.has(id)));
 }
 const next={...object,artMesh:mesh,artPose:pose};
 return {...next,script:writeStates(object.script,states,next).script};
}
