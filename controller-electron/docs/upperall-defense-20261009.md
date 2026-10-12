# Defensa y salida de animación: prueba local

Runtime `09102026_html5_upperall_defense_preview`.
Con Hub y juego cerrados, abrir `ABRIR_TIMING_PRUEBA.cmd` en la raíz. Usar Timing,
Autoclick apagado y Registro de combate encendido. La partida que sigue abierta
cargó el runtime anterior: debe reiniciarse para cargar estas correcciones.

## Evidencia de la sesión

La captura `hub-client-2026-10-09T20-29-21-361Z` corresponde a la prueba anterior.
En la derrota de las 17:32:31 locales, estábamos quietos en (14,18). Se envió
un tiro anticipado al rival 0, después un barrido al rival 1; el rival 0 entró
a (13,17). No se envió una reacción posterior a ese contacto. La regla antigua
descartaba esa reacción por haber asignado ya el tiro anticipado al mismo ID.
Esto no prueba si el primer tiro perdió por su fase o por el hold del servidor.

No hay 149 salientes dirigidos a nuestro propio ID en esa captura. No se atribuye
esa sesión a cocos propios. El código sí contiene una regla de coco propio
automático desde el 01/10; las pruebas reproducen dos errores en sus condiciones.

## Correcciones

- Un tiro anticipado no elimina la posibilidad de una única reacción de
  respaldo al contacto. El respaldo revalida avatar, posición, modo, generación,
  trabas y el intervalo desde el último envío de cualquier mecanismo. No repite
  su tiro con un segundo callback. Expira después de un paso.
- En modo de tiro único, un plan TICK respeta el intervalo compartido si otra
  reacción o salida se adelantó; registra `shared_gap`.
- El coco propio considera la cobertura del guardia en el momento del
  desbloqueo, no 900 ms después. Un coco ya en camino al rival evita el coco
  propio redundante. La cuenta regresiva de Ring se distingue de la animación
  de un punch aceptado y no activa ese mecanismo.
- Las trabas, contactos, cobertura y planes de coco de una ronda/sala anterior
  se descartan al cambiar de ronda/sala. El comienzo de una ronda establece
  su propia cuenta regresiva.
- No encontrar rival en el primer disparo de salida de coco conserva el intento
  de respaldo para un rival que entre después.
- El registro admite `coco_self` y `coco_used`; la reacción informa los motivos
  de cancelación. El estado muestra el tipo de traba y la configuración de cocos.

Pasan los 10 casos de `qa/timing-defense-regression.cjs`, además de renderer,
eliminación/IDs, atribución de aprendizaje, Autoclick y seguridad. Antes del
cambio, 8 de los 9 casos iniciales de defensa fallaban; el décimo verifica el
intervalo compartido nuevo. Las suites históricas restantes mantienen los
límites descritos en `upperall-20261009.md`; no se declara aprobada toda la suite.

Estas son correcciones de comportamiento verificadas con un cliente simulado,
no una garantía de ganar carreras. No se ha jugado con este runtime nuevo ni
se publicó una actualización. Licencias y cuenta usan el inicio normal.
