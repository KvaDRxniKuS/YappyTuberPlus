import {artFramePoints} from "../engine/artMeshPlayback";
import {compiledArtMesh,evaluateArtMesh,addArtOffsets,bindArtVertices,applyArtBindings} from "../engine/artMeshRuntime";
import type { ObjectFrame, RigFrame, RigObject, RigPreset, Vec2 } from "../types";
import { applyOffsets, meshEnabled, meshOf, paramOffsets, regularGrid, sampleDeform } from "../engine/mesh";
import { invertAffine, objectMatrix, staticValues, transformPoint } from "./rigCanvas";
import { zoneGeometry } from "./mesh";

/*
 * «Деформируется родителем».
 *
 * У объекта есть галка: гнётся ли он вместе с деформером родителя. Выключена —
 * объект едет только за пивотом (то есть за базой родителя, как раньше).
 * Включена — точка ребёнка берётся с **деформированной** поверхности родителя:
 * сетка родителя сдвинула это место, и ребёнок сдвинулся вместе с ним.
 *
 * Сцена рисует объекты плоско (каждый от своей базы), поэтому изгиб — это
 * смещение: у ребёнка считается, где его центр оказался бы на сетке родителя, и
 * на сколько эта точка ушла от недеформированной. Такой подход не требует
 * переписывать матрицы: достаточно подменить значения кадра, и хит-тест,
 * рамка, ручки и отрисовка видят одно и то же.
 *
 * Ключи состояний приходят сюда картой точек (`points` из вкладки
 * «Состояния»), поэтому ребёнок гнётся и от позы родителя, а не только от его
 * авторской сетки.
 */

/** Предел вложенности: защита от петли в структуре, а не ограничение модели. */
const MAX_DEPTH = 32;

/** Объекты от корня к родителю: изгиб считается сверху вниз. */
function ancestors(preset: RigPreset, object: RigObject): RigObject[] {
  const byId = new Map(preset.objects.map((item) => [item.id, item]));
  const chain: RigObject[] = [];
  let current = object.parentId ? byId.get(object.parentId) : undefined;
  for (let depth = 0; current && depth < MAX_DEPTH; depth += 1) {
    chain.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return chain;
}

/** Смещения сетки объекта: параметры `warp*` и точки ключа, если их дали. */
function gridOffsets(object: RigObject, values: ObjectFrame, points?: Record<string, Vec2>): Record<string, Vec2> {
  const mesh = meshOf(object);
  if (!mesh) return {};
  const result: Record<string, Vec2> = { ...(paramOffsets(mesh, values) ?? {}) };
  for (const [index, offset] of Object.entries(points ?? {})) {
    const previous = result[index];
    result[index] = previous
      ? { x: previous.x + offset.x, y: previous.y + offset.y }
      : offset;
  }
  return result;
}

/**
 * На сколько сетка объекта сдвинула точку мира.
 *
 * Точка переводится в координаты картинки родителя, оттуда — в доли зоны, там
 * берётся смещение узлов и возвращается в мир через линейную часть матрицы:
 * поворот и масштаб родителя сдвиг тоже поворачивают.
 */
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
  if(!meshEnabled(object)) return undefined;
  const mesh=meshOf(object);
  if(!mesh?.enabled) return undefined;
  const grid=applyOffsets(mesh.deform,gridOffsets(object,values,points));
  const rest=grid.rest ?? regularGrid(grid.cols,grid.rows).points;
  if(grid.points.every((p,i)=>Math.hypot(p.x-rest[i].x,p.y-rest[i].y)<1e-8)) return undefined;
  const matrix=objectMatrix(object,values),inverse=invertAffine(matrix),zone=zoneGeometry(object);
  return point=>{
    const local=transformPoint(inverse,point.x,point.y);
    const content={x:local.x+object.pivot.x*object.width,y:local.y+object.pivot.y*object.height};
    const uv=zone.toZone(content),shifted=sampleDeform(grid,uv.x,uv.y),target=zone.toObject(shifted.x,shifted.y);
    const dx=target.x-content.x,dy=target.y-content.y;
    return {x:matrix.a*dx+matrix.c*dy,y:matrix.b*dx+matrix.d*dy};
  };
}

/** Центр объекта в мире: пивот стоит на базе, то есть в `base.x`/`base.y`. */
function center(object: RigObject, values: ObjectFrame): Vec2 {
  return { x: object.base.x + values.x, y: object.base.y + values.y };
}

/**
 * Кадр, в котором дети стоят на деформированной поверхности родителей.
 *
 * Возвращается новый кадр: значения чужих объектов не правятся, а сам кадр
 * остаётся тем, что пришёл от ядра. Офсеты считаются от корня вниз, поэтому
 * вложенные деформеры складываются.
 */
export function bendFrame(
  preset: RigPreset,
  frame: RigFrame | null,
  points?: Map<string, Record<string, Vec2>>,
): RigFrame | null {
  if (!frame) return frame;
  // Нет ни одной сетки — нечего и считать: кадр возвращается как есть.
  if (!preset.objects.some((object) => meshOf(object)?.enabled)) return frame;
  const objects: Record<string, ObjectFrame> = {};
  for (const object of preset.objects) {
    const values = frame.objects[object.id];
    if (!values) continue;
    if (object.deformParent === false) {
      objects[object.id] = values;
      continue;
    }
    let point = center(object, values);
    let shift: Vec2 = { x: 0, y: 0 };
    for (const parent of ancestors(preset, object)) {
      // Родитель, который сам не гнётся, дальше деформацию не передаёт —
      // это и значит «едет только пивот ребёнка».
      if (parent.deformParent === false) continue;
      const parentValues = frame.objects[parent.id];
      if (!parentValues) continue;
      const offset = deformOffset(parent, parentValues, point, points?.get(parent.id));
      if (!offset.x && !offset.y) continue;
      shift = { x: shift.x + offset.x, y: shift.y + offset.y };
      point = { x: point.x + offset.x, y: point.y + offset.y };
    }
    objects[object.id] = shift.x || shift.y
      ? { ...values, x: values.x + shift.x, y: values.y + shift.y }
      : values;
  }
  return { ...frame, objects };
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
  if(!preset.objects.some(meshEnabled)) return undefined;
  points=artFramePoints(preset,frame,points);
  const byId=new Map(preset.objects.map(object=>[object.id,object]));
  type Sampler=(point:Vec2)=>Vec2;
  const samplers=new Map<string,Sampler|undefined>();
  const transforms=new WeakMap<RigObject,Sampler|undefined>();
  return object=>{
    if(object.deformParent===false || !object.parentId) return undefined;
    if(transforms.has(object)) return transforms.get(object);
    const chain:Sampler[]=[];
    const seen=new Set<string>([object.id]);
    let parent=byId.get(object.parentId);
    for(let depth=0;parent&&depth<MAX_DEPTH&&!seen.has(parent.id);depth++) {
      seen.add(parent.id);
      if(meshEnabled(parent) && (!parent.artMesh || (!!object.artMesh && object.deformParent===true))) {
        if(!samplers.has(parent.id)) samplers.set(parent.id,prepareDeformOffset(parent,frame?.objects[parent.id]??staticValues(parent),points?.get(parent.id)));
        const sampler=samplers.get(parent.id);
        if(sampler) chain.push(sampler);
      }
      parent=parent.parentId?byId.get(parent.parentId):undefined;
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
