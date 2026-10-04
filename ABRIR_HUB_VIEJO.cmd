@echo off
setlocal
title BB Hub - modo viejo (.cmd)
rem Como antes de distribuir: el Hub corre desde el codigo (sin ofuscar, sin
rem bytecode, sin licencia) y el juego lo abre HTML5\ABRIR_HUB.cmd con Node +
rem Playwright y el runtime sin ofuscar de HTML5\hub_runtime.
set "ROOT=%~dp0"
set "HUBDIR=%ROOT%controller-electron"
set "RT=%ROOT%HTML5\hub_runtime"
set "BB5_ALLIES=Flee"

tasklist /FI "IMAGENAME eq BB Hub.exe" 2>nul | find /I "BB Hub.exe" >nul
if not errorlevel 1 (
  echo El BB Hub instalado esta abierto. Cerralo ^(tambien desde la bandeja^) y volve a abrir este archivo.
  pause
  exit /b 1
)
if not exist "%RT%\launch_hub_client.js" (
  echo No encuentro %RT%\launch_hub_client.js
  pause
  exit /b 1
)

echo Sincronizando el runtime actual del codigo. Este archivo NO hace rollback historico.
copy /Y "%HUBDIR%\electron\game\flash_runtime.page.js" "%RT%\flash_runtime.page.js" >nul
copy /Y "%HUBDIR%\electron\game\ring_scene.page.js" "%RT%\ring_scene.page.js" >nul

if not exist "%HUBDIR%\dist-ui\index.html" (
  echo Compilando la interfaz del Hub...
  pushd "%HUBDIR%"
  call npm run build
  popd
)

echo Abriendo BB Hub desde el codigo...
set "BB_SKIP_LICENSE=1"
set "BB_HUB_NO_GAME=1"
start "BB Hub" /D "%HUBDIR%" "%HUBDIR%\node_modules\.bin\electron.cmd" .
set "BB_SKIP_LICENSE="
set "BB_HUB_NO_GAME="

echo Esperando que el Hub escuche en 127.0.0.1:9999...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "$deadline = (Get-Date).AddSeconds(60);" ^
  "while ((Get-Date) -lt $deadline) {" ^
  "  $c = New-Object System.Net.Sockets.TcpClient;" ^
  "  try { $c.Connect('127.0.0.1', 9999); $c.Close(); exit 0 } catch { $c.Close(); Start-Sleep -Milliseconds 300 }" ^
  "}; exit 1"
if errorlevel 1 (
  echo El Hub no abrio el puerto 9999 en 60 s.
  pause
  exit /b 1
)
echo Hub listo.

call "%ROOT%HTML5\ABRIR_HUB.cmd"
endlocal
