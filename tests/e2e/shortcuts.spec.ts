import {test,expect} from "@playwright/test";
import {TOOL_SHORTCUTS,toolForCode,SHORTCUT_GROUPS} from "../../src/engine/shortcuts";

test("справочник инструментов и обработчик клавиш используют один реестр",()=>{
  const tools=SHORTCUT_GROUPS.find(group=>group.title==="Сцена")!.items;
  for(const command of TOOL_SHORTCUTS) {
    expect(toolForCode(command.code)).toBe(command.tool);
    expect(tools.some(([key,label])=>key===command.key&&label===command.label)).toBe(true);
  }
  expect(new Set(TOOL_SHORTCUTS.map(command=>command.code)).size).toBe(TOOL_SHORTCUTS.length);
  expect(toolForCode("KeyQ")).toBeUndefined();
});
