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
