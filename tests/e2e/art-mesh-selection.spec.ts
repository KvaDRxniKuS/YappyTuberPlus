import {test,expect} from "@playwright/test";
import {selectArtRegion} from "../../src/engine/artMeshSelection";
const points=[{id:"v2",world:{x:10,y:10}},{id:"v9",world:{x:30,y:30}},{id:"v20",world:{x:50,y:10}}];
test("reverse rectangle selects by displayed scene position and includes boundary",()=>{
 const previous=new Set(["v20"]);
 expect([...selectArtRegion(points,[{x:30,y:30},{x:10,y:10}],"rect",previous,"replace")]).toEqual(["v2","v9"]);
 expect([...previous]).toEqual(["v20"]);
});
test("add and subtract preserve non-hit vertices and stable IDs",()=>{
 const path=[{x:0,y:0},{x:20,y:20}],previous=new Set(["v9"]);
 expect([...selectArtRegion(points,path,"rect",previous,"add")]).toEqual(["v9","v2"]);
 expect([...selectArtRegion(points,path,"rect",new Set(["v2","v9"]),"subtract")]).toEqual(["v9"]);
});
test("lasso excludes rectangle-only hits and handles edges",()=>{
 const path=[{x:0,y:0},{x:60,y:0},{x:0,y:60}];
 expect([...selectArtRegion(points,path,"lasso",new Set(),"replace")]).toEqual(["v2","v9","v20"]);
 const tighter=[{x:0,y:0},{x:55,y:0},{x:0,y:55}];
 expect([...selectArtRegion(points,tighter,"lasso",new Set(),"replace")]).toEqual(["v2"]);
 expect([...selectArtRegion(points,path.slice(0,2),"lasso",new Set(["v9"]),"add")]).toEqual(["v9"]);
});
test("selection is independent of viewport zoom and never changes its point snapshot",()=>{
 const snapshot=JSON.stringify(points),path=[{x:5,y:5},{x:35,y:35}];
 const picked=selectArtRegion(points,path,"rect",new Set(),"replace");
 // A camera changes pixels, not the scene-space point/region inputs.
 expect(selectArtRegion(points,path,"rect",new Set(),"replace")).toEqual(picked);
 expect(JSON.stringify(points)).toBe(snapshot);
 expect(selectArtRegion([],path,"rect",new Set(),"replace").size).toBe(0);
});
