# Basic, Pro y actualizaciones — BB Hub 0.1.2

El cliente está preparado. El 3 de octubre de 2026 se configuraron en el
entorno Production de Cryptlex la función `ring_board` (Board Pro) y los
conjuntos `basic` (nombre visible Basic, tier 0, valor `false`) y `pro`
(nombre visible Pro, tier 1, valor `true`), vinculados al producto BB Hub.
Se creó la plataforma `windows`; el canal `stable` ya existía.

La release BB Hub 0.1.1 está guardada como borrador sin publicar. `SHA256.txt`
se cargó y figura protegido por licencia. Cryptlex rechazó el instalador por
el límite de almacenamiento del plan. El usuario autorizó la publicación y
eligió alojamiento HTTPS propio; falta recibir el enlace directo al EXE.
Los enlaces recibidos de Wormhole y Google Drive no sirven para el actualizador:
Wormhole caduca en 24 horas/100 descargas; Drive entrega una página de advertencia
antes de descargar el EXE. La distribución 0.1.2 añade compatibilidad con los
nombres externos sin espacios que exige Cryptlex. Falta alojamiento HTTPS directo.
El archivo externo no obtiene automáticamente la protección de descarga de
Cryptlex y debe conservar su disponibilidad y el hash de la distribución.

Con autorización del usuario, se asignó Pro a su licencia de prueba. La
sincronización nativa y el ejecutable final reconocieron `ring_board=true`:
GENUINE, servidor Board y worker correctos, HTTP/WS habilitados. La plantilla
existente `15d-node-locked` conserva su duración y límite de activaciones.

## Basic y Pro

1. En Features, crea la función con nombre exacto `ring_board`. Usa el nombre
   visible «Board Pro».
2. Crea los Entitlement Sets «Basic» y «Pro».
3. Asigna `ring_board` con valor de texto `false` a Basic y `true` a Pro.
4. Vincula cada plantilla/licencia al conjunto correspondiente. Las licencias
   existentes sin este permiso se consideran Basic para Board.
5. Para ampliar una licencia, cambia su conjunto a Pro o asigna el permiso
   `ring_board=true` directamente a esa licencia. La clave puede conservarse.

El cliente consulta `GetFeatureEntitlement` de LexActivator, no el nombre de
la licencia ni un archivo local con el plan. Un permiso ausente, ilegible o
deshabilitado bloquea Board. Si un permiso temporal caduca, se usa el valor
base del Entitlement Set; si no hay valor base habilitado, Board se bloquea.

Los cambios remotos llegan con la sincronización de Cryptlex según el
intervalo de la licencia y la conectividad del equipo. No debe confundirse
con la comprobación local cada segundo de Board. Revisa la tolerancia offline
y el intervalo de sincronización antes de vender planes revocables.

La edición Basic muestra una vista previa de ejemplo y todos los controles
de Board, deshabilitados. El aviso de Pro aparece únicamente dentro de la
pestaña Board. Inicio conserva su fila e interruptor, sin pedir una ampliación.
No se inicia el servidor del bot para una licencia Basic; el motor rechaza
además las órdenes directas, y las órdenes pendientes se cancelan al perder
el permiso. El modo automático también requiere ese permiso.

## Releases y actualizaciones

1. Crea la plataforma con nombre exacto `windows` y utiliza el canal `stable`.
   Este instalador es exclusivamente Windows x64.
2. Crea la release `0.1.2` para BB Hub y adjunta el instalador
   `BB Hub Setup 0.1.2.exe` y su `SHA256.txt` de la distribución.
   Para alojamiento externo usa en Cryptlex el nombre `BB-Hub-Setup-0.1.2.exe`
   o `BB_Hub_Setup_0.1.2.exe`. SHA256.txt puede conservar el nombre original
   del instalador con espacios. No uses el SHA256 del borrador 0.1.1.
3. Utiliza archivos alojados en Cryptlex con descarga protegida por licencia.
   Si las políticas de mantenimiento/versiones limitan el acceso, vincula las
   licencias que correspondan a esta release antes de distribuirla.
4. Publica la release cuando se haya comprobado el archivo y su hash.
5. En futuras versiones, incrementa `package.json` y
   `electron/license/config.json`, compila y publica una release superior.
   Conserva uno de esos patrones de nombre y adjunta `SHA256.txt`.
   Cryptlex pide MD5 para la metadata de archivos externos; no sustituye
   SHA256.txt. El cliente exige SHA256 y rechaza hashes contradictorios o
   varios instaladores coincidentes. Para 0.1.2 el EXE mide 124373480 bytes,
   con SHA256 `7c9a2801d95c4b6e503287165d793ed1f1df4d5798dd4ede840b05aaa5e7c8cf`.

El Hub comprueba versiones permitidas al iniciar y cada seis horas. También
hay un botón «Buscar actualizaciones» en Timing. Las consultas tienen una
separación mínima de 30 segundos. Los errores no bloquean el uso del Hub.

Una actualización disponible muestra «Descargar e instalar». Solo esa acción
inicia la descarga: no hay instalación silenciosa ni reinicio automático
mientras se juega. El cliente valida HTTPS, tamaño y SHA256 antes de abrir
el instalador. Usa el SHA256 de la metadata cuando tiene formato válido o
el hash de `SHA256.txt` publicado en la misma release. Una descarga alterada,
un hash ausente o un tamaño incorrecto impiden la ejecución.

Antes de abrir el asistente se detienen modos, conexiones y hotkeys; luego
se cierra BB Hub. El asistente conserva las preferencias y la activación
existente. Las URLs con la clave se mantienen en el proceso principal y no
se envían a la interfaz. No se incorpora un token administrativo al cliente.

## Validación del panel y pendientes

Antes de la ampliación, la licencia real se comprobó como Basic: abría el Hub
y dejaba los puertos de Board cerrados. Después de asignarle Pro se comprobó
el permiso nativo y el arranque del ejecutable real con Board habilitado.
La retirada del permiso y una descarga corrupta se verificaron con proveedores
de prueba controlados, sin suspender ni revocar la licencia del usuario y sin
ejecutar un instalador descargado. La consulta real de Releases respondió
correctamente sin una actualización disponible para 0.1.1.

Después de configurar el panel, verifica con licencias independientes Basic
y Pro: desbloqueo, retirada del permiso con Board activo y actualización real
a una release posterior. El instalador aún no tiene firma Authenticode;
la verificación SHA256 no sustituye la identificación del editor por firma.

Documentación oficial:

- https://cryptlex.com/docs/features-and-entitlements/accessing-feature-entitlements
- https://cryptlex.com/docs/releases/auto-updates
- https://cryptlex.com/docs/releases/creating-releases
