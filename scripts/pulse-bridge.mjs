// Мост пульсометра: отдаёт пульс приложению по WebSocket и HTTP.
//
// Зачем мост вообще: пульсомеры говорят на BLE, USB-serial или своём протоколе, а
// приложение понимает WebSocket и HTTP. Мост переводит одно в другое и живёт в
// фоне, пока идёт стрим.
//
// Запуск без аргументов — режим тренажёра: пульс плавно гуляет 60…110, удары идут
// по его частоте. Так интеграцию можно проверить без железа.
//
//   node scripts/pulse-bridge.mjs            # тренажёр, порт 17801
//   node scripts/pulse-bridge.mjs --hr 90    # ровные 90 ударов
//   node scripts/pulse-bridge.mjs --port 18000
//
// Что отдаёт:
//   ws://127.0.0.1:17801/inputs   поток {"heart_rate":72,"beat":0|1}
//   http://127.0.0.1:17801/state  тот же снимок одним ответом (для транспорта http)
//
// Зависимостей нет: сервер WebSocket собран на голом `node:http`, чтобы мост
// запускался двойным кликом без `npm install`.

import http from "node:http";
import crypto from "node:crypto";

const args = process.argv.slice(2);
function arg(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
}

const PORT = Number(arg("port", 17801));
const FIXED = arg("hr", null) === null ? null : Number(arg("hr", null));
const BEAT_MS = 120;

/** Текущее состояние: его видят и WebSocket, и HTTP. */
const state = { heart_rate: 72, beat: 0 };
const clients = new Set();

server();

function server() {
  const httpServer = http.createServer((request, response) => {
    if (request.url === "/state" || request.url === "/") {
      response.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      response.end(JSON.stringify(state));
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "нет такого адреса: есть /state и ws://…/inputs" }));
  });

  httpServer.on("upgrade", (request, socket) => {
    const key = request.headers["sec-websocket-key"];
    if (!key) {
      socket.destroy();
      return;
    }
    // Рукопожатие по RFC 6455: без него браузер и WebView не откроют сокет.
    const accept = crypto
      .createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    clients.add(socket);
    // Сразу отдаём снимок: модуль не должен ждать первого удара.
    send(socket, state);
    socket.on("data", (buffer) => onFrame(socket, buffer));
    const drop = () => clients.delete(socket);
    socket.on("close", drop);
    socket.on("error", drop);
  });

  httpServer.listen(PORT, "127.0.0.1", () => {
    console.log(`Пульс: ws://127.0.0.1:${PORT}/inputs · http://127.0.0.1:${PORT}/state`);
    if (FIXED === null) console.log("Режим тренажёра: пульс гуляет 60…110. Ctrl+C — остановить.");
    else console.log(`Ровный пульс: ${FIXED}. Ctrl+C — остановить.`);
  });

  httpServer.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(`Порт ${PORT} занят: закройте прошлый мост или запустите с --port 17802.`);
    } else {
      console.error(`Мост не запустился: ${error.message}`);
    }
    process.exit(1);
  });

  tick();
}

/**
 * Разбор кадров клиента. Нужен минимум: закрытие и пинг. Данные от приложения
 * (подписка) нам не нужны — поток один и тот же для всех.
 */
function onFrame(socket, buffer) {
  const opcode = buffer[0] & 0x0f;
  if (opcode === 0x8) {
    socket.end();
    clients.delete(socket);
    return;
  }
  if (opcode === 0x9) {
    // Пинг: отвечаем пустым понгом, иначе браузер закроет соединение.
    socket.write(Buffer.from([0x8a, 0x00]));
  }
}

/** Отправка текстового кадра: серверные кадры не маскируются. */
function send(socket, payload) {
  const data = Buffer.from(JSON.stringify(payload), "utf8");
  const header = data.length < 126
    ? Buffer.from([0x81, data.length])
    : Buffer.from([0x81, 126, data.length >> 8, data.length & 0xff]);
  try {
    socket.write(Buffer.concat([header, data]));
  } catch {
    clients.delete(socket);
  }
}

/** Один удар: сердце бьётся — флаг 1, через мгновение снова 0. */
function tick() {
  state.heart_rate = FIXED === null
    // Медленное блуждание вместо случайных скачков: на графике видно волну.
    ? Math.round(85 + 25 * Math.sin(Date.now() / 20000))
    : FIXED;
  state.beat = 1;
  broadcast();
  setTimeout(() => {
    state.beat = 0;
    broadcast();
  }, BEAT_MS);
  // Следующий удар — по текущей частоте.
  setTimeout(tick, Math.max(300, Math.round(60000 / Math.max(30, state.heart_rate))));
}

function broadcast() {
  for (const socket of clients) send(socket, state);
}
