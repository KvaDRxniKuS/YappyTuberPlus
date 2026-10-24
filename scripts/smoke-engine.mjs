/**
 * Engine contract smoke test. Loads the actual Rust/WASM core in Node, so the
 * build can be verified on machines without a browser:
 *
 *   npm run test:engine
 */
import { readFileSync } from "node:fs";

const artifact = new URL("../public/rig_core.wasm", import.meta.url);
const { instance } = await WebAssembly.instantiate(readFileSync(artifact), {});
const { rig_alloc, rig_free, rig_call, memory } = instance.exports;

function call(request) {
  const input = new TextEncoder().encode(JSON.stringify(request));
  const pointer = rig_alloc(input.length);
  new Uint8Array(memory.buffer, pointer, input.length).set(input);
  const packed = rig_call(pointer, input.length);
  rig_free(pointer, input.length);
  const outPointer = Number(packed & 0xffffffffn);
  const outLength = Number((packed >> 32n) & 0xffffffffn);
  const text = new TextDecoder().decode(new Uint8Array(memory.buffer, outPointer, outLength));
  rig_free(outPointer, outLength);
  return JSON.parse(text);
}

function assert(condition, message) {
  if (!condition) {
    console.error(`✗ ${message}`);
    process.exit(1);
  }
  console.log(`✓ ${message}`);
}

const base = (x, y) => ({
  x, y, rotation: 0, sizeX: 1, sizeY: 1, skewX: 0, skewY: 0,
  opacity: 1, visible: 1, layer: 0,
});

const config = {
  canvas: { width: 1000, height: 600 },
  globals: "speed = 2\nwave = sin(time * speed)",
  objects: [
    {
      id: "head", name: "Head", kind: "sprite", image: null, parentId: null,
      pivot: { x: 0.5, y: 0.5 }, base: base(500, 300), width: 200, height: 200,
      script: "x = smooth(speak * 10, 120)\ny = wave * 5\nrotation = sin(time) * 4",
    },
    {
      id: "eye", name: "Eye", kind: "sprite", image: null, parentId: "head",
      pivot: { x: 0.5, y: 0.5 }, base: base(520, 280), width: 50, height: 50,
      script: "x = inherit + follow(offset, parent).x\ny = inherit + follow(offset, parent).y\nrotation = inherit",
    },
  ],
};

const inputs = {
  speak: 0.5, loudness: 0.4, db: -20, talking: 1,
  viseme_a: 0, viseme_e: 0, viseme_i: 0, viseme_o: 0, viseme_u: 0, signals: {},
};

const created = call({ op: "create", config });
assert(created.ok && created.handle === 1, "ядро создаёт движок из пресета");

const first = call({ op: "tick", handle: 1, now: 0.016, inputs, paused: false, resetClock: true });
assert(first.ok && first.frame.seq === 1, "первый кадр вычисляется");

let last = first;
for (let index = 2; index <= 60; index += 1) {
  last = call({ op: "tick", handle: 1, now: index / 60, inputs, paused: false, resetClock: false });
}
assert(last.frame.seq === 60, "последовательность кадров монотонна");
assert(last.frame.objects.head.y !== first.frame.objects.head.y, "глобальная переменная wave() развивается во времени");
assert(Math.abs(last.frame.objects.eye.y) > 0.5, "иерархия передаёт динамику родителя через follow()");
assert(last.frame.diagnostics.length === 0, "нет диагностических предупреждений");

const values = Object.values(last.frame.objects).flatMap((object) => Object.values(object));
assert(values.every((value) => Number.isFinite(value)), "нет NaN/Infinity в кадре");

const paused = call({ op: "tick", handle: 1, now: 2, inputs, paused: true, resetClock: false });
assert(paused.ok && paused.frame.seq === last.frame.seq, "пауза не продвигает симуляцию");

const bad = call({ op: "validate", config: { ...config, objects: [{ ...config.objects[0], id: "bad id" }] } });
assert(!bad.ok && /ID/.test(bad.error), "некорректный ID отклоняется");

const missing = call({ op: "tick", handle: 999, now: 3, inputs, paused: false, resetClock: false });
assert(!missing.ok, "обращение к удалённому движку возвращает ошибку");

// Demo mouth: two sprites, exactly one visible depending on speech.
const mouthConfig = {
  canvas: { width: 1000, height: 600 },
  globals: "",
  objects: [
    {
      id: "mouth", name: "Рот · открыт", kind: "sprite", image: null, parentId: null,
      pivot: { x: 0.5, y: 0.5 }, base: base(500, 300), width: 140, height: 70,
      script: "visible = talking > 0 or speak > 0.02 ? 1 : 0",
    },
    {
      id: "mouth_closed", name: "Рот · закрыт", kind: "sprite", image: null, parentId: null,
      pivot: { x: 0.5, y: 0.5 }, base: base(500, 300), width: 140, height: 70,
      script: "visible = talking > 0 or speak > 0.02 ? 0 : 1",
    },
  ],
};
const mouthEngine = call({ op: "create", config: mouthConfig });
const silent = call({ op: "tick", handle: mouthEngine.handle, now: 0.1, inputs: { ...inputs, talking: 0, speak: 0 }, paused: false, resetClock: true });
assert(silent.frame.objects.mouth.visible === 0 && silent.frame.objects.mouth_closed.visible === 1, "при молчании виден закрытый рот");
const speaking = call({ op: "tick", handle: mouthEngine.handle, now: 0.2, inputs: { ...inputs, talking: 1, speak: 0.4 }, paused: false, resetClock: false });
assert(speaking.frame.objects.mouth.visible === 1 && speaking.frame.objects.mouth_closed.visible === 0, "при речи виден открытый рот");
const loud = call({ op: "tick", handle: mouthEngine.handle, now: 0.3, inputs: { ...inputs, talking: 0, speak: 0.3 }, paused: false, resetClock: false });
assert(loud.frame.objects.mouth.visible === 1, "громкость без talking тоже открывает рот");
call({ op: "dispose", handle: mouthEngine.handle });

call({ op: "dispose", handle: 1 });
console.log("\nДвижок Rust/WASM работает.");
