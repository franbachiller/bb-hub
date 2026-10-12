# Autoclick por paso (prueba local)

Abrir `ABRIR_AUTOCLICK_PASO_PRUEBA.cmd` desde la raíz, con Hub y juego cerrados.
Usa el inicio normal del Hub, con la licencia y la cuenta guardadas. No instala
una actualización ni publica una release. La versión oficial sigue siendo 0.1.21.

Runtime de prueba: `12102026_html5_step_clock_stable_preview`.
En **Autoclick por paso**, elegir referencia, ventana e intervalo, fichar
a un rival en el juego y activar. El ejemplo inicial es `[350, 400)` ms,
un clic cada 10 ms: 350, 360, 370, 380 y 390 ms. El final está excluido.
Las configuraciones antiguas de cantidad de clics se convierten a un intervalo
entero aproximado. Los parámetros se guardan; la función arranca apagada.

Referencias:

- **Yo o fichado**: sigue a cualquiera de los dos; sirve cuando nosotros
  estamos quietos y se mueve el fichado. Es el valor inicial para nuevas
  configuraciones. Las referencias guardadas se conservan.
- **Mi keko**: un burst por paso propio recibido.
- **Fichado**: un burst por paso del rival actualmente fichado. Sirve quieto.
- **Movimiento en sala**: un burst por grupo de movimientos de usuarios recibido.

No calcula proximidad ni elige enemigos. Antes de cada clic consulta
`selection.instance.avatarFichado.userSpaceId`; nunca usa la selección retenida
del Hub. Se verificó en el cliente abierto que la ficha es el mismo objeto del
avatar del renderer: se exige esa identidad, además del id. Cambiar la ficha
cambia el destinatario del siguiente clic; quitarla,
ficharse a uno mismo, a un aliado o a una entidad retirada impide el envío.

## Reloj y límites

El hook se ejecuta al recibir `socketWorker.onmessage`, antes de la cola RAF del
cliente. Lee Walk 182 de usuarios (modo 1), id en campo 1 y duración en campo 5.
Mascotas y NPCs no originan pasos. Si ese worker no está disponible se usa el
hook de recepción del cliente, indicado como respaldo en la interfaz.

Es un reloj del **paso recibido en el cliente**, no la hora absoluta del servidor:
el paquete no contiene esa marca. No proyecta ciclos sin nuevos movimientos.
Al cambiar de sala/ronda invalida el reloj y espera un paso nuevo. Una ventana
se recorta al final real del paso, manteniendo el intervalo. Si el inicio queda
fuera del paso, no dispara. No se escala silenciosamente.

Cada paso distinto del mismo actor renueva el reloj, incluso con duraciones
inferiores a 50 ms. Solo los movimientos de actores distintos del mismo grupo
se agrupan en las referencias de pareja/sala. El respaldo de recepción funciona
también si cambia la forma del mensaje del worker, sin repetir un paquete
ya observado. Una WalkingAnimation nativa nueva puede suministrar un paso
continuo no observado por paquetes, usando sus campos `time/elapsedMs`.
Si un circuito controla externamente su fase, no se inventa una duración.

La barra recibe estados ligeros separados de la actualización general del Hub.
El modo deja pasar la caminata original: no aplica la sustitución de recorridos
por tiles de UpperAll, aunque esa opción esté activa para Timing.

## Medición del cruce

Se muestrea por cuadro exclusivamente la pareja nosotros/fichado. Azul marca
la fase de máxima cercanía visual observada, usando la interpolación nativa
en el plano del suelo; verde indica los intervalos de contacto lateral en la
grilla observada. Los intervalos separados no se unen ocultando sus huecos.
Rojo sigue mostrando la ventana configurada de clics. La última medición
permanece mientras llega la siguiente; cambiar de fichado no hereda sus datos.

Se informan distancia en píxeles, muestras y resolución real de lectura en ms.
Una muestra interrumpida se señala como parcial. No es precisión de 1 ms si
el cliente dibuja un cuadro cada 16 ms. El reloj tampoco revela el instante
en que el servidor recibe o acepta el punch: permite comparar cruces visuales
con la ventana de clics, sin prometer una ventana ganadora.
El registro de combate admite `step_crossing` además de los clics.

Un Worker independiente programa los clics con fechas absolutas calculadas
con `performance.timeOrigin + performance.now()`. El envío sigue ocurriendo en
el hilo del cliente mediante `upper.upperRequest(id)`, igual que el golpe normal.
Cada clic reinicia la guarda local de 100 ms para permitir el burst; el servidor
sigue decidiendo qué acepta. No usa el motor de Timing, sus predicciones, su
aprendizaje ni su multiplicador de paquetes.

No hay espera ocupada ni prioridad alta. Windows y la cola del hilo principal
pueden retrasar callbacks: se descartan los que llegan fuera de `[inicio, final)`
o más de 8 ms después de su fecha. La interfaz informa fase, enviados,
descartados y retraso del último intento. Enviado significa despacho observado
al socket nativo, no golpe aceptado por el servidor.

Activar este modo apaga Timing, Board, modo automático, Simon, disparo libre y
salidas. Apagarlo, modificar su ventana, un paso nuevo, un límite de sala/ronda
o desconectar el Hub invalida los callbacks pendientes. Reconectar no reactiva
el modo. Los disparos atrasados del Board y de Timing no pueden elegir otro id.

## Verificación

Pasan 22 grupos de Autoclick, la compilación de interfaz y la prueba Electron
con preload aislado e IPC real: intervalo, persistencia, borrador, referencia
de pareja, marcas de cruce, validación, apagado y layout a 980 px. También pasan
las suites actuales de renderer, vida/IDs, atribución, defensa, reelección,
proveedores y seguridad. La eficacia de la ventana se valida jugando; no se
hicieron ataques de prueba en una partida real durante esta revisión.

Actualización del 12/10: la captura pasiva en vivo detectó un Walk de 600 ms
seguido por una animación de 540 ms. El runtime anterior rearmaba la ventana
unos 109 ms después del comienzo; en esa muestra mantuvo el origen, pero cambió
la duración y el programador. Ahora la duración visual no sustituye un paso
recibido ni otro actor de la pareja puede reemplazarlo con su animación mientras
está activo. Una nueva animación sigue siendo respaldo cuando falta un paso
recibido activo. La lectura temprana se engancha también si el worker aparece
después del descubrimiento inicial, o si el cliente reemplaza su handler.

La interfaz anterior ocultaba la marca cuando la medición y el paso actual
tenían distintas duraciones. Ahora prefiere una medición actual compatible y
mantiene una barra medida con su propia escala, además del instante numérico,
la comparación con la ventana y la aclaración de si hubo contacto en grilla.
`step_clock` registra origen, duración, referencia y generación para estudiar
las variaciones posteriores. La captura guardada de esa sesión no contenía
los eventos de clic/cruce; la evidencia de cambio se capturó en vivo durante
12 segundos sin enviar golpes ni alterar el reloj del juego.

`node qa/step-click-regression.cjs`: emite 211 con el constructor y el método
upper oficiales en un cliente simulado; cubre destinos, cambios de ficha,
ids reciclados, límites temporales, grupos de paquetes, reloj del Worker,
cancelación, persistencia y exclusión entre modos. La aceptación y efectividad
en Ring necesitan una partida real con esta versión de prueba.

Compilación y prueba de interfaz Electron con preload sandboxed correctas. Las
seis suites históricas `timing-selection`, `timing-alive`, `timing-renderer`,
`timing-learning`, `timing-sweep-retry` y `timing-offline-harness` tienen fallos
que se reprodujeron con el runtime de HEAD sin esta función; no se usan como
evidencia de que el Timing actual esté libre de problemas. Comparaciones en
`tmp/step-click-20261008/*.baseline.log`.

Actualización 09/10: se corrigieron los fallos de renderer y eliminación/IDs;
esas dos suites ahora pasan. También se corrigió la atribución de aprendizaje
entre rivales. Ver `upperall-20261009.md` para las pruebas y fallos restantes.
