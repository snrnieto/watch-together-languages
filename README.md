# Watch Together Languages

Extensión de Chrome para ver una película o serie en **dos idiomas a la vez**: uno por el
parlante (para quien está contigo) y otro por tus audífonos (para ti). La hice para aprender
idiomas viendo series con alguien que no los está aprendiendo.

Plataformas: **Netflix** y **YouTube** (en YouTube solo funciona con videos que tengan varias
pistas de audio).

> **Proyecto personal, gratuito y sin relación con Netflix ni con YouTube.** Lee la sección
> [Aviso](#aviso) antes de usarla.

## Instalar

No está en la Chrome Web Store; se instala en modo desarrollador:

1. Descarga este repositorio (**Code → Download ZIP**) y descomprímelo, o clónalo con git.
2. Abre `chrome://extensions`.
3. Activa **Modo de desarrollador** (arriba a la derecha).
4. Haz clic en **Cargar descomprimida** y elige la carpeta del proyecto (la que tiene `manifest.json`).
5. Fija el ícono en la barra (ícono de pieza de rompecabezas → chincheta).
6. Recarga las pestañas de Netflix o YouTube que ya tuvieras abiertas.

Para actualizar: descarga la nueva versión, reemplaza la carpeta y en `chrome://extensions`
haz clic en recargar (⟳) en la tarjeta de la extensión.

## Usar

**La primera vez**
1. Abre una película en Netflix y dale play.
2. Abre la extensión → **Permitir ver mis dispositivos de audio**. Chrome lo pregunta como
   "micrófono" porque es el único permiso que muestra la lista de dispositivos. **No se graba nada.**
3. Vuelve a abrir la extensión y elige:
   - **La película sale por**: tu parlante o la TV.
   - **El segundo idioma sale por**: tus audífonos.
   - **Idioma para los audífonos**: solo aparecen los idiomas disponibles para ese título.

**Cada vez**
- Pones la película y haces clic en **Activar audio dual**, o activas **Activar automáticamente**
  y no tienes que hacer nada.

**Los audífonos**
- No tienen que estar siempre conectados. Si no lo están, todo suena normal por el parlante.
- Si los conectas a mitad del capítulo, el segundo idioma arranca solo.
- Si se desconectan, el segundo idioma se silencia al instante, así nunca suenan los dos
  idiomas mezclados por el parlante.
- Con audífonos Bluetooth usa **Adelantar audífonos** para compensar su retraso.

## Cómo funciona

**Netflix: todo en la misma pestaña.** Netflix no permite dos reproducciones en el mismo
navegador, así que no se abre nada más:
- `src/netflix-manifest.js` toma la lista de pistas que el reproductor de Netflix ya tiene en la
  página, con los enlaces del audio de cada idioma.
- `src/inline-player.js` reproduce la pista del segundo idioma en un `<audio>` oculto (Media
  Source Extensions), por pedazos y sincronizada con el video. Solo usa pistas que Netflix
  entrega **sin cifrar**: si una pista viene protegida, la descarta. No rompe ni evade ningún DRM.
- `src/content.js` envía ese audio a los audífonos (`setSinkId`) y lo mantiene muteado hasta que
  esté ahí.

**YouTube: pestaña secundaria** en una ventana pequeña que se minimiza sola, sincronizada con la
principal.

Otros archivos:
- `src/adapters/*.js`: un adaptador por plataforma (tiempo, seek, play/pausa, pistas de audio).
- `src/page.js`: puente con el reproductor de la página.
- `src/background.js`: coordina las sesiones.
- `src/popup/`: el menú de la extensión.

Para agregar una plataforma: crear `src/adapters/<plataforma>.js` con la misma interfaz y
agregar el dominio en `manifest.json`.

## Privacidad

- No recoge, guarda ni envía datos a ningún servidor. No tiene analítica.
- El permiso de "micrófono" solo se usa para ver los nombres de tus dispositivos de audio;
  el micrófono se cierra de inmediato y no se graba nada.
- Lo único que guarda, y solo en tu navegador, son tus preferencias: idioma, dispositivos,
  volumen y retraso.

## Aviso

- Proyecto **personal, gratuito y de código abierto**, sin relación con Netflix, Inc. ni con
  YouTube/Google. Las marcas pertenecen a sus dueños.
- Es para **uso personal** con tu propia suscripción. **No descarga ni guarda contenido**: el audio
  se reproduce mientras ves el título y se descarta.
- Usar extensiones que modifican el sitio puede ir en contra de los términos de uso de Netflix.
  **Úsala bajo tu propio riesgo.**
- Depende de cómo funcionan hoy los reproductores de Netflix y YouTube. Si cambian (por ejemplo,
  si Netflix empieza a cifrar el audio), puede dejar de funcionar, y no se intentará evadir
  ninguna protección.
- No aceptaré cambios que agreguen descarga o guardado de contenido.

## Limitaciones conocidas

- Netflix solo entrega el audio de algunos idiomas por título (normalmente el original y unos
  pocos doblajes); solo esos aparecen en el menú.
- En YouTube usa 2 reproducciones y puede pedir un clic en Play la primera vez.
- Los anuncios de YouTube desincronizan unos segundos hasta que terminan.

## Licencia

[MIT](LICENSE)
