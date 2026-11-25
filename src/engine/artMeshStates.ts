import type {ArtDeformation,ArtOffsets} from "./artDeformation";
import {insertArtVertex,removeArtVertex} from "./artDeformation";
import type {Vec2} from "../types";
import {fromPosePoints,toPosePoints,type States,type Pose} from "./states";

/** Immutable edit transaction, suitable for one editor undo record. No global
 * state; caller commits mesh and states together, never in separate renders. */
export interface ArtStateEdit {mesh:ArtDeformation;states:States}
function editPoses(mesh:ArtDeformation,states:States,edit:(poses:ArtOffsets[])=>{mesh:ArtDeformation;poses:ArtOffsets[]}):ArtStateEdit {
  const poses=states.layers.flatMap(layer=>layer.poses.map(p=>fromPosePoints(p.points)??{}));
  const result=edit(poses);let index=0;
  return {mesh:result.mesh,states:{...states,layers:states.layers.map(layer=>({...layer,
    poses:layer.poses.map(p=>{
      const points=toPosePoints(result.poses[index++]);
      const next:Pose={...p};if(points)next.points=points;else delete next.points;
      return next;
    }),
  }))}};
}
export function insertArtStateVertex(mesh:ArtDeformation,states:States,p:Vec2):ArtStateEdit {
  return editPoses(mesh,states,poses=>insertArtVertex(mesh,p,poses));
}
export function removeArtStateVertex(mesh:ArtDeformation,states:States,id:string):ArtStateEdit {
  return editPoses(mesh,states,poses=>removeArtVertex(mesh,id,poses));
}
/** Full regeneration intentionally resets only vertex poses. Caller confirms
 * replacement before committing; this function never mutates the old project. */
export function replaceArtStateMesh(mesh:ArtDeformation,states:States):ArtStateEdit {
  return {mesh,states:{...states,layers:states.layers.map(layer=>({...layer,poses:layer.poses.map(p=>{
    const next={...p};delete next.points;return next;
  })}))}};
}
/** Record a pose from explicit offsets. Rest geometry is not used as a pose
 * buffer: editing rest must never accidentally create animation keys. */
export function artRecordDelta(mesh:ArtDeformation,previous:ArtOffsets|null,current:ArtOffsets):ArtOffsets|null {
  if(!previous)return null;
  const ids=new Set(mesh.vertices.map(v=>v.id));
  for(const source of [previous,current])for(const [id,p] of Object.entries(source)) {
    if(!ids.has(id)||!Number.isFinite(p.x)||!Number.isFinite(p.y))throw new Error("Invalid vertex pose recording");
  }
  const result:ArtOffsets={};let changed=false;
  for(const id of ids){
    const before=previous[id]??{x:0,y:0},after=current[id]??{x:0,y:0};
    if(Math.abs(before.x-after.x)>1e-6||Math.abs(before.y-after.y)>1e-6)changed=true;
    if(Math.abs(after.x)>1e-6||Math.abs(after.y)>1e-6)result[id]={...after};
  }
  return changed?result:null;
}
