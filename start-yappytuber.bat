@echo off
rem ===========================================================================
rem  YappyTuberPlus - zapusk
rem
rem  Двойной клик: открывает редактор в браузере. Обновление и сборку ядра
rem  делает отдельный файл update-yappytuber.bat: запуск ничего не скачивает и
rem  не собирает, поэтому он быстрый.
rem
rem  Прошлый запуск закрывается сам: порты редактора, моста и агента
rem  освобождаются перед стартом, окна искать и закрывать руками не нужно.
rem
rem    --no-open      не открывать браузер
rem    --no-bridge    не запускать мост для OBS
rem    --no-update    не поднимать локальный агент обновлений (порт 17802)
rem    --app          открыть редактор как приложение: нативное окно Tauri,
rem                   а без Rust - окно браузера без вкладок
rem    --tauri        запустить нативное окно Tauri
rem    --port 5199    другой порт редактора
rem    --dir PATH     папка проекта, если bat лежит не в нём
rem    --help         справка
rem ===========================================================================
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul 2>&1
title YappyTuberPlus - zapusk

set "OVERLAY_BRIDGE_PORT=17800"
set "UPDATE_AGENT_PORT=17802"
set "OPEN=1"
set "BRIDGE=1"
set "AGENT=1"
set "MODE=dev"
set "PORT=5173"
set "APP_DIR="

:parse
if "%~1"=="" goto parsed
set "ARG=%~1"
if /i "%ARG%"=="--no-open" ( set "OPEN=0" & goto next )
if /i "%ARG%"=="--no-bridge" ( set "BRIDGE=0" & goto next )
if /i "%ARG%"=="--bridge" ( set "BRIDGE=1" & goto next )
if /i "%ARG%"=="--no-update" ( set "AGENT=0" & goto next )
if /i "%ARG%"=="--tauri" ( set "MODE=tauri" & goto next )
if /i "%ARG%"=="--app" ( set "MODE=app" & goto next )
if /i "%ARG%"=="--help" goto usage
if /i "%ARG%"=="-h" goto usage
if /i "%ARG:~0,7%"=="--port=" ( set "PORT=%ARG:~7%" & goto next )
if /i "%ARG%"=="--port" ( shift & set "PORT=%~1" & goto next )
if /i "%ARG:~0,6%"=="--dir=" ( set "APP_DIR=%ARG:~6%" & goto next )
if /i "%ARG%"=="--dir" ( shift & set "APP_DIR=%~1" & goto next )
echo Неизвестный параметр: %ARG%
:next
shift
goto parse
:parsed

echo.
echo == YappyTuberPlus: запуск
echo.

rem --- где лежит проект ------------------------------------------------------
if defined APP_DIR goto app_dir_ready
set "APP_DIR=%~dp0"
if "%APP_DIR:~-1%"=="\" set "APP_DIR=%APP_DIR:~0,-1%"
if exist "%APP_DIR%\package.json" goto app_dir_ready
set "APP_DIR=%CD%\YappyTuberPlus"
:app_dir_ready
cd /d "%APP_DIR%"
if errorlevel 1 goto bad_dir
echo Папка проекта: %APP_DIR%

rem --- окружение -------------------------------------------------------------
call :refresh_path
where node >nul 2>&1
if errorlevel 1 goto no_node
where npm >nul 2>&1
if errorlevel 1 goto no_node
for /f "delims=" %%v in ('node -v') do echo Node.js %%v

rem --- проект подготовлен? ---------------------------------------------------
rem Запуск ничего не собирает: если зависимостей или ядра нет, их ставит и
rem собирает update-yappytuber.bat. Спрашиваем один раз, а не молча падаем.
if not exist "node_modules" goto need_update
if not exist "public\rig_core.wasm" goto need_update
goto prepared

:need_update
echo.
echo Проект ещё не подготовлен: нет node_modules или public\rig_core.wasm.
echo Это делает update-yappytuber.bat - он скачает изменения и соберёт ядро.
echo.
if not exist "%~dp0update-yappytuber.bat" goto need_update_manual
set "ANSWER="
set /p "ANSWER=Запустить обновление сейчас? [Y/n]: "
if /i "%ANSWER%"=="n" goto need_update_manual
call "%~dp0update-yappytuber.bat"
if errorlevel 1 goto fail
if not exist "node_modules" goto need_update_manual
if not exist "public\rig_core.wasm" goto need_update_manual
goto prepared

:need_update_manual
echo.
echo Сначала запустите update-yappytuber.bat, потом этот файл.
goto fail

:prepared

rem --- прошлый запуск не мешает ----------------------------------------------
rem Порт держит node.exe прошлого запуска: без этого Vite молча взял бы другой
rem порт, а мост для OBS не поднялся бы вовсе, и окна пришлось бы закрывать руками.
call :free_port %PORT%
if "%BRIDGE%"=="1" call :free_port %OVERLAY_BRIDGE_PORT%
if "%AGENT%"=="1" call :free_port %UPDATE_AGENT_PORT%

rem --- запуск ----------------------------------------------------------------
if "%BRIDGE%"=="1" start "YappyTuberPlus OBS bridge" /min cmd /c "npm run overlay:bridge"
rem Локальный агент обновлений: страница просит его заменить файлы папки сборки.
rem Без него обновление папки делается только лаунчером при следующем запуске.
if "%AGENT%"=="1" start "YappyTuberPlus update agent" /min cmd /c "npm run update:agent"
rem Нативное окно возможно только при установленном Rust: без него --app
rem откатывается на окно-приложение браузера, а потом на обычный браузер.
set "TAURI_READY=0"
where cargo >nul 2>&1
if not errorlevel 1 if exist "src-tauri" set "TAURI_READY=1"
if /i "%MODE%"=="app" if "%TAURI_READY%"=="1" goto run_app_tauri
if /i "%MODE%"=="app" set "MODE=app-browser"
if /i "%MODE%"=="tauri" if "%TAURI_READY%"=="0" set "MODE=dev"
if /i "%MODE%"=="app-browser" echo Rust/Tauri не найден - открою окно-приложение в браузере.
if /i "%MODE%"=="app-browser" goto open_app
if "%OPEN%"=="1" start "" /min cmd /c "timeout /t 4 >nul & start http://localhost:%PORT%/"
goto opened

rem Окно-приложение: тот же редактор без вкладок, адресной строки и меню.
rem Так «Захват окна» не затягивает в кадр интерфейс браузера.
:open_app
echo Окно-приложение: без вкладок и адресной строки.
if "%OPEN%"=="0" goto opened
set "CHROME="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "CHROME=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not defined CHROME if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "CHROME=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined CHROME goto open_app_fallback
start "YappyTuberPlus app" /min powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 4; Start-Process -FilePath '%CHROME%' -ArgumentList '--app=http://localhost:%PORT%/','--window-size=1280,860'"
goto opened

:open_app_fallback
echo Chrome/Edge не найден - открою редактор в обычном браузере.
start "" /min cmd /c "timeout /t 4 >nul & start http://localhost:%PORT%/"

:opened
echo.
echo Редактор:  http://localhost:%PORT%/
echo Оверлей:   http://localhost:%PORT%/overlay.html?overlay=1^&guide=1
echo Захват:    http://localhost:%PORT%/overlay.html?capture=1
echo Остановка: Ctrl+C в этом окне
echo.
if /i "%MODE%"=="tauri" goto run_tauri
call npm run dev -- --port %PORT%
goto finish

:run_app_tauri
echo Режим приложения: нативное окно Tauri.
echo Первый запуск собирает окно несколько минут, дальше запуск быстрый.

:run_tauri
call npm run tauri dev
goto finish

rem --- вспомогательное -------------------------------------------------------
:free_port
rem Освобождает порт: закрывает прошлый запуск, чтобы не искать окна руками.
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":%~1[^0-9].*LISTENING"') do (
  echo == Порт %~1 занят прошлым запуском: закрываю процесс %%p
  taskkill /f /pid %%p >nul 2>&1
)
timeout /t 1 >nul 2>&1
goto :eof

:refresh_path
rem Подхватываем PATH после установки Node.js в другом окне.
set "PATH=%PATH%;C:\Program Files\nodejs;%LOCALAPPDATA%\Programs\nodejs;%APPDATA%\npm"
goto :eof

:finish
if errorlevel 1 pause
timeout /t 2 >nul 2>&1
exit /b 0

rem --- справка и ошибки ------------------------------------------------------
:usage
echo YappyTuberPlus - запуск
echo.
echo   start-yappytuber.bat [параметры]
echo.
echo   --no-open      не открывать браузер
echo   --no-bridge    не запускать мост для OBS
echo   --no-update    без локального агента обновлений
echo   --app          открыть редактор как приложение (нативное окно Tauri,
echo                  а без Rust - окно браузера без вкладок)
echo   --tauri        запустить нативное окно Tauri
echo   --port 5199    другой порт редактора
echo   --dir PATH     папка проекта
echo.
echo Обновление и сборка ядра - отдельный файл update-yappytuber.bat.
pause
exit /b 0

:no_node
echo.
echo ОШИБКА: не найден Node.js. Установите Node.js 20 или новее: https://nodejs.org/
echo Быстрая установка окружения: install-build-tools.bat
goto fail

:bad_dir
echo.
echo ОШИБКА: не удалось перейти в %APP_DIR%
goto fail

:fail
echo.
pause
exit /b 1
