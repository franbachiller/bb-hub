@echo off
:: Ejecutar como Administrador - agrega game.boombang.tv al hosts
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Necesita permisos de Administrador.
    echo Click derecho en este archivo y selecciona "Ejecutar como administrador"
    pause
    exit /b 1
)

findstr /C:"game.boombang.tv" "C:\Windows\System32\drivers\etc\hosts" >nul 2>&1
if %errorlevel%==0 (
    echo Ya existe la entrada para game.boombang.tv. No se realizo ningun cambio.
    echo.
    type "C:\Windows\System32\drivers\etc\hosts"
    pause
    exit /b 0
)

echo 127.0.0.1	game.boombang.tv	# BOT BB proxy redirect >> "C:\Windows\System32\drivers\etc\hosts"
echo.
echo OK - Agregado: 127.0.0.1  game.boombang.tv
echo.
type "C:\Windows\System32\drivers\etc\hosts"
echo.
pause
