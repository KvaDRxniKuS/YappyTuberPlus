@echo off
rem ===========================================================================
rem  YappyTuberPlus - публикация папки сборки в репозиторий
rem
rem  Двойной клик: берёт уже готовую папку dist (её собирает npm run build),
rem  проверяет, что она совпадает с репозиторием, что исходники закоммичены и
rem  что есть доступ к GitHub, затем коммитит и отправляет папку.
rem
rem  САМ НЕ СОБИРАЕТ И НЕ ТЕСТИРУЕТ: сначала сборка и проверка, потом публикация.
rem
rem  При успехе окно закрывается само, при ошибке - остаётся с объяснением.
rem
rem  Параметры:
rem    publish-build.bat --check        показать, что уедет, ничего не отправляя
rem    publish-build.bat D:\Rig\dist   другая папка сборки
rem ===========================================================================
setlocal EnableExtensions
chcp 65001 >nul 2>&1
title YappyTuberPlus - публикация сборки
pushd "%~dp0"

set "OPTIONS="
set "FOLDER="
:parse
if "%~1"=="" goto parsed
if /i "%~1"=="--check" ( set "OPTIONS=%OPTIONS% --check" & shift & goto parse )
if /i "%~1"=="--help" goto usage
set "FOLDER=%~1"
shift
goto parse
:parsed
if not "%FOLDER%"=="" set "OPTIONS=%OPTIONS% --folder "%FOLDER%""

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo Не найден Node.js - он нужен для публикации.
  echo Запустите install-build-tools.bat или поставьте Node.js с nodejs.org.
  echo.
  pause
  popd
  exit /b 1
)
where git >nul 2>&1
if errorlevel 1 (
  echo.
  echo Не найден Git - без него публиковать некуда.
  echo Запустите install-build-tools.bat или поставьте Git с git-scm.com.
  echo.
  pause
  popd
  exit /b 1
)

node scripts\publish-build.mjs%OPTIONS%
if errorlevel 1 (
  echo.
  echo Публикация не выполнена - причина выше.
  echo Сборку при этом никто не менял: папка осталась как была.
  echo.
  pause
  popd
  exit /b 1
)

timeout /t 8 >nul 2>&1
popd
exit /b 0

:usage
echo.
echo  publish-build.bat            опубликовать папку dist
echo  publish-build.bat --check    показать, что уедет, ничего не отправляя
echo  publish-build.bat D:\Rig\dist  другая папка сборки
echo.
echo  Скрипт только публикует: собрать и проверить нужно заранее - npm run build.
echo.
pause
popd
exit /b 0
