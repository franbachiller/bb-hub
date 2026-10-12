# Cruces con varios rivales y reelección de la reacción

Prueba local: `09102026_html5_upperall_multi_contact_preview`.
Abrir `ABRIR_TIMING_PRUEBA.cmd` al terminar la sesión y cerrar Hub/juego.
No se reemplazó el runtime abierto ni se publicó una actualización.

## Observaciones de partidas

En `hub-client-2026-10-09T21-20-15-125Z` sí funcionó la corrección de carga
tardía: constructor detectado, 56 pasos individuales enviados frente a 29
solicitudes de caminar en la primera consulta. No recuperó por sí sola la
eficacia que describe el usuario.

En el cruce perdido a las 18:23:28 locales, el primer tiro salió a 197188.3 ms
al rival 2, puntuado 0.359. El barrido salió al rival 7 a 197296.8 ms: 108.5 ms
después. El lote de movimiento llegó a 197350.6 ms; dejó a nosotros en (15,16),
al rival 2 en (17,15) y al 7 en (14,15). La reacción al 7 salió a 197400.1 ms,
tras respetar el intervalo del barrido. El 211 del rival 7 llegó a 197590.6 ms.
Eso prueba elección inicial incorrecta y diferencia entre envíos; no prueba
qué petición del rival recibió primero el servidor ni por qué ganó.

En otro cruce, a las 18:22:49, sí se tiró primero al rival correcto, el 4,
y hubo reacción al mismo ID tras recibir el contacto. También se perdió.
No alcanza con corregir la elección de ID para explicar todos los casos.

El analizador existente `HTML5/tools/analyze_contact_targets.js` comparó ocho
capturas del 02/10 con tres del 09/10. En episodios registrados de contacto
con dos o más rivales libres cercanos y primer tiro al ID del contacto:

| Capturas | Ganamos | Nos pegaron | Sin resolución en la ventana |
| --- | ---: | ---: | ---: |
| 02/10 | 80 | 38 | 4 |
| 09/10 | 1 | 7 | 0 |

La elección anticipada cubrió 122/156 contactos (78%) en esas capturas antiguas
y 8/9 (89%) en las nuevas. La muestra reciente es pequeña; las partidas no
son controladas ni comparan los mismos rivales. El analizador depende de las
posiciones y comienzos de ronda registrados y busca resoluciones hasta 800 ms
después del contacto: no identifica inequívocamente qué petición ganó.

El primer envío al ID correcto quedó aproximadamente 160 ms antes del lote
recibido el 02/10 y 166 ms antes en las derrotas del 09/10; el ping mediano
fue 167 y 171 ms respectivamente. No aparece una demora general grande hasta
la llamada a la API nativa. Eso no mide el envío WebSocket real ni la aceptación
del servidor. El cliente observado sigue construyendo 211 con el ID como único
parámetro y pasando el mensaje al worker de transporte. No se demuestra un
cambio de reglas del servidor.

## Regresión corregida

Mi cambio de defensa anterior volvió a conservar exclusivamente el primer
rival durante la espera de una reacción y consumía los demás contactos nuevos.
Se reprodujo con la prueba histórica de reelección: cuando salía el primer
rival, no se enviaba nada al segundo que seguía válido.

Ahora se conservan los avatares de todos los contactos nuevos del lote.
Al abrir el intervalo se vuelve a validar identidad, contacto, eliminación,
retirada, aliado, silenciamiento, stun y bloqueo. Se conserva el primer rival
si sigue válido; si no, se elige otro contacto nuevo del mismo lote. Nuevos
contactos que llegan durante la misma espera se incorporan al plan existente.
Un lote nuevo, cambio de sala/ronda, apagado o reutilización de ID no perpetúa
el plan. No se añaden contactos antiguos ni se duplica el golpe.

El diagnóstico `react_fallback` incluye objetivo original, objetivo final,
número de alternativas y milisegundos de espera. Pasan 19 casos de reelección,
los 10 de defensa y las comprobaciones de constructor, renderer, vida/IDs,
atribución, Autoclick y seguridad. Se mantienen los límites de las otras suites
históricas documentados en `upperall-20261009.md`.

La reelección resuelve una regresión real, especialmente relevante con varios
rivales. Aún no se jugó con este nuevo runtime: no se atribuye a esta corrección
la recuperación completa de Ring ni se promete ganar carreras.
