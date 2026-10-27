@echo off
title BB Hub - Prime 30/09 (runtime v6_44, sin observador)
rem Lo mismo que el 30/09: runtime v6_44_silent_gap, Hub del 01/10, lanzador clasico de HTML5\harness,
rem T+10 manual, un pedido, barrido y reaccion. SIN el observador del cable.
rem Cierra antes el BB Hub instalado y BoomBang. Registros: HTML5\captures.
rem Cuenta: la del lanzador clasico (cambiarla con HTML5\CAMBIAR_CUENTA_HUB.cmd).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0RECUPERACION_TIMING\abrir.ps1" -Variante 29-septiembre -SinCable
if errorlevel 1 pause
