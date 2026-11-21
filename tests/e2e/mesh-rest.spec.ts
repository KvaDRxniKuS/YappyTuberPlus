import { expect, test } from "@playwright/test";
import { defaultMesh, editGridRest, meshVertices, normalizeGrid, regularGrid, resizeGrid, sampleDeform, shiftNode } from "../../src/engine/mesh";

test("точки вне деформера не прижимаются к его границе", () => {
  const grid = shiftNode(regularGrid(2,2),3,0.4,0.2);
  for (const p of [{x:-0.2,y:0.5},{x:1.2,y:0.7},{x:0.5,y:2}]) expect(sampleDeform(grid,p.x,p.y)).toEqual(p);
});

test("Ctrl меняет базовые узлы без деформации нарезки", () => {
  const mesh = defaultMesh();
  mesh.art.points.push({x:0.4,y:0.4},{x:-0.2,y:0.5},{x:1.2,y:0.5});
  mesh.deform = editGridRest(mesh.deform,(p,i) => i === 3 ? {x:p.x+0.4,y:p.y+0.2} : p);
  const vertices = meshVertices(mesh);
  vertices.params.forEach((p,i) => {
    expect(vertices.targets[i].x).toBeCloseTo(p.x,5);
    expect(vertices.targets[i].y).toBeCloseTo(p.y,5);
  });
  expect(normalizeGrid(JSON.parse(JSON.stringify(mesh.deform)))).toEqual(mesh.deform);
});

test("поворот базы сохраняет картинку и новую область воздействия", () => {
  const rest = editGridRest(regularGrid(2,2),p => ({x:1-p.y,y:p.x}));
  const deformed = shiftNode(rest,0,0.2,0);
  expect(sampleDeform(rest,0.25,0.6).x).toBeCloseTo(0.25,5);
  expect(sampleDeform(rest,0.25,0.6).y).toBeCloseTo(0.6,5);
  expect(sampleDeform(deformed,1,0).x).toBeCloseTo(1.2,5);
  expect(resizeGrid(rest,3,3).rest).toHaveLength(9);
});

test("Ctrl за угол меняет размер всей базы, а не тянет меш", async () => {
  const { resizeRestControl } = await import("../../src/engine/mesh");
  const grid = resizeRestControl(regularGrid(3,3),8,{x:1,y:0.5});
  expect(grid.rest![4]).toEqual({x:1,y:0.75});
  expect(grid.points).toEqual(grid.rest);
  expect(sampleDeform(grid,0.4,0.6)).toEqual({x:0.4,y:0.6});
});

test("базовая правка не записывается как деформация ключа", async () => {
  const { gridRecordDelta } = await import("../../src/engine/states");
  const grid = regularGrid(2,2);
  const next = editGridRest(grid,p => ({x:p.x*2,y:p.y}));
  expect(gridRecordDelta(grid,grid,next)).toBeNull();
});

test("инструмент нарезки переводит показанную точку обратно в исходную", async () => {
  const { inverseDeform } = await import("../../src/engine/mesh");
  const grid = shiftNode(regularGrid(2,2),3,0.2,0.1);
  const shown = sampleDeform(grid,0.4,0.5);
  const source = inverseDeform(grid,shown);
  expect(source.x).toBeCloseTo(0.4,4);
  expect(source.y).toBeCloseTo(0.5,4);
});
