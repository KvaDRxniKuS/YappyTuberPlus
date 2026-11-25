import {test,expect} from "@playwright/test";
import {readFileSync} from "node:fs";
test("combined Windows launcher stops on update failure and preserves build exit code",()=>{
  const script=readFileSync("app-update-build.bat","utf8").replaceAll("\r","");
  expect(script).toContain('call "%~dp0app-update.bat" --strict --no-wasm\nif errorlevel 1 goto update_failed');
  expect(script).toContain('call "%~dp0app-build.bat" %*\nset "RESULT=%ERRORLEVEL%"\npopd\nexit /b %RESULT%');
  const update=readFileSync("app-update.bat","utf8");
  expect(update).toContain('if "%STRICT%"=="1" goto npm_failed');
  expect(update).toContain('if "%STRICT%"=="1" goto fail');
});

test("native build closes running application before compilation and aborts on failure",()=>{
  const script=readFileSync("app-build.bat","utf8");
  const stop=script.indexOf("Stop-Process -Id $app.Id -Force -ErrorAction Stop");
  expect(stop).toBeGreaterThan(0);
  expect(stop).toBeLessThan(script.indexOf("call npm run tauri build"));
  expect(script).toContain("$app.WaitForExit()");
  expect(script).toContain("if errorlevel 1 goto close_failed");
});
