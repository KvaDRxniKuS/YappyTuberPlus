/**
 * Числа версии из исходников — для скриптов сборки.
 *
 * Те же числа живут в `src/version.ts`, `src/overlay/protocol.ts` и
 * `crates/rig-core/src/lib.rs`. Здесь они читаются, а не дублируются: иначе
 * `build.json` в собранной папке однажды разойдётся с редактором, и никто не
 * заметит.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

function number(pattern, text, fallback = null) {
  const match = pattern.exec(text);
  return match ? Number(match[1]) : fallback;
}

/** Паспорт текущего репозитория: релиз и поколения слоёв. */
export function readVersion(root) {
  const versionText = readFileSync(join(root, "src", "version.ts"), "utf8");
  const protocolText = readFileSync(join(root, "src", "overlay", "protocol.ts"), "utf8");
  const block = /export const VERSION: ProjectVersion = \{([\s\S]*?)\};/.exec(versionText)?.[1] ?? "";
  if (!block) throw new Error("src/version.ts: не найден объект VERSION");

  const release = /release:\s*\[(\d+),\s*(\d+)\]/.exec(block);
  if (!release) throw new Error("src/version.ts: не найден release");
  const major = Number(release[1]);
  const minor = Number(release[2]);
  const core = number(/core:\s*(\d+)/, block);
  const shell = number(/shell:\s*(\d+)/, block);
  const format = number(/export const PRESET_FORMAT\s*=\s*(\d+)/, versionText);
  const modules = number(/export const MODULE_FORMAT\s*=\s*(\d+)/, versionText);
  const bridge = number(/OVERLAY_PROTOCOL\s*=\s*(\d+)/, protocolText);
  // Диапазон совместимости ядра: по нему обновление понимает, не сломает ли
  // новая сборка уже открытую сцену.
  const coreText = readFileSync(join(root, "crates", "rig-core", "src", "lib.rs"), "utf8");
  const acceptsFrom = number(/ACCEPTS_FROM:\s*u32\s*=\s*(\d+)/, coreText, 1);
  if ([core, shell, format, modules, bridge].some((value) => value === null)) {
    throw new Error("не удалось прочитать все поколения версии");
  }

  return {
    release: [major, minor],
    core,
    format,
    bridge,
    modules,
    shell,
    /** Машинная запись: `1.1.22.4.1.1.1`. */
    version: [major, minor, core, format, bridge, modules, shell].join("."),
    /** Старейшее поколение сценариев, которое понимает это ядро. */
    acceptsFrom,
    /** Версия для установщика: `1.0.0` (MSI и NSIS принимают три числа). */
    packaging: `${major}.${minor}.0`,
  };
}
