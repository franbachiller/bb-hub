@echo off
setlocal
set "BB_TIMING_PUNCH_ISOLATION="
set "BB_TIMING_PUNCH_ISOLATION_PHASE="
title BB Hub - Prueba de Autoclick por paso
set "HUB_STEP_DIR=%~dp0controller-electron"
tasklist /FI "IMAGENAME eq BB Hub.exe" 2>nul | find /I "BB Hub.exe" >nul
if not errorlevel 1 (
  echo Cerra el BB Hub instalado antes de abrir esta prueba.
  pause
  exit /b 1
)
tasklist /FI "IMAGENAME eq BoomBangHTML5.exe" 2>nul | find /I "BoomBangHTML5.exe" >nul
if not errorlevel 1 (
  echo Cerra BoomBang HTML5 para que el Hub cargue el runtime nuevo.
  pause
  exit /b 1
)
if not exist "%HUB_STEP_DIR%\dist-ui\index.html" (
  echo Falta compilar la interfaz de la prueba.
  pause
  exit /b 1
)
echo Abriendo prueba local. Usa tu licencia y cuenta habituales.
echo En el Hub: Autoclick por paso. Ejemplo: inicio 350, final 400, intervalo 10 ms.
echo Runtime esperado: 12102026_html5_step_click_encounter_preview
pushd "%HUB_STEP_DIR%"
start "BB Hub - Autoclick por paso" "%HUB_STEP_DIR%\node_modules\electron\dist\electron.exe" .
popd
endlocal
