@echo off
title BB Hub - Timing original (01/10 + runtime 02/10)
rem Hub del 01/10, runtime v6_62 del 02/10 y el lanzador original (HTML5\harness).
rem Cierra antes el BB Hub instalado y BoomBang. Registros: HTML5\captures.
rem Cuenta: la del lanzador clasico (cambiarla con HTML5\CAMBIAR_CUENTA_HUB.cmd).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0RECUPERACION_TIMING\abrir.ps1" -Variante 2-octubre -SinCable
if errorlevel 1 pause
