# Autoclick por paso: reloj y cruces

Prueba local: `ABRIR_AUTOCLICK_PASO_PRUEBA.cmd`.
Runtime: `12102026_html5_step_click_encounter_preview`. Sin publicación ni
incremento de versión. Los lanzadores de Timing comparten este runtime y
conservan el diagnóstico de punch aislado.

## Correcciones comprobadas

- La agrupación PAIR/ROOM exige duración igual: un paso corto del fichado ya
  no hereda 600 ms del otro personaje.
- El fallback nativo no consume una animación antes de poder observarla.
  Una nueva animación con inicio distinto puede sustituir un reloj anterior.
  La animación comprimida 540/600 ms del mismo paso sigue sin duplicarlo.
- Un reloj asociado a la ficha anterior no dispara sobre una nueva ficha.
  Un reloj SELF sigue consultando la ficha actual antes de cada envío.
- Se conserva el último encuentro con contacto del fichado, en lugar de
  reemplazarlo por cualquier movimiento lejano. Cambiar la ventana conserva
  esa medición; cambiar de sala/ficha no permite heredar datos de otro actor.
- La UI prioriza contacto actual y después el último encuentro útil. La marca
  azul usa la cercanía visual medida durante contacto cuando está disponible.
- La barra roja previsualiza el formulario. «Preparar ventana para este cruce»
  descuenta el RTT completo y prepara los valores sin aplicarlos ni activar el
  modo. Referencias que exigen enviar antes de recibir el paso se muestran como
  imposibles. «Un golpe» prepara un único pedido por paso, útil para medir.
- El registro distingue fase programada, envío real, retraso y llegada estimada.

La ficha nativa (`avatarFichado`) sigue siendo obligatoria y debe coincidir
con el objeto del renderer. No hay selección por proximidad ni fallback de ID.
Al activar esta función se mantienen apagados Timing, Board y Simon.

## Alcance de la medición

Azul indica una cercanía observada, no una aceptación del servidor ni un
instante de victoria garantizado. Se muestra la resolución real de muestreo.
La compensación de conexión es una estimación; el servidor puede retener o
descartar pedidos. La eficacia aún debe comprobarse en Ring.

## Verificación

262 casos del runtime/host y ocho grupos de métricas/UI pasan; build Vite
correcto. QA visual con datos simulados: azul visible en 420/600 ms; RTT160;
botón prepara235–285 ms y mueve la ventana roja sin enviar acciones.
`tmp/step-click-20261012/verification.json` conserva el resultado y
`step-click-ui.png` la captura. No se operó el juego abierto durante la prueba.
