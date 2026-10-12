# Prueba de un pedido por paso — 12/10/2026

Lanzador local: `ABRIR_TIMING_PUNCH_AISLADO.cmd`.
Runtime: `12102026_html5_upperall_punch_isolation_preview`.

## Qué se observó

En `hub-client-2026-10-12T15-34-45-469Z` hubo cuatro golpes propios y siete
recibidos en siete Rings. Los siete terminaron con nuestra eliminación. En
cada último cruce perdido, el primario eligió al atacante correcto y la
casilla propia prevista coincidió con la siguiente posición recibida. Todos
esos primarios salieron sin retraso del callback registrado, entre 149 y
159 ms antes del movimiento de contacto.

Seis golpes rivales se resolvieron 13–55 ms después del movimiento recibido.
El repeat de +105 ms demoró la reacción local de contacto, pero esa reacción
también necesitaría transporte hasta el servidor. Quitar esa espera no
demuestra que ganemos esas carreras. En la pérdida restante hubo una reacción
enviada 185 ms antes del golpe rival, sin resultado propio.

No hubo 144 en los últimos 450 ms de ninguno de los once cruces propios/fatales.
La ausencia de rechazo no confirma que el servidor haya aceptado, retenido o
ejecutado un pedido. El 211 tampoco identifica la solicitud que produjo el
golpe. Medir una llamada al API con ID correcto no resuelve esa incertidumbre.

El burst físico ya era uno en las ocho capturas del 02/10 (20.658 disparos) y
en las dos capturas revisadas del 01/10. Las tres resoluciones propias actuales
comparables tardan 69, 81 y 102 ms desde el movimiento de contacto; la mediana
del 02/10 era 103 ms. No hay evidencia de una nueva demora general en nuestros
golpes, ni de que restaurar burst cinco recupere el comportamiento OG.

Los tres aciertos con primario fueron a fase 15/14/14; las pérdidas siguientes
fueron a fase 13. Es una muestra pequeña, con rivales distintos y solicitudes
competidoras: no establece que 13 sea una fase inválida ni que adelantar más
sea correcto. Ahora Auto conserva el margen cuando la pérdida no puede
atribuirse al primario.

## Qué aísla esta prueba

Es un diagnóstico separado, no una mejora de eficacia ya demostrada:

- Conserva la selección automática de Timing. No usa el enemigo fichado.
- Envía como máximo un pedido automático anticipado por paso, con un solo
  paquete y fase fija T+13 ms, la fase de la sesión analizada.
- Retira los repeats, barridos, reacciones y tiros de desbloqueo de esta prueba.
  Así una segunda petición automática no puede confundirse con el primario
  del mismo paso ni interferir en su retención.
- Conserva el reloj y la corrección inicial de transporte, pero no ajusta la
  fase ni guarda aprendizaje experimental en las claves del modo habitual.
- El golpe manual sigue disponible. Si se usa durante un cruce, ese caso se
  registra como competido y no sirve para atribuir el resultado al primario.

T+13 es una fase estimada respecto de la grilla local de recepción del servidor;
no es un ACK ni un sello de llegada física de uplink. Un rechazo 144 con campos
de razón debe conservarse y analizarse como tal, no etiquetarse automáticamente
como un pedido temprano. Una derrota sin respuesta tampoco prueba aceptación.

## Cómo probar y leer el resultado

Cerrar Hub/juego y abrir el lanzador aislado. Activar Registro de combate,
dejar Autoclick por paso apagado y encender Timing. El Registro debe mostrar
la prueba de punch aislado a T+13 ms. Jugar varios Rings como siempre, evitando
el golpe manual en los cruces que se quieran medir.

Se comparan: selección y posición válidas, pedidos efectivamente enviados,
retraso local, rechazos, resultado propio/rival y demora de resolución. Una
victoria atribuible a un único pedido estima su retención; una pérdida sin
respuesta queda sin atribución. Para estudiar otra fase se debe repetir el
mismo modo aislado cambiando solo esa fase, no mezclar nuevos cambios del motor.

Volver a `ABRIR_TIMING_PRUEBA.cmd` recupera el funcionamiento habitual. La
prueba no se publica, no incrementa la versión y no cambia el flujo de cuentas,
licencias ni distribución.

## Evidencia reproducible

- `tmp/races-1534-20261012/report.md` y `placements-report.md`
- `tmp/self-projection-20261012/eligibility-result.json`
- `tmp/acceptance-vectors-20261012/findings.md` y `burst-findings.md`
- `tmp/punch-isolation-20261012/before-hashes.json`: fuentes previas a esta prueba
- `tmp/punch-isolation-20261012/analyze.job.json`: resume una nueva captura aislada

Las 24 verificaciones locales pasan, con 256 casos: 240 del funcionamiento
habitual, diez del aislamiento del runtime y seis grupos de integración del
host. Resultado: `tmp/punch-isolation-20261012/verification.json`.

La verificación offline comprueba aislamiento y ausencia de regresiones. La
eficacia y la política de retención del servidor requieren esta prueba real;
no se deducen del número de tests verdes.
