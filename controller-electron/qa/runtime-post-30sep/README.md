# Pruebas del runtime posterior al 30/09

Hub 0.1.26 vuelve a empaquetar el runtime del 30/09 (`29092026_html5_hub_v6_44_silent_gap`), el del prime.
Estas pruebas cubren funciones que se agregaron al runtime después de esa fecha (Autoclick por paso,
aislamiento del golpe, aprendizaje nuevo, Timing fichado, etc.) y no aplican a lo que se distribuye.
Quedan guardadas por si se vuelve a ese runtime; sus rutas relativas apuntan a `../electron` y hay que
moverlas de nuevo a `qa/` para correrlas. La prueba de lo que se distribuye es `qa/prime-0126-regression.cjs`.
- `test-hub-runtime.cjs` venía de `qa/harness/` (sus fixtures siguen ahí).
