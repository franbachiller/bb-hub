@echo off
setlocal
set "BB_TIMING_PUNCH_ISOLATION="
set "BB_TIMING_PUNCH_ISOLATION_PHASE="
title BB Hub - Prueba de Timing UpperAll
set "HUB_TIMING_DIR=%~dp0controller-electron"
tasklist /FI "IMAGENAME eq BB Hub.exe" 2>nul | find /I "BB Hub.exe" >nul
if not errorlevel 1 (
  echo Cerra el BB Hub instalado antes de abrir esta prueba.
  pause
  exit /b 1
)
tasklist /FI "IMAGENAME eq BoomBangHTML5.exe" 2>nul | find /I "BoomBangHTML5.exe" >nul
if not errorlevel 1 (
  echo Cerra BoomBang HTML5 para que el Hub cargue el runtime corregido.
  pause
  exit /b 1
)
if not exist "%HUB_TIMING_DIR%\dist-ui\index.html" (
  echo Falta compilar la interfaz de la prueba.
  pause
  exit /b 1
)
echo Prueba local. Usa tu licencia y cuenta habituales.
echo Runtime esperado: 12102026_html5_selected_step_controls_preview
echo En el Hub: Autoclick por paso apagado, TIMING Automatico / Solo el fichado.
echo Activa Registro de combate antes de entrar a Ring.
pushd "%HUB_TIMING_DIR%"
start "BB Hub - Timing UpperAll" "%HUB_TIMING_DIR%\node_modules\electron\dist\electron.exe" .
popd
endlocal
