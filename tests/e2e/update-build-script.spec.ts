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
