@echo off
rem ===========================================================================
rem  Пульс: мост для модуля «Пульсометр»
rem
rem  Двойной клик — мост запускается и отдаёт пульс приложению:
rem    ws://127.0.0.1:17801/inputs    поток для модуля
rem    http://127.0.0.1:17801/state   тот же снимок одним ответом
rem
rem  Без железа это тренажёр: пульс гуляет 60...110, удары идут по частоте.
rem  Свой пульс: pulse-bridge.bat --hr 90
rem  Другой порт: pulse-bridge.bat --port 18000
rem  Остановка: Ctrl+C или закрыть окно.
rem ===========================================================================
setlocal EnableExtensions
chcp 65001 >nul 2>&1
title Пульс: мост для YappyTuberPlus

where node >nul 2>&1
if errorlevel 1 goto no_node

node "%~dp0scripts\pulse-bridge.mjs" %*
echo.
echo Мост остановлен.
pause
exit /b 0

:no_node
echo.
echo Не найден Node.js: мост написан на нём и без Node не запускается.
echo Поставьте Node.js LTS: https://nodejs.org/ — и запустите файл снова.
echo.
pause
exit /b 1
