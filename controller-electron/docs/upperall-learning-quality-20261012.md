# Auto y las cuatro partidas del 12/10

Prueba local preparada en `ABRIR_TIMING_PRUEBA.cmd`.
Runtime: `12102026_html5_upperall_learning_quality_preview`.

## Evidencia de la sesión

Se revisó `hub-client-2026-10-12T09-45-39-972Z`, correspondiente al build
`12102026_html5_upperall_dispatch_preview`: cuatro Ring, primero ganado con
tres golpes, siguientes tres sin golpes propios. Los cruces finales de las
tres derrotas incluyen envíos al ID de quien nos golpeó. Coco terminó bien y
no hay un retraso general del scheduler que explique estas pérdidas.

La configuración enviada por el Hub permaneció igual. Auto cambió el objetivo
de llegada: fases primarias 15 -> 14 -> 13 -> 12 -> 9/11 ms. Dos victorias
tenían solicitudes de primario y repeat compatibles con el resultado. Las
tres pérdidas se clasificaron como `late` sin respuesta atribuida al primario
(`ourPhase=null`), y aun así adelantaban el margen. Una ausencia de 144 no
demuestra aceptación ni orden de llegada en el servidor.

La correlación con frames de WebSocket se validó por longitud del builder,
cifrado, orden y unicidad; 479 pedidos, incluidos 154 punches. En los 17 tiros
decisivos, el frame sale 0.93–3.72 ms después del socket API, con un error del
anchor de ±2.563 ms. Eso acota el tramo local. No verifica target del ciphertext,
TCP delivery ni aceptación del servidor. Informes detallados:

- `tmp/round-audit-20261012/findings.md`
- `tmp/round-audit-20261012/wire-findings.md`
- `tmp/round-audit-20261012/wire-validation.json`

## Corrección

Ahora se separa resultado observado de evidencia suficiente para aprender:

- Un rechazo ambiguo, tardío, sin petición o de otra generación no alimenta
  B/margin. Antes la compuerta protegía corr/sigma, pero ya había insertado la
  respuesta en el histórico de aprendizaje.
- Un hit puede pertenecer al primario, repeat, REACT, EXIT o clic manual.
  Se consideran las peticiones compatibles en la ventana de hold de 200 ms y
  la incertidumbre del reloj. Solo el primario atribuible a una única petición
  puede aportar su fase estimada y ajustar margen. Esa atribución usa un modelo
  local; el servidor no proporciona un identificador de petición en su 211.
- Una derrota sin respuesta propia se registra como `loss`, con `learned=false`,
  sin afirmar una llegada tardía ni adelantar el golpe.
- Las respuestas confiables retienen el snapshot del plan armado, incluyendo
  generación, origen, tick, fase y retraso observado; un refit posterior no
  cambia su referencia. Los competidores usan su lead guardado al enviar.
- Los clics manuales nativos también se registran como posibles competidores.
  Los packet bursts carecen de atribución por paquete y no enseñan B/margin.
- La migración elimina etiquetas antiguas sin provenancia de calidad. Conserva
  la B existente únicamente como prior débil y mantiene corr/configuración.
  Las nuevas muestras guardan versión y calidad; un contenedor de versión nueva
  no permite reutilizar puntos sin ese marcador.

No cambió el algoritmo de selección ni el despacho de los punches de esta
sesión. No se cambió el valor de llegada del usuario por ensayo manual.
Autoclick por paso sigue aislado y dirigido al fichado; licencias, cuentas,
instaladores y updater conservan su implementación anterior.

## Validación y límite

20 verificaciones pasan: sintaxis y seguridad, más **240 casos**, incluyendo
18 casos de calidad del aprendizaje y 48 del harness completo. Resultado
congelado de esta revisión: `tmp/ring-causality-20261012/verification.json`.

El replay de aprendizaje con los seis cruces y los mismos envíos registrados
admite una sola actualización, en la segunda victoria. El margen potencial
queda 10 -> 10 -> 9 -> 9 -> 9 -> 9 -> 9, en lugar de 9/8/7/4/6/6. Este replay
reconstruye los planes con los campos disponibles; no predice victorias ni
simula nuevas solicitudes. Artefactos: `tmp/clock-audit-20261012/replay-quality*`.

Falta una nueva prueba de Ring para medir eficacia. Reiniciar Hub/juego con el
lanzador local, comprobar el build, mantener la misma configuración, Autoclick
por paso apagado y Registro de combate activo. Evaluar envíos y resultados
reales, no tomar el número de pruebas offline como prueba de eficacia.
