import {test,expect} from "@playwright/test";
import {generateRegularArt,moveArtRest} from "../../src/engine/artDeformation";
import {applyArtBindings,bindArtVertices,compileArtMesh,evaluateArtMesh,readArtMesh,readArtOffsets} from "../../src/engine/artMeshRuntime";
import {drawArtMesh} from "../../src/render/mesh";
test("new schema roundtrips strictly and owns parsed data",()=>{
 const mesh=generateRegularArt(2,2,100,100);const parsed=readArtMesh(JSON.parse(JSON.stringify(mesh)));
 expect(parsed).toEqual(mesh);parsed.vertices[0].rest.x=90;expect(mesh.vertices[0].rest.x).toBe(0);
 for(const raw of [{cols:2,rows:2,points:[]},{...mesh,vertices:[mesh.vertices[0],mesh.vertices[0]]},
  {...mesh,nextId:0},{...mesh,triangles:[["v0","v1","missing"]]},
  {...mesh,triangles:[mesh.triangles[0],[...mesh.triangles[0]].reverse()]}])expect(()=>readArtMesh(raw)).toThrow();
 expect(()=>readArtOffsets({v9:{x:1,y:2}},mesh)).toThrow();
 expect(()=>readArtOffsets({v0:{x:Infinity,y:2}},mesh)).toThrow();
 expect(readArtOffsets({v0:{x:1,y:2}},mesh)).toEqual({v0:{x:1,y:2}});
});
test("geometry uses direct vertex offsets, fixed UV and explicit triangles only",()=>{
 const mesh=generateRegularArt(2,2,100,100);
 const compiled=compileArtMesh(moveArtRest(mesh,"v0",{x:-10,y:5}));
 const result=evaluateArtMesh(compiled,{v0:{x:3,y:7}});
 expect(result.targets[0]).toEqual({x:-7,y:12});expect(result.uv[0]).toEqual({x:0,y:0});
 expect(result.triangles).toEqual([0,1,3,0,3,2]);
 expect(result.uv).toBe(compiled.uv);expect(result.triangles).toBe(compiled.triangles);
 expect(evaluateArtMesh(compiled).targets[0]).toEqual({x:-10,y:5});
});
test("parent bindings are reusable across poses and preserve holes/exterior",()=>{
 const parent=compileArtMesh(generateRegularArt(2,2,100,100));
 const points=[{x:75,y:25},{x:-10,y:25}];const bindings=bindArtVertices(parent,points);
 const pose=Object.fromEntries(parent.ids.map(id=>[id,{x:10,y:20}]));
 expect(applyArtBindings(parent,evaluateArtMesh(parent,pose).targets,points,bindings)).toEqual([{x:85,y:45},points[1]]);
 expect(applyArtBindings(parent,evaluateArtMesh(parent).targets,points,bindings)).toEqual(points);
 const hole=compileArtMesh({...generateRegularArt(2,2,100,100),triangles:[]});
 expect(bindArtVertices(hole,points)).toEqual([null,null]);
});
test("unified renderer draws explicit faces and empty meshes do not draw the image",()=>{
 let draws=0;const ctx={save(){},restore(){},beginPath(){},moveTo(){},lineTo(){},closePath(){},clip(){},transform(){},drawImage(){draws++;}} as unknown as CanvasRenderingContext2D;
 const image={width:100,height:100} as CanvasImageSource;
 const mesh=generateRegularArt(2,2,100,100);
 drawArtMesh(ctx,image,compileArtMesh({...mesh,triangles:[]}));expect(draws).toBe(0);
 drawArtMesh(ctx,image,compileArtMesh(mesh),{v0:{x:10,y:5}});expect(draws).toBe(2);
});
