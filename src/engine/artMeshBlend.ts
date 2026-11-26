import type {ArtOffsets} from "./artDeformation";
import {weightsAt,type StateLayer} from "./states";

/** Vertex layers blend whole poses, not separate nonzero coordinates.
 * A missing vertex/coordinate is neutral, but its pose still carries weight.
 * This keeps average interpolation continuous when a coordinate crosses zero. */
export function blendArtLayer(layer:StateLayer,weights:readonly number[]):ArtOffsets {
 const result:ArtOffsets={};
 let denominator=0;
 layer.poses.forEach((pose,index)=>{
  const weight=weights[index];if(!Number.isFinite(weight))return;
  denominator+=weight;
  for(const [id,point] of Object.entries(pose.points??{})){
   if(!/^v(?:0|[1-9][0-9]*)$/.test(id))continue;
   const previous=result[id]??{x:0,y:0};
   result[id]={x:previous.x+point[0]*weight,y:previous.y+point[1]*weight};
  }
 });
 if(layer.normalize==="average")for(const id of Object.keys(result)){
  const p=result[id];result[id]=Math.abs(denominator)>1e-9?{x:p.x/denominator,y:p.y/denominator}:{x:0,y:0};
 }
 return result;
}
export function artPosePoints(layer:StateLayer,at:number):ArtOffsets {
 return blendArtLayer(layer,weightsAt(layer,at));
}
