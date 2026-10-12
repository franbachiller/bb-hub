# Prueba local: Timing fichado, recuperación y Autoclick

Rama `codex/timing-selected-step-controls`, desde la publicación `v0.1.22`. Runtime `12102026_html5_selected_step_controls_preview`. No modifica el instalador ni la publicación de clientes.

Cerrar Hub y BoomBang HTML5 antes de abrir `ABRIR_TIMING_PRUEBA.cmd` o `ABRIR_AUTOCLICK_PASO_PRUEBA.cmd`. Ambos lanzan el mismo Hub local compilado, con licencia y cuenta habituales. El juego debe abrirse desde este Hub para inyectar el runtime nuevo.

## Timing

`Objetivo automático` conserva la selección por proximidad. `Solo el fichado` usa el mismo motor y su fase principal T+13, pero evalúa exclusivamente la ficha nativa actual. Sin ficha válida, propia, aliada, eliminada o con objeto reemplazado no envía a otro jugador. El cambio de modo invalida callbacks anteriores. El modo elegido se conserva al apagar, usar la hotkey y reiniciar.

Si el primario normal caería dentro de nuestra animación de golpe/coco conocido, y existe un rival lateral válido, se reprograma ese mismo primario al fin del bloqueo +10 ms. No agrega un pedido: conserva un primario por paso y protege el intervalo del siguiente T+13. Revalida identidad, ficha, contacto, locks y eliminación; un golpe manual intermedio cancela la recuperación. Si llega tarde o consumiría la guarda del próximo primario, se cancela.

Tres anticipaciones sin respuesta no excluyen por 1,8 s a un jugador nativo válido de Ring. El silencio se registra sin afirmar que el servidor aceptó el pedido. La exclusión existente de NPC/protección fuera de ese caso se conserva.

## Autoclick por paso

`Momento` representa el envío desde el paso recibido. `Un golpe` programa exactamente ese ms; `3 intentos` programa momento−20, momento, momento+20. Los pedidos que quedan fuera de la duración real se omiten sin desplazar los demás. Los intervalos anteriores se conservan en `Personalizado`, hasta que el usuario elige otro patrón.

El azul conserva el último cruce completo con contacto del fichado, nunca una aproximación parcial. Incluye duración, referencia y movimiento de ambos. No es una medición de aceptación del servidor y ya no se recomienda convertirlo automáticamente a una ventana restando el ping. El rojo muestra los envíos configurados; cambios en formulario requieren Aplicar.

Si el juego conectado aún usa un runtime anterior sin estas capacidades, el Hub pide reabrirlo antes de habilitar el patrón simple o Timing fichado. Apagar siempre sigue permitido. En el perfil fijo, la interfaz presenta la fase principal como lectura y oculta controles de fase/burst que ese motor no utiliza.

## Evidencia y límites

Pruebas del motor, scheduler, ficha, recuperación, migración y protocolo: `tmp/step-controls-20261012/verification.json`. Capturas y QA de interfaz: `tmp/step-controls-20261012/`.

Las capturas anteriores incluyen victorias acercándose a enemigos quietos y una derrota estando quietos con el ID y T+13 correctos. Esta actualización corrige bordes reproducibles, pero no demuestra que aquella derrota se debiera a esos bordes ni garantiza ganar todas las carreras. Falta comparar efectividad en nuevas partidas reales.
