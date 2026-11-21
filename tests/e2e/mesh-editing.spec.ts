import { test,expect } from "@playwright/test";
import { addArtPoint,artArea,artFromGrid,defaultMesh,eraseArtStroke,meshPointsInBox,moveMeshGroup } from "../../src/engine/mesh";

test("быстрый взмах ластика не пропускает точки между событиями мыши",()=>{
  const art=addArtPoint(artFromGrid(2,2),{x:0.5,y:0.5})!;
  const before=JSON.stringify(art);
  const shown=art.points.map(p=>({x:p.x*100,y:p.y*100}));
  const next=eraseArtStroke(art,shown,{x:20,y:50},{x:80,y:50},5);
  expect(next.points).toHaveLength(4);
  expect(artArea(next)).toBeCloseTo(1,6);
  expect(JSON.stringify(art)).toBe(before);
});

test("пустой взмах не пересобирает меш",()=>{
  const art=artFromGrid(2,2);
  expect(eraseArtStroke(art,art.points,{x:20,y:20},{x:30,y:20},1)).toBe(art);
});

test("рамка Shift работает в обоих направлениях и включает границы",()=>{
  const points=[{x:0,y:0},{x:10,y:10},{x:20,y:20},{x:30,y:30}];
  expect(meshPointsInBox(points,{x:20,y:20},{x:0,y:0})).toEqual([0,1,2]);
});

test("выделенные узлы перемещаются одновременно, остальные и база не меняются",()=>{
  const mesh=defaultMesh(),before=JSON.stringify(mesh);
  const next=moveMeshGroup(mesh,[0,1],{x:0.2,y:0.3},"warp");
  expect(next.deform.points.slice(0,2)).toEqual([{x:0.2,y:0.3},{x:1.2,y:0.3}]);
  expect(next.deform.points.slice(2)).toEqual(mesh.deform.points.slice(2));
  expect(next.art).toBe(mesh.art);expect(next.deform.rest).toBe(mesh.deform.rest);
  expect(JSON.stringify(mesh)).toBe(before);
});
