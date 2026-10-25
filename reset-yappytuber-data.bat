@echo off
rem ===========================================================================
rem  YappyTuberPlus - данные приложения и их сброс
rem
rem  Двойной клик: показывает, где приложение хранит аватары и пресеты,
rem  и по подтверждению удаляет автосохранение (профиль WebView2).
rem
rem  Параметры:
rem    --profile   удалить автосохранение (пресет, картинки, раскладка)
rem    --presets   удалить сохранённые файлы *.yappy.json
rem    --all       удалить и то, и другое
rem    --help      справка
rem
rem  Закрывайте приложение перед удалением: WebView2 держит профиль открытым.
rem ===========================================================================
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul 2>&1
title YappyTuberPlus - данные приложения

set "IDENT=com.yappytuberplus.studio"
set "PROFILE=%LOCALAPPDATA%\%IDENT%"
set "PRESETS=%APPDATA%\%IDENT%\presets"
set "DO_PROFILE=0"
set "DO_PRESETS=0"
set "ASK=1"

:parse
if "%~1"=="" goto parsed
if /i "%~1"=="--profile" ( set "DO_PROFILE=1" & set "ASK=0" & shift & goto parse )
if /i "%~1"=="--presets" ( set "DO_PRESETS=1" & set "ASK=0" & shift & goto parse )
if /i "%~1"=="--all" ( set "DO_PROFILE=1" & set "DO_PRESETS=1" & set "ASK=0" & shift & goto parse )
if /i "%~1"=="--help" goto usage
echo Неизвестный параметр: %~1
goto usage

:parsed
echo.
echo === YappyTuberPlus: где лежат данные ===
echo.
echo Автосохранение сессии (пресет, картинки в base64, раскладка панелей):
echo   %PROFILE%\EBWebView\Default\Local Storage\leveldb
echo.
echo Файлы, сохранённые кнопкой «Сохранить»:
echo   %PRESETS%
echo.
echo Картинок отдельными файлами приложение не пишет: аватар хранится внутри
echo пресета (data URL), поэтому он и «приезжает» вместе с автосохранением.
echo.

if "!ASK!"=="1" (
  set "ANSWER="
  set /p "ANSWER=Удалить автосохранение сессии (пресет, картинки, раскладка) [y/N]: "
  if /i "!ANSWER!"=="y" set "DO_PROFILE=1"
  set "ANSWER="
  set /p "ANSWER=Удалить сохранённые файлы пресетов из второй папки [y/N]: "
  if /i "!ANSWER!"=="y" set "DO_PRESETS=1"
)

if "!DO_PROFILE!"=="0" if "!DO_PRESETS!"=="0" goto done

tasklist /fi "imagename eq yappytuberplus.exe" 2>nul | find /i "yappytuberplus.exe" >nul
if not errorlevel 1 (
  echo.
  echo Приложение запущено. Закройте его и запустите скрипт снова.
  goto done
)

if "!DO_PROFILE!"=="1" call :drop_profile
if "!DO_PRESETS!"=="1" call :drop_presets
goto done

:drop_profile
if exist "%PROFILE%\EBWebView" (
  rmdir /s /q "%PROFILE%\EBWebView"
  if exist "%PROFILE%\EBWebView" (
    echo Не удалось удалить профиль: %PROFILE%\EBWebView
  ) else (
    echo Автосохранение удалено: %PROFILE%\EBWebView
  )
) else (
  echo Профиля нет — автосохранения не было.
)
exit /b 0

:drop_presets
if exist "%PRESETS%" (
  del /q "%PRESETS%\*.yappy.json" 2>nul
  rem Папки файлов объектов: рядом с каждым пресетом лежит <имя>.assets.
  for /d %%D in ("%PRESETS%\*.assets") do rd /s /q "%%~fD"
  echo Сохранённые пресеты и папки их файлов удалены из %PRESETS%
) else (
  echo Папки с сохранёнными пресетами нет.
)
exit /b 0

:done
echo.
pause
exit /b 0

:usage
echo YappyTuberPlus - данные приложения
echo.
echo   reset-yappytuber-data.bat            показать пути и спросить
echo   reset-yappytuber-data.bat --profile  удалить автосохранение
echo   reset-yappytuber-data.bat --presets  удалить файлы пресетов
echo   reset-yappytuber-data.bat --all      удалить всё
echo.
pause
exit /b 0
