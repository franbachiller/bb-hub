# Constructor de paquetes cargado después del arranque

Prueba local: `09102026_html5_upperall_packet_refresh_preview`.
Cerrar Hub y juego al terminar la partida y abrir `ABRIR_TIMING_PRUEBA.cmd`.
El runtime de la partida observada permanece sin reemplazar en vivo.

La sesión `hub-client-2026-10-09T21-04-33-777Z` empezó con cuatro derrotas
sin golpes propios aceptados. Después registró tres golpes propios de Ring,
a las 18:09:41, 18:10:06 y 18:14:43 locales. Esos resultados corresponden al
runtime anterior: no validan esta corrección. En las cuatro derrotas iniciales
hubo solicitudes al ID del rival que luego nos eliminó y reacciones posteriores
al contacto. No se observa un fallo general del opcode 211 ni una falta total
de envíos. La captura no permite atribuir cada golpe aceptado a una solicitud
concreta cuando hubo más de una pendiente al mismo rival.

Falla comprobada: `providers.packet=false`, `stepWalk.enabled=true`, 199
solicitudes de caminar y cero pasos enviados por Step Walk. El constructor
nativo `at` se exporta como `a` desde el módulo de selección
`r4a9c641fe4d6-DtLRSrNC.js`. La búsqueda inicial termina al encontrar los
cuatro proveedores obligatorios en el módulo principal. La búsqueda periódica
de proveedores tardíos omitía `packet`. Por eso la opción de caminar de a un
tile estaba encendida pero dejaba pasar los recorridos completos originales.
Además conservaba un destino cuya primera sustitución nunca se había enviado.

La búsqueda periódica ahora incluye el constructor. A diferencia de los
servicios del juego, este proveedor no requiere una instancia singleton.
Cuando no puede empezar una sustitución se conserva una única solicitud
original y se descarta el destino pendiente. Si una continuación falla, se
intenta devolver el recorrido al cliente mediante la salida existente.
El estado `tick.stepWalk.packetReady` permite comprobar la detección.

Tres pruebas nuevas verifican carga tardía sin singleton ni búsquedas
repetidas, ausencia de recorridos fantasma cuando falta el constructor y envío
de un solo tile con continuación al destino original. Pasan también renderer,
vida/IDs, atribución, defensa, Autoclick y seguridad. Las limitaciones de las
otras suites históricas siguen documentadas en `upperall-20261009.md`.

Se comprobó el formato construyendo mensajes con la clase nativa de esta
partida, sin enviarlos al servidor. Esta corrección restaura un mecanismo que
no estaba funcionando; todavía necesita una partida con el runtime nuevo.
No demuestra que el constructor ausente explique las derrotas estando quietos
ni garantiza ganar carreras. No se publica una actualización ni se cambian
licencias, credenciales o prioridades de procesos.
