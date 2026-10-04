# BB Hub — distribución Windows

## 0.1.3 — el Hub abre el juego

0.1.2 traía solo el Hub: el juego se abría con `ABRIR_HUB_Y_CONTROLLER.cmd`
(Node + Playwright + `HTML5/hub_runtime`), que no existe en el equipo del
cliente, así que el Hub instalado quedaba esperando en el `:9999`.

- `electron/game/game-launcher.cjs`: login en `backend-launcher.boombang.tv`
  (con 2FA), ticket, `BoomBangHTML5.exe --remote-debugging-port=9230`,
  conexión CDP con `playwright-core`, inyección de `ring_scene` +
  `flash_runtime` y puente al `:9999` (`hub-bridge.cjs`). Sin
  `--remote-allow-origins=*`: el puerto CDP no acepta páginas web.
- La cuenta se guarda en `userData/game-account.json`, contraseña cifrada con
  `safeStorage` (DPAPI del usuario de Windows).
- Si el juego ya tenía otro runtime cargado (una sesión anterior), el Hub lo
  recarga: `flash_runtime` nunca se instala dos veces en la misma página, y un
  runtime viejo en memoria explicaba timing en T+0 fijo y coco guard sin
  aplicar aunque el Hub fuera el correcto. La barra lateral muestra el build
  del runtime conectado.
- Runtime v6_62 original (sha256 `3fc2dabb06a7fa53fd4ca548230e233a272973e541ad0d85b61cc4d2373b5968`).
  El 03/10 a las 17:40 Gemini cambió `HTML5/hub_runtime/flash_runtime.page.js`
  sin cambiar el build: STEP armaba disparos contra cualquiera que se moviera,
  `threatPick` sumaba +5000 al seleccionado, coco a cualquiera en diagonal
  durante la animación (con el cupo contado dos veces), guards fuera del Ring
  y el avatar en cada `state`. Se recuperó desde la copia de Gemini anterior
  a esos cambios, sin su código de avatar; tiene lo documentado de v6_60–v6_62.
  `sync-runtime` rechaza un runtime con esos cambios.
- "Llegada del click" se guarda al elegirla. Antes solo se guardaba junto con
  otro ajuste: un T+N manual tocado una vez volvía en cada inicio (`auto:
  false` en las capturas del 03 y 04/10, contra `auto: true` el 02/10), sin
  aprender, y en T+0 los clicks rebotaban.
- Runtime v6_63 (`react_after_blind`): la reacción ya no se anula porque el
  click del tick haya ido al mismo rival si ese click salió a ciegas (antes
  del lote). En la sesión del 02/10, 8 de 15 muertes fueron un click a ciegas
  al asesino sin reacción; el 04/10, la muerte capturada también (click a
  ciegas 161 ms antes de que llegara, sin 144, golpe del rival en T+253; la
  reacción aterriza ~T+170). `sync-runtime` no baja de versión.
- Runtime v6_64 (`floor10`): Auto vuelve a no bajar de T+10, como en v6_44.
  El piso del 01/10 seguía al jitter medido y en una sesión limpia (sigma 2-3)
  bajaba hasta T+4 (04/10: 111 de 154 primeros clicks en T+4). Las capturas
  del 03/10 se quedaban en T+12 solo porque el jitter medido ahí era alto.
- Prioridad del cliente: renderers de BoomBangHTML5.exe en High, resto en
  AboveNormal, reaplicado cada 15 s.
- Diagnósticos de combate apagados en la versión distribuida.
- Inicio muestra nuestro personaje (diseño traído de la rama de Gemini): el
  lanzador lee `#BoomBangFlowerPowerAvatar` del juego cada 4 s, fuera del
  runtime (Gemini lo mandaba en cada `state`, 4 veces por segundo, dentro del
  camino del timing). Un `blob:` sale como data URL.
- `npm run sync-runtime` copia `HTML5/hub_runtime/{flash_runtime,ring_scene}.page.js`
  a `electron/game/`; `protect` imprime el build del runtime que empaqueta y lo
  ofusca sin string array (renombrado solamente, para no tocar el timing).

Verificado en Linux: núcleo protegido (bytecode + ofuscación) contra el
original con la misma sesión simulada, 80 mensajes al runtime idénticos;
runtime ofuscado contra el original en Chromium, misma API y mismo arranque;
lanzador de punta a punta contra Chromium real con iframe del juego en otro
proceso, runtime viejo precargado y cierre del juego; `playwright-core` desde
un `.asar` con Electron 44. Pendiente en Windows: login real, 2FA y
`BoomBangHTML5.exe`.

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
