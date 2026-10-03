@echo off
setlocal
cd /d "%~dp0"

set "PYTHON_EXE=%LocalAppData%\Programs\Python\Python313\python.exe"
if exist "%PYTHON_EXE%" goto run_proxy

where py >nul 2>&1
if %errorlevel%==0 (
  set "PYTHON_EXE=py"
  goto run_proxy
)

where python >nul 2>&1
if %errorlevel%==0 (
  set "PYTHON_EXE=python"
  goto run_proxy
)

echo No se encontro Python. Instala Python o ajusta run_proxy.cmd
exit /b 1

:run_proxy
set "MULTIPLY="
:ask_multiply
set "MULTIPLY="
set /p MULTIPLY=Multiply (default 1): 
set "MULTIPLY=%MULTIPLY: =%"
if "%MULTIPLY%"=="" (
  set "MULTIPLY=1"
  goto launch_proxy
)

set "NON_DIGITS="
for /f "delims=0123456789" %%A in ("%MULTIPLY%") do set "NON_DIGITS=%%A"
if defined NON_DIGITS (
  echo Valor invalido. Ingresa un entero positivo.
  goto ask_multiply
)

set /a MULTIPLY_NUM=%MULTIPLY% >nul 2>&1
if errorlevel 1 (
  echo Valor invalido. Ingresa un entero positivo.
  goto ask_multiply
)
if %MULTIPLY_NUM% LEQ 0 (
  echo Valor invalido. Ingresa un entero positivo.
  goto ask_multiply
)

:launch_proxy
set "MULTIPLY=%MULTIPLY_NUM%"
echo Iniciando proxy con multiply=%MULTIPLY%x
%PYTHON_EXE% proxy.py --mode mitm --listen-host 127.0.0.1 --listen-port 7100 --remote-host 144.217.189.239 --remote-port 7100 --http-host 127.0.0.1 --http-port 18446 --multiply %MULTIPLY% --log-dir logs %*
endlocal
