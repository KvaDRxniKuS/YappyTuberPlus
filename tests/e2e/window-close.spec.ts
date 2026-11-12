import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/*
 * Крестик закрывает приложение.
 *
 * Повод прямой: в обработчике закрытия стояло `await main.close()`, а `close()`
 * приходит в тот же обработчик — обработчик ждал обещание, обещание ждало
 * обработчик, и окно не закрывалось совсем: программу снимали через диспетчер
 * задач. Проверяем именно то, что ломалось: ожидания `close()` в обработчике
 * нет, а главное окно уничтожается `destroy()`, который не спрашивает.
 */

test("закрытие главного окна не ждёт самого себя", () => {
  const app = readFileSync(join(process.cwd(), "src", "App.tsx"), "utf8");
  // Уничтожение вместо закрытия: destroy() не поднимает closeRequested.
  expect(app).toContain("main.destroy()");
  expect(app).not.toContain("await main.close()");
  // Дочерние окна закрываются, но обработчик их не ждёт: иначе зависшее
  // дочернее окно держало бы крестик.
  expect(app).toContain("void Promise.all([closeOverlayWindow(), closeCaptureWindow()]).finally(finish);");
  // Страховка на случай, если дочернее окно не ответило вовсе.
  expect(app).toContain("window.setTimeout(finish, 400);");
});

test("крестик завершает процесс, а не только окно", () => {
  const app = readFileSync(join(process.cwd(), "src", "App.tsx"), "utf8");
  // destroy() снимает окно, но цикл событий может остаться живым (дочерние окна,
  // зависшая страница оверлея) — процесс висел в диспетчере задач.
  expect(app).toContain('invoke("app_exit")');
  const rust = readFileSync(join(process.cwd(), "src-tauri", "src", "lib.rs"), "utf8");
  expect(rust).toContain("fn app_exit(app: tauri::AppHandle)");
  expect(rust).toContain("app.exit(0);");
  expect(rust).toContain("app_exit");
  // Без разрешения core:window:allow-destroy вызов destroy() отклоняется, а
  // ошибка глотается catch — окно оставалось на экране.
  const capability = readFileSync(
    join(process.cwd(), "src-tauri", "capabilities", "default.json"),
    "utf8",
  );
  expect(capability).toContain("core:window:allow-destroy");
});
