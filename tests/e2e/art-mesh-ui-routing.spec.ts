import {test,expect} from "@playwright/test";
import {readFileSync} from "node:fs";
import {TOOL_SHORTCUTS} from "../../src/engine/shortcuts";
test("scene and inspector no longer expose legacy grid authoring or clipboard",()=>{
 const scene=readFileSync("src/components/Scene.tsx","utf8"),inspector=readFileSync("src/components/Inspector.tsx","utf8");
 for(const old of ["drawMeshOverlay","meshBrush","meshNode","quietMeshTool","actMeshTool","gridRotationHandle","meshClipboard","onWarp:","onMesh:"])expect(scene).not.toContain(old);
 for(const old of ["meshClipboard","resizeGrid","resetGrid","Гнуть картинку сеткой","СЕТКА ${mesh.deform.cols}"])expect(inspector).not.toContain(old);
 expect(scene).toContain('if(current.tool==="warp"||current.tool==="deform")return;');
 expect(scene).toContain("<ArtMeshGenerator");expect(inspector).toContain("НЕТ СЕТКИ");
 expect(TOOL_SHORTCUTS.find(t=>t.code==="KeyT")?.label).toBe("Деформация артмеша");
});
