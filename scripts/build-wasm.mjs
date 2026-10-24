import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const root = process.cwd();
const localCargo = join(homedir(), ".cargo", "bin", "cargo");
const cargo = existsSync(localCargo) ? localCargo : "cargo";
const artifact = join(root, "public", "rig_core.wasm");

const probe = spawnSync(cargo, ["--version"], { stdio: "ignore" });
if (probe.status !== 0) {
  // The built core is committed, so a machine without Rust can still build and
  // run the frontend. A real Rust build always takes priority when available.
  if (existsSync(artifact)) {
    console.warn("cargo не найден — используется уже собранный public/rig_core.wasm");
    process.exit(0);
  }
  console.error("cargo не найден и public/rig_core.wasm отсутствует: установите Rust");
  process.exit(1);
}

const result = spawnSync(cargo, [
  "build", "-p", "rig-core", "--release", "--target", "wasm32-unknown-unknown",
], { cwd: root, stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
mkdirSync(join(root, "public"), { recursive: true });
copyFileSync(
  join(root, "target", "wasm32-unknown-unknown", "release", "rig_core.wasm"),
  artifact,
);
console.log("Rust core → public/rig_core.wasm");
