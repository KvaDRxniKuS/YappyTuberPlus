import {test,expect} from "@playwright/test";
import {generateAlphaArt,traceAlphaContours,type AlphaMeshOptions} from "../../src/engine/artMeshAlpha";
import {bindArtPoint} from "../../src/engine/artDeformation";
const options:AlphaMeshOptions={threshold:128,padding:0,contourSpacing:2,interiorSpacing:2,simplification:0};
function raster(rows:number[][]){return {width:rows[0].length,height:rows.length,alpha:Uint8Array.from(rows.flat()),objectWidth:rows[0].length,objectHeight:rows.length};}
test("alpha threshold produces explicit mesh with local UV and fresh stable IDs",()=>{
 const input=raster([[0,0,0],[0,200,0],[0,0,0]]);
 const mesh=generateAlphaArt(input,{...options,nextId:10});
 expect(mesh.vertices.every(v=>Number(v.id.slice(1))>=10)).toBe(true);
 expect(bindArtPoint(mesh,{x:1.5,y:1.5})).not.toBeNull();expect(bindArtPoint(mesh,{x:.5,y:.5})).toBeNull();
 for(const v of mesh.vertices)expect(v.uv).toEqual({x:v.rest.x/3,y:v.rest.y/3});
 expect(()=>generateAlphaArt(input,{...options,threshold:220})).toThrow();
});
test("ring retains its hole and separate islands never get bridging faces",()=>{
 const ring=raster([[255,255,255,255,255],[255,0,0,0,255],[255,0,0,0,255],[255,0,0,0,255],[255,255,255,255,255]]);
 const mesh=generateAlphaArt(ring,options);
 expect(bindArtPoint(mesh,{x:2.5,y:2.5})).toBeNull();expect(bindArtPoint(mesh,{x:.5,y:2.5})).not.toBeNull();
 const islands=generateAlphaArt(raster([[255,0,0,255],[255,0,0,255]]),options);
 expect(bindArtPoint(islands,{x:2,y:1})).toBeNull();
 expect(traceAlphaContours(Uint8Array.from([1,0,0,1]),2,2)).toHaveLength(2);
});
test("padding expands coverage while invalid parameters and budgets fail safely",()=>{
 const input=raster([[0,0,0],[0,255,0],[0,0,0]]);
 const mesh=generateAlphaArt(input,{...options,padding:1});
 expect(bindArtPoint(mesh,{x:.5,y:1.5})).not.toBeNull();
 expect(()=>generateAlphaArt(input,{...options,interiorSpacing:.00001})).toThrow();
 expect(()=>generateAlphaArt(input,{...options,padding:Infinity})).toThrow();
 expect(()=>generateAlphaArt(input,{...options,contourSpacing:0})).toThrow();
 expect(Array.from(input.alpha)).toEqual([0,0,0,0,255,0,0,0,0]);
});
test("contour spacing creates used boundary vertices and interior spacing adds real topology",()=>{
 const input={width:1,height:1,objectWidth:20,objectHeight:20,alpha:Uint8Array.of(255)};
 const coarse=generateAlphaArt(input,{...options,contourSpacing:10,interiorSpacing:100});
 const fine=generateAlphaArt(input,{...options,contourSpacing:2,interiorSpacing:5,simplification:.1});
 expect(fine.vertices.length).toBeGreaterThan(coarse.vertices.length);
 const used=new Set(fine.triangles.flat());
 expect(fine.vertices.every(v=>used.has(v.id))).toBe(true);
 expect(fine.vertices.some(v=>v.rest.x>0&&v.rest.x<20&&v.rest.y>0&&v.rest.y<20)).toBe(true);
});
test("circle uses local triangles, all vertices and complete interior coverage",()=>{
 const size=100,alpha=new Uint8Array(size*size);
 for(let y=0;y<size;y++)for(let x=0;x<size;x++)if(Math.hypot(x+.5-50,y+.5-50)<43)alpha[y*size+x]=255;
 const mesh=generateAlphaArt({width:size,height:size,alpha,objectWidth:size,objectHeight:size},{...options,contourSpacing:7,interiorSpacing:8,simplification:1});
 const vertices=new Map(mesh.vertices.map(v=>[v.id,v.rest])),used=new Set(mesh.triangles.flat());
 expect(used.size).toBe(mesh.vertices.length);
 let longest=0;
 for(const t of mesh.triangles){const [a,b,c]=t.map(id=>vertices.get(id)!);expect(Math.abs((b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x))).toBeGreaterThan(1e-8);for(let i=0;i<3;i++){const p=vertices.get(t[i])!,q=vertices.get(t[(i+1)%3])!;longest=Math.max(longest,Math.hypot(p.x-q.x,p.y-q.y));}}
 expect(longest).toBeLessThan(25);
 for(let y=15;y<86;y+=5)for(let x=15;x<86;x+=5)if(Math.hypot(x-50,y-50)<39)expect(bindArtPoint(mesh,{x,y})).not.toBeNull();
});
test("grid and concentric layouts use all points without contour-to-contour interior bridges",()=>{
 const size=100,alpha=new Uint8Array(size*size);
 for(let y=0;y<size;y++)for(let x=0;x<size;x++)if(Math.hypot(x+.5-50,y+.5-50)<44)alpha[y*size+x]=255;
 for(const layout of ["grid","radial"] as const){
  const mesh=generateAlphaArt({width:size,height:size,alpha,objectWidth:size,objectHeight:size},{...options,layout,contourSpacing:8,interiorSpacing:10,simplification:4});
  expect(new Set(mesh.triangles.flat()).size).toBe(mesh.vertices.length);
  const vertices=new Map(mesh.vertices.map(v=>[v.id,v.rest]));
  for(const face of mesh.triangles)for(let i=0;i<3;i++){const a=vertices.get(face[i])!,b=vertices.get(face[(i+1)%3])!;expect(Math.hypot(a.x-b.x,a.y-b.y)).toBeLessThan(30);}
  if(layout==="radial")expect(mesh.vertices.some(v=>Math.hypot(v.rest.x-50,v.rest.y-50)<1)).toBe(true);
 }
});
test("hairy alpha contour is density-controlled and high simplification backs off safely",()=>{
 const size=128,alpha=new Uint8Array(size*size);
 for(let y=10;y<118;y++)for(let x=10;x<118;x++){
  const body=x>=30&&x<=95&&y>=30&&y<=100;
  const hair=y>=10&&y<70&&x>=20&&x<108&&((x-20)%8<3);
  if(body||hair)alpha[y*size+x]=255;
 }
 const raster={width:size,height:size,alpha,objectWidth:size,objectHeight:size};
 const fine=generateAlphaArt(raster,{...options,contourSpacing:2,interiorSpacing:30,simplification:0});
 for(const simplification of [4,7,8,20]){
  const mesh=generateAlphaArt(raster,{...options,contourSpacing:20,interiorSpacing:30,simplification});
  expect(mesh.vertices.length).toBeLessThan(fine.vertices.length*.6);
  expect(new Set(mesh.triangles.flat()).size).toBe(mesh.vertices.length);
 }
});
test("both alpha layouts preserve holes with aggressive simplification",()=>{
 const size=64,alpha=new Uint8Array(size*size);
 for(let y=0;y<size;y++)for(let x=0;x<size;x++){const r=Math.hypot(x+.5-32,y+.5-32);if(r<29&&r>13)alpha[y*size+x]=255;}
 for(const layout of ["grid","radial"] as const)for(const simplification of [4,8,20]){
  const mesh=generateAlphaArt({width:size,height:size,objectWidth:size,objectHeight:size,alpha},{...options,layout,contourSpacing:8,interiorSpacing:8,simplification});
  expect(bindArtPoint(mesh,{x:32,y:32})).toBeNull();
  expect(new Set(mesh.triangles.flat()).size).toBe(mesh.vertices.length);
 }
});
test("thin alpha strip receives local refinement even when grid rows miss it",()=>{
 const width=120,height=10,alpha=new Uint8Array(width*height);
 for(let y=4;y<6;y++)for(let x=1;x<119;x++)alpha[y*width+x]=255;
 const mesh=generateAlphaArt({width,height,objectWidth:width,objectHeight:height,alpha},{...options,contourSpacing:12,interiorSpacing:10,simplification:4});
 const byId=new Map(mesh.vertices.map(v=>[v.id,v.rest]));
 for(const face of mesh.triangles)for(let i=0;i<3;i++){const p=byId.get(face[i])!,q=byId.get(face[(i+1)%3])!;expect(Math.hypot(p.x-q.x,p.y-q.y)).toBeLessThan(19);}
 expect(new Set(mesh.triangles.flat()).size).toBe(mesh.vertices.length);
});
