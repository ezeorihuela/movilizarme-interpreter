// MovilizarMe Interpreter - servidor v2
// Salas con clave por iglesia, panel de super administrador, contador de
// minutos por iglesia (webhooks de LiveKit) y correo de bienvenida.
// Env: LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, DATABASE_URL, PORT
// Sin DATABASE_URL usa memoria (solo pruebas locales).
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const { AccessToken, WebhookReceiver } = require('livekit-server-sdk');

const LIVEKIT_URL = process.env.LIVEKIT_URL || '';
const API_KEY = process.env.LIVEKIT_API_KEY || '';
const API_SECRET = process.env.LIVEKIT_API_SECRET || '';
const PORT = process.env.PORT || 8080;
const DATABASE_URL = process.env.DATABASE_URL || '';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function makeCode(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}
const normKey = (k) => String(k || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
const fmtKey = (k) => (k && k.length === 8 ? k.slice(0, 4) + '-' + k.slice(4) : k);

// ---------------- Almacén de datos ----------------
let pool = null;
if (DATABASE_URL) {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
}
const mem = { churches: [], rooms: new Map(), settings: new Map(), nextId: 1 };

async function dbInit() {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS churches (
    id SERIAL PRIMARY KEY, name TEXT NOT NULL, contact_name TEXT DEFAULT '',
    email TEXT DEFAULT '', key TEXT UNIQUE NOT NULL, status TEXT NOT NULL DEFAULT 'trial',
    trial_ends DATE, notes TEXT DEFAULT '', created_at TIMESTAMPTZ DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS rooms (
    code TEXT PRIMARY KEY, church_id INT, church_name TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT now(), finished_at TIMESTAMPTZ,
    participant_minutes NUMERIC DEFAULT 0, listener_minutes NUMERIC DEFAULT 0, peak INT DEFAULT 0)`);
  await pool.query(`ALTER TABLE rooms ADD COLUMN IF NOT EXISTS title TEXT DEFAULT ''`);
}
const store = {
  async getSetting(k) {
    if (pool) { const r = await pool.query('SELECT v FROM settings WHERE k=$1', [k]); return r.rows[0] ? r.rows[0].v : null; }
    return mem.settings.has(k) ? mem.settings.get(k) : null;
  },
  async setSetting(k, v) {
    if (pool) await pool.query('INSERT INTO settings(k,v) VALUES($1,$2) ON CONFLICT(k) DO UPDATE SET v=$2', [k, v]);
    else mem.settings.set(k, v);
  },
  async listChurches() {
    if (pool) { const r = await pool.query('SELECT * FROM churches ORDER BY created_at'); return r.rows; }
    return mem.churches.slice();
  },
  async getChurchByKey(key) {
    if (pool) { const r = await pool.query('SELECT * FROM churches WHERE key=$1', [key]); return r.rows[0] || null; }
    return mem.churches.find((c) => c.key === key) || null;
  },
  async getChurch(id) {
    if (pool) { const r = await pool.query('SELECT * FROM churches WHERE id=$1', [id]); return r.rows[0] || null; }
    return mem.churches.find((c) => c.id === Number(id)) || null;
  },
  async createChurch(data) {
    if (pool) {
      const r = await pool.query(
        `INSERT INTO churches(name, contact_name, email, key, status, trial_ends, notes)
         VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [data.name, data.contact_name, data.email, data.key, data.status, data.trial_ends, data.notes]);
      return r.rows[0];
    }
    const c = Object.assign({ id: mem.nextId++, created_at: new Date().toISOString() }, data);
    mem.churches.push(c); return c;
  },
  async updateChurch(id, data) {
    const cur = await this.getChurch(id); if (!cur) return null;
    const next = Object.assign({}, cur, data);
    if (pool) {
      await pool.query(
        `UPDATE churches SET name=$1, contact_name=$2, email=$3, key=$4, status=$5, trial_ends=$6, notes=$7 WHERE id=$8`,
        [next.name, next.contact_name, next.email, next.key, next.status, next.trial_ends, next.notes, id]);
    } else {
      const i = mem.churches.findIndex((c) => c.id === Number(id)); mem.churches[i] = next;
    }
    return next;
  },
  async createRoom(code, church, title) {
    if (pool) await pool.query('INSERT INTO rooms(code, church_id, church_name, title) VALUES($1,$2,$3,$4)', [code, church ? church.id : null, church ? church.name : '', title || '']);
    else mem.rooms.set(code, { code, church_id: church ? church.id : null, church_name: church ? church.name : '', title: title || '', created_at: Date.now(), finished_at: null, participant_minutes: 0, listener_minutes: 0, peak: 0 });
  },
  async getRoom(code) {
    if (pool) { const r = await pool.query('SELECT * FROM rooms WHERE code=$1', [code]); return r.rows[0] || null; }
    return mem.rooms.get(code) || null;
  },
  async addMinutes(code, total, listener, peak) {
    if (pool) await pool.query('UPDATE rooms SET participant_minutes = participant_minutes + $1, listener_minutes = listener_minutes + $2, peak = GREATEST(peak, $3) WHERE code = $4', [total, listener, peak, code]);
    else { const r = mem.rooms.get(code); if (r) { r.participant_minutes += total; r.listener_minutes += listener; r.peak = Math.max(r.peak, peak); } }
  },
  async finishRoom(code) {
    if (pool) await pool.query('UPDATE rooms SET finished_at = now() WHERE code=$1', [code]);
    else { const r = mem.rooms.get(code); if (r) r.finished_at = Date.now(); }
  },
  async usage() {
    // Por iglesia: salas y minutos del mes actual y de siempre
    if (pool) {
      const r = await pool.query(`
        SELECT c.id, c.name,
          COUNT(r.code) FILTER (WHERE date_trunc('month', r.created_at) = date_trunc('month', now())) AS rooms_month,
          COALESCE(SUM(r.participant_minutes) FILTER (WHERE date_trunc('month', r.created_at) = date_trunc('month', now())), 0) AS minutes_month,
          COALESCE(SUM(r.listener_minutes) FILTER (WHERE date_trunc('month', r.created_at) = date_trunc('month', now())), 0) AS listener_month,
          COUNT(r.code) AS rooms_total,
          COALESCE(SUM(r.participant_minutes), 0) AS minutes_total
        FROM churches c LEFT JOIN rooms r ON r.church_id = c.id GROUP BY c.id, c.name`);
      return r.rows;
    }
    const now = new Date(); const out = [];
    for (const c of mem.churches) {
      const rs = [...mem.rooms.values()].filter((r) => r.church_id === c.id);
      const rm = rs.filter((r) => new Date(r.created_at).getMonth() === now.getMonth());
      out.push({ id: c.id, name: c.name, rooms_month: rm.length, minutes_month: rm.reduce((a, r) => a + r.participant_minutes, 0), listener_month: rm.reduce((a, r) => a + r.listener_minutes, 0), rooms_total: rs.length, minutes_total: rs.reduce((a, r) => a + r.participant_minutes, 0) });
    }
    return out;
  },
  async activeRooms() {
    if (pool) { const r = await pool.query('SELECT code, church_name, created_at FROM rooms WHERE finished_at IS NULL AND created_at > now() - interval \'12 hours\' ORDER BY created_at DESC'); return r.rows; }
    return [...mem.rooms.values()].filter((r) => !r.finished_at).map((r) => ({ code: r.code, church_name: r.church_name, created_at: new Date(r.created_at).toISOString() }));
  },
};

// Idioma de los mensajes: el cliente manda el idioma de su interfaz en el
// cuerpo (lang) o en la cabecera X-MM-Lang. Español por defecto.
function langOf(req) {
  const l = (req.body && req.body.lang) || (req.get ? req.get('X-MM-Lang') : '') || '';
  return l === 'en' ? 'en' : 'es';
}
function L(req, es, en) { return langOf(req) === 'en' ? en : es; }

function churchValid(c, lg) {
  const en = lg === 'en';
  if (!c) return { ok: false, error: en ? 'Church key not recognized.' : 'Clave de iglesia no reconocida.' };
  if (c.status === 'suspended') return { ok: false, error: en ? "This church's subscription is suspended. Contact MovilizarMe." : 'La suscripción de esta iglesia está suspendida. Contacta a MovilizarMe.' };
  if (c.status === 'trial' && c.trial_ends) {
    const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
    if (new Date(c.trial_ends) < hoy) return { ok: false, error: en ? "This church's trial period has ended. Contact MovilizarMe." : 'El periodo de prueba de esta iglesia terminó. Contacta a MovilizarMe.' };
  }
  return { ok: true };
}

// ---------------- Contraseña del administrador ----------------
function hashPass(pass, salt) {
  return crypto.scryptSync(pass, salt, 64).toString('hex');
}
async function setAdminPass(pass) {
  const salt = crypto.randomBytes(16).toString('hex');
  await store.setSetting('admin_pass', salt + ':' + hashPass(pass, salt));
}
async function checkAdminPass(pass) {
  const saved = await store.getSetting('admin_pass');
  if (!saved) return false;
  const [salt, h] = saved.split(':');
  const calc = hashPass(pass, salt);
  return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(calc));
}
async function sessionToken() {
  const saved = await store.getSetting('admin_pass');
  return crypto.createHmac('sha256', saved || 'sin-clave').update('mm-admin-session').digest('hex');
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim(); });
  return out;
}
async function isAdmin(req) {
  const t = parseCookies(req).mm_admin;
  return !!t && t === (await sessionToken());
}
async function requireAdmin(req, res, next) {
  if (await isAdmin(req)) return next();
  res.status(401).json({ error: L(req, 'Sesión de administrador requerida.', 'Admin session required.') });
}

// ---------------- Correo de bienvenida ----------------
async function sendWelcome(church, lg) {
  const E = (es, en) => (lg === 'en' ? en : es);
  if (!church.email) throw new Error(E('Esta iglesia no tiene correo registrado.', 'This church has no email on file.'));
  const clave = fmtKey(church.key);
  const prueba = church.status === 'trial' && church.trial_ends
    ? `\nSu periodo de prueba vence el ${new Date(church.trial_ends).toLocaleDateString('es')}.` : '';
  const texto =
`Hola, ${church.contact_name || church.name}:

¡Bienvenidos al servicio de interpretación en vivo de MovilizarMe!

Su iglesia: ${church.name}
Su clave de acceso: ${clave}${prueba}

Con esa clave, su intérprete entra a la consola y crea la sala de cada servicio:
Consola del intérprete: https://movilizar.me/escuchar/consola.html

Los oyentes no necesitan clave ni cuenta. Solo escanean el código QR de la
pantalla de proyector o entran a https://movilizar.me/escuchar con el código
de la sala.

Pasos rápidos:
1. Abran la consola y escriban su clave (se recuerda en ese equipo).
2. Creen la sala y abran la pantalla de proyector desde la consola.
3. El intérprete toca "Empezar a interpretar" y habla por su micrófono.
4. La congregación escanea el QR y toca "Escuchar".

Guarden su clave en un lugar seguro y no la compartan fuera de su equipo.

¿Dudas? Escríbannos a ezequiel@movilizar.me

MovilizarMe · Ayudando a las personas a encontrar su camino de regreso a Dios`;
  // Vía principal: API de Gmail por HTTPS (Render gratis bloquea SMTP).
  const refresh = await store.getSetting('gmail_refresh');
  if (refresh) { await sendViaGmail(church, texto); return; }
  // Respaldo: SMTP clásico (solo funciona donde no bloqueen los puertos).
  const user = await store.getSetting('smtp_user');
  const pass = await store.getSetting('smtp_pass');
  if (!user || !pass) throw new Error(E('Correo no configurado: conecta tu cuenta de Google en el panel.', 'Email not set up: connect your Google account in the panel.'));
  const nodemailer = require('nodemailer');
  const t = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass }, family: 4, connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 25000 });
  await t.sendMail({
    from: `MovilizarMe <${user}>`, to: church.email,
    subject: 'Su clave de interpretación en vivo · MovilizarMe',
    text: texto,
  });
}

// ---------------- Gmail API (OAuth, envío por HTTPS) ----------------
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://panel.movilizar.me').replace(/\/$/, '');
const GOOGLE_REDIRECT = PUBLIC_URL + '/api/admin/google/callback';

async function googleTokenRequest(params) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error('Google: ' + (d.error_description || d.error || ('HTTP ' + r.status)));
    err.code = d.error === 'invalid_grant' ? 'EGMAILAUTH' : 'EGMAIL';
    throw err;
  }
  return d;
}
async function gmailAccessToken() {
  const refresh = await store.getSetting('gmail_refresh');
  if (!refresh) { const e = new Error('La cuenta de Google no está conectada.'); e.code = 'EGMAILAUTH'; throw e; }
  const d = await googleTokenRequest({ client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, refresh_token: refresh, grant_type: 'refresh_token' });
  return d.access_token;
}
function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
async function sendViaGmail(church, texto) {
  const from = (await store.getSetting('gmail_user')) || 'me';
  const subject = 'Su clave de interpretación en vivo · MovilizarMe';
  const mime = [
    'From: MovilizarMe <' + from + '>',
    'To: ' + church.email,
    'Subject: =?UTF-8?B?' + Buffer.from(subject, 'utf8').toString('base64') + '?=',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    // El cuerpo base64 va en líneas de 76 caracteres (estándar MIME):
    // en una sola línea larga, Apple Mail no lo decodifica y muestra
    // el código crudo en vez del texto.
    Buffer.from(texto, 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n').trim(),
  ].join('\r\n');
  const access = await gmailAccessToken();
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + access, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: b64url(mime) }),
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    const err = new Error('Gmail: ' + ((d.error && d.error.message) || ('HTTP ' + r.status)));
    err.code = (r.status === 401 || r.status === 403) ? 'EGMAILAUTH' : 'EGMAIL';
    throw err;
  }
}

// ---------------- App ----------------
const app = express();
app.use(cors());
// El panel es una herramienta privada: fuera de los buscadores.
app.use((req, res, next) => { res.setHeader('X-Robots-Tag', 'noindex, nofollow'); next(); });
app.get('/robots.txt', (req, res) => { res.type('text/plain').send('User-agent: *\nDisallow: /\n'); });

// Webhook de LiveKit: cuerpo crudo, antes del parser JSON
const receiver = (API_KEY && API_SECRET) ? new WebhookReceiver(API_KEY, API_SECRET) : null;
const joins = new Map(); // sala:identidad -> {joinedAt, room}
app.post('/api/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  if (!receiver) return res.status(503).end();
  try {
    const evt = await receiver.receive(req.body.toString(), req.get('Authorization'));
    const roomName = evt.room ? evt.room.name : '';
    const p = evt.participant || {};
    if (evt.event === 'participant_joined' && roomName) {
      joins.set(roomName + ':' + p.identity, { joinedAt: Number(p.joinedAt) || Math.floor(Date.now() / 1000), room: roomName });
      const enSala = [...joins.keys()].filter((k) => k.startsWith(roomName + ':')).length;
      await store.addMinutes(roomName, 0, 0, enSala);
    } else if (evt.event === 'participant_left' && roomName) {
      const j = joins.get(roomName + ':' + p.identity);
      joins.delete(roomName + ':' + p.identity);
      const joinedAt = j ? j.joinedAt : (Number(p.joinedAt) || Math.floor(Date.now() / 1000));
      const mins = Math.max(0, (Date.now() / 1000 - joinedAt) / 60);
      const esOyente = String(p.identity || '').startsWith('oyente-');
      await store.addMinutes(roomName, mins, esOyente ? mins : 0, 0);
    } else if (evt.event === 'room_finished' && roomName) {
      for (const [k, j] of [...joins.entries()]) {
        if (j.room === roomName) {
          const mins = Math.max(0, (Date.now() / 1000 - j.joinedAt) / 60);
          const esOyente = k.split(':')[1].startsWith('oyente-');
          await store.addMinutes(roomName, mins, esOyente ? mins : 0, 0);
          joins.delete(k);
        }
      }
      await store.finishRoom(roomName);
    }
    res.status(200).end();
  } catch (e) {
    res.status(401).end();
  }
});

app.use(express.json());

app.get('/', (req, res) => res.redirect('/admin'));
app.get('/health', async (req, res) => {
  res.json({ ok: true, service: 'movilizarme-interpreter', version: 2, livekit: LIVEKIT_URL ? 'configurado' : 'sin-configurar', datos: pool ? 'base-de-datos' : 'memoria' });
});

// Crear sala: exige la clave de una iglesia con suscripción válida.
// Nombre del evento (opcional): lo escribe la consola, por ejemplo
// "Servicio dominical" o "Conferencia", y el oyente lo ve como título.
function cleanTitle(v) {
  return String(v || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 80);
}
app.post('/api/room', async (req, res) => {
  const key = normKey((req.body || {}).key);
  const church = await store.getChurchByKey(key);
  const v = churchValid(church, langOf(req));
  if (!v.ok) return res.status(403).json({ error: v.error });
  const title = cleanTitle((req.body || {}).name);
  let code = makeCode(6);
  while (await store.getRoom(code)) code = makeCode(6);
  await store.createRoom(code, church, title);
  res.json({ room: code, church: church.name, title });
});

// Token temporal de Azure para el modo IA de la consola.
// Valida la sala y la clave igual que /api/token para el rol intérprete.
// La clave de Azure vive solo en el servidor: al navegador llega un token
// temporal de 10 minutos que pide este endpoint a Azure.
app.post('/api/azure/token', async (req, res) => {
  const { room, key } = req.body || {};
  const code = String(room || '').toUpperCase();
  const r = await store.getRoom(code);
  if (!r || r.finished_at) return res.status(404).json({ error: L(req, 'Sala no encontrada o ya cerrada.', 'Room not found or already closed.') });
  const church = await store.getChurchByKey(normKey(key));
  if (!church || church.id !== r.church_id) return res.status(403).json({ error: L(req, 'Se requiere la clave de la iglesia dueña de esta sala.', 'The key of the church that owns this room is required.') });
  const v = churchValid(church, langOf(req));
  if (!v.ok) return res.status(403).json({ error: v.error });
  const azKey = await store.getSetting('azure_key');
  const azRegion = await store.getSetting('azure_region');
  if (!azKey || !azRegion) return res.status(400).json({ error: L(req, 'La interpretación por IA aún no está configurada. Falta guardar la clave de Azure en el panel.', 'AI interpretation is not set up yet. The Azure key still needs to be saved in the panel.') });
  try {
    const resp = await fetch('https://' + azRegion + '.api.cognitive.microsoft.com/sts/v1.0/issueToken', {
      method: 'POST',
      headers: { 'Ocp-Apim-Subscription-Key': azKey, 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (!resp.ok) throw new Error('Azure respondió ' + resp.status);
    const token = await resp.text();
    res.json({ token, region: azRegion });
  } catch (e) {
    res.status(502).json({ error: L(req, 'Azure rechazó la clave o no respondió. Revisa la clave y la región guardadas en el panel.', 'Azure rejected the key or did not respond. Check the key and region saved in the panel.') });
  }
});

// Token: el oyente solo necesita la sala; el intérprete, la clave de su iglesia
app.post('/api/token', async (req, res) => {
  const { room, role, name, key } = req.body || {};
  const code = String(room || '').toUpperCase();
  const r = await store.getRoom(code);
  if (!r || r.finished_at) return res.status(404).json({ error: L(req, 'Sala no encontrada o ya cerrada.', 'Room not found or already closed.') });
  if (!API_KEY || !API_SECRET) return res.status(500).json({ error: L(req, 'Servidor sin claves de LiveKit.', 'Server is missing its LiveKit keys.') });
  const isInterpreter = role === 'interpreter';
  if (isInterpreter) {
    const church = await store.getChurchByKey(normKey(key));
    if (!church || church.id !== r.church_id) return res.status(403).json({ error: L(req, 'Se requiere la clave de la iglesia dueña de esta sala.', 'The key of the church that owns this room is required.') });
    const v = churchValid(church, langOf(req));
    if (!v.ok) return res.status(403).json({ error: v.error });
  }
  const identity = (isInterpreter ? 'interprete-' : 'oyente-') + Math.random().toString(36).slice(2, 9);
  const at = new AccessToken(API_KEY, API_SECRET, { identity, name: name || (isInterpreter ? 'Intérprete' : 'Oyente'), ttl: '6h' });
  at.addGrant({ roomJoin: true, room: code, canPublish: isInterpreter, canSubscribe: true, canPublishData: isInterpreter });
  res.json({ token: await at.toJwt(), url: LIVEKIT_URL, room: code, title: r.title || '' });
});

// ---------------- Panel de administración ----------------
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '..', 'web', 'admin.html')));

app.get('/api/admin/state', async (req, res) => {
  const saved = await store.getSetting('admin_pass');
  res.json({ needsSetup: !saved, authed: await isAdmin(req), mailConfigured: !!(await store.getSetting('smtp_user')) });
});
app.post('/api/admin/setup', async (req, res) => {
  if (await store.getSetting('admin_pass')) return res.status(409).json({ error: L(req, 'La contraseña ya existe.', 'The password already exists.') });
  const pass = String((req.body || {}).password || '');
  if (pass.length < 10) return res.status(400).json({ error: L(req, 'Usa al menos 10 caracteres.', 'Use at least 10 characters.') });
  await setAdminPass(pass);
  res.cookie('mm_admin', await sessionToken(), { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 30 * 24 * 3600 * 1000 });
  res.json({ ok: true });
});
app.post('/api/admin/login', async (req, res) => {
  if (!(await checkAdminPass(String((req.body || {}).password || '')))) return res.status(401).json({ error: L(req, 'Contraseña incorrecta.', 'Incorrect password.') });
  res.cookie('mm_admin', await sessionToken(), { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 30 * 24 * 3600 * 1000 });
  res.json({ ok: true });
});
app.post('/api/admin/logout', (req, res) => { res.clearCookie('mm_admin'); res.json({ ok: true }); });

app.get('/api/admin/churches', requireAdmin, async (req, res) => {
  const churches = await store.listChurches();
  const usage = await store.usage();
  const u = Object.fromEntries(usage.map((x) => [x.id, x]));
  res.json({ churches: churches.map((c) => Object.assign({}, c, { key: fmtKey(c.key), usage: u[c.id] || null })), activeRooms: await store.activeRooms() });
});
app.post('/api/admin/churches', requireAdmin, async (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: L(req, 'Falta el nombre de la iglesia.', 'The church name is missing.') });
  let key = makeCode(8);
  while (await store.getChurchByKey(key)) key = makeCode(8);
  const church = await store.createChurch({
    name: String(b.name), contact_name: String(b.contactName || ''), email: String(b.email || ''),
    key, status: ['trial', 'active', 'suspended'].includes(b.status) ? b.status : 'trial',
    trial_ends: b.trialEnds || null, notes: String(b.notes || ''),
  });
  res.json({ church: Object.assign({}, church, { key: fmtKey(church.key) }) });
});
app.patch('/api/admin/churches/:id', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const data = {};
  if (b.name !== undefined) data.name = String(b.name);
  if (b.contactName !== undefined) data.contact_name = String(b.contactName);
  if (b.email !== undefined) data.email = String(b.email);
  if (b.status !== undefined) data.status = b.status;
  if (b.trialEnds !== undefined) data.trial_ends = b.trialEnds || null;
  if (b.notes !== undefined) data.notes = String(b.notes);
  if (b.regenerateKey) { let k = makeCode(8); while (await store.getChurchByKey(k)) k = makeCode(8); data.key = k; }
  const church = await store.updateChurch(req.params.id, data);
  if (!church) return res.status(404).json({ error: L(req, 'Iglesia no encontrada.', 'Church not found.') });
  res.json({ church: Object.assign({}, church, { key: fmtKey(church.key) }) });
});
app.post('/api/admin/churches/:id/welcome', requireAdmin, async (req, res) => {
  const church = await store.getChurch(req.params.id);
  if (!church) return res.status(404).json({ error: L(req, 'Iglesia no encontrada.', 'Church not found.') });
  try { await sendWelcome(church, langOf(req)); res.json({ ok: true }); }
  catch (e) {
    let m = e.message;
    if (e.code === 'EGMAILAUTH') m = L(req, 'La autorización de Google venció o fue revocada. En el panel, vuelve a conectar tu cuenta de Google.', 'The Google authorization expired or was revoked. In the panel, reconnect your Google account.');
    else if (e.code === 'EAUTH') m = L(req, 'Gmail rechazó el usuario o la contraseña. Revisa que la contraseña sea una contraseña de aplicación vigente de esa cuenta.', 'Gmail rejected the user or password. Make sure the password is a current app password for that account.');
    else if (e.code === 'ETIMEDOUT' || e.code === 'ECONNECTION' || e.code === 'ESOCKET') m = L(req, 'No se pudo conectar con el servidor de Gmail (la conexión falló o tardó demasiado). Inténtalo de nuevo en un momento.', 'Could not connect to the Gmail server (the connection failed or took too long). Try again in a moment.');
    res.status(400).json({ error: m });
  }
});
app.get('/api/admin/settings', requireAdmin, async (req, res) => {
  res.json({
    smtpUser: (await store.getSetting('smtp_user')) || '', smtpConfigured: !!(await store.getSetting('smtp_pass')),
    gmailUser: (await store.getSetting('gmail_user')) || '', gmailConnected: !!(await store.getSetting('gmail_refresh')),
    googleConfigured: !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
    azureRegion: (await store.getSetting('azure_region')) || '', azureConfigured: !!(await store.getSetting('azure_key')),
  });
});
app.get('/api/admin/google/connect', requireAdmin, async (req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return res.redirect('/admin?gmail=sin-credenciales');
  const nonce = crypto.randomBytes(16).toString('hex');
  await store.setSetting('google_oauth_nonce', nonce);
  const q = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID, redirect_uri: GOOGLE_REDIRECT, response_type: 'code',
    scope: 'openid email https://www.googleapis.com/auth/gmail.send',
    access_type: 'offline', prompt: 'consent', state: nonce,
  });
  res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + q.toString());
});
app.get('/api/admin/google/callback', async (req, res) => {
  try {
    const nonce = await store.getSetting('google_oauth_nonce');
    if (!nonce || req.query.state !== nonce || !req.query.code) return res.redirect('/admin?gmail=error');
    await store.setSetting('google_oauth_nonce', '');
    const d = await googleTokenRequest({ client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, code: String(req.query.code), redirect_uri: GOOGLE_REDIRECT, grant_type: 'authorization_code' });
    if (!d.refresh_token) return res.redirect('/admin?gmail=sin-token');
    let email = '';
    try {
      const ui = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { 'Authorization': 'Bearer ' + d.access_token } });
      const uj = await ui.json().catch(() => ({}));
      email = uj.email || '';
    } catch (e) { /* el correo es opcional */ }
    await store.setSetting('gmail_refresh', d.refresh_token);
    await store.setSetting('gmail_user', email);
    res.redirect('/admin?gmail=conectado');
  } catch (e) {
    res.redirect('/admin?gmail=error');
  }
});
app.post('/api/admin/google/disconnect', requireAdmin, async (req, res) => {
  const refresh = await store.getSetting('gmail_refresh');
  if (refresh) { try { await fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: refresh }) }); } catch (e) { /* da igual */ } }
  await store.setSetting('gmail_refresh', '');
  await store.setSetting('gmail_user', '');
  res.json({ ok: true });
});
app.post('/api/admin/settings', requireAdmin, async (req, res) => {
  const b = req.body || {};
  if (b.smtpUser !== undefined) await store.setSetting('smtp_user', String(b.smtpUser));
  if (b.smtpPass) await store.setSetting('smtp_pass', String(b.smtpPass));
  if (b.azureRegion !== undefined) await store.setSetting('azure_region', String(b.azureRegion).trim().toLowerCase());
  if (b.azureKey) await store.setSetting('azure_key', String(b.azureKey).trim());
  res.json({ ok: true });
});

dbInit()
  .then(() => app.listen(PORT, () => console.log('Interpreter server v2 en puerto ' + PORT + (pool ? ' (con base de datos)' : ' (memoria, solo pruebas)'))))
  .catch((e) => { console.error('Error iniciando la base de datos:', e.message); app.listen(PORT, () => console.log('Interpreter server v2 en puerto ' + PORT + ' (sin base de datos)')); });
