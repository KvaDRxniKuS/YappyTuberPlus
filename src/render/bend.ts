import {artFramePoints} from "../engine/artMeshPlayback";
import {compiledArtMesh,evaluateArtMesh,addArtOffsets,bindArtVertices,applyArtBindings} from "../engine/artMeshRuntime";
import type { ObjectFrame, RigFrame, RigObject, RigPreset, Vec2 } from "../types";
import { invertAffine, objectMatrix, staticValues, transformPoint } from "./rigCanvas";

/** Explicit triangle sources map selected vertices in world space. Object bases
 * remain unchanged; no geometry is invented for children without an artMesh. */

/** Предел вложенности: защита от петли в структуре, а не ограничение модели. */
const MAX_DEPTH = 32;

export function deformOffset(
  object: RigObject,
  values: ObjectFrame,
  point: Vec2,
  points?: Record<string, Vec2>,
): Vec2 {
  return prepareDeformOffset(object,values,points)?.(point) ?? {x:0,y:0};
}

/** Prepare once per object/frame, never normalize or allocate grids per vertex. */
export function prepareDeformOffset(object: RigObject,values: ObjectFrame,points?: Record<string,Vec2>): ((point:Vec2)=>Vec2) | undefined {
  if(object.artMesh){
    const compiled=compiledArtMesh(object.artMesh);
    const offsets=addArtOffsets(object.artPose,points);
    if(!Object.values(offsets).some(p=>p.x!==0||p.y!==0))return undefined;
    const targets=evaluateArtMesh(compiled,offsets).targets;
    const matrix=objectMatrix(object,values),inverse=invertAffine(matrix);
    return point=>{
      const local=transformPoint(inverse,point.x,point.y);
      const content={x:local.x+object.pivot.x*object.width,y:local.y+object.pivot.y*object.height};
      const binding=bindArtVertices(compiled,[content]);
      const target=applyArtBindings(compiled,targets,[content],binding)[0];
      const dx=target.x-content.x,dy=target.y-content.y;
      return {x:matrix.a*dx+matrix.c*dy,y:matrix.b*dx+matrix.d*dy};
    };
  }
  return undefined;
}

/** Maps mesh vertices, not object bases or child deformer control points. */
export function parentMeshTransform(
  preset: RigPreset,
  object: RigObject,
  frame: RigFrame | null,
  points?: Map<string, Record<string, Vec2>>,
): ((point: Vec2) => Vec2) | undefined {
  return createParentMeshTransforms(preset,frame,points)?.(object);
}

/** One lazy hierarchy index per draw, and no hierarchy work for ordinary rigs. */
export function createParentMeshTransforms(
  preset:RigPreset,frame:RigFrame|null,points?:Map<string,Record<string,Vec2>>,
):((object:RigObject)=>((point:Vec2)=>Vec2)|undefined)|undefined {
  if(!preset.objects.some(o=>!!o.artMesh)) return undefined;
  points=artFramePoints(preset,frame,points);
  const byId=new Map(preset.objects.map(object=>[object.id,object]));
  type Sampler=(point:Vec2)=>Vec2;
  const samplers=new Map<string,Sampler|undefined>();
  const transforms=new WeakMap<RigObject,Sampler|undefined>();
  return object=>{
    if(object.deformParent!==true || !object.artMesh || (!object.parentId&&!object.deformSources?.length)) return undefined;
    if(transforms.has(object)) return transforms.get(object);
    const chain:Sampler[]=[];
    const seen=new Set<string>([object.id]);
    const sources:RigObject[]=[];
    if(object.deformSources){
      for(const id of object.deformSources)if(!seen.has(id)){seen.add(id);const source=byId.get(id);if(source)sources.push(source);}
    }else{
      let parent=object.parentId?byId.get(object.parentId):undefined;
      for(let depth=0;parent&&depth<MAX_DEPTH&&!seen.has(parent.id);depth++){
        seen.add(parent.id);sources.push(parent);parent=parent.parentId?byId.get(parent.parentId):undefined;
      }
    }
    if(object.deformSources){
      const depth=(source:RigObject)=>{let count=0,parent=source.parentId;const visited=new Set([source.id]);while(parent&&!visited.has(parent)){visited.add(parent);count++;parent=byId.get(parent)?.parentId??null;}return count;};
      sources.sort((a,b)=>depth(b)-depth(a)||preset.objects.indexOf(a)-preset.objects.indexOf(b));
    }
    for(const parent of sources)if(parent.artMesh){
      if(!samplers.has(parent.id))samplers.set(parent.id,prepareDeformOffset(parent,frame?.objects[parent.id]??staticValues(parent),points?.get(parent.id)));
      const sampler=samplers.get(parent.id);if(sampler)chain.push(sampler);
    }
    if(!chain.length) {transforms.set(object,undefined);return undefined;}
    const values=frame?.objects[object.id]??staticValues(object);
    const matrix=objectMatrix(object,values),inverse=invertAffine(matrix);
    const transform:Sampler=point=>{
      let world=transformPoint(matrix,point.x-object.pivot.x*object.width,point.y-object.pivot.y*object.height);
      for(const sampler of chain) {const delta=sampler(world);world={x:world.x+delta.x,y:world.y+delta.y};}
      const local=transformPoint(inverse,world.x,world.y);
      return {x:local.x+object.pivot.x*object.width,y:local.y+object.pivot.y*object.height};
    };
    transforms.set(object,transform);return transform;
  };
}
