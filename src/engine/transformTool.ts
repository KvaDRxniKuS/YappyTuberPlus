import type {BasePose,RigObject,ObjectFrame,Vec2} from "../types";
import {objectMatrix,multiplyAffine,invertAffine,transformPoint,type Affine} from "../render/rigCanvas";
export type TransformHandle={kind:"scale"|"skew"|"rotate"|"move";x:number;y:number};
const identity=():Affine=>({a:1,b:0,c:0,d:1,e:0,f:0});
export function transformZone(object:RigObject):Affine{return object.transformFrame??{a:Math.max(1,object.width),b:0,c:0,d:Math.max(1,object.height),e:0,f:0};}
export function worldZone(object:RigObject,values:ObjectFrame):Affine{
 const local=transformZone(object);return multiplyAffine(objectMatrix(object,values),{...local,e:local.e-object.pivot.x*object.width,f:local.f-object.pivot.y*object.height});
}
export function transformHandles(zone:Affine,zoom:number){
 const handles:Array<TransformHandle&{point:Vec2;stem?:Vec2}>=[];
 for(const [x,y] of [[0,0],[.5,0],[1,0],[1,.5],[1,1],[.5,1],[0,1],[0,.5]])handles.push({kind:"scale",x,y,point:transformPoint(zone,x,y)});
 const center=transformPoint(zone,.5,.5);
 for(const [x,y] of [[.5,0],[1,.5],[.5,1],[0,.5]]){const stem=transformPoint(zone,x,y),dx=stem.x-center.x,dy=stem.y-center.y,length=Math.hypot(dx,dy)||1;handles.push({kind:"rotate",x,y,stem,point:{x:stem.x+dx/length*25/zoom,y:stem.y+dy/length*25/zoom}});}
 return handles;
}
export function hitTransform(zone:Affine,point:Vec2,zoom:number):TransformHandle|null{
 if(Math.abs(zone.a*zone.d-zone.b*zone.c)<1e-8)return null;
 for(const h of transformHandles(zone,zoom))if(Math.hypot(h.point.x-point.x,h.point.y-point.y)<8/zoom)return h;
 const p=transformPoint(invertAffine(zone),point.x,point.y);
 const ex=7/zoom/Math.max(1,Math.hypot(zone.a,zone.b)),ey=7/zoom/Math.max(1,Math.hypot(zone.c,zone.d));
 if(p.x>=-ex&&p.x<=1+ex&&p.y>=-ey&&p.y<=1+ey){
  if(Math.abs(p.y)<ey)return {kind:"skew",x:.5,y:0};if(Math.abs(p.y-1)<ey)return {kind:"skew",x:.5,y:1};
  if(Math.abs(p.x)<ex)return {kind:"skew",x:0,y:.5};if(Math.abs(p.x-1)<ex)return {kind:"skew",x:1,y:.5};
  return {kind:"move",x:.5,y:.5};
 }return null;
}
/** Apply an affine world-space gesture. Ctrl changes only editor metadata;
 * ordinary gestures decompose back to the existing base channels, never mesh UV/rest.
 * Work from the pointer-down snapshot, not the previous mouse event. */
export function transformGesture(object:RigObject,values:ObjectFrame,zone:Affine,handle:TransformHandle,start:Vec2,end:Vec2,options:{ctrl:boolean;alt:boolean;shift:boolean}):{base?:BasePose;frame?:Affine}{
 if(Math.hypot(end.x-start.x,end.y-start.y)<1e-9||Math.abs(values.sizeX*values.sizeY)<1e-10)return {};
 const inv=invertAffine(zone),s=transformPoint(inv,start.x,start.y),p=transformPoint(inv,end.x,end.y);
 const matrix=objectMatrix(object,values),pivot=transformPoint(inv,matrix.e,matrix.f);
 const anchor=options.alt?pivot:options.shift||handle.kind==="rotate"?{x:.5,y:.5}:{x:1-handle.x,y:1-handle.y};
 let delta=identity();
 if(handle.kind==="rotate"){
  const c=transformPoint(zone,anchor.x,anchor.y),angle=Math.atan2(end.y-c.y,end.x-c.x)-Math.atan2(start.y-c.y,start.x-c.x),cos=Math.cos(angle),sin=Math.sin(angle);
  delta={a:cos,b:sin,c:-sin,d:cos,e:c.x-cos*c.x+sin*c.y,f:c.y-sin*c.x-cos*c.y};
 }else{
  const local=identity();
  const safe=(v:number)=>Math.abs(v)<.001?(v<0?-.001:.001):v;
  if(handle.kind==="move"){local.e=p.x-s.x;local.f=p.y-s.y;}
  if(handle.kind==="scale"){
   if(handle.x!==.5)local.a=safe(1+(p.x-s.x)/safe(handle.x-anchor.x));
   if(handle.y!==.5)local.d=safe(1+(p.y-s.y)/safe(handle.y-anchor.y));
  }
  if(handle.kind==="skew"){
   if(handle.x===.5)local.c=(p.x-s.x)/safe(handle.y-anchor.y);
   else local.b=(p.y-s.y)/safe(handle.x-anchor.x);
  }
  if(handle.kind!=="move"){local.e=anchor.x-local.a*anchor.x-local.c*anchor.y;local.f=anchor.y-local.b*anchor.x-local.d*anchor.y;}
  delta=multiplyAffine(multiplyAffine(zone,local),inv);
 }
 if(options.ctrl){
  const frame=multiplyAffine(multiplyAffine(invertAffine(matrix),delta),zone);
  frame.e+=object.pivot.x*object.width;frame.f+=object.pivot.y*object.height;
  return {frame};
 }
 const next=multiplyAffine(delta,matrix),sx=Math.hypot(next.a,next.b),sy=(next.a*next.d-next.b*next.c)/sx;
 if(sx<1e-7||Math.abs(sy)<1e-7)return {};
 return {base:{...object.base,x:next.e-values.x,y:next.f-values.y,rotation:Math.atan2(next.b,next.a)*180/Math.PI-values.rotation,sizeX:sx/values.sizeX,sizeY:sy/values.sizeY,skewX:Math.atan((next.a*next.c+next.b*next.d)/(sx*sx))*180/Math.PI-values.skewX,skewY:-values.skewY}};
}
