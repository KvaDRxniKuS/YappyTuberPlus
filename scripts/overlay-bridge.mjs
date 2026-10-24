import { WebSocketServer } from "ws";

/**
 * Local overlay bridge for OBS Browser Source.
 *
 * The editor page and the overlay page exchange messages over BroadcastChannel
 * inside one browser process. OBS runs in its own process, so it cannot see
 * those messages. This tiny relay forwards messages between every connected
 * WebSocket client; the app uses it only through the same-origin
 * `/overlay-ws` proxy that Vite provides.
 *
 * The bridge only relays opaque JSON. It never computes rig state, so the
 * single-driver rule (DESIGN §13.3) is preserved: exactly one editor publishes
 * frames.
 *
 * Usage: npm run overlay:bridge   (defaults to 127.0.0.1:17800)
 */

const port = Number(process.env.OVERLAY_BRIDGE_PORT || 17800);
const host = process.env.OVERLAY_BRIDGE_HOST || "0.0.0.0";

const server = new WebSocketServer({ port, host, path: "/overlay-ws" });
const clients = new Set();

server.on("connection", (socket) => {
  clients.add(socket);
  socket.send(JSON.stringify({ t: "bridge", sender: "bridge", status: "ready" }));
  socket.on("message", (data, isBinary) => {
    if (isBinary) return;
    const text = data.toString();
    for (const peer of clients) {
      if (peer !== socket && peer.readyState === 1) peer.send(text);
    }
  });
  socket.on("close", () => clients.delete(socket));
  socket.on("error", () => clients.delete(socket));
});

server.on("listening", () => {
  console.log(`overlay bridge → ws://${host}:${port}/overlay-ws (Vite proxy: /overlay-ws)`);
});

server.on("error", (error) => {
  console.error(`overlay bridge failed: ${error.message}`);
  process.exitCode = 1;
});

const shutdown = () => {
  for (const socket of clients) socket.close();
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
