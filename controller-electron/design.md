# Design — BB Hub

Sistema de diseño fijo del BB Hub y del panel del Ring-board (el `<iframe>` de la vista Board).
Todo rediseño futuro lee este archivo primero. Si una pantalla necesita algo que el sistema no
permite, se enmienda este archivo; no se pisa el sistema en una sola pantalla.

## System
- Genre · modern-minimal (herramienta de escritorio, densa, seria), sobre papel oscuro
- Theme · custom tuned (vibe: "carmesí sobre papel oscuro, consola nocturna seria")
- Axes · dark / geometric-sans / warm (carmesí, hue ~22°)
- Tone · técnico / austero. Español rioplatense, corto, sin frases poéticas.

## Macrostructure family (app)
- Shell · N3 side-rail (izquierda, ~13rem, indicador de texto + ícono en carmesí; colapsa a íconos ≤ 1180 px con punto carmesí de 6 px para "activo" y a barra superior ≤ 760 px) + T4 stat strip arriba (conexión, ping, golpes, recibidos, carreras, coco, objetivo, Detener todo). La tira nunca oculta cifras: a ≤ 980 px acorta etiquetas ("Ganadas") y achica huecos. Sin footer.
- Inicio no repite cifras de la tira: "Sesión" muestra llegada estimada (cifra grande), objetivo, frontera del server y variación.
- Vistas de ajustes (Timing, Drops) · F3 spec sheet: filas nombre + descripción a la izquierda, control a la derecha, reglas finas entre filas; columna lateral opcional con UNA superficie (`paper-2`) para lecturas.
- Vistas de índice (Inicio, Jugadores, Registro) · Index-First: listas y tablas con reglas finas, sin tarjetas.
- Tablero (Board / Ring-board) · Map / Diagram: el tablero es la página (stage ≥ 62vh, zoom-to-fit con márgenes de media casilla); la línea de estado va en la cabecera y las herramientas en una sola fila.

## Theme (tokens.css es la fuente de verdad)
- `--color-paper`        oklch(14.5% 0.010 20)
- `--color-paper-2`      oklch(17.5% 0.011 20)   superficie elevada (panel, cabecera de tabla)
- `--color-paper-3`      oklch(21% 0.012 20)     hover, segmento activo
- `--color-rule`         oklch(27% 0.012 20)     reglas y bordes de superficie
- `--color-rule-2`       oklch(50% 0.012 20)     bordes de controles (≥ 3:1)
- `--color-ink`          oklch(95% 0.006 20)
- `--color-ink-2`        oklch(78% 0.010 20)
- `--color-muted`        oklch(64% 0.012 20)
- `--color-accent`       oklch(65% 0.190 22)     carmesí para texto y marcas (≥ 4,5:1 sobre paper, paper-3 y accent-wash)
- `--color-accent-fill`  oklch(50% 0.190 22)     carmesí de relleno (Detener todo, Board armado, switch maestro)
- `--color-accent-fill-2` oklch(46% 0.180 22)    hover del relleno
- `--color-accent-ink`   oklch(96% 0.010 20)     texto sobre el relleno (≈ 5:1)
- `--color-accent-wash`  oklch(23% 0.055 22)     fila objetivo, avisos
- `--color-focus`        oklch(70% 0.190 22)     anillo de foco, 2 px, offset 2 px, sin animación
- `--color-warn`         oklch(80% 0.140 75)     segunda y última señal: advertencias, "Modificado"
- Tablero: `--color-board-tile` oklch(29% 0.014 20) (≈1,4:1 sobre paper), `--color-board-tile-2` oklch(26% 0.012 20), junta entre casillas = `paper`, `--color-board-rival` oklch(72% 0.012 20), `--color-board-contact` oklch(40% 0.140 22). Nombres sobre plaqueta `paper` 86 %, ubicados sin pisarse (abajo, arriba, derecha, izquierda, más lejos).

Reglas de acento: el carmesí es "el bot actúa / peligro / objetivo" y ocupa ≤ 5 % de la vista. ON/conectado es monocromo (tinta clara); no hay verde. La transparencia solo es modificador de un token (overlays del canvas: `withAlpha(token, a)`), nunca un color propio.

## Typography
- Display · Inter 700, tracking −0.02em (títulos de vista, secciones, estado del motor, marca "BB Hub"). Inter es elección explícita del usuario (Hallmark la lista como default a evitar; la pidió el dueño).
- Body · Inter 400 (UI a 14 px); cifras en Inter con `tabular-nums` + `font-feature-settings: "tnum"`; cifra grande en Inter 300
- Mono · Geist Mono 400/500, un solo rol semántico: valores de máquina. Slots: ms y T+N, ids y #n, coordenadas, hash de escena, último comando, tecla de reinscripción, líneas del Registro, tabla y meta del roster del Ring-board.
- Escala 1.333: `--text-xs` 12 · `--text-sm` 14 · `--text-md` 18.7 · `--text-lg` 24.9 · `--text-xl` 33.2 · `--text-2xl` 44.2
- Sin itálicas en títulos, sin mayúsculas con tracking, sin eyebrows ni numeración de secciones.
- Fuentes locales: `@fontsource/inter` + `@fontsource/geist-mono` (Hub); `inter-latin-*.woff2` y `geist-mono-latin-*.woff2` en `ring-board/public/fonts/`.

## Signature
Una sola marca de dominio: la casilla isométrica del tablero (rombo 2:1, `.tile-mark`, `clip-path`). Aparece como marca "BB Hub", en el flag "Objetivo", en "Armar/Desarmar Board", en el título "Ring" del tablero y como marcador de las líneas de Registro (carmesí = pérdida, tinta = golpe, ámbar = aviso, sin marca = info). Sin glow ni ornamento.

## Spacing
Escala de 4 pt con nombre (`--space-3xs` … `--space-2xl`). Nada de valores sueltos. Controles a 36 px (`2.25rem`): botón, input, segmentado y stepper comparten altura.

## CTA voice
- Peligro / acción del bot · relleno `accent-fill`, texto `accent-ink`, radio 6 px ("Detener todo", "Desarmar Board").
- Primario neutro · relleno `ink`, texto `paper` ("Guardar" con cambios, "Aplicar").
- Secundario · borde `rule-2`, fondo transparente.
- Acción pendiente con acento · borde + texto `accent` ("Armar Board").
- Selectores de opciones · segmentado: el activo sube a `paper-3` con un subrayado carmesí de 2 px.
- Switches · apagado `paper-3`; encendido `ink` (ajustes) o `accent-fill` (maestros: Timing, Board).

## Motion stance
- Motion-cut. Tres primitivas: fundido de vista 200 ms, presión de botón (translateY 1 px), deslizamiento del switch 120 ms.
- Easing `--ease-out` (0.16, 1, 0.3, 1). Nada de glow, pulsos infinitos, scanlines ni bloom.
- `prefers-reduced-motion`: transiciones a 1 ms, animaciones a ≤ 150 ms.

## Microinteractions stance
- Éxito silencioso: el estado visible es la confirmación. Errores en un aviso `role="alert"` con borde carmesí.
- Hover solo como refuerzo; todo tiene `:focus-visible` inmediato.

## Per-page allowances
- Activación de licencia · por pedido del usuario: ventana opaca negro mate `#111111`, bordes y controles neutros, primario blanco; logo real `electron/assets/icon.png` y texto en español neutro. Conserva Inter + Geist Mono; sin tarjetas flotantes, transparencias, blur, degradados ni sombras.
- Aliados · los jugadores de la sala van en una grilla de casillas con borde `rule` (keko real extraído del juego, nombre, #id y estado), cada una es un interruptor de un clic (`aria-pressed`). Aliado = borde `ink` + etiqueta rellena `ink`; el carmesí no se usa (no es "el bot actúa"). Los aliados guardados van en lista con reglas finas.
- Sin enriquecimiento (ni ilustraciones ni fondos decorativos): la función carga la pantalla.
- El canvas del tablero lee los tokens en tiempo de ejecución (`cssToken()` en `ring-board/src/web/app.ts`).

## What pages MUST share
Marca "BB Hub" con el rombo carmesí, el par Inter + Geist Mono, el carmesí y su lugar, la voz de botones (radio 6 px, 36 px de alto), reglas finas en vez de tarjetas, títulos en minúscula de oración.

## What pages MAY differ on
La macroestructura dentro de la familia de arriba (spec sheet, índice o diagrama según la vista).

## Exports
`tokens.css` (en este proyecto, copiado idéntico a `ring-board/public/tokens.css`) es la fuente de verdad.
Para Tailwind v4 `@theme`, DTCG `tokens.json` o variables de shadcn/ui, pedir "extend design.md with <formato> exports".
