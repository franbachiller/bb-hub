# Licencia BB Hub — Cryptlex / LexActivator

El gate (`gate.cjs`) necesita dos datos de tu panel de Cryptlex. Sin ellos, en
build de producción la app no arranca (modo `NO_CONFIG`).

## Qué pegar (una sola vez, desde https://app.cryptlex.com)

1. **Product ID** → en `config.json`, campo `productId`.
   Panel → *Products* → tu producto → copiás el **Product ID** (un GUID tipo
   `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`).

2. **Product.dat** → en el archivo `product.dat` (reemplazás todo el contenido).
   Panel → *Products* → tu producto → botón **Download product.dat**. Abrís ese
   archivo, copiás TODO el texto (es una línea larga) y lo pegás acá.
   > Alternativa: podés copiar directo el string de "Product Data" del panel.

3. **releaseVersion** en `config.json`: la versión de BB Hub que estás por
   distribuir (hoy `0.1.0`). Sirve si después usás licencias por versión.

## Cómo generás licencias para vender

Panel → *Licenses* → *Create license* → elegís la **License Policy**.
- La **política** define: duración (ej. 1 mes), cuántas PCs por licencia
  (activaciones, ej. 1), y el **lease / server sync** (cada cuánto el Hub
  revalida contra el server). Ese lease es lo que define qué tan rápido corta
  el kill-switch cuando revocás.
- Recomendado para empezar: duración mensual, 1 activación, lease corto
  (ej. cada 1–2 h) y *allow suspension* activado.

## Cómo cortás a un moroso (kill-switch)

Panel → *Licenses* → la licencia del cliente →
- **Suspend** (reversible) o **Revoke/Delete** (saca la activación).
En la próxima sincronización (dentro del lease), el Hub recibe el estado por el
callback, frena el bot y muestra "licencia inactiva". No se borra nada ajeno de
la PC del cliente: el `.exe` simplemente deja de funcionar.

## Probar con tu trial (30 días)

Mientras tengas el trial de Cryptlex activo, podés crear el producto, una
política y una licencia de prueba, y activar el Hub con esa clave para ver todo
el circuito (activar → revocar → bloquear) end-to-end.
