// MovilizarMe Interpreter - servidor de tokens (LiveKit Cloud)
// Crea códigos de sala y firma tokens cortos por rol.
// Variables de entorno: LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, PORT
const express = require('express');
const cors = require('cors');
const { AccessToken } = require('livekit-server-sdk');

const app = express();
app.use(cors());
app.use(express.json());

const LIVEKIT_URL = process.env.LIVEKIT_URL || '';
const API_KEY = process.env.LIVEKIT_API_KEY || '';
const API_SECRET = process.env.LIVEKIT_API_SECRET || '';
const PORT = process.env.PORT || 8080;

// Código de sala: 6 caracteres sin ambiguos (sin 0/O, 1/I/L)
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function roomCode() {
  let code = '';
  for (let i = 0; i < 6; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return code;
}

// Salas creadas en esta corrida (memoria; se reinicia con el servidor)
const rooms = new Map(); // code -> createdAt
const ROOM_TTL_MS = 12 * 60 * 60 * 1000;
function roomAlive(code) {
  const t = rooms.get(code);
  if (!t) return false;
  if (Date.now() - t > ROOM_TTL_MS) { rooms.delete(code); return false; }
  return true;
}

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'movilizarme-interpreter', livekit: LIVEKIT_URL ? 'configurado' : 'sin-configurar' });
});

// Crear una sala nueva y devolver su código
app.post('/api/room', (req, res) => {
  let code = roomCode();
  while (rooms.has(code)) code = roomCode();
  rooms.set(code, Date.now());
  res.json({ room: code });
});

// Firmar un token: role = 'interpreter' (publica) | 'listener' (solo escucha)
app.post('/api/token', async (req, res) => {
  const { room, role, name } = req.body || {};
  if (!room || !roomAlive(String(room).toUpperCase())) {
    return res.status(404).json({ error: 'Sala no encontrada o ya cerrada.' });
  }
  if (!API_KEY || !API_SECRET) {
    return res.status(500).json({ error: 'Servidor sin claves de LiveKit.' });
  }
  const isInterpreter = role === 'interpreter';
  const identity = (isInterpreter ? 'interprete-' : 'oyente-') + Math.random().toString(36).slice(2, 9);
  const at = new AccessToken(API_KEY, API_SECRET, {
    identity,
    name: name || (isInterpreter ? 'Intérprete' : 'Oyente'),
    ttl: '6h',
  });
  at.addGrant({
    roomJoin: true,
    room: String(room).toUpperCase(),
    canPublish: isInterpreter,
    canSubscribe: true,
    canPublishData: isInterpreter,
  });
  res.json({ token: await at.toJwt(), url: LIVEKIT_URL, room: String(room).toUpperCase() });
});

app.listen(PORT, () => console.log('Interpreter token server en puerto ' + PORT));
