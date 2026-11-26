import type {RigObject,RigPreset,RigFrame,Vec2} from "../types";
import {readStates,artWeightName,type States,type StatePreview} from "./states";
import type {ArtOffsets} from "./artDeformation";
const parsed=new WeakMap<RigObject,States>();
function statesOf(object:RigObject){let states=parsed.get(object);if(!states){states=readStates(object.script);parsed.set(object,states);}return states;}
/** Uses evaluated weights from this frame only. Never guesses expressions from
 * current inputs (which may already belong to a newer frame). */
export function artStateOffsets(object:RigObject,frame:RigFrame|null,preview?:StatePreview|null):ArtOffsets{
 const result:ArtOffsets={};if(!object.artMesh)return result;
 const ids=new Set(object.artMesh.vertices.map(v=>v.id));
 const layers=statesOf(object).layers.filter(l=>l.poses.length>0);
 layers.forEach((layer,i)=>{
  if(preview?.id===object.id&&preview.pointLayer===i){
   for(const [id,p] of Object.entries(preview.points??{}))if(ids.has(id)){
    const old=result[id]??{x:0,y:0};result[id]={x:old.x+p.x,y:old.y+p.y};
   }return;
  }
  const sums:ArtOffsets={},denoms:ArtOffsets={};
  layer.poses.forEach((pose,j)=>{
   const weight=frame?.vars?.[object.id]?.[artWeightName(i,j)];
   if(weight===undefined||!Number.isFinite(weight))return;
   for(const [id,p] of Object.entries(pose.points??{}))if(ids.has(id)){
    const sum=sums[id]??{x:0,y:0},denom=denoms[id]??{x:0,y:0};
    sums[id]={x:sum.x+p[0]*weight,y:sum.y+p[1]*weight};
    denoms[id]={x:denom.x+(p[0]!==0?weight:0),y:denom.y+(p[1]!==0?weight:0)};
   }
  });
  for(const [id,p] of Object.entries(sums)){
   const d=denoms[id],old=result[id]??{x:0,y:0};
   const average=layer.normalize==="average";
   result[id]={x:old.x+(average?(d.x?p.x/d.x:0):p.x),y:old.y+(average?(d.y?p.y/d.y:0):p.y)};
  }
 });return result;
}
/** Overrides are complete state contributions (authored artPose is added later). */
export function artFramePoints(preset:RigPreset,frame:RigFrame|null,overrides?:Map<string,Record<string,Vec2>>,preview?:StatePreview|null){
 const result=new Map(overrides);
 for(const object of preset.objects)if(object.artMesh&&!overrides?.has(object.id))result.set(object.id,artStateOffsets(object,frame,preview));
 return result;
}
