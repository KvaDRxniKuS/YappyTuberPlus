@echo off
rem One entry point: update sources/dependencies, then build the native app.
rem Arguments are app-build.bat options: --no-bundle, --fast, --no-open.
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul 2>&1
if /i "%~1"=="--help" goto help
pushd "%~dp0"
if errorlevel 1 exit /b 1
call "%~dp0app-update.bat" --strict --no-wasm
if errorlevel 1 goto update_failed
rem app-update may change the current directory; build always uses this repo.
call "%~dp0app-build.bat" %*
set "RESULT=%ERRORLEVEL%"
popd
exit /b %RESULT%

:update_failed
echo.
echo Update failed. Native build was not started.
popd
exit /b 1

:help
echo app-update-build.bat [--no-bundle] [--fast] [--no-open]
echo Updates the project, then builds the Windows app and installer.
echo WASM is built by app-build.bat, not twice.
exit /b 0
