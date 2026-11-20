import { readFileSync } from "node:fs";
const wasm = await WebAssembly.instantiate(readFileSync("public/rig_core.wasm"), {});
const ex = wasm.instance.exports;
const enc = new TextEncoder(), dec = new TextDecoder();
function call(request) {
  const input = enc.encode(JSON.stringify(request));
  const ptr = ex.rig_alloc(input.length);
  new Uint8Array(ex.memory.buffer, ptr, input.length).set(input);
  let packed;
  try { packed = ex.rig_call(ptr, input.length); } finally { ex.rig_free(ptr, input.length); }
  const p = Number(packed & 0xffffffffn), l = Number((packed >> 32n) & 0xffffffffn);
  return JSON.parse(dec.decode(new Uint8Array(ex.memory.buffer, p, l)));
}
const base = { x: 400, y: 300, rotation: 0, sizeX: 1, sizeY: 1, skewX: 0, skewY: 0, opacity: 1, visible: 1, layer: 0 };
const mk = (script, watch = []) => ({ id: "o1", name: "o", kind: "sprite", enabled: true, image: null, parentId: null,
  pivot: { x: 0.5, y: 0.5 }, base, script, width: 100, height: 100, watch });
for (const [label, script, watch] of [
  ["своя переменная", "foo = 2\nx = foo\n", []],
  ["зеркало", "x_states = 0\nstates_x = x_states\nx = inherit + x_states\n", ["states_x"]],
  ["канал без своего", "x_states = 10\nx = x_states\n", ["x_states"]],
]) {
  const created = call({ op: "create", config: { canvas: { width: 960, height: 540 }, globals: "", objects: [mk(script, watch)], constants: [] } });
  console.log(label, "→ create:", JSON.stringify(created).slice(0, 140));
  if (!created.ok) continue;
  call({ op: "updateBase", handle: created.handle, bases: [{ id: "o1", base }] });
  const tick = call({ op: "tick", handle: created.handle, now: 1, inputs: { values: { "manual.value": 0.5 }, signals: {} }, paused: false, resetClock: true });
  console.log("   кадр:", JSON.stringify(tick.frame?.objects?.o1?.x), "vars:", JSON.stringify(tick.frame?.vars), "diag:", JSON.stringify(tick.frame?.diagnostics));
}
