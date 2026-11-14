import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  declarationAt, localNames, planRename, renameBehaviour, renameBehaviourChange,
  renameGlobalInObjects, renameInScript, renameSpans,
} from "../../src/engine/rename";
import type { RigObject } from "../../src/types";

/**
 * Переименование переменной.
 *
 * Переменная объявляется присваиванием, поэтому имя живёт сразу в нескольких
 * местах: в объявлении, в формулах, в `state.имя` и снимком в настройках
 * поведения. Правка объявления должна обновить остальные — иначе вчерашняя
 * формула молча читает ноль.
 */

const SCRIPT = `eye_target = 1
x = eye_target + state.eye_target
face.eye_target = 2
text = "eye_target"
// eye_target в комментарии
eye_target(3)
`;

test("своя переменная — это имя слева вне блока события", () => {
  const script = `eye_target = 1
x = eye_target + 1
counter = counter + 1
on start {
  inner = 5
}
event speak (loud = mic.loudness ; 5000) { mic.talking > 0.2 }
on speak {
  loud = loud * 2
}
`;
  // Параметр объекта (`x`), переменные события (`inner`, `loud`) — не свои.
  expect(localNames(script)).toEqual(["eye_target", "counter"]);
  // Повтор объявления не дублирует имя.
  expect(localNames("mood = 1\nmood = 2\n")).toEqual(["mood"]);
  // Имя, занятое языком, переменной не считается.
  expect(localNames("time = 5\nstate = 1\n")).toEqual([]);
});

test("замена не трогает строки, комментарии, поля и вызовы", () => {
  const spans = renameSpans(SCRIPT, "eye_target");
  // Объявление, чтение, `state.eye_target` — три. Поле `face.eye_target`,
  // строка, комментарий и вызов остаются как есть.
  expect(spans.length).toBe(3);
  const renamed = renameInScript(SCRIPT, "eye_target", "gaze");
  expect(renamed.count).toBe(3);
  expect(renamed.text).toContain("gaze = 1");
  expect(renamed.text).toContain("x = gaze + state.gaze");
  expect(renamed.text).toContain("face.eye_target = 2");
  expect(renamed.text).toContain('text = "eye_target"');
  expect(renamed.text).toContain("// eye_target в комментарии");
  expect(renamed.text).toContain("eye_target(3)");
});

test("имя события и имя переменной не путаются", () => {
  const script = `event clap() { mouse.left.up }
on clap {
  x = 1
}
`;
  // `event clap` и `on clap` — событие; переменной с таким именем тут нет.
  expect(renameSpans(script, "clap")).toEqual([]);
  expect(renameInScript(script, "clap", "clap2").count).toBe(0);
});

test("переменная события не переименовывается вместе с переменной объекта", () => {
  const script = `loud = 1
x = loud
event speak (loud = mic.loudness ; 5000) { loud > 0.2 }
on speak {
  mouth.open = loud > 0.5
}
`;
  const renamed = renameInScript(script, "loud", "voice");
  // Объявление и чтение сверху — да; параметр события, его условие и тело — нет.
  expect(renamed.count).toBe(2);
  expect(renamed.text).toContain("voice = 1");
  expect(renamed.text).toContain("x = voice");
  expect(renamed.text).toContain("event speak (loud = mic.loudness ; 5000) { loud > 0.2 }");
  expect(renamed.text).toContain("mouth.open = loud > 0.5");
});

test("в чужое имя не переименовать: занятое языком остаётся как есть", () => {
  expect(renameInScript("mood = 1\nx = mood\n", "mood", "x").count).toBe(0);
  expect(renameInScript("mood = 1\nx = mood\n", "mood", "time").count).toBe(0);
  expect(renameInScript("mood = 1\nx = mood\n", "mood", "не имя").count).toBe(0);
  // То же имя — не замена.
  expect(renameInScript("mood = 1\nx = mood\n", "mood", "mood").count).toBe(0);
});

test("объявление узнаётся по позиции: только слева от «=» и только вне блоков", () => {
  const script = "eye_target = 1\non start {\n  mood = 2\n}\n";
  const decl = declarationAt(script, 3);
  expect(decl?.name).toBe("eye_target");
  expect(decl?.from).toBe(0);
  expect(decl?.to).toBe(10);
  // Каретка сразу за именем — это тоже его правка.
  expect(declarationAt(script, 10)?.name).toBe("eye_target");
  // Справа от `=`, в формуле, в блоке события — не объявление.
  expect(declarationAt(script, 14)).toBeNull();
  expect(declarationAt(script, 30)).toBeNull();
  // Параметр объекта объявлением не считается: своя переменная им не станет.
  expect(declarationAt("x = 1\n", 0)).toBeNull();
});

test("имя набирается по буквам: последовательность продолжается, начало не теряется", () => {
  const before = "eye_target = 1\nx = eye_target\n";
  // Стёр имя целиком и напечатал одну букву — замена началась.
  const first = planRename(before, "g = 1\nx = eye_target\n", { fromA: 0, toA: 10, insert: "g" }, null);
  expect(first?.current).toBe("eye_target");
  expect(first?.next).toBe("g");
  expect(first?.changes.length).toBe(1);
  expect(first?.pending).toEqual({ from: "eye_target", to: "g", line: 0 });
  // Следующая буква продолжает то же переименование: имя уже стоит в тексте.
  const second = planRename(
    "g = 1\nx = g\n", "ga = 1\nx = g\n", { fromA: 1, toA: 1, insert: "a" }, first!.pending,
  );
  expect(second?.current).toBe("g");
  expect(second?.next).toBe("ga");
  // Начало последовательности не съезжает: объекты переименовываются с исходного имени.
  expect(second?.pending.from).toBe("eye_target");
  expect(second?.changes).toEqual([{ from: 11, to: 12, insert: "ga" }]);
});

test("набор нового объявления с нуля ничего не переименовывает", () => {
  // Печатаем новую строку: `moo` → `mood`, это вставки в конец имени.
  expect(planRename("moo = 1\nx = 1\n", "mood = 1\nx = 1\n", { fromA: 3, toA: 3, insert: "d" }, null)).toBeNull();
  // Правка в формуле — не объявление.
  expect(planRename("mood = 1\nx = mo\n", "mood = 1\nx = moo\n", { fromA: 11, toA: 11, insert: "o" }, null)).toBeNull();
  // Стирание до пустого имени: последовательность жива, но менять пока не на что.
  const empty = planRename("mood = 1\nx = mood\n", "= 1\nx = mood\n", { fromA: 0, toA: 4, insert: "" }, null);
  expect(empty?.changes).toEqual([]);
  expect(empty?.pending).toEqual({ from: "mood", to: "", line: 0 });
  // Занятое языком имя тоже не заменяется — но последовательность продолжается.
  const reserved = planRename("mood = 1\nx = mood\n", "time = 1\nx = mood\n", { fromA: 0, toA: 4, insert: "time" }, null);
  expect(reserved?.changes).toEqual([]);
  expect(reserved?.pending.from).toBe("mood");
});

test("ссылка в настройках поведения правится вместе с именем", () => {
  const script = '// @behaviour {"visibility":[{"kind":"state","name":"mood"},{"kind":"signal","name":"mood"}]}\n'
    + "x = 1\n";
  const next = renameBehaviour(script, "mood", "humor");
  expect(next).toContain('"kind":"state","name":"humor"');
  // Сигнал — другое имя с тем же написанием: его не трогаем.
  expect(next).toContain('"kind":"signal","name":"mood"');
  // Строка блока остаётся разбираемой.
  const line = next.split("\n")[0].slice("// @behaviour ".length);
  expect(JSON.parse(line).visibility.length).toBe(2);
  // Правка отдельным изменением нужна редактору: позиции строки в скрипте.
  const change = renameBehaviourChange(script, "mood", "humor");
  expect(change).not.toBeNull();
  expect(script.slice(change!.from, change!.to)).toContain("@behaviour");
});

test("глобальная переменная обновляется во всех объектах, кроме своих тёзок", () => {
  const objects: RigObject[] = [
    { id: "face", script: "x = mood * 2\n" } as RigObject,
    { id: "eyes", script: 'mood = 1\nx = mood\n' } as RigObject,
    { id: "body", script: '// @behaviour {"visibility":[{"kind":"state","name":"mood"}]}\n' } as RigObject,
    { id: "tail", script: "x = 1\n" } as RigObject,
  ];
  const { objects: next, report } = renameGlobalInObjects(objects, "mood", "humor");
  const byId = new Map(next.map((object) => [object.id, object.script]));
  expect(byId.get("face")).toBe("x = humor * 2\n");
  // Здесь своя переменная `mood` — объект пропущен целиком.
  expect(byId.get("eyes")).toBe("mood = 1\nx = mood\n");
  expect(byId.get("body")).toContain('"name":"humor"');
  expect(byId.get("tail")).toBe("x = 1\n");
  expect(report.objects).toBe(2);
  expect(report.skipped).toEqual(["eyes"]);
  // Битое новое имя — ни одного изменения.
  expect(renameGlobalInObjects(objects, "mood", "1x").report).toEqual({ objects: 0, skipped: [] });
});

test("редактор переименовывает по правке объявления, приложение — в объектах", () => {
  const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
  const editor = read("src/components/ScriptEditor.tsx");
  // Правка объявления распознаётся и продолжается по буквам.
  expect(editor).toContain("planRename");
  expect(editor).toContain("RenameTyping");
  expect(editor).toContain("renameDeclaration");
  // Блок поведения в том же скрипте — отдельным изменением.
  expect(editor).toContain("renameBehaviourChange");
  // Глобальная переменная уходит в объекты через приложение.
  expect(editor).toContain("onRenameGlobal");
  expect(editor).toContain("flushGlobalRename");
  const app = read("src/App.tsx");
  expect(app).toContain("renameGlobalInObjects");
  expect(app).toContain("onRenameGlobal={renameGlobalVariable}");
  const panel = read("src/components/RightPanel.tsx");
  expect(panel).toContain("onRenameGlobal={props.onRenameGlobal}");
  // Отчёт под редактором: пропуск не должен выглядеть молчанием.
  expect(editor).toContain("script-rename-note");
});
