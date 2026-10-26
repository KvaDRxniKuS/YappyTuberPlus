@echo off
rem ===========================================================================
rem  YappyTuberPlus - сборка приложения (.exe)
rem
rem  Двойной клик: собирает нативное приложение и установщик Windows.
rem  Результат:
rem    src-tauri\target\release\yappytuberplus.exe
rem    src-tauri\target\release\bundle\nsis\YappyTuberPlus_<версия>_x64-setup.exe
rem
rem  Параметры:
rem    --no-bundle   только .exe, без установщика (быстрая проверка)
rem    --fast        без пересборки WASM-ядра (если Rust не нужен под рукой)
rem    --no-open     не открывать папку с результатом (для сборки из скрипта)
rem    --help        справка
rem
rem  Первый запуск долгий: компилируется Rust-часть (5-20 минут).
rem  При успехе папка с результатом открывается сама, а окно закрывается:
rem  нажимать ничего не нужно. Окно остаётся открытым только при ошибке.
rem  Если чего-то не хватает, скрипт предложит запустить install-build-tools.bat.
rem ===========================================================================
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul 2>&1
title YappyTuberPlus - сборка .exe
pushd "%~dp0"

set "PF=%ProgramFiles%"
set "PF86=%ProgramFiles(x86)%"
if not defined PF86 set "PF86=%ProgramFiles%"
set "CARGO_BIN=%USERPROFILE%\.cargo\bin"
set "PATH=%CARGO_BIN%;%PF%\nodejs;%PF%\Git\cmd;%PATH%"
set "BUNDLE=1"
set "FAST=0"
set "OPEN=1"
set "EXE=src-tauri\target\release\yappytuberplus.exe"

:parse
if "%~1"=="" goto parsed
if /i "%~1"=="--no-bundle" ( set "BUNDLE=0" & shift & goto parse )
if /i "%~1"=="--fast" ( set "FAST=1" & shift & goto parse )
if /i "%~1"=="--no-open" ( set "OPEN=0" & shift & goto parse )
if /i "%~1"=="--help" goto usage
echo Неизвестный параметр: %~1
goto usage

:parsed
echo.
echo ============================================================
echo   YappyTuberPlus - сборка .exe
echo ============================================================
echo.

rem --- файл лежит в папке проекта? -------------------------------------------
if exist "package.json" goto in_project
echo ОШИБКА: рядом с этим файлом нет папки проекта (package.json).
echo.
echo Положите build-yappytuber.bat в корень папки YappyTuberPlus
echo (рядом с package.json и src-tauri) и запустите снова.
pause
popd
exit /b 1

:in_project
rem --- инструменты ------------------------------------------------------------
set "TOOLS_OK=1"
set "NODE_STATE=есть"
set "RUST_STATE=есть"
set "MSVC_STATE=есть"

where node >nul 2>&1
if not errorlevel 1 goto node_found
if exist "%PF%\nodejs\node.exe" goto node_found
set "NODE_STATE=нет"
set "TOOLS_OK=0"
:node_found

if exist "%CARGO_BIN%\cargo.exe" goto cargo_found
where cargo >nul 2>&1
if not errorlevel 1 goto cargo_found
set "RUST_STATE=нет"
set "TOOLS_OK=0"
:cargo_found

del "%TEMP%\ytp_vs.txt" >nul 2>&1
if exist "%PF86%\Microsoft Visual Studio\Installer\vswhere.exe" (
  "%PF86%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath >"%TEMP%\ytp_vs.txt" 2>nul
)
if exist "%TEMP%\ytp_vs.txt" for %%A in ("%TEMP%\ytp_vs.txt") do if not "%%~zA"=="0" goto msvc_found
set "MSVC_STATE=нет"
set "TOOLS_OK=0"
:msvc_found

echo Проверка инструментов:
echo   Node.js ........ %NODE_STATE%
echo   Rust ........... %RUST_STATE%
echo   MSVC (C++) ..... %MSVC_STATE%
echo.

if "%TOOLS_OK%"=="1" goto tools_ok
echo Собирать нечем: не хватает компонентов выше.
if not exist "install-build-tools.bat" goto tools_missing
rem Вопрос через Enter, а не через `choice`: `choice` пищит на любой «лишней»
rem клавише, а набирать Y/N вслепую неудобно.
set "ANSWER="
set /p "ANSWER=Запустить установку инструментов? [Y/n]: "
if /i "%ANSWER%"=="n" goto tools_missing
call "%~dp0install-build-tools.bat"
popd
exit /b 0
:tools_missing
echo.
echo Запустите install-build-tools.bat (двойной клик) - он поставит всё нужное.
echo Подробности: docs\BUILD.md
pause
popd
exit /b 1

:tools_ok
rem --- зависимости ------------------------------------------------------------
if not exist "node_modules" goto npm_ci
if not exist "node_modules\.package-lock.json" goto npm_ci
if not exist "node_modules\react" goto npm_ci
echo == Зависимости ==
call npm install --no-audit --no-fund --prefer-offline
if errorlevel 1 goto npm_failed
goto deps_done

:npm_ci
echo == Установка зависимостей (npm ci) ==
call npm ci --no-audit --no-fund
if errorlevel 1 (
  echo npm ci не удался - пробую npm install.
  call npm install --no-audit --no-fund
  if errorlevel 1 goto npm_failed
)
:deps_done

rem --- WASM-ядро --------------------------------------------------------------
if "%FAST%"=="1" goto wasm_done
echo == Ядро рига (wasm32) ==
if not exist "%CARGO_BIN%\rustup.exe" goto wasm_done
"%CARGO_BIN%\rustup.exe" target add wasm32-unknown-unknown >nul 2>&1
if errorlevel 1 echo Не удалось добавить wasm32 - используется public\rig_core.wasm.
:wasm_done

rem --- сборка ----------------------------------------------------------------
echo.
echo == Сборка приложения ==
echo Первый раз это долго: компилируется Rust. Не закрывайте окно.
echo.
if "%BUNDLE%"=="1" goto build_full
call npm run tauri build -- --no-bundle
goto build_done
:build_full
call npm run tauri build

:build_done
set "RESULT=%errorlevel%"
echo.
if not "%RESULT%"=="0" goto build_failed
if not exist "%EXE%" goto build_failed

set "RELEASE=%CD%\src-tauri\target\release"
echo ============================================================
echo   Готово
echo ============================================================
echo Приложение: %RELEASE%\yappytuberplus.exe
set "SETUP="
for %%F in ("%RELEASE%\bundle\nsis\*.exe") do if exist "%%~fF" set "SETUP=%%~fF"
if defined SETUP echo Установщик: %SETUP%
if not defined SETUP echo Установщик не собирался (--no-bundle) или NSIS недоступен.
echo.
echo Установщик можно отдать пользователям: Node.js и Rust им не нужны.
echo Подробности: docs\BUILD.md
echo.

rem Папку открываем сразу, без вопроса: ждать клавишу незачем, а `choice`
rem пищал на каждую «лишнюю» клавишу. Окно закрывается само.
if "%OPEN%"=="0" goto build_quiet
if defined SETUP goto open_setup
if exist "%RELEASE%" start "" explorer "%RELEASE%"
goto build_quiet
:open_setup
start "" explorer /select,"%SETUP%"
:build_quiet
popd
exit /b 0

:npm_failed
echo.
echo ОШИБКА: не удалось установить зависимости npm.
echo Проверьте интернет и запустите файл снова.
pause
popd
exit /b 1

:build_failed
echo.
echo ОШИБКА сборки. Что чаще всего мешает:
echo   - нет MSVC Build Tools: запустите install-build-tools.bat;
echo   - нет Rust или target wasm32: install-build-tools.bat -^> Rust;
echo   - занят порт 5173 или окно приложения уже открыто;
echo   - нет интернета для загрузки NSIS (тогда: build-yappytuber.bat --no-bundle).
echo.
echo Полный текст ошибки - выше в этом окне. Подробнее: docs\BUILD.md
pause
popd
exit /b 1

:usage
echo YappyTuberPlus - сборка .exe
echo.
echo   build-yappytuber.bat               приложение + установщик
echo   build-yappytuber.bat --no-bundle   только .exe
echo   build-yappytuber.bat --fast        без пересборки WASM-ядра
echo   build-yappytuber.bat --no-open     не открывать папку с результатом
echo.
echo Инструменты сборки ставит install-build-tools.bat.
echo При успехе папка с результатом открывается сама, окно закрывается.
pause
popd
exit /b 0
