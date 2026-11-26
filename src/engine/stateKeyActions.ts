import type {Pose} from "./states";
import type {ArtDeformation} from "./artDeformation";
import {artSymmetryPairs,reflectArtVector} from "./artMeshSymmetry";
export function mirrorStateKey(key:Pose,mesh:ArtDeformation|undefined,width:number,height:number,angle:number):Pose{
 const pose={...key.pose},delta=reflectArtVector({x:pose.x??0,y:pose.y??0},angle);
 if(pose.x!==undefined||pose.y!==undefined){pose.x=delta.x;pose.y=delta.y;}
 for(const name of ["rotation","skewX","skewY"] as const)if(pose[name]!==undefined)pose[name]=-pose[name]!;
 const pairs=mesh?artSymmetryPairs(mesh,{angle,center:{x:width/2,y:height/2}}):new Map<string,string>();
 const points=key.points?Object.fromEntries(Object.entries(key.points).map(([id,p])=>{const v=reflectArtVector({x:p[0],y:p[1]},angle);return [pairs.get(id)??id,[v.x,v.y] as [number,number]];})):undefined;
 return {...key,pose,points};
}
export function pasteStateKey(source:Pose,target:Pose):Pose{
 return {...structuredClone(source),at:target.at,weight:target.weight};
}
let held:Pose|null=null;
export const copyStateKey=(pose:Pose)=>{held=structuredClone(pose);};
export const heldStateKey=()=>held?structuredClone(held):null;
