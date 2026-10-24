@echo off
rem ===========================================================================
rem  YappyTuberPlus - установка инструментов сборки
rem
rem  Двойной клик: проверяет и ставит всё, что нужно для сборки .exe:
rem    Node.js LTS (сборка фронтенда)
rem    Visual Studio Build Tools + C++ (компилятор MSVC)
rem    Rust (rustup, x86_64-pc-windows-msvc)
rem    WebView2 Runtime (окно приложения)
rem    Git (по желанию: нужен автообновлению папки проекта)
rem
rem  Параметры:
rem    --check   только показать, чего не хватает, ничего не ставить
rem    --yes     без подтверждения перед установкой
rem    --help    справка
rem
rem  Нужны права администратора (будет запрос UAC) и интернет.
rem ===========================================================================
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul 2>&1
title YappyTuberPlus - установка инструментов сборки
pushd "%~dp0"

set "PF=%ProgramFiles%"
set "PF86=%ProgramFiles(x86)%"
if not defined PF86 set "PF86=%ProgramFiles%"
set "CARGO_BIN=%USERPROFILE%\.cargo\bin"
set "WORK=%TEMP%\yappytuberplus-setup"
set "ASSUME_YES=0"
set "CHECK_ONLY=0"
set "ELEVATED=0"

:parse
if "%~1"=="" goto parsed
if /i "%~1"=="--yes" ( set "ASSUME_YES=1" & shift & goto parse )
if /i "%~1"=="-y" ( set "ASSUME_YES=1" & shift & goto parse )
if /i "%~1"=="--check" ( set "CHECK_ONLY=1" & shift & goto parse )
if /i "%~1"=="--admin" ( set "ELEVATED=1" & shift & goto parse )
if /i "%~1"=="--help" goto usage
echo Неизвестный параметр: %~1
goto usage

:parsed
echo.
echo ============================================================
echo   YappyTuberPlus - инструменты сборки .exe
echo ============================================================
echo.

rem --- права администратора --------------------------------------------------
if "%ELEVATED%"=="1" goto admin_ok
if "%CHECK_ONLY%"=="1" goto admin_ok
net session >nul 2>&1
if not errorlevel 1 goto admin_ok
echo Нужны права администратора: установка компонентов Windows.
echo Сейчас появится запрос UAC - нажмите "Да".
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -ArgumentList '%* --admin' -Verb RunAs" >nul 2>&1
if errorlevel 1 echo Похоже, запрос прав отменён. Запустите файл правой кнопкой: "Запуск от имени администратора".
popd
exit /b 0

:admin_ok
if not exist "%WORK%" mkdir "%WORK%" >nul 2>&1
where winget >nul 2>&1
if errorlevel 1 (
  echo winget не найден - компоненты будут скачиваться установщиками с сайтов.
  echo.
)

rem --- что уже стоит ----------------------------------------------------------
call :detect
echo Что найдено:
echo   Node.js ........ %NODE_STATE%
echo   MSVC (C++) ..... %MSVC_STATE%
echo   Rust ........... %RUST_STATE%
echo   WebView2 ....... %WV2_STATE%
echo   Git ............ %GIT_STATE%   (не обязательно)
echo.

if "%CHECK_ONLY%"=="1" goto summary
if "%MISSING%"=="0" goto all_ok

if "%ASSUME_YES%"=="0" (
  echo Будут установлены отсутствующие компоненты.
  echo Visual Studio Build Tools - это 2-4 ГБ и 10-20 минут.
  echo.
  choice /c YN /m "Продолжить установку"
  if errorlevel 2 goto summary
)
echo.

rem --- Node.js ---------------------------------------------------------------
if "%NODE_OK%"=="1" goto node_done
echo == Node.js LTS ==
call :winget_install OpenJS.NodeJS.LTS "Node.js LTS"
call :detect
if "%NODE_OK%"=="1" goto node_done
call :download "https://nodejs.org/dist/latest-v22.x/win-x64/node.msi" "%WORK%\node.msi"
if not exist "%WORK%\node.msi" call :download "https://nodejs.org/dist/latest/win-x64/node.msi" "%WORK%\node.msi"
if exist "%WORK%\node.msi" (
  echo Устанавливаю Node.js...
  msiexec /i "%WORK%\node.msi" /qn /norestart
)
set "PATH=%PF%\nodejs;%PATH%"
call :detect
:node_done

rem --- Visual Studio Build Tools ---------------------------------------------
if "%MSVC_OK%"=="1" goto msvc_done
echo == Visual Studio Build Tools (C++) ==
call :winget_install_vs
call :detect
if "%MSVC_OK%"=="1" goto msvc_done
call :download "https://aka.ms/vs/17/release/vs_buildtools.exe" "%WORK%\vs_buildtools.exe"
if exist "%WORK%\vs_buildtools.exe" (
  echo Устанавливаю Build Tools... Это надолго.
  "%WORK%\vs_buildtools.exe" --quiet --wait --norestart --nocache --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended
)
call :detect
:msvc_done

rem --- Rust ------------------------------------------------------------------
if "%RUST_OK%"=="1" goto rust_done
echo == Rust ==
call :winget_install Rustlang.Rustup "Rust"
call :detect
if "%RUST_OK%"=="1" goto rust_done
call :download "https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe" "%WORK%\rustup-init.exe"
if exist "%WORK%\rustup-init.exe" (
  echo Устанавливаю Rust...
  "%WORK%\rustup-init.exe" -y --default-host x86_64-pc-windows-msvc --profile default
)
set "PATH=%CARGO_BIN%;%PATH%"
call :detect
:rust_done

rem --- WebView2 --------------------------------------------------------------
if "%WV2_OK%"=="1" goto webview_done
echo == WebView2 Runtime ==
call :winget_install Microsoft.EdgeWebView2Runtime "WebView2 Runtime"
call :detect
if "%WV2_OK%"=="1" goto webview_done
call :download "https://go.microsoft.com/fwlink/p/?LinkId=2124703" "%WORK%\webview2setup.exe"
if exist "%WORK%\webview2setup.exe" (
  echo Устанавливаю WebView2...
  "%WORK%\webview2setup.exe" /silent /install
)
call :detect
:webview_done

rem --- Git (не обязательно) ---------------------------------------------------
if "%GIT_OK%"=="1" goto git_done
echo == Git (по желанию) ==
call :winget_install Git.Git "Git"
call :detect
:git_done

rem --- target для WASM-ядра ---------------------------------------------------
if not exist "%CARGO_BIN%\rustup.exe" goto summary
echo == Ядро рига (wasm32) ==
"%CARGO_BIN%\rustup.exe" target add wasm32-unknown-unknown >nul 2>&1
if errorlevel 1 echo Не удалось добавить target wasm32 - ядро возьмётся из public\rig_core.wasm.

rem --- итог ------------------------------------------------------------------
:summary
call :detect
echo.
echo ============================================================
echo   Node.js ........ %NODE_STATE%
echo   MSVC (C++) ..... %MSVC_STATE%
echo   Rust ........... %RUST_STATE%
echo   WebView2 ....... %WV2_STATE%
echo   Git ............ %GIT_STATE%   (не обязательно)
echo ============================================================
echo.
if "%MISSING%"=="0" goto all_ok
echo Чего-то не хватает. Можно поставить вручную:
echo   Node.js:  https://nodejs.org/          (LTS, установщик .msi)
echo   Rust:     https://rustup.rs/           (x86_64-pc-windows-msvc)
echo   MSVC:     https://aka.ms/vs/17/release/vs_buildtools.exe
echo             при установке отметьте "Разработка классических приложений на C++"
echo   WebView2: https://developer.microsoft.com/microsoft-edge/webview2/
echo.
echo После установки закройте окно и запустите этот файл снова - он проверит всё заново.
pause
popd
exit /b 1

:all_ok
echo Всё готово. Дальше - build-yappytuber.bat (двойной клик), он соберёт .exe.
echo.
if not exist "build-yappytuber.bat" goto done
choice /c YN /t 15 /d Y /m "Собрать приложение сейчас"
if errorlevel 2 goto done
echo.
call "%~dp0build-yappytuber.bat"
popd
exit /b 0

:done
pause
popd
exit /b 0

rem ===========================================================================
rem  Подпрограммы
rem ===========================================================================

:detect
set "NODE_OK=0"
set "MSVC_OK=0"
set "RUST_OK=0"
set "WV2_OK=0"
set "GIT_OK=0"
where node >nul 2>&1
if not errorlevel 1 set "NODE_OK=1"
if exist "%PF%\nodejs\node.exe" set "NODE_OK=1"
if exist "%CARGO_BIN%\cargo.exe" set "RUST_OK=1"
where cargo >nul 2>&1
if not errorlevel 1 set "RUST_OK=1"
del "%WORK%\vs.txt" >nul 2>&1
if exist "%PF86%\Microsoft Visual Studio\Installer\vswhere.exe" (
  "%PF86%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath >"%WORK%\vs.txt" 2>nul
)
if exist "%WORK%\vs.txt" for %%A in ("%WORK%\vs.txt") do if not "%%~zA"=="0" set "MSVC_OK=1"
reg query "HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" /v pv >nul 2>&1
if not errorlevel 1 set "WV2_OK=1"
reg query "HKCU\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" /v pv >nul 2>&1
if not errorlevel 1 set "WV2_OK=1"
if exist "%PF86%\Microsoft\EdgeWebView\Application" set "WV2_OK=1"
where git >nul 2>&1
if not errorlevel 1 set "GIT_OK=1"
if exist "%PF%\Git\cmd\git.exe" set "GIT_OK=1"
set "MISSING=0"
if "%NODE_OK%"=="0" set "MISSING=1"
if "%MSVC_OK%"=="0" set "MISSING=1"
if "%RUST_OK%"=="0" set "MISSING=1"
if "%WV2_OK%"=="0" set "MISSING=1"
call :state NODE_OK NODE_STATE
call :state MSVC_OK MSVC_STATE
call :state RUST_OK RUST_STATE
call :state WV2_OK WV2_STATE
call :state GIT_OK GIT_STATE
exit /b 0

:state
if "!%~1!"=="1" set "%~2=есть"
if not "!%~1!"=="1" set "%~2=нет"
exit /b 0

:winget_install
rem %1 = id пакета, %2 = имя для человека
where winget >nul 2>&1
if errorlevel 1 exit /b 1
echo Устанавливаю %~2 через winget...
winget install --id %~1 -e --silent --accept-source-agreements --accept-package-agreements
exit /b 0

:winget_install_vs
where winget >nul 2>&1
if errorlevel 1 exit /b 1
echo Устанавливаю Visual Studio Build Tools через winget...
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --silent --accept-source-agreements --accept-package-agreements --override "--wait --passive --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
exit /b 0

:download
rem %1 = адрес, %2 = файл
echo Скачиваю %~1
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '%~1' -OutFile '%~2' -UseBasicParsing } catch { exit 1 }"
exit /b 0

:usage
echo YappyTuberPlus - установка инструментов сборки
echo.
echo   install-build-tools.bat           проверить и установить всё нужное
echo   install-build-tools.bat --check   только показать, чего не хватает
echo   install-build-tools.bat --yes     без подтверждения
echo.
echo Ставит: Node.js LTS, Visual Studio Build Tools (C++), Rust, WebView2,
echo и по желанию Git. Нужны права администратора и интернет.
pause
popd
exit /b 0
