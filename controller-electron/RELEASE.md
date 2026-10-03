# BB Hub — distribución Windows

La entrega final del 3 de octubre de 2026 está en
`../DISTRIBUCION/BB Hub 0.1.2 Windows x64`, junto con un ZIP para enviar.
La carpeta contiene únicamente el instalador NSIS x64, `LEEME.txt` y
`SHA256.txt`. No incluye claves, fuentes, archivos de desarrollo ni registros.

## Compilación reproducible

Desde `controller-electron`, con las dependencias de `package-lock.json`:

```powershell
npm ci
npm run dist -- --config.directories.output=release
```

Electron está fijado en 44.5.1 y electron-builder en 26.15.3. El script de
protección usa el V8 del propio Electron para generar el bytecode.
El instalador y el activador usan los logos existentes de `electron/assets`;
el activador tiene fondo negro mate y textos en español neutro.

En esta sesión, por el espacio disponible en C:, la compilación final se
generó en `D:/bb-hub-build-temp-1003/release-012-final`. La entrega de
`DISTRIBUCION` procede de esa compilación. Los demás directorios de salida
anteriores del proyecto pueden contener compilaciones antiguas.

Para compilar en D: se usaron también `TEMP`, `TMP` y `ELECTRON_CACHE`
dentro de `D:/bb-hub-build-temp-1003`.

## Verificación

Después de compilar, selecciona explícitamente el ejecutable a comprobar:

```powershell
$env:BB_PACKAGED_APP_DIR = 'D:/bb-hub-build-temp-1003/release-012-final/win-unpacked'
node qa/runtime-security.cjs
node qa/pro-hotkey-updater.cjs
.\node_modules\.bin\electron.cmd qa/packaged-smoke.cjs
.\node_modules\.bin\electron.cmd qa/board-packaged-smoke.cjs
node qa/packaged-security.cjs
npm audit --omit=dev
```

`packaged-smoke` comprueba el núcleo protegido, los preloads en sandbox,
el IPC y el renderizado del Hub y del activador. No inicia el bot.
`runtime-security` comprueba controles de remitente y bloqueo de funciones
ante una licencia inválida con estados simulados.
`packaged-security` inicia el ejecutable real con la activación existente,
verifica los fuses y el hash ASAR, intenta inyección mediante variables de
entorno y opciones de depuración, y comprueba que una copia del ASAR alterada
es rechazada. Usa una copia temporal para la alteración y no modifica la
licencia en Cryptlex.

## Estado verificado — 3 de octubre de 2026

- Compilación NSIS x64 correcta y asistente en español.
- Núcleo y gate de licencia compilados en bytecode; preloads y JavaScript
  del servidor/worker Board ofuscados. La UI se genera con Vite.
- Hub y activador renderizan correctamente con los preloads en sandbox.
- Activación real GENUINE en este equipo y persistencia al reiniciar.
- La licencia real Basic abrió el Hub con los puertos del bot cerrados.
- Tras asignarle Pro con autorización, el gate nativo reconoció `ring_board`
  con valor `true`; el ejecutable final inició Board/worker y abrió HTTP/WS.
- Board y worker se prueban desde el ASAR con permiso Pro simulado; retirar
  el permiso rechaza HTTP y cierra WebSocket. La licencia real no se cambia.
- El atajo de Timing se guarda; un atajo ocupado conserva el anterior.
- La vista previa Basic conserva controles visibles y deshabilitados.
- El actualizador verifica tamaño/SHA256 y rechaza archivos alterados antes
  de ejecutar; la prueba sustituye el lanzamiento del instalador.
- Inyección mediante NODE_OPTIONS y depuración externa bloqueadas.
- Fuses e integridad ASAR verificados; archivo alterado rechazado.
- Auditoría de dependencias de producción: cero avisos conocidos reportados.

Pendientes: instalación en un Windows limpio y suspensión/revocación real
desde Cryptlex. Esos escenarios no se sustituyen por pruebas simuladas.
El instalador y el ejecutable no tienen firma digital de editor.

Consulta `SECURITY-RELEASE.md` para el alcance y los límites de las medidas.
Basic/Pro ya están configurados en Cryptlex. La release 0.1.1 está en borrador
con SHA256.txt cargado; el almacenamiento de Cryptlex rechazó el EXE. El
usuario eligió alojamiento externo, pero los enlaces recibidos de Wormhole
y Google Drive no entregan un binario directo permanente para el actualizador.
0.1.2 admite nombres externos sin espacios y está lista en DISTRIBUCION.
Falta una URL HTTPS directa válida antes de publicar 0.1.2 con su nuevo hash.
Consulta `CRYPTLEX-SETUP.md` para el estado remoto y las siguientes releases.
