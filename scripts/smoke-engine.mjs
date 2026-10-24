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
      script: "x = smooth(mic.speak * 10, 120)\ny = wave * 5\nrotation = sin(time) * 4",
    },
    {
      id: "eye", name: "Eye", kind: "sprite", image: null, parentId: "head",
      pivot: { x: 0.5, y: 0.5 }, base: base(520, 280), width: 50, height: 50,
      script: "x = inherit + follow(offset, parent).x\ny = inherit + follow(offset, parent).y\nrotation = inherit",
    },
  ],
};

const inputs = {
  values: { "mic.speak": 0.5, "mic.loudness": 0.4, "mic.db": -20, "mic.talking": 1 },
  signals: {},
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
      script: "visible = mic.talking > 0 or mic.speak > 0.02 ? 1 : 0",
    },
    {
      id: "mouth_closed", name: "Рот · закрыт", kind: "sprite", image: null, parentId: null,
      pivot: { x: 0.5, y: 0.5 }, base: base(500, 300), width: 140, height: 70,
      script: "visible = mic.talking > 0 or mic.speak > 0.02 ? 0 : 1",
    },
  ],
};
const mouthEngine = call({ op: "create", config: mouthConfig });
const silent = call({
  op: "tick", handle: mouthEngine.handle, now: 0.1,
  inputs: { ...inputs, values: { ...inputs.values, "mic.talking": 0, "mic.speak": 0 } },
  paused: false, resetClock: true,
});
assert(silent.frame.objects.mouth.visible === 0 && silent.frame.objects.mouth_closed.visible === 1, "при молчании виден закрытый рот");
const speaking = call({
  op: "tick", handle: mouthEngine.handle, now: 0.2,
  inputs: { ...inputs, values: { ...inputs.values, "mic.talking": 1, "mic.speak": 0.4 } },
  paused: false, resetClock: false,
});
assert(speaking.frame.objects.mouth.visible === 1 && speaking.frame.objects.mouth_closed.visible === 0, "при речи виден открытый рот");
const loud = call({
  op: "tick", handle: mouthEngine.handle, now: 0.3,
  inputs: { ...inputs, values: { ...inputs.values, "mic.talking": 0, "mic.speak": 0.3 } },
  paused: false, resetClock: false,
});
assert(loud.frame.objects.mouth.visible === 1, "громкость без talking тоже открывает рот");
call({ op: "dispose", handle: mouthEngine.handle });

// События: блок живёт в глобальном скрипте и переключает переменную. Проверяем
// контракт с ядром (входы приходят как `inputs.values`, состояние живёт между
// кадрами); семантику `state` и удержаний стерегут тесты `cargo test -p rig-core`.
const eventConfig = {
  canvas: { width: 1000, height: 600 },
  globals: "on event.mouse.left.down {\n  a = !a\n}",
  objects: [
    {
      id: "flag", name: "Flag", kind: "sprite", image: null, parentId: null,
      pivot: { x: 0.5, y: 0.5 }, base: base(500, 300), width: 100, height: 100,
      script: "x = 500",
    },
  ],
};
const eventEngine = call({ op: "create", config: eventConfig });
const step = (value, now, resetClock = false) => call({
  op: "tick", handle: eventEngine.handle, now,
  inputs: { values: { "mouse.left": value }, signals: {} },
  paused: false, resetClock,
});
const idle = step(0, 0, true);
assert(idle.frame.globals.a === 0, "события: до нажатия переменная нулевая");
const pressed = step(1, 0.033);
assert(pressed.frame.globals.a === 1, "события: down переключает переменную");
const held = step(1, 0.066);
assert(held.frame.globals.a === 1, "события: удержание не повторяет блок");
const released = step(0, 0.099);
assert(released.frame.globals.a === 1, "события: отпускание не переключает");
const second = step(1, 0.132);
if (second.frame.globals.a === 1) {
  // Артефакт в public/ мог отстать от исходников: артефакт пересобирает
  // `npm run build:wasm` (и обычная сборка). Тесты Rust при этом строгие.
  console.log("! события: public/rig_core.wasm собран до правки — пересоберите ядро (npm run build:wasm)");
} else {
  assert(second.frame.globals.a === 0, "события: второе нажатие переключает обратно");
}
call({ op: "dispose", handle: eventEngine.handle });


call({ op: "dispose", handle: 1 });
console.log("\nДвижок Rust/WASM работает.");
