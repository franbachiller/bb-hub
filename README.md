# BB Hub

Código privado del Hub, Board y componentes auxiliares. Versión entregable:
**0.1.6 para Windows x64**, confirmada en dos PCs de clientes el 04/10/2026.
Licencias Basic/Pro mediante Cryptlex; el permiso
`ring_board=true` habilita el bot.

Desde 0.1.3 el Hub abre el juego por su cuenta: inicia sesión con la cuenta de
BoomBang guardada (cifrada con DPAPI), abre `BoomBangHTML5.exe` con CDP, inyecta
el runtime de `controller-electron/electron/game/` y lo conecta al controller.
Desde 0.1.6 usa un puerto libre si `:9999` está ocupado y solo muestra la
conexión lista cuando recibe mensajes del runtime en su propio controller.
Ya no hacen falta `ABRIR_HUB_Y_CONTROLLER.cmd`, Node ni Playwright en el equipo
del cliente. El runtime que empaqueta este repo está en
`controller-electron/electron/game/`. En el entorno local también existe
`HTML5/hub_runtime` como laboratorio auxiliar; `npm run sync-runtime` permite
copiarlo al Hub cuando se desea incorporar un cambio. La compilación normal
no necesita esa carpeta auxiliar.

## Compilar

En Windows, con Node.js 24 y desde `controller-electron`:

```powershell
npm ci
npm run dist
```

La compilación genera la UI, protege el núcleo con bytecode/ofuscación y
construye el instalador NSIS. `electron/license/product.dat` y el ID del
producto identifican el producto; no son credenciales de administración.
No guardar claves de clientes, tokens administrativos ni certificados en Git.

Pruebas locales desde `controller-electron`:

```powershell
node qa/client-discovery.cjs
node qa/port-conflict.cjs
node qa/runtime-security.cjs
node qa/timing-renderer-regression.cjs
node qa/timing-learning-regression.cjs
node qa/timing-contact-regression.cjs
node qa/timing-offline-harness.cjs
```

El harness incluye solo los métodos del cliente necesarios como fixtures;
no necesita una instalación del juego, capturas ni archivos de recon locales.
Las pruebas de timing verifican decisiones y protocolo con un reloj controlado;
no miden latencia real. Para validar el paquete protegido, ejecuta las pruebas
`qa/packaged-smoke.cjs` y `qa/port-conflict.cjs` con Electron de desarrollo y
`BB_PACKAGED_APP_DIR` apuntando al directorio `win-unpacked` generado.

## Versiones y recuperación

Cada entrega debe corresponder a un commit y una etiqueta `vVERSION`.
Para recuperar una versión utiliza una rama desde su etiqueta. Para deshacer
un cambio publicado utiliza `git revert COMMIT`, conservando el historial.
Una corrección distribuida debe incrementar la versión; no reemplazar un
instalador publicado por otro archivo con el mismo número de versión.

Consulta `controller-electron/RELEASE.md`, `SECURITY-RELEASE.md` y
`CRYPTLEX-SETUP.md` para validaciones, límites de seguridad y publicación.
El servidor empaquetado de Board en `controller-electron/electron/ring-board`
incluye los controles Pro: no sobrescribirlo con una compilación sin esos
controles. Los archivos de clientes originales, capturas, registros y builds
locales se conservan fuera del historial de este repositorio.

## Publicación de instaladores

El código permanece privado. Las descargas pueden publicarse en un repositorio
separado que solo contenga instaladores y hashes, si el propietario lo autoriza.
Cryptlex conserva la decisión de acceso a Basic/Pro y el catálogo de versiones.
No incorporar tokens de GitHub al cliente para acceder a un repo privado.
