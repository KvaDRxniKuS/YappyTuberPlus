import type {RigObject} from "../types";
import type {ArtDeformation,ArtOffsets} from "./artDeformation";
import {readArtMesh,readArtOffsets} from "./artMeshRuntime";
import {readStates,writeStates} from "./states";
import {replaceArtStateMesh} from "./artMeshStates";
export interface ArtMeshClip {mesh:ArtDeformation;pose:ArtOffsets;width:number;height:number}
export type ArtMeshPasteScale="local"|"fit";
let held:ArtMeshClip|null=null;
function copy(clip:ArtMeshClip):ArtMeshClip {
 if(!Number.isFinite(clip.width)||!Number.isFinite(clip.height)||clip.width<=0||clip.height<=0)throw new Error("Invalid clipboard dimensions");
 const mesh=readArtMesh(clip.mesh);return {...clip,mesh,pose:readArtOffsets(clip.pose,mesh)};
}
/** In-memory buffer, never shares mutable mesh/offset arrays with an object. */
export function holdArtMesh(object:RigObject):void {
 if(!object.artMesh)throw new Error("Нет артмеша для копирования.");
 held=copy({mesh:object.artMesh,pose:object.artPose??{},width:object.width,height:object.height});
}
export function heldArtMesh():ArtMeshClip|null{return held?copy(held):null;}
/** Full replacement transaction. No numeric-grid resampling or ID guessing.
 * UV stay normalized; fit scales rest and, optionally, authored local offsets. */
export function pasteArtMesh(object:RigObject,source:ArtMeshClip,scale:ArtMeshPasteScale,includePose:boolean):RigObject {
 const clip=copy(source);
 if(!["sprite","shape","media","group"].includes(object.kind??"sprite")||!Number.isFinite(object.width)||!Number.isFinite(object.height)||object.width<=0||object.height<=0)throw new Error("Для вставки нужны положительные размеры объекта.");
 if(scale!=="local"&&scale!=="fit")throw new Error("Invalid art paste scale");
 let nextId=object.artMesh?.nextId??0;
 if(!Number.isSafeInteger(nextId+clip.mesh.vertices.length))throw new Error("Unsafe clipboard vertex IDs");
 const ids=new Map(clip.mesh.vertices.map(v=>[v.id,`v${nextId++}`]));
 const sx=scale==="fit"?object.width/clip.width:1,sy=scale==="fit"?object.height/clip.height:1;
 const artMesh:ArtDeformation={schema:1,nextId,vertices:clip.mesh.vertices.map(v=>({id:ids.get(v.id)!,rest:{x:v.rest.x*sx,y:v.rest.y*sy},uv:{...v.uv}})),triangles:clip.mesh.triangles.map(t=>t.map(id=>ids.get(id)!) as [string,string,string])};
 const artPose:ArtOffsets=includePose?Object.fromEntries(Object.entries(clip.pose).map(([id,p])=>[ids.get(id)!,{x:p.x*sx,y:p.y*sy}])):{};
 // Scaled finite input can still overflow when dimensions differ drastically.
 readArtMesh(artMesh);readArtOffsets(artPose,artMesh);
 const next={...object,artMesh,artPose};
 const states=replaceArtStateMesh(artMesh,readStates(object.script)).states;
 return {...next,script:writeStates(object.script,states,next).script};
}
