import {test,expect} from "@playwright/test";
import {readFileSync} from "node:fs";
import {regularGrid,resizeGrid} from "../../src/engine/mesh";
test("scene grid size controls use resizeGrid and undoable mesh action",()=>{
 const scene=readFileSync("src/components/Scene.tsx","utf8");
 const controls=scene.slice(scene.indexOf('aria-label="Столбцов сетки деформации"'),scene.indexOf('className={brush.on'));
 expect(controls).toContain('aria-label="Строк сетки деформации"');
 expect(controls).toContain('resizeGrid(meshEditing.deform, Number(event.target.value), meshEditing.deform.rows)');
 expect(controls).toContain('resizeGrid(meshEditing.deform, meshEditing.deform.cols, Number(event.target.value))');
 expect(controls.match(/actMeshTool/g)).toHaveLength(2);
});
test("rectangular grid resizing preserves a uniform deformation",()=>{
 const grid=regularGrid(3,3);grid.points=grid.points.map(p=>({x:p.x+.15,y:p.y-.2}));
 const next=resizeGrid(grid,7,4);
 expect([next.cols,next.rows,next.points.length]).toEqual([7,4,28]);
 const neutral=regularGrid(7,4);
 next.points.forEach((p,i)=>{expect(p.x-neutral.points[i].x).toBeCloseTo(.15);expect(p.y-neutral.points[i].y).toBeCloseTo(-.2);});
});
