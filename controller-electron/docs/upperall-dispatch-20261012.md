# Timing / UpperAll: revisión del 12 de octubre

Prueba local: `ABRIR_TIMING_PRUEBA.cmd`. Runtime esperado:
`12102026_html5_upperall_dispatch_preview`.

La versión del paquete sigue en 0.1.21. Esta revisión no publica instaladores ni
actualizaciones; tampoco modifica licencias, activación, cuentas o el cifrado del
cliente. El runtime de `electron/game` se sincroniza con `HTML5/hub_runtime`.
Autoclick por paso conserva su destino exclusivamente fichado y sus controles.

## Fallos comprobados y cambios

- **Fin de coco mal interpretado.** UserCocoPotion 184/120 termina un efecto
  cuando su tercer campo vale cero, aunque el segundo siga siendo positivo.
  Los registros del 12/10 contienen un inicio `35,35` seguido 7001 ms después
  por `1,0`; el código anterior lo trataba como otro coco de siete segundos.
  Ahora solo los tipos 32..41 inician coco, y la terminación libera la cuenta,
  conserva el aprendizaje de duración y actualiza la salida del rival.
- **Identificación tardía y resync.** Si el efecto precede a nuestro avatar,
  se recupera por cuenta manteniendo su vencimiento original. AnimResync 215,
  kind 2, aporta edad y duración restantes. Su parámetro no es un tipo 184:
  no aprende tipos inventados ni cuenta cocos gastados. Rechaza cuentas/IDs
  incoherentes y tiempos inválidos. No usa la duración visual de Upper para
  modificar el bloqueo del servidor.
- **Pedidos diferidos ligados solo al ID.** RETRY, RUNLOCK, EXIT y las ventanas
  STEP retienen identidad nativa. Un cambio de avatar, salida, cambio de sala,
  desactivación o nueva generación cancela el pedido correspondiente. RETRY
  vuelve a comprobar contacto, trabas y el último hueco de envío. Un rechazo
  tardío no duplica una reacción de contacto que ya fue enviada.
- **Estados heredados entre ocupantes.** Un nuevo ocupante no hereda mute,
  bloqueo o historial de contacto del ID anterior. Una reconstrucción continua
  de la misma cuenta mantiene su bloqueo de Upper. Los espectadores de Ring
  siguen eliminados hasta la próxima ronda.
- **Preflight obsoleto.** Cada paso nuevo invalida la decisión preparada,
  incluyendo “sin amenaza”. Antes de enviar también comprueba eliminación,
  identidad, aliado, mute y bloqueo. Si el objetivo dejó de ser elegible,
  calcula el rival actual en lugar de perder ese turno.
- **Reloj contaminado o duplicado.** Solo movimientos de jugadores, modo 1 de
  182, alimentan el tick. Worker y socket-entry comparten la llegada original
  por fingerprint FIFO acotado, tanto para fase como para el reloj del actor.
  Un cambio de sala/gong en el mismo batch recupera su primera muestra; una
  entrada fallida `128/120 [-1]` conserva la sala y el reloj.
- **Correcciones de posición 135.** La reconciliación nativa actualiza la
  posición sin inventar pasos. Una revisión de movimiento impide que una
  rotación vieja de la cola RAF borre un 182 posterior. Conserva la última
  revisión por posición porque el cliente puede comprimir rotaciones durante
  catch-up. Las llamadas y errores del renderer original se mantienen.
- **Caminos antiguos de selección.** STATE, contacto, landing y Pulse automático
  eligen su rival independientemente de ficha. STATE agrupa callbacks y vuelve
  a decidir al enviar. Contacto no consume su oportunidad si el envío falló o
  el hueco todavía no abrió. Pulse manual conserva su selección.
- **Sweep vacío.** Reutiliza el turno ya programado para el rival original solo
  si sigue siendo la mejor amenaza elegible y mantiene la identidad. No añade
  pedidos al plan ni sustituye un runner-up válido.

## Contratos del cliente comprobados

Referencias principales: `HTML5/recon/live-20261002/.../deobfuscated.resolved.js`,
`HTML5/recon/audit-20261003-bundles/renderer.strings.js` y extracciones del 09/10.

`upperRequest` construye 211 con un único roomId; el 211 entrante lleva atacante
en campo 2 y defensor en campo 6. La salida marca `__departing` o `_removed`
antes de borrar el avatar. UserRotate 135 aplica posición y cancela movimiento.
AnimResync 215 contiene roomId, cuenta, kind, param, peer, edad y duración.

El socket nativo recibe el worker antes de encolar el renderer para RAF.
No encontramos un retraso fijo extra en Upper ni evidencia suficiente para
cambiar el cifrado, el alcance lateral, el bloqueo de Upper de 14 s o afirmar
un cambio del servidor. Una llamada a la API nativa no demuestra aceptación
del servidor.

## Validación y prueba real pendiente

19 verificaciones pasan: sintaxis, seguridad del runtime y **222 casos** de
dispatch, inbound, coco, resync, orden del renderer, identidad, selección,
defensa, preflight, sweep/retry, contacto, aprendizaje y Autoclick, incluyendo
48 escenarios del harness completo. Se actualizaron expectativas antiguas de
dos callbacks de reacción y del clock de mascotas; los escenarios que reutilizan
tiempos absolutos se aislaron para no inventar cooldowns desde el futuro.

Resultados: `tmp/upperall-20261012/verify-result.json` y logs por suite.
El runtime anterior se conserva en `tmp/upperall-20261012/runtime-before.js`;
el diff específico de esta revisión está en `runtime-changes.patch`.

Estas pruebas verifican decisiones y contratos, no victoria ni latencia real
del servidor. Falta probar una partida con este build. Cerrar Hub/juego, abrir
`ABRIR_TIMING_PRUEBA.cmd`, mantener Autoclick por paso apagado, activar Registro
de combate y jugar con las opciones habituales de Timing. Comprobar el build
en el Hub antes de evaluar los cruces y los rivales que entran mientras estamos
quietos.
