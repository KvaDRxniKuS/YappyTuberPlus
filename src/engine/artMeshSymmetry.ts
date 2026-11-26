import type {ArtDeformation,ArtOffsets} from "./artDeformation";
export type ArtSymmetry={axis:"x"|"y";at:number}|{angle:number;center:{x:number;y:number}};
/** Angle in degrees from the vertical axis, in object-local coordinates. */
export function reflectArtVector(p:{x:number;y:number},axis:"x"|"y"|number){
 if(axis==="x")return {x:-p.x,y:p.y};if(axis==="y")return {x:p.x,y:-p.y};
 if(!Number.isFinite(axis))throw new Error("Invalid symmetry angle");
 const radians=axis*Math.PI/180,nx=Math.cos(radians),ny=Math.sin(radians),dot=p.x*nx+p.y*ny;
 return {x:p.x-2*dot*nx,y:p.y-2*dot*ny};
}
/** Snapshot pairing by rest position. Spatial buckets keep large meshes from
 * paying an all-pairs search. Only mutual nearest neighbours are paired. */
export function artSymmetryPairs(mesh:ArtDeformation,symmetry:ArtSymmetry,tolerance=.5):Map<string,string>{
 const angled="angle" in symmetry;
 const center=angled?symmetry.center:symmetry.axis==="x"?{x:symmetry.at,y:0}:{x:0,y:symmetry.at};
 const axis=angled?symmetry.angle:symmetry.axis;
 if(!Number.isFinite(center.x)||!Number.isFinite(center.y)||(typeof axis==="number"&&!Number.isFinite(axis))||!Number.isFinite(tolerance)||tolerance<=0)throw new Error("Invalid symmetry axis");
 const buckets=new Map<string,typeof mesh.vertices>();
 const key=(x:number,y:number)=>`${Math.floor(x/tolerance)},${Math.floor(y/tolerance)}`;
 for(const v of mesh.vertices){const k=key(v.rest.x,v.rest.y);const bucket=buckets.get(k)??[];bucket.push(v);buckets.set(k,bucket);}
 const nearest=new Map<string,string>();
 for(const v of mesh.vertices){
  const reflected=reflectArtVector({x:v.rest.x-center.x,y:v.rest.y-center.y},axis);
  const p={x:reflected.x+center.x,y:reflected.y+center.y};
  let found:string|undefined,distance=tolerance*tolerance;
  const bx=Math.floor(p.x/tolerance),by=Math.floor(p.y/tolerance);
  for(let x=bx-1;x<=bx+1;x++)for(let y=by-1;y<=by+1;y++)for(const candidate of buckets.get(`${x},${y}`)??[]){
   const d=(candidate.rest.x-p.x)**2+(candidate.rest.y-p.y)**2;
   if(d<=distance&&(d<distance||found===undefined||candidate.id<found)){distance=d;found=candidate.id;}
  }
  if(found)nearest.set(v.id,found);
 }
 const pairs=new Map<string,string>();
 for(const [id,other] of nearest)if(nearest.get(other)===id)pairs.set(id,other);
 return pairs;
}
/** Reflect deltas once, never sum a mirrored contribution twice. If both sides
 * are driven (brush/selection), the larger local motion wins; ties use stable ID.
 * Vertices on the axis can move along it, not away from it. */
export function mirrorArtDeltas(deltas:ArtOffsets,pairs:ReadonlyMap<string,string>,axis:"x"|"y"|number):ArtOffsets{
 const result:ArtOffsets={...deltas},done=new Set<string>();
 for(const [id,other] of pairs){
  if(done.has(id))continue;done.add(id);done.add(other);
  const a=deltas[id],b=deltas[other];if(!a&&!b)continue;
  if(id===other){const reflected=reflectArtVector(a,axis);result[id]={x:(a.x+reflected.x)/2,y:(a.y+reflected.y)/2};continue;}
  const length=(p:{x:number;y:number}|undefined)=>p?p.x*p.x+p.y*p.y:-1;
  const chooseA=length(a)>length(b)||(length(a)===length(b)&&id<other);
  const source=chooseA?a:b;if(!source)continue;
  const from=chooseA?id:other,to=chooseA?other:id;
  result[from]={...source};result[to]=reflectArtVector(source,axis);
 }
 return result;
}
