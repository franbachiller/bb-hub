@echo off
setlocal
title BB Hub - Prueba de punch aislado
set "HUB_TIMING_DIR=%~dp0controller-electron"
set "BB_TIMING_PUNCH_ISOLATION=1"
set "BB_TIMING_PUNCH_ISOLATION_PHASE=13"
tasklist /FI "IMAGENAME eq BB Hub.exe" 2>nul | find /I "BB Hub.exe" >nul
if not errorlevel 1 (
  echo Cerra el BB Hub instalado antes de abrir esta prueba.
  pause
  exit /b 1
)
tasklist /FI "IMAGENAME eq BoomBangHTML5.exe" 2>nul | find /I "BoomBangHTML5.exe" >nul
if not errorlevel 1 (
  echo Cerra BoomBang HTML5 para que el Hub cargue la prueba aislada.
  pause
  exit /b 1
)
if not exist "%HUB_TIMING_DIR%\dist-ui\index.html" (
  echo Falta compilar la interfaz de la prueba.
  pause
  exit /b 1
)
if not exist "%HUB_TIMING_DIR%\node_modules\electron\dist\electron.exe" (
  echo Falta Electron en la carpeta de la prueba.
  pause
  exit /b 1
)
echo Prueba local. Usa tu licencia y cuenta habituales.
echo Punch aislado: T+13 ms, un pedido por paso.
echo El aprendizaje y las opciones guardadas no se modifican por esta prueba.
echo Runtime esperado: 12102026_html5_selected_step_controls_preview
echo En el Hub: TIMING activo y Autoclick por paso apagado.
echo Activa Registro de combate antes de entrar a Ring.
pushd "%HUB_TIMING_DIR%"
start "BB Hub - Punch aislado" "%HUB_TIMING_DIR%\node_modules\electron\dist\electron.exe" .
popd
endlocal
