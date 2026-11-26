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
