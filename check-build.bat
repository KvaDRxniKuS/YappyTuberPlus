@echo off
rem ===========================================================================
rem  YappyTuberPlus - проверка версии папки сборки
rem
rem  Двойной клик: спрашивает папку (Enter - dist) и сверяет её паспорт
rem  build.json с репозиторием. При совпадении окно закрывается само через
rem  несколько секунд, при расхождении - остаётся открытым с объяснением.
rem
rem  Параметры:
rem    check-build.bat D:\Rig\dist   папку можно передать сразу
rem ===========================================================================
setlocal EnableExtensions
chcp 65001 >nul 2>&1
title YappyTuberPlus - проверка сборки
pushd "%~dp0"

set "FOLDER=%~1"
if not "%FOLDER%"=="" goto check
set "FOLDER=dist"
set /p "ANSWER=Папка сборки (Enter - %FOLDER%): "
if not "%ANSWER%"=="" set "FOLDER=%ANSWER%"

:check
where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo Не найден Node.js - он нужен для проверки.
  echo Запустите install-build-tools.bat или поставьте Node.js с nodejs.org.
  echo.
  pause
  popd
  exit /b 1
)

node scripts\build-version.mjs --check "%FOLDER%"
if errorlevel 1 (
  echo.
  echo Проверка не прошла: версия или состав файлов не совпадают с паспортом.
  echo Пересоберите её - npm run build или build-yappytuber.bat.
  echo.
  pause
  popd
  exit /b 1
)

echo.
echo Всё совпадает - папку можно раздавать.
timeout /t 6 >nul 2>&1
popd
exit /b 0
