# MovilizarMe Interpreter - MVP (WebRTC / LiveKit)

Construido el 2026-11-24. Plan completo en ../PLAN.md.

## Piezas

- `server/` - Servidor de tokens (Node + Express + livekit-server-sdk).
  Crea códigos de sala de 6 caracteres y firma tokens cortos: el intérprete
  puede publicar audio; el oyente solo puede escuchar. Probado en local:
  sala creada, tokens decodificados con los permisos correctos y sala falsa
  rechazada.
- `web/interprete.html` - Consola del intérprete: crear sala, elegir
  micrófono o fuente de audio, empezar/terminar, ver oyentes conectados.
- `web/proyector.html` - Pantalla para proyectar: QR grande (apunta a la
  página del oyente con el código puesto) y el código en letras gigantes.
  La librería de QR va incluida en `web/qrcode.min.js`, sin depender de CDN.
- `web/escuchar.html` - Página del oyente: bilingüe automática según el
  idioma del teléfono, código precargado si entra por QR, un solo botón
  grande "Escuchar". Esta página vivirá en movilizar.me/escuchar.

## Para ponerlo en vivo (en orden)

1. Ezequiel crea la cuenta de LiveKit Cloud (livekit.io) con su correo y un
   proyecto. En Settings > API keys genera una clave; la API key y el secret
   se guardan por la vía segura, nunca en el código.
2. El servidor de tokens se despliega en Render (web service desde
   `server/`, comando `npm start`) con las variables de `.env.example`:
   LIVEKIT_URL (wss://...livekit.cloud), LIVEKIT_API_KEY, LIVEKIT_API_SECRET.
3. `web/config.js`: apuntar `api` a la URL pública del servidor en Render.
4. Copiar `escuchar.html` (como index de /escuchar), `app.css`, `config.js`
   y `qrcode.min.js` al repo del sitio movilizar-me; la consola y el
   proyector pueden vivir en la misma carpeta o en una ruta interna.
5. Prueba piloto en un servicio real con audiencia pequeña (plan gratuito
   de LiveKit: ~8 a 10 oyentes en un servicio de 2 horas).

## Notas

- El audio del intérprete se publica sin cancelación de eco ni supresión de
  ruido (pensado para micrófono de diadema o salida de consola). Si se usa
  el micrófono del teléfono en sala abierta, revisar esos ajustes.
- Las salas viven en la memoria del servidor y caducan a las 12 horas.
- Fase siguiente: canal IA (texto + texto-a-voz) y consola de administración
  por iglesia; ver ../OPCIONES-IA.md cuando esté listo el estudio.

## Cuenta LiveKit (creada 2026-11-24)
- Cuenta creada por Ezequiel entrando con GitHub (ezeorihuela); proyecto
  "MovilizarMe Interpreter", región US, plan Build (gratuito), sin tarjeta.
- URL del proyecto: wss://movilizarme-interpreter-ok53esg9.livekit.cloud
- Las claves API se generan al desplegar y van directo a las variables de
  entorno de Render; nunca pasan por el chat ni por el código.

## Despliegue (2026-11-24, en vivo)
- Servidor de tokens en Render (plan gratuito):
  https://movilizarme-interpreter.onrender.com
  Verificado en producción: crea salas y firma tokens con los permisos
  correctos contra el proyecto real de LiveKit. Ojo: el plan gratuito de
  Render duerme tras inactividad; la primera conexión puede tardar hasta
  un minuto en despertar. En un servicio se mantiene despierto desde que
  la consola crea la sala.
- Páginas publicadas en el sitio: movilizar.me/escuchar (oyente),
  movilizar.me/escuchar/consola.html (intérprete) y
  movilizar.me/escuchar/proyector.html (proyección), enlazadas desde la
  página Herramientas en ambos idiomas.
- Repositorio del código: github.com/ezeorihuela/movilizarme-interpreter

## v2: Panel de super administrador (2026-11-24)
- El servidor exige la CLAVE de una iglesia para crear salas y para el
  token del intérprete. El oyente sigue libre: código y un botón.
- Datos en Postgres (Neon) vía DATABASE_URL: iglesias, claves, estatus
  (trial con fecha, activa, suspendida), salas y minutos. Sin
  DATABASE_URL corre en memoria (solo pruebas locales).
- Contador de minutos por iglesia con los webhooks de LiveKit
  (participant_joined/left, room_finished) en POST /api/webhook. La URL
  del webhook se registra en el proyecto de LiveKit.
- Panel en /admin del propio servidor: primer acceso crea la contraseña
  del administrador. Desde ahí: alta de iglesias, generación de claves,
  estatus y trials, salas activas, uso mensual por iglesia y envío del
  correo de bienvenida (SMTP de Gmail con contraseña de aplicación, que
  se guarda desde el propio panel en Ajustes).
- La pantalla de proyector incluye "Descargar imagen": compone la
  tarjeta de la sala como PNG 1920x1080 (logo, QR, código) lista para
  usar como diapositiva.
