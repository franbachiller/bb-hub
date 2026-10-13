# BB Hub — distribución Windows

## 0.1.24 — Timing fichado y publicación completa

Mismas mejoras del runtime probado en la rama de desarrollo: opción AUTO/SELECTED, recuperación del único primario al fin de animación, filtro de silencio corregido para jugadores de Ring y controles simples de Autoclick. El azul es un cruce visual completo, no una calibración del servidor.

Reemplaza 0.1.23, publicada en Cryptlex sin SHA256. Esta release contiene los dos archivos externos verificados antes de publicar. Validación de bytecode, UI/activación empaquetadas, fuses, integridad ASAR y descarga pública con SHA256. Motor, cuentas, licencias y updater conservan su código probado. Entrega: `DISTRIBUCION/BB Hub 0.1.24 Windows x64`.


## 0.1.22 — Timing de un pedido y Autoclick por paso

Promueve el perfil probado por el propietario (9 golpes propios y 2 recibidos):
T+13 ms fijo, un solo pedido anticipado por paso y selección automática. Sin
reintentos, reacción adicional ni aprendizaje que cambie esa fase. El motor
del juego conserva exactamente el hash probado; el Hub empaquetado activa el
perfil al conectar, antes de la configuración guardada.

Autoclick por paso conserva como único objetivo la ficha nativa. Corrige pasos
cortos y continuos, retiene el cruce útil en azul y prepara una ventana de
envío con compensación estimada de RTT. Un envío no confirma aceptación.

Validación: 270 casos/grupos locales, perfil del bytecode protegido, UI y
activación empaquetadas; ASAR extraído del instalador idéntico al paquete.
Entrega en `DISTRIBUCION/BB Hub 0.1.22 Windows x64` y manifiesto
`docs/releases/0.1.22.json`. Cuentas, licencias y updater conservan su flujo.

## 0.1.16 — Timing del 02/10 y respaldo en la salida de coco

Preparada para distribuir; sin publicar en Cryptlex ni en el repositorio de
instaladores. Runtime `05102026_html5_hub_v6_62_og_exit_backup`: las decisiones
de Timing son las del v6_62 del 02/10 (sha256 normalizado 3fc2dabb...). Se
retiran v6_63..v6_73 (0.1.7-0.1.12): reelección de contacto, objetivo automático
en cada movimiento y bloqueo por `__departing`.

- Salida de coco en modo "1 click": respaldo 105 ms después del primer golpe.
  Final de Ring del 05/10: el único golpe se apuntó al fin estimado del coco, el
  fin real llegó 42 ms después y el server lo ignoró; la reacción quedó retenida.
  Silencios de salida: 0 de 81 del 01-03/10, 5 el 04-05/10.
- El runtime envía `timing_target` con cada golpe automático: el Hub muestra el
  objetivo al instante (antes, estado de 250-700 ms más refresco de UI).
- El juego vuelve a correr con sus renderers en prioridad High (cada 15 s).

Validación: 48 casos históricos del runtime, runtime-security, client-discovery,
port-conflict, pro-hotkey-updater y avatares sobre el paquete. No se corrieron las
regresiones de timing v6_68+ (prueban lo que se retira) ni las pruebas que abren
el Hub empaquetado sobre el perfil en uso. Instalador sin firma, como los anteriores.
Entrega: `../DISTRIBUCION/BB Hub 0.1.16 Windows x64.zip`; manifiesto
`../docs/releases/0.1.16.json`.

## 0.1.12 oficial — reelección de contacto y avatares en retirada

Durante la espera del intervalo de envío, la reacción conservaba el primer
objetivo. Si se movía, salía o quedaba eliminado/bloqueado, cancelaba el golpe
aunque otro rival del mismo lote siguiera en contacto. v6_73 vuelve a elegir
entre los contactos nuevos originales al ejecutar la reacción. Conserva el
intervalo real, la cancelación por cambio de sala/lote, eliminación propia o
Timing apagado y la prevención de duplicados. No añade objetivos de contactos
anteriores ni cambia el aprendizaje, la repetición o las opciones del usuario.

El cliente puede conservar un avatar marcado `__departing` mientras termina
su animación. Ese objeto ya no es un rival elegible para el cliente nativo.
Timing ahora consulta la marca en su filtro de entidades y rechaza tanto la
elección como los envíos automáticos retenidos hacia ese avatar.

La investigación y sus límites están en `../docs/timing-investigacion-2026-10-05.md`.
Ambos defectos se reproducen; no se ha demostrado que expliquen todas las
derrotas ni que la eficacia contra el servidor vuelva a ser la anterior.
El propietario solicitó oficializar esta versión el 05/10/2026. Se promueve
el mismo instalador verificado, sin recompilar ni cambiar sus bytes. Conserva
los arreglos anteriores de Timing y Board y el retorno local a 0.1.11.

Validación: 55 casos dirigidos en el runtime del ASAR protegido, 48 casos
generales offline con el wrapper de reloj fijo, Board automático/persistencia
y permisos, UI/activación, detección del cliente, conflicto de puerto y
actualizador. El ASAR del instalador coincide con el paquete probado; conserva
bytecode, fuses e integridad. No contiene cuentas ni ajustes personales.
Los lanzadores se comprobaron con el arranque de la aplicación simulado.
Entrega: `../DISTRIBUIBLE_0.1.12/BB Hub Setup 0.1.12.exe`; en esta PC,
`../ABRIR_TIMING_PRUEBA_0.1.12.cmd`, runtime `v6_73_contact_reselect`.
Resultado verificable de la prueba: `../docs/releases/0.1.12-test.json`.
Promoción oficial y publicación: `../docs/releases/0.1.12.json`.

Publicada en el repositorio público de instaladores y en Cryptlex Production,
canal `stable`, plataforma `windows`. La descarga pública conserva tamaño y
SHA256 de la prueba. El código sigue privado. El catálogo y sus dos archivos
se verificaron en el panel; la prueba nativa de actualización con activación
local no pudo completarse (`LA_E_CLIENT`, luego sin activación utilizable en
el proceso QA). No se activaron/desactivaron licencias ni se cambiaron permisos.

## 0.1.11 de prueba — oportunidad vacía y reacción pendiente

En el cruce con Launch del 04/10 a las 18:40:19 (Argentina), salieron dos
pedidos al ID correcto, 440 y 264 ms antes del golpe recibido. Ninguno tuvo
confirmación. Esto no demuestra la causa de todos los fallos ni dónde se
ignoraron esos pedidos. El golpe manual posterior sí tuvo confirmación y usa
el mismo formato de paquete 211, con tres envíos separados por unos 120 ms.

La reproducción con las posiciones registradas muestra una oportunidad vacía:
el sweep excluía al objetivo principal y no enviaba nada si no había segundo
candidato. v6_72 conserva la preferencia por el segundo rival; si no existe,
revalida al principal y aprovecha ese disparo ya programado solamente si sigue
siendo el mejor candidato válido y pasó el intervalo de 100 ms del último envío.
No añade temporizadores de disparo ni cambia los ajustes del usuario.

La reacción pendiente vuelve a comprobar ese intervalo al ejecutarse, por si
otro disparo salió mientras esperaba. Su temporizador de respaldo se cancela
lógicamente tras un envío exitoso: no produce un duplicado. El registro conserva
también las razones de omisión de los disparos secundarios, los bloqueos de IDs
y las reentradas de isla para poder investigar la siguiente pelea.

Se conservan las correcciones de IDs/eliminaciones de 0.1.9 y la persistencia
del Board automático de 0.1.10. Licencias, Cryptlex, cuentas y selección manual
sin cambios. Prueba local; falta validar su eficacia jugando contra el servidor.

## 0.1.10 de prueba — Board automático en el instalador

Al activar el modo automático de Timing, `setAutoRun` habilita la sala y arma
Board. La política de salas se intentaba guardar dentro de `resources/app.asar`,
un recurso de solo lectura. El registro contiene `ENOTDIR` en
`ScenePolicyStore.markSceneAllowed`; el fallo se reproduce con el paquete 0.1.9
al ejecutar la activación real del Controller. La memoria de rivales usaba
la misma ubicación incorrecta en el worker.

En Electron, política y memoria se guardan en `app.getPath("userData")/ring-board`.
El proceso principal pasa esta ubicación al worker, incluidos sus reinicios.
La primera apertura copia los valores iniciales del paquete; las siguientes
conservan las modificaciones y el aprendizaje del perfil. El Board independiente
en Node conserva su carpeta `data`. No se cambian el solver, las decisiones de
Timing v6_71 ni las licencias.

Validación: reproducción de la excepción en el ASAR anterior, compilación
TypeScript, persistencia y comprobación del flujo automático en el paquete nuevo.
La prueba usa un perfil temporal y sensores simulados; no paga entradas ni abre
cuentas del juego. Falta confirmar el ciclo contra el servidor real.

La suite general antigua de Board tiene 13 pruebas fallidas y una suite que
importa un `strike-planner.js` inexistente; la misma ejecución en una copia
aislada de HEAD reproduce esos fallos antes de esta corrección. Se conservan
como deuda previa y no se cambian los cerebros para hacerlas pasar.

## 0.1.9 de prueba — eliminación e IDs válidos al disparar

Un objetivo retenido por un repeat/burst/exit podía recibir un pedido automático
después de que un 211 lo marcara eliminado. El selector inicial filtraba muertos,
pero el envío final no validaba decisiones ya guardadas. Ahora el envío automático
requiere un avatar actual, no obsoleto y no eliminado; el control manual se conserva.

`refreshEliminated` también aplicaba a Ring la regla de reentrada de islas:
un ID eliminado que desaparecía y reaparecía se volvía elegible sin nueva ronda.
En Ring la eliminación permanece hasta el cambio de ronda/sala. En islas se detecta
también el reemplazo de avatar entre dos comprobaciones de 100 ms, y la reentrada
propia limpia tanto `selfOut` como la pausa antigua.

Se conservan v6_70, sus decisiones de Timing y la independencia de la ficha;
no es otro rollback. Seis regresiones prueban envíos pendientes, reemplazo de
espectadores, nueva ronda, reentrada y caché de IDs. Las pruebas históricas de isla
se ajustan para usar una escena de isla y recrear avatares como el cliente real.

La observación del cliente v6_70 confirmó la salida de 11 punches por WebSocket,
con 0,7–1,5 ms desde el envío al worker hasta el socket. No demuestra aceptación
del servidor ni excluye otros fallos intermitentes. Los defectos de estado se
reprodujeron fuera del juego; falta validar v6_71 jugando en Ring.

Runtime: `04102026_html5_hub_v6_71_alive_targets`. Entrega local de prueba,
sin publicación remota. Licencias, Cryptlex, cuenta y UI sin cambios.

## 0.1.8 de prueba — reacción al contacto después de un intento anticipado

El registro del 04/10/2026 a las 15:18:44 (Argentina) muestra a Herbert
quieto en 19,13 y a Dylaan entrando en 18,12. Timing envió un `TICK_BLIND`
al rival 365 ms antes del golpe recibido; el movimiento que confirmó el
contacto llegó 199 ms antes de ese golpe. No hubo confirmación del intento
propio en ese intervalo. `reactCheck` anulaba la reacción porque el rival
ya figuraba como objetivo del intento anticipado, equiparando envío con
contacto cubierto.

v6_70 conserva la reacción si el último disparo hacia ese rival salió
antes del batch que confirmó el contacto. Respeta el gap existente de
100 ms; una confirmación de impacto, cambio de sala o desactivación
cancela el disparo pendiente. Un disparo al mismo rival posterior al batch
sigue evitando duplicados. Un rechazo tardío del intento anticipado no
añade un tercer click cuando la reacción ya salió.

La prueba reproduce los tiempos y posiciones registrados, con nuestro
personaje quieto, en Ring y escenas fuera de Ring. Falló con v6_69 y pasa
con la corrección. Se mantienen las 48 pruebas de combate, selección,
aprendizaje y posición; se verifica también el runtime del paquete protegido
y su correspondencia con el instalador. Esto demuestra el fallo y la
corrección de esa supresión; no prueba todavía que explique todos los
cruces omitidos ni que gane la carrera en el servidor real.

Entrega local: `../PRUEBAS_0.1.8/BB Hub Setup 0.1.8.exe`, runtime
`04102026_html5_hub_v6_70_confirmed_contact`. Conserva 0.1.7, licencias y
Cryptlex. Pendiente validación jugando; sin publicación remota.

## 0.1.7 de prueba — ficha independiente del combate automático

El usuario observó que un clic para fichar parecía cambiar a quién golpeaba
Timing. La auditoría confirmó que el selector TICK principal de v6_68 ya
elegía por amenazas sin consultar la ficha. Se encontraron dependencias
reales en los modos antiguos STEP/contacto/landing/STATE/GRID/MOVE_DELAY,
el pulso automático y las preferencias enviadas a Board. Esto no demuestra
todavía que la ficha sea la causa de la pérdida de reacción del TICK actual.

El runtime v6_69 usa amenazas y proximidad en esas rutas antiguas, da prioridad
a la proximidad cuando el pulso es automático y no permite que un disparo
automático sin rival válido caiga al fichado. Board recibe la selección sin
preferencias y las entidades sin `targetLock`. El TICK activo evita incluso
leer el getter nativo de la ficha en su ruta de movimiento. No se modifican
su calibración, compensación, ventana ni cooldowns.

La UI distingue «Fichado» de «Último disparo de Timing», calculado después de
enviar realmente el golpe. Esa información se reinicia al cambiar de sala
y nunca presenta a nuestro propio personaje como rival automático.

La entrega local está en `../PRUEBAS_0.1.7/BB Hub Setup 0.1.7.exe`.
Pruebas de selección: sin fichar, fichado propio, rival próximo, lejano y
aliado; contacto entre cuatro enemigos; rutas heredadas; preferencias de
Board; reporte del golpe; movimiento STATE con la opción TICK inactiva aún
marcada. También se comprueban las 48 pruebas del harness y las regresiones
de posición, aprendizaje y contacto. Se verifica de nuevo el núcleo
protegido, la UI empaquetada y el ASAR extraído del instalador.

El sistema de licencias, configuración de Cryptlex, detección del juego,
conexión por puerto libre y keko/nombre se conservan. El instalador excluye
cuentas y ajustes personales. Esta versión aún requiere validación jugando;
0.1.6 sigue siendo la entrega confirmada en dos PCs de clientes. La prueba
no se publica en GitHub ni en el actualizador.

## 0.1.6 — conexión cuando el puerto está ocupado

El registro del cliente confirmó `EADDRINUSE` en `127.0.0.1:9999`: el juego
cargaba el runtime, pero el controller de esa ventana no podía escuchar.
El Hub integrado conserva 9999 como primera opción y, si está ocupado, pide
un puerto libre a Windows. El lanzador espera a que ese servidor esté listo
y usa su puerto real. Los lanzadores externos conservan el puerto fijo.

«Juego conectado» ahora exige que el controller reciba mensajes desde el
socket de ese lanzador y reconozca su build. Un runtime que quedó abierto
puede identificarse con su mensaje periódico `state`, sin repetir `hello`.
Los errores del puente también muestran el puerto y código en Registro.

Pruebas: conflicto real de puerto, ida y vuelta hello/state/config por TCP,
ausencia de tráfico hacia el proceso ajeno, rechazo de una conexión sin el
runtime esperado, parada y reinicio, núcleo/lanzador protegidos del ASAR,
renderer/preload empaquetados y regresiones de timing. La entrega es
`../DISTRIBUIBLE_0.1.6/BB Hub Setup 0.1.6.exe`.

Conserva el runtime v6_68 byte por byte, la detección de instalaciones de
0.1.5 y la UI de keko/nombre. No cambia el sistema de licencias ni incluye
cuentas o ajustes personales. El 04/10/2026 el usuario confirmó que la
actualización funciona correctamente en dos PCs de clientes distintos.

## 0.1.5 — ubicación del cliente HTML5

Cuando el cliente oficial estaba instalado fuera de la ruta fija de Roaming,
el Hub mostraba «No se encontró BoomBang HTML5». Se añadió detección en
Roaming/Local y lectura de la ubicación de HTML5 registrada por el launcher
en `installed.json`. Inicio permite volver a buscar o seleccionar
`BoomBangHTML5.exe` mediante el selector de archivos de Windows. Esa selección
se guarda en las opciones del juego y se conserva al reiniciar.

Se validan el nombre y la existencia del archivo; una selección cancelada
conserva la configuración. Los IPC nuevos siguen sujetos a los controles de
ventana y licencia. Las pruebas cubren carpetas con espacios y caracteres no
ASCII, rutas personalizadas, una instalación eliminada, metadatos inválidos,
persistencia y la interacción con el renderer/preload empaquetados.

La entrega es `../DISTRIBUIBLE_0.1.5/BB Hub Setup 0.1.5.exe`, con su SHA256 e
instrucciones. El ASAR extraído del instalador coincide con el que pasó las
pruebas. Mantiene el runtime v6_68 de 0.1.4 con el mismo hash, la UI de keko y
nombre y la configuración de Cryptlex. No incluye una cuenta del juego ni
ajustes personales. No se ha verificado todavía en la PC remota del cliente.

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
  El 03/10 a las 17:40 la versión experimental cambió `HTML5/hub_runtime/flash_runtime.page.js`
  sin cambiar el build: STEP armaba disparos contra cualquiera que se moviera,
  `threatPick` sumaba +5000 al seleccionado, coco a cualquiera en diagonal
  durante la animación (con el cupo contado dos veces), guards fuera del Ring
  y el avatar en cada `state`. Se recuperó desde la copia experimental anterior
  a esos cambios, sin su código de avatar; tiene lo documentado de v6_60–v6_62.
  `sync-runtime` rechaza un runtime con esos cambios.
- "Llegada del click" se guarda al elegirla. Antes solo se guardaba junto con
  otro ajuste: un T+N manual tocado una vez volvía en cada inicio (`auto:
  false` en las capturas del 03 y 04/10, contra `auto: true` el 02/10), sin
  aprender, y en T+0 los clicks rebotaban.
- Runtime: el v6_62 original del 02/10 (`02102026_html5_hub_v6_62_exit_pick`,
  sha256 3fc2dabb…), elegido por el usuario. Se descartaron v6_63, v6_64 y la
  prueba con v6_44 del 04/10. `sync-runtime` no reemplaza el runtime
  empaquetado por otro build sin `--force`.
- El runtime del juego se empaqueta sin ofuscar (idéntico a
  `electron/game/flash_runtime.page.js`). El 04/10 el usuario jugó el mismo
  runtime sin ofuscar con `ABRIR_HUB_VIEJO.cmd` y volvió a reaccionar como
  siempre, cosa que con el Hub instalado (runtime ofuscado) no pasaba.
  `BB_PAGE_OBF=1` lo vuelve a ofuscar. El proceso principal sigue en bytecode.
- El lanzador abre el juego igual que `ABRIR_HUB_Y_CONTROLLER.cmd` (mismos
  flags, `--remote-allow-origins=*` incluido). Se sacó la prioridad High que
  se reaplicaba cada 15 s con PowerShell; el `.cmd` nunca la usó.
- Diagnósticos de combate apagados en la versión distribuida.
- Inicio muestra nuestro personaje (diseño traído de la rama experimental): el
  lanzador lee `#BoomBangFlowerPowerAvatar` del juego al conectar y 15 s después, fuera del
  runtime (versión experimental lo mandaba en cada `state`, 4 veces por segundo, dentro del
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
