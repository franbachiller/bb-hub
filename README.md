# BB Hub

Código privado del Hub, Board y componentes auxiliares. Versión entregable:
**0.1.3 para Windows x64**. Licencias Basic/Pro mediante Cryptlex; el permiso
`ring_board=true` habilita el bot.

Desde 0.1.3 el Hub abre el juego por su cuenta: inicia sesión con la cuenta de
BoomBang guardada (cifrada con DPAPI), abre `BoomBangHTML5.exe` con CDP, inyecta
el runtime de `controller-electron/electron/game/` y lo conecta al `:9999`.
Ya no hacen falta `ABRIR_HUB_Y_CONTROLLER.cmd`, Node ni Playwright en el equipo
del cliente. El runtime se desarrolla en `HTML5/hub_runtime`; antes de compilar,
`npm run sync-runtime` copia la versión actual al Hub.

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
