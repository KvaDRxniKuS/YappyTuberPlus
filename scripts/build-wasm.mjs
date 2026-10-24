import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const root = process.cwd();
const localCargo = join(homedir(), ".cargo", "bin", "cargo");
const cargo = existsSync(localCargo) ? localCargo : "cargo";
const result = spawnSync(cargo, [
  "build", "-p", "rig-core", "--release", "--target", "wasm32-unknown-unknown",
], { cwd: root, stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
mkdirSync(join(root, "public"), { recursive: true });
copyFileSync(
  join(root, "target", "wasm32-unknown-unknown", "release", "rig_core.wasm"),
  join(root, "public", "rig_core.wasm"),
);
console.log("Rust core → public/rig_core.wasm");
