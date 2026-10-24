@echo off
rem ===========================================================================
rem  YappyTuberPlus - obnovlenie i zapusk
rem
rem  Двойной клик: скачивает последние изменения, ставит зависимости, собирает
rem  WASM-ядро при наличии Rust и открывает редактор в браузере.
rem
rem    --no-open      не открывать браузер
rem    --no-bridge    не запускать мост для OBS
rem    --no-serve     только обновить и собрать
rem    --tauri        запустить нативное окно Tauri
rem    --port 5199    другой порт редактора
rem    --branch NAME  другая ветка
rem    --dir PATH     папка проекта, если bat лежит не в нём
rem    --help         справка
rem ===========================================================================
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul 2>&1
title YappyTuberPlus - obnovlenie i zapusk

set "REPO_URL=https://github.com/KvaDRxniKuS/YappyTuberPlus.git"
set "BRANCH=arena/e287965b-yappytuberplus"
set "FALLBACK_BRANCH=main"
set "OPEN=1"
set "BRIDGE=1"
set "SERVE=1"
set "MODE=dev"
set "PORT=5173"
set "APP_DIR="

:parse
if "%~1"=="" goto parsed
set "ARG=%~1"
if /i "%ARG%"=="--no-open" ( set "OPEN=0" & goto next )
if /i "%ARG%"=="--no-bridge" ( set "BRIDGE=0" & goto next )
if /i "%ARG%"=="--bridge" ( set "BRIDGE=1" & goto next )
if /i "%ARG%"=="--no-serve" ( set "SERVE=0" & goto next )
if /i "%ARG%"=="--tauri" ( set "MODE=tauri" & goto next )
if /i "%ARG%"=="--help" goto usage
if /i "%ARG:~0,9%"=="--branch=" ( set "BRANCH=%ARG:~9%" & goto next )
if /i "%ARG%"=="--branch" ( shift & set "BRANCH=%~1" & goto next )
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
echo == YappyTuberPlus: обновление и запуск
echo.

rem --- где лежит проект ------------------------------------------------------
if defined APP_DIR goto app_dir_ready
set "APP_DIR=%~dp0"
if "%APP_DIR:~-1%"=="\" set "APP_DIR=%APP_DIR:~0,-1%"
if exist "%APP_DIR%\.git" goto app_dir_ready
if exist "%APP_DIR%\package.json" goto app_dir_ready
set "APP_DIR=%CD%\YappyTuberPlus"
:app_dir_ready
echo Папка проекта: %APP_DIR%

rem --- окружение -------------------------------------------------------------
call :refresh_path
where git >nul 2>&1
if errorlevel 1 call :install_tool git
where node >nul 2>&1
if errorlevel 1 call :install_tool node
call :refresh_path
where git >nul 2>&1
if errorlevel 1 goto no_git
where node >nul 2>&1
if errorlevel 1 goto no_node
where npm >nul 2>&1
if errorlevel 1 goto no_node
for /f "delims=" %%v in ('node -v') do echo Node.js %%v
node -e "process.exit(process.versions.node.split('.')[0]>=20?0:1)" >nul 2>&1
if errorlevel 1 echo ** Node.js старше 20 - сборка может не пройти.
goto env_ready

:install_tool
rem Автоустановка через winget: Git или Node.js LTS.
set "TOOL=%~1"
if /i "%TOOL%"=="git" (
  set "TOOL_NAME=Git"
  set "WINGET_ID=Git.Git"
  set "TOOL_URL=https://git-scm.com/download/win"
) else (
  set "TOOL_NAME=Node.js LTS"
  set "WINGET_ID=OpenJS.NodeJS.LTS"
  set "TOOL_URL=https://nodejs.org/"
)
where winget >nul 2>&1
if errorlevel 1 goto install_manual
echo.
echo Не найден %TOOL_NAME%. Можно установить автоматически через winget.
choice /c YN /m "Установить %TOOL_NAME%"
if errorlevel 2 goto install_manual
echo == Установка %TOOL_NAME% - winget install %WINGET_ID%
winget install --id "%WINGET_ID%" --exact --silent --accept-package-agreements --accept-source-agreements
if errorlevel 1 goto install_manual
echo == %TOOL_NAME% установлен.
goto :eof

:install_manual
echo.
echo Поставьте %TOOL_NAME% вручную: %TOOL_URL%
echo После установки закройте это окно и запустите файл снова.
goto fail

:refresh_path
rem Подхватываем PATH после установки в текущем окне.
set "PATH=%PATH%;C:\Program Files\nodejs;C:\Program Files\Git\cmd;%LOCALAPPDATA%\Programs\nodejs;%APPDATA%\npm"
goto :eof

:env_ready

rem --- клонирование ----------------------------------------------------------
if exist "%APP_DIR%\.git" goto update
if exist "%APP_DIR%\package.json" goto attach_repo
echo.
echo == Клонирование ветки %BRANCH%
if exist "%APP_DIR%" goto clone_failed
git clone --branch "%BRANCH%" "%REPO_URL%" "%APP_DIR%"
if not errorlevel 1 goto update
echo ** Не удалось взять ветку %BRANCH%, клонирую ветку по умолчанию.
if exist "%APP_DIR%" rmdir /s /q "%APP_DIR%"
git clone "%REPO_URL%" "%APP_DIR%"
if errorlevel 1 goto clone_failed
goto update

rem --- папка скачана архивом -------------------------------------------------
:attach_repo
cd /d "%APP_DIR%"
if errorlevel 1 goto bad_dir
echo.
echo ** Папка без .git: похоже, скачан ZIP-архив. Включаю автообновление.
echo    Содержимое приводится к текущей версии ветки; ваши новые файлы не удаляются.
git init -q >nul 2>&1
git remote remove origin >nul 2>&1
git remote add origin "%REPO_URL%"
git fetch origin --prune >nul 2>&1
if errorlevel 1 goto attach_failed
set "ATTACH="
git rev-parse --verify --quiet "origin/%BRANCH%" >nul 2>&1
if not errorlevel 1 set "ATTACH=%BRANCH%"
if defined ATTACH goto attach_branch
git rev-parse --verify --quiet "origin/%FALLBACK_BRANCH%" >nul 2>&1
if errorlevel 1 goto attach_failed
set "ATTACH=%FALLBACK_BRANCH%"
:attach_branch
git symbolic-ref HEAD "refs/heads/%ATTACH%" >nul 2>&1
git reset --hard "origin/%ATTACH%" >nul 2>&1
if errorlevel 1 goto attach_failed
echo == Автообновление включено: ветка %ATTACH%.
goto update

:attach_failed
rem Откат: убираем полуподключённый .git, файлы пользователя не трогаем.
if exist "%APP_DIR%\.git" rmdir /s /q "%APP_DIR%\.git"
echo ** Не удалось подключить репозиторий - запускаю текущие файлы без автообновления.
echo    Проверьте доступ к GitHub; для приватного репозитория войдите в Git Credential Manager.
goto deps

rem --- обновление ------------------------------------------------------------
:update
cd /d "%APP_DIR%"
if errorlevel 1 goto bad_dir
git remote get-url origin >nul 2>&1
if errorlevel 1 git remote add origin "%REPO_URL%"
echo.
echo == Получение обновлений
git fetch origin --prune >nul 2>&1
if errorlevel 1 echo ** git fetch не удался, работаю с локальной копией.

rem Берём ту из двух веток, где последний коммит новее: сессионную или main.
set "HAS_BRANCH="
set "HAS_MAIN="
git rev-parse --verify --quiet "origin/%BRANCH%" >nul 2>&1
if not errorlevel 1 set "HAS_BRANCH=1"
git rev-parse --verify --quiet "origin/%FALLBACK_BRANCH%" >nul 2>&1
if not errorlevel 1 set "HAS_MAIN=1"
if not defined HAS_BRANCH if not defined HAS_MAIN goto update_skipped
if not defined HAS_BRANCH (
  set "TARGET=%FALLBACK_BRANCH%"
  goto target_ready
)
if not defined HAS_MAIN (
  set "TARGET=%BRANCH%"
  goto target_ready
)
set "STAMP_BRANCH=0"
set "STAMP_MAIN=0"
for /f "delims=" %%i in ('git log -1 --format=%%ct "origin/%BRANCH%"') do set "STAMP_BRANCH=%%i"
for /f "delims=" %%i in ('git log -1 --format=%%ct "origin/%FALLBACK_BRANCH%"') do set "STAMP_MAIN=%%i"
set "TARGET=%BRANCH%"
if %STAMP_MAIN% GTR %STAMP_BRANCH% set "TARGET=%FALLBACK_BRANCH%"
:target_ready
echo Ветка обновления: %TARGET%

set "DIRTY="
git rev-parse --verify --quiet HEAD >nul 2>&1
if errorlevel 1 goto check_branch
rem Только правки отслеживаемых файлов: новые файлы пользователя не трогаем.
for /f "delims=" %%i in ('git status --porcelain --untracked-files=no') do set "DIRTY=1"
if defined DIRTY (
  echo ** Правки файлов репозитория сохраняю в git stash - yappytuber auto-backup.
  git stash push -m "yappytuber auto-backup" >nul 2>&1
)

:check_branch
set "CURRENT="
for /f "delims=" %%i in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set "CURRENT=%%i"
if /i "%CURRENT%"=="%TARGET%" goto branch_ready
if not defined CURRENT goto first_checkout
git checkout "%TARGET%" >nul 2>&1
if errorlevel 1 git checkout -b "%TARGET%" "origin/%TARGET%" >nul 2>&1
goto branch_ready

:first_checkout
rem Репозиторий без коммитов (например, после git init): ставим ветку и файлы.
git symbolic-ref HEAD "refs/heads/%TARGET%" >nul 2>&1
git reset --hard "origin/%TARGET%" >nul 2>&1
if errorlevel 1 goto update_failed

:branch_ready
git merge --ff-only "origin/%TARGET%" >nul 2>&1
if errorlevel 1 (
  echo ** Ветка разошлась с удалённой - выполняю жёсткий сброс на origin/%TARGET%.
  echo    Прежнее состояние можно вернуть через: git reflog
  git reset --hard "origin/%TARGET%"
  if errorlevel 1 goto update_failed
)
for /f "delims=" %%i in ('git log -1 --oneline') do echo Коммит: %%i
goto deps


rem --- зависимости -----------------------------------------------------------
:deps
echo.
if exist "node_modules" goto deps_sync
echo == Установка зависимостей - npm ci
call npm ci --no-audit --no-fund
if errorlevel 1 goto npm_failed
goto wasm

:deps_sync
echo == Проверка зависимостей
call npm install --no-audit --no-fund --prefer-offline >nul 2>&1
if errorlevel 1 echo ** npm install не удался, использую текущие node_modules.

rem --- WASM-ядро -------------------------------------------------------------
:wasm
echo.
echo == Rust-ядро WASM
where cargo >nul 2>&1
if errorlevel 1 goto wasm_prebuilt
where rustup >nul 2>&1
if errorlevel 1 goto wasm_prebuilt
rustup target list --installed 2>nul | findstr /c:"wasm32-unknown-unknown" >nul
if errorlevel 1 goto wasm_prebuilt
call npm run build:wasm
if errorlevel 1 goto wasm_failed
goto serve

:wasm_prebuilt
if not exist "public\rig_core.wasm" goto wasm_missing
echo Rust/wasm32 не найден - использую собранный public\rig_core.wasm.

rem --- запуск ----------------------------------------------------------------
:serve
if "%SERVE%"=="0" goto done
if "%BRIDGE%"=="1" start "YappyTuberPlus OBS bridge" /min cmd /c "npm run overlay:bridge"
if "%OPEN%"=="1" start "" /min cmd /c "timeout /t 4 >nul & start http://localhost:%PORT%/"
echo.
echo Редактор:  http://localhost:%PORT%/
echo Оверлей:   http://localhost:%PORT%/overlay.html?overlay=1^&guide=1
echo Остановка: Ctrl+C в этом окне
echo.
if /i "%MODE%"=="tauri" goto run_tauri
call npm run dev -- --port %PORT%
goto finish

:run_tauri
call npm run tauri dev
goto finish

rem --- завершение ------------------------------------------------------------
:done
echo.
echo == Готово: проект обновлён и собран.
goto finish

:finish
if errorlevel 1 pause
timeout /t 2 >nul 2>&1
exit /b 0

rem --- справка и ошибки ------------------------------------------------------
:usage
echo YappyTuberPlus - обновление и запуск
echo.
echo   start-yappytuber.bat [параметры]
echo.
echo   --no-open      не открывать браузер
echo   --no-bridge    не запускать мост для OBS
echo   --no-serve     только обновить и собрать
echo   --tauri        запустить нативное окно Tauri
echo   --port 5199    другой порт редактора
echo   --branch NAME  другая ветка
echo   --dir PATH     папка проекта
pause
exit /b 0

:no_git
echo.
echo ОШИБКА: не найден git. Установите Git for Windows: https://git-scm.com/download/win
goto fail

:no_node
echo.
echo ОШИБКА: не найден Node.js. Установите Node.js 20 или новее: https://nodejs.org/
goto fail

:update_skipped
echo ** Ветки не получены с удалённого репозитория - продолжаю без обновления.
goto deps

:update_failed
echo.
echo ОШИБКА: не удалось обновить ветку %TARGET%.
goto fail

:npm_failed
echo.
echo ОШИБКА: npm ci завершился с ошибкой.
goto fail

:wasm_missing
echo.
echo ОШИБКА: нет Rust/wasm32 и отсутствует public\rig_core.wasm
goto fail

:wasm_failed
echo.
echo ОШИБКА: сборка WASM завершилась с ошибкой.
goto fail

:clone_failed
echo.
echo ОШИБКА: не удалось склонировать %REPO_URL%
echo Проверьте доступ к GitHub и папку %APP_DIR%
echo Для приватного репозитория войдите в GitHub в окне Git Credential Manager.
goto fail

:bad_dir
echo.
echo ОШИБКА: не удалось перейти в %APP_DIR%
goto fail

:fail
echo.
pause
exit /b 1
