# Investigación de Timing — 5 de octubre de 2026

Se encontraron dos defectos reproducibles del motor actual y se preparó una corrección aislada. **Todavía no está demostrada la causa completa de la pérdida de eficacia en Ring ni una recuperación del rendimiento en partidas.** El golpe manual funciona según la confirmación del usuario; no hace falta repetir esa prueba.

La investigación revisó el runtime actual y el backup del 2 de octubre, el cliente oficial desofuscado de la última captura (`r2e01cc70d40f`), su transporte, movimiento, selección, retirada de avatares y animaciones. El análisis adicional recorrió 61 archivos de sesiones de octubre en `HTML5/captures` y el registro local del Hub. La identificación histórica de Ring depende de las señales guardadas: las muestras no son un experimento controlado y algunas entradas directas a un Ring carecen del comienzo de ronda en el registro.

## 1. Una reacción pendiente puede perder todos sus objetivos

En `reactCheck`, el motor elige un único rival y llama a `reactPick(true)`. Esa llamada marca **todos** los vecinos actuales como contactos ya conocidos. Cuando el disparo debe esperar por el pedido anterior, el callback conserva exclusivamente el primer rival.

Si ese rival sale del contacto, desaparece, queda eliminado o entra en su bloqueo antes del callback, la reacción termina sin disparar. Otro rival que sigue al lado ya quedó consumido por el conjunto de contactos anteriores: una nueva revisión no lo reconoce como entrada nueva. La oportunidad depende entonces de otros disparadores, como el próximo tiro del tick.

**Prueba:** fixture con dos contactos recién entrados, un pedido anterior a `9946 ms` y la ventana siguiente a `10047 ms`. Con v72 no sale ningún pedido cuando el primero deja de servir. La copia corregida envía uno al segundo en esa misma ventana, manteniendo los 101 ms entre pedidos. También se comprobaron eliminación, bloqueo, silenciamiento, cambio de ronda, apagado de Timing y ausencia de alternativas.

**Corrección aislada:** conservar los IDs de los contactos nuevos de ese lote y volver a elegir entre ellos cuando abre el hueco. Reutiliza los filtros existentes; no exige fichar y no adelanta un envío dentro del cooldown.

Este defecto es especialmente pertinente cuando hay varios rivales. **No se ha identificado todavía un episodio registrado de los últimos duelos que permita atribuirle esa derrota específica.** El mecanismo de conservar un único objetivo también existe en el backup del 2/10: no corresponde presentarlo como una incorporación exclusiva de la distribución.

## 2. Un avatar presente en el mapa puede haber salido del servidor

El cliente oficial, en `RemoveUserFromSpace`, puede recibir la baja de un jugador y conservar su objeto mientras termina la animación. Le coloca `__departing = true`, desactiva su sombra y lo retira del mapa después. `isAvatarSombraSelectable` rechaza explícitamente ese estado.

Timing comprueba que el ID siga en `avatars`, que no esté en `out` y que no pertenezca a una sala anterior. No consulta `__departing`. Por eso **la presencia del objeto no garantiza que el jugador siga en la sala**, y el motor puede escogerlo o repetirle un pedido. Puede ocurrir si no conoce previamente su eliminación, por ejemplo al entrar a una sala o ante una salida durante otra animación.

**Prueba:** con un rival lateral, presente en `avatars` y marcado `__departing`, v72 lo selecciona y emite un pedido automático. La copia corregida lo excluye de la selección y del envío automático. El control manual de la API permanece intacto.

**Corrección aislada:** incorporar exclusivamente esa marca de retirada al filtro existente de entidad no válida. No se usó la apariencia, el nombre, la invisibilidad ni el hecho de que un jugador esté quieto como criterio de exclusión.

La misma marca del cliente ya existía en los recursos del 2/10. Esto demuestra una validación incompleta, pero no demuestra por sí solo el origen temporal de la regresión. Las capturas históricas no contienen esa propiedad por avatar, así que no permiten cuantificar retrospectivamente cuántos pedidos fueron a entidades en retirada.

## 3. Espera local comprobada: repetición y reacción compiten por el mismo hueco

En dos derrotas de Ring del 4/10, a las 20:45:57 y 20:47:39 de Argentina, la reacción al contacto confirmado esperó aproximadamente 43 y 42 ms por el reintento anterior. Los pedidos reales salieron aproximadamente 46 y 50 ms después del movimiento recibido. En la victoria de las 20:44:55 también hubo espera, de alrededor de 55 ms.

Esto confirma una pérdida concreta de inmediatez de la reacción. **No confirma que esa espera sea la causa única:** antes del contacto ya habían salido pedidos al rival correcto. El segundo click a +105 ms también aparece en sesiones antiguas que funcionaban bien.

El vector pendiente es arbitrar las oportunidades entre anticipación, repetición y contacto confirmado, usando evidencia de aceptación y de contacto. No se quitó el cooldown ni se cambiaron las opciones del usuario para fabricar una mejora. La copia preparada corrige la pérdida de alternativas durante la espera, pero conserva ese límite de envío.

## Información del juego que merece aprovecharse

| Señal | Lo que demuestra el código o el registro | Uso posible y límite |
| --- | --- | --- |
| Baja `128/123` y `__departing` | El servidor puede haber retirado un jugador aunque el renderer conserve su objeto. | Validar la entidad y evitar objetivos fantasma; corrección preparada. |
| Rechazo `144` con campos | `ErrorUpper` admite motivo y valor. Se encontraron 8 `zone_blocked` y 1 `not_hunter` en una sesión antigua. Los 144 de las dos sesiones v72 analizadas no tenían campos. | Separar restricciones de sala de rechazos geométricos; no usar cualquier rechazo con motivo como muestra del borde de contacto. No explica los últimos duelos de v72. |
| Resincronización `215` | `AnimResync` lee ID de sala, ID de cuenta, tipo de animación, datos asociados, tiempo transcurrido y duración opcional. El cliente usa esos tiempos para recuperar una animación iniciada antes de entrar. | Recuperar conocimiento de animaciones ya activas al entrar y evitar tratar a todos como libres. Es información de animación: su duración no demuestra la duración exacta de la inmunidad del servidor. No se sustituyeron los bloqueos medidos por duraciones visuales. |
| Indicador de continuación del `182` | El cliente lee el último campo como indicador de último paso. Timing lo guarda, pero `threatPick` no condiciona su modelo por ese campo. | Candidato a predictor; se evaluó por separado y no mostró una mejora de elección suficiente para incorporarlo. |

No se encontró en el código leído un campo adicional del pedido `211` que convierta el golpe automático en uno distinto del manual. `upperRequest` construye un `211` con el ID de sala del objetivo. Los IDs de cuenta se usan en otras señales, como coco y resincronización; mezclar esos espacios de IDs sería un error.

El cliente dibuja golpes en otras direcciones y hace una estocada visual a distancias mayores. Eso **no demuestra un mayor alcance permitido por el servidor**. Tampoco se tomó el emulador no oficial mencionado en las memorias como código o reglas del servidor oficial.

## Evaluación del modelo de objetivos con datos reservados

Se entrenaron dos variantes con las sesiones del 1/10 UTC y se evaluaron con las del 2/10 UTC, sin entrenar sobre las de evaluación. Son 8.509 lotes de entrenamiento y 5.003 lotes de evaluación, con 8.244 ejemplos de rivales cercanos. El análisis excluye eliminaciones y bloqueos de upper conocidos; no puede reconstruir todos los cocos ni las posiciones iniciales.

| Modelo | Error probabilístico Brier, menor es mejor | Objetivo correcto en 395 lotes con varios candidatos y contacto |
| --- | ---: | ---: |
| Julio, actual | 0,04664 | 348 |
| Octubre, sin separar continuación | 0,04613 | 342 |
| Octubre, separando continuación | 0,04569 | 346 |

La variante con continuación mejora ligeramente la calibración probabilística, pero **no mejora la elección del objetivo** en esta evaluación. No se incorporó al producto.

Estos resultados están condicionados a conocer la próxima casilla real propia: aíslan la predicción del rival y no validan la proyección de nuestro movimiento. No son porcentajes de victorias, ni una simulación completa del motor, ni una promesa de mejora en Ring.

## Transporte y límites de lo medido

La comparación anterior encontró equivalentes los 72 miembros principales de Socket/Ping tras normalizar nombres. En la captura de isla verificada, 12 pedidos automáticos llegaron de la API al envío real del WebSocket en aproximadamente 1,0–1,7 ms. Esa muestra no cubre los duelos de Ring anteriores. No permite concluir que la conexión nunca se demore, ni que el servidor haya aceptado esos golpes.

Los registros de los duelos recientes contienen pedidos al ID del rival que terminó golpeándonos. El análisis adicional no encontró pedidos a uno mismo en los tramos de Ring identificados de octubre. Esto no sustituye la validación completa de entidades, ni justifica descartar la observación del usuario de que la reacción perdió eficacia.

Las conclusiones antiguas sobre una moneda del servidor o una retención fija son modelos inferidos de capturas; **no son una lectura del servidor oficial ni una explicación demostrada de esta regresión**.

## Corrección preparada y verificación

La copia está en `tmp/duel-deep-20261005/flash_runtime.contact_candidate.js`, identificada como `05102026_html5_research_contact_reselect`. Solo cambia la elección al ejecutar una reacción pendiente y el filtro de `__departing`.

Pasaron **51 casos dirigidos**: 9 de reacción nueva, 1 de retirada, 8 de contacto existentes, 12 de barrido/reintento, 6 de entidades vivas, 9 de independencia del fichado, 3 de aprendizaje y 3 de integración con el renderer.

La suite general antigua no está completamente en verde: tanto v72 sin cambios como la copia fallan en el mismo punto porque la prueba busca persistencia en `bbhub.tickAuto.v5` y el runtime actual usa `v6`. Antes de ese punto pasan 12 comprobaciones. Se reprodujo el fallo contra la base para evitar atribuírselo al candidato. El reloj fijo de ese harness exige limitar los giros de espera dentro del fixture; ese ensayo no mide rendimiento real.

Las pruebas, resultados JSON y trabajos reproducibles están en `tmp/duel-deep-20261005/`. No se ejecutaron golpes, navegación, nuevas sesiones, cambios de cuenta ni pruebas activas contra jugadores durante esta investigación.

Al terminar la investigación, el instalador y los runtimes canónicos seguían siendo v72. Ambos conservaron SHA-256 `b4c8a9d150215375d911bf981ece2a0408614740a035aeb1f6e9d7dfbb3d529d`. No se modificaron Cryptlex, claves, cuentas, opciones de juego ni movimiento; no se publicó ni se pusheó esta copia.

Después, a pedido del usuario, se preparó **0.1.12 de prueba**, runtime `05102026_html5_hub_v6_73_contact_reselect`, incorporando exclusivamente las dos correcciones descritas a las fuentes y al paquete protegido. El instalador está en `PRUEBAS_0.1.12/BB Hub Setup 0.1.12.exe`; `ABRIR_TIMING_PRUEBA_0.1.12.cmd` permite abrirlo en esta PC sin instalar. `VOLVER_TIMING_0.1.11.cmd` abre el paquete anterior conservado para comparar. Ambos usan el perfil existente y requieren cerrar Hub y juego antes de cambiar de versión.

Pasaron **55 casos dirigidos contra el runtime del ASAR real**, incluyendo 14 nuevos de reelección/retirada, y **48 casos generales** mediante el wrapper ya existente `qa/timing-offline-harness.cjs`. Ese wrapper adapta la clave de persistencia y elimina exclusivamente la espera activa del reloj fijo de la prueba: resuelve las incompatibilidades del harness antiguo sin cambiar el producto ni medir latencia real. También pasaron Board automático y persistencia, permisos, interfaz y activación, detección del cliente, conflicto de puerto e integridad del paquete e instalador. El ASAR extraído del instalador coincide con el paquete probado. El manifiesto verificable está en `docs/releases/0.1.12-test.json` y los resultados en `tmp/test-ready-20261005/`.

Se conservan los instaladores y el paquete ejecutable de 0.1.11. Licencias y configuración de Cryptlex intactas; el paquete nuevo excluye cuentas y opciones personales. La prueba no está publicada en GitHub ni en el actualizador. Sigue pendiente la eficacia real en Ring.

La siguiente validación útil es contrastar la copia contra el mismo motor base en partidas reales, registrando alternativas perdidas, retirada de entidades y tiempos de reacción. No hace falta otra prueba manual: el objetivo pendiente es demostrar recuperación de la eficacia automática, especialmente en duelos donde estos dos defectos no bastan para explicar el fallo.

El 05/10/2026 el propietario solicitó oficializar 0.1.12. El mismo instalador, sin recompilar, se promovió a `DISTRIBUIBLE_0.1.12` y se publicó en el repositorio público de instaladores y en el catálogo estable de Cryptlex. La decisión de promoción no añade una validación de eficacia en combate. `docs/releases/0.1.12.json` conserva las comprobaciones, enlaces y límites de la entrega oficial.
