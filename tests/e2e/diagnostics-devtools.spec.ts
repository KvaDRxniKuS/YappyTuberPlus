import {test,expect} from "@playwright/test";
import {readFileSync} from "node:fs";
test("release diagnostics explicitly enables devtools and limits command to editor",()=>{
  const cargo=readFileSync("src-tauri/Cargo.toml","utf8");
  const rust=readFileSync("src-tauri/src/lib.rs","utf8");
  expect(cargo).toContain('"protocol-asset", "devtools"');
  const command=rust.slice(rust.indexOf("fn open_diagnostics_devtools("),rust.indexOf("#[cfg_attr(mobile"));
  expect(command).toContain('window.label() != "main"');
  expect(command.indexOf('return Err')).toBeLessThan(command.indexOf('window.open_devtools()'));
  expect(rust).toContain('open_diagnostics_devtools,');
});
