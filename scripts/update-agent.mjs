#!/usr/bin/env node
/**
 * Локальный агент обновления собранной папки.
 *
 * Зачем отдельный процесс: страница в браузере не может писать файлы. Агент
 * запускается рядом с папкой сборки (его поднимает лаунчер), скачивает новую
 * версию из репозитория, проверяет каждый файл по отпечатку из `build.json` и
 * только потом заменяет файлы на диске. Страница просит его об этом одним
 * запросом через прокси Vite (`/update`), поэтому CORS и адреса не нужны.
 *
 * Что он **не** делает: не трогает пресеты и профиль пользователя (они лежат
 * в `%APPDATA%`/`~/.local/share`), не запускает сборку, не лезет в git.
 *
 * Запуск:
 *
 * ```
 * npm run update:agent                     # папка dist рядом с проектом
 * UPDATE_FOLDER=D:\Rig\dist npm run update:agent
 * UPDATE_AGENT_PORT=17802 UPDATE_FOLDER=dist node scripts/update-agent.mjs
 * ```
 *
 * Ограничения безопасности: слушает только 127.0.0.1, принимает манифест лишь
 * с разрешённого адреса (по умолчанию — папка сборки этого репозитория), пишет
 * только те пути, что перечислены в манифесте, и только внутри папки сборки.
 */
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

const port = Number(process.env.UPDATE_AGENT_PORT || 17802);
const host = process.env.UPDATE_AGENT_HOST || "127.0.0.1";
const folder = resolve(process.env.UPDATE_FOLDER || "dist");
const REPO = "KvaDRxniKuS/YappyTuberPlus";
/** Единственный разрешённый хост: сырые файлы этого репозитория. */
const allowedHost = "raw.githubusercontent.com";
/** Паспорт разрешён с любой ветки репозитория: ветка разработки переезжает. */
const allowedPath = new RegExp(`^/${REPO}/[^/]+(/[^/]+)*/dist/build\\.json$`);
const extraManifest = process.env.UPDATE_MANIFEST || "";

/** Разрешён ли этот адрес паспорта: свой репозиторий и папка сборки. */
function allowed(url) {
  if (extraManifest && url === extraManifest) return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.host === allowedHost && allowedPath.test(parsed.pathname);
  } catch {
    return false;
  }
}
const maxBody = 64 * 1024;

const text = (res, status, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Путь из манифеста не может выйти за пределы папки сборки. */
function safePath(relative) {
  const target = resolve(folder, relative);
  if (target !== folder && !target.startsWith(folder + sep)) {
    throw new Error(`путь вне папки сборки: ${relative}`);
  }
  return target;
}

function localVersion() {
  const manifest = join(folder, "build.json");
  if (!existsSync(manifest)) return null;
  try {
    return JSON.parse(readFileSync(manifest, "utf8")).version ?? null;
  } catch {
    return null;
  }
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${url}: ответ ${response.status}`);
  const data = await response.json();
  if (!data || typeof data.version !== "string") throw new Error("в манифесте нет версии");
  return data;
}

/**
 * Скачать, проверить и заменить файлы.
 *
 * Сначала в память скачивается и проверяется всё, и только потом что-то
 * пишется: оборванная сеть или подменённый файл не должны оставить папку
 * наполовину обновлённой.
 */
async function apply(manifestUrl) {
  if (!existsSync(join(folder, "build.json"))) {
    throw new Error(`в папке ${folder} нет build.json — обновлять нечего`);
  }
  const manifest = await fetchJson(manifestUrl);
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  if (!files.length) throw new Error("в манифесте нет списка файлов");
  const base = manifestUrl.slice(0, manifestUrl.lastIndexOf("/") + 1);

  const staged = [];
  for (const file of files) {
    if (!file || typeof file.path !== "string") throw new Error("в манифесте битый список файлов");
    const target = safePath(file.path);
    const response = await fetch(`${base}${file.path}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`${file.path}: ответ ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (file.size && bytes.length !== file.size) {
      throw new Error(`${file.path}: пришло ${bytes.length} байт вместо ${file.size}`);
    }
    if (file.sha256 && sha256(bytes) !== file.sha256) {
      throw new Error(`${file.path}: файл не совпал по отпечатку`);
    }
    staged.push({ target, bytes });
  }

  // Только теперь, когда всё скачано и проверено, пишем на диск.
  for (const item of staged) {
    mkdirSync(dirname(item.target), { recursive: true });
    writeFileSync(item.target, item.bytes);
  }
  writeFileSync(join(folder, "build.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { version: manifest.version, files: staged.length };
}

const server = createServer((request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
  if (request.method === "GET" && url.pathname === "/health") {
    text(response, 200, { ok: true, folder, version: localVersion() });
    return;
  }
  if (request.method === "POST" && url.pathname === "/apply") {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBody) { text(response, 413, { ok: false, error: "слишком большой запрос" }); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on("end", () => {
      void (async () => {
        try {
          const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
          const manifestUrl = typeof body.manifest === "string" ? body.manifest : "";
          if (!allowed(manifestUrl)) {
            text(response, 403, { ok: false, error: "источник обновления не разрешён" });
            return;
          }
          const result = await apply(manifestUrl);
          console.log(`обновлено до ${result.version}: файлов ${result.files} в ${folder}`);
          text(response, 200, { ok: true, ...result });
        } catch (reason) {
          const error = reason instanceof Error ? reason.message : String(reason);
          console.log(`обновление не установлено: ${error}`);
          text(response, 500, { ok: false, error });
        }
      })();
    });
    return;
  }
  text(response, 404, { ok: false, error: "неизвестный запрос" });
});

server.listen(port, host, () => {
  const version = localVersion();
  console.log(`update agent → http://${host}:${port}/health (папка ${folder}`
    + `${version ? `, версия ${version}` : ", папка не собрана"})`);
  if (!existsSync(join(folder, "build.json"))) {
    console.log("В папке нет build.json: обновление отклонит запрос. Соберите папку — npm run build.");
  }
});
