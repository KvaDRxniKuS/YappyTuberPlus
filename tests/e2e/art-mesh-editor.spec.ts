import {test,expect} from "@playwright/test";
import {generateRegularArt} from "../../src/engine/artDeformation";
import {artEditorPoint,editArtVertex} from "../../src/render/artMeshEditor";
import {createDemoPreset} from "../../src/data/demoPreset";
import {readFileSync} from "node:fs";
test("base edits preserve UV/relative poses; pose edits preserve base and topology",()=>{
 const mesh=generateRegularArt(2,2,100,100),pose={v0:{x:4,y:7}};
 const rest=editArtVertex(mesh,pose,"v0",{x:20,y:30},{x:25,y:28},"rest");
 expect(rest.mesh.vertices[0].rest).toEqual({x:5,y:-2});expect(rest.mesh.vertices[0].uv).toEqual({x:0,y:0});
 expect(rest.pose).toBe(pose);
 const moved=editArtVertex(mesh,pose,"v0",{x:20,y:30},{x:25,y:28},"pose");
 expect(moved.mesh).toBe(mesh);expect(moved.pose.v0).toEqual({x:9,y:5});expect(pose.v0).toEqual({x:4,y:7});
});
test("pointer coordinates respect object pivot and camera-space transform",()=>{
 const object={...createDemoPreset().objects[0],width:100,height:80,pivot:{x:.5,y:.5}};
 expect(artEditorPoint(object,{x:40,y:60},{a:2,b:0,c:0,d:2,e:20,f:40})).toEqual({x:60,y:50});
});
test("generator is draft-only until explicit apply and exposes preview counts",()=>{
 const source=readFileSync("src/components/ArtMeshGenerator.tsx","utf8");
 expect(source).toContain('aria-label="Предпросмотр сетки"');
 expect(source).toContain('onApply(mesh)');expect(source).toContain('disabled={!mesh}');
 expect(source).toContain('onClick={onClose}');
});
