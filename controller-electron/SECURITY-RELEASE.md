# Seguridad de la distribución BB Hub 0.1.2

## Medidas implementadas

El proceso principal, el núcleo del controlador y la puerta de licencia se
ofuscan y compilan en bytecode con el V8 de Electron 44.5.1. Los preloads se
ofuscan sin salir del sandbox. El JavaScript del servidor y worker Board se
ofusca y sus mapas de fuente se eliminan del paquete protegido.

Las ventanas usan aislamiento de contexto, sandbox y Node deshabilitado en
el renderer. Se bloquean ventanas externas, navegación y webviews. Los
manejadores IPC comprueban la ventana y su frame principal antes de aceptar
órdenes. Las funciones del controlador comprueban además la licencia.

El estado de licencia se valida al abrir la aplicación, antes de ejecutar
órdenes y cada 15 segundos usando el estado local de Cryptlex. Los eventos
de sincronización actualizan ese estado. Los 15 segundos no representan
una consulta a Internet ni garantizan detección inmediata de una revocación
en el servidor. El intervalo de sincronización y la política offline del
producto Cryptlex determinan cuándo llega ese cambio al cliente.

Cuando el estado deja de ser utilizable, se desactivan modos automáticos,
hotkeys y Board, se cierran las conexiones del motor y vuelve el activador.
El servidor Board también comprueba la licencia en HTTP y WebSocket.
Los errores temporales de red respetan el período de gracia reconocido
por el estado local de LexActivator, sin convertirlos en una activación nueva.

Los fuses deshabilitan RunAsNode, NODE_OPTIONS y el inspector de Node.
El ejecutable elimina las opciones de depuración remota de Chromium.
La aplicación empaquetada ignora las variables de desarrollo que permiten
omitir licencia o cargar una URL de Vite. Se exige carga desde ASAR y se
habilita la validación de integridad del ASAR integrada en Electron.

Se actualizó Electron y las dependencias de producción. La auditoría de
producción del 3 de octubre de 2026 no reporta avisos conocidos. Esto no
equivale a demostrar ausencia de vulnerabilidades y no describe las
dependencias que se usan únicamente al compilar.

## Pruebas y límites

Board exige además el permiso firmado `ring_board=true`, obtenido mediante
LexActivator. Una licencia Basic no inicia el servidor del bot y tampoco
puede ejecutar órdenes de Board mediante el controlador. El servidor
comprueba el permiso en HTTP, WebSocket y al despachar trabajo, y cierra
todas sus sesiones al perderlo. Los temporizadores del controlador vuelven
a comprobarlo antes de enviar una orden pendiente al juego.

La vista previa de Basic usa un SVG de ejemplo dentro del renderer del Hub;
no abre el servidor ni una sesión del bot. Los controles permanecen visibles
y deshabilitados. Ocultar o deshabilitar controles no constituye la protección
de licencia: la autorización del motor se aplica por separado.

El actualizador usa releases permitidas por Cryptlex, descarga por HTTPS y
comprueba tamaño y SHA256 antes de ejecutar el instalador. La instalación
se inicia únicamente al pulsar «Descargar e instalar» y detiene el motor.
Este flujo se probó con archivos de prueba y lanzamiento simulado; aún
requiere publicar una release y probar una actualización real. La firma
digital del editor sigue pendiente.

El ejecutable final se probó con la activación válida ya existente en este
equipo. El Hub, el bridge del renderer, el servidor Board y su worker
arrancaron. Los intentos de NODE_OPTIONS, RunAsNode e inspector no abrieron
las superficies comprobadas. Una copia con una entrada del encabezado ASAR
alterada fue rechazada por fallo de integridad. La prueba no demuestra que
un atacante con control del ejecutable no pueda modificar sus verificaciones.

Los controles IPC y la parada del motor ante estados inválidos pasaron
pruebas locales con estados simulados. No se suspendió ni revocó la licencia
real del usuario. Quedan por comprobar esos cambios desde el panel Cryptlex
y la instalación en un Windows limpio.

El bytecode y la ofuscación aumentan el trabajo necesario para analizar y
modificar el cliente; no son cifrado irreversible. Un atacante con control
del sistema puede intentar modificar el ejecutable, la biblioteca nativa,
la memoria o las comprobaciones locales. La biblioteca nativa de Cryptlex
requiere archivos fuera del ASAR. No existe una garantía de cliente
imposible de crackear. No se incluyen claves de clientes ni secretos de
administración de Cryptlex en la entrega.

## Decisiones para la distribución

Pedir la licencia en el instalador puede limitar el acceso normal al archivo,
pero no sustituye el control en la aplicación: el contenido de un instalador
puede extraerse o copiarse desde un equipo que ya lo haya instalado.
La versión entregada conserva la activación al iniciar y durante el uso.
Una descarga privada con acceso asociado a una licencia puede añadirse como
barrera de distribución, manteniendo las validaciones de ejecución.

Antes de ampliar la distribución, conviene revisar en Cryptlex los límites
de activación por licencia, el intervalo de sincronización y la tolerancia
offline según la política comercial, y verificar revocación real con una
licencia de prueba independiente. No se modificaron estas políticas remotas.

El instalador y el ejecutable están sin firma digital de editor. Para una
distribución pública, la firma Authenticode ayuda a verificar el editor y
el archivo entregado. El SHA256 detecta diferencias respecto a la copia
publicada, siempre que el hash se entregue mediante un canal confiable.

Para una protección superior, las decisiones o funciones valiosas deben
depender de un servicio controlado por el proveedor, con autorización en
el servidor. Esa arquitectura no forma parte de esta compilación.

## Mantenimiento

La copia incorporada de Board en `electron/ring-board/dist/server.js`
contiene el control de licencia. Si se reemplaza por una nueva compilación
del proyecto Board, hay que conservar ese control y volver a probarlo.
Las salidas `protected`, `dist` y `release` se generan; solo debe enviarse
la carpeta final de distribución y su ZIP.
