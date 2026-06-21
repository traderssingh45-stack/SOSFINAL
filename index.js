// Campus SOS — backend server
// Receives SOS alerts from students, stores them, and pushes a notification
// to every registered admin device instantly via Firebase Cloud Messaging.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const Database = require('better-sqlite3');
const admin = require('firebase-admin');

// ---------- Firebase Admin init ----------
let firebaseReady = false;
try {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not set');
  const serviceAccount = JSON.parse(raw);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  firebaseReady = true;
  console.log('[firebase] initialized OK, project:', serviceAccount.project_id);
} catch (err) {
  console.error('[firebase] NOT initialized —', err.message);
  console.error('[firebase] Push notifications will be disabled until FIREBASE_SERVICE_ACCOUNT_JSON is set correctly.');
}

// ---------- DB setup ----------
const db = new Database(path.join(__dirname, 'sos.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS alerts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    lat REAL,
    lon REAL,
    accuracy REAL,
    loc_note TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    ack_at INTEGER,
    resolved_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS admin_tokens (
    token TEXT PRIMARY KEY,
    label TEXT,
    created_at INTEGER NOT NULL
  );
`);

const insertAlert = db.prepare(`
  INSERT INTO alerts (id, name, lat, lon, accuracy, loc_note, status, created_at)
  VALUES (@id, @name, @lat, @lon, @accuracy, @loc_note, 'active', @created_at)
`);
const updateAlertLocation = db.prepare(`
  UPDATE alerts SET lat=@lat, lon=@lon, accuracy=@accuracy WHERE id=@id
`);
const ackAlert = db.prepare(`UPDATE alerts SET status='ack', ack_at=@ts WHERE id=@id`);
const resolveAlert = db.prepare(`UPDATE alerts SET status='resolved', resolved_at=@ts WHERE id=@id`);
const cancelAlert = db.prepare(`DELETE FROM alerts WHERE id=@id`);
const getAlert = db.prepare(`SELECT * FROM alerts WHERE id=?`);
const listAlerts = db.prepare(`SELECT * FROM alerts ORDER BY created_at DESC LIMIT 100`);

const upsertToken = db.prepare(`
  INSERT INTO admin_tokens (token, label, created_at) VALUES (@token, @label, @ts)
  ON CONFLICT(token) DO UPDATE SET label=@label
`);
const allTokens = db.prepare(`SELECT token FROM admin_tokens`);
const deleteToken = db.prepare(`DELETE FROM admin_tokens WHERE token=?`);

// ---------- App ----------
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

function rowToAlert(r) {
  return {
    id: r.id,
    name: r.name,
    lat: r.lat,
    lon: r.lon,
    accuracy: r.accuracy,
    locNote: r.loc_note,
    status: r.status,
    createdAt: r.created_at,
    ackAt: r.ack_at,
    resolvedAt: r.resolved_at,
  };
}

// Register an admin device's push token (called once the admin grants notification permission)
app.post('/api/admin/register', (req, res) => {
  const { token, label } = req.body || {};
  if (!token) return res.status(400).json({ error: 'token is required' });
  upsertToken.run({ token, label: label || 'admin device', ts: Date.now() });
  res.json({ ok: true });
});

app.post('/api/admin/unregister', (req, res) => {
  const { token } = req.body || {};
  if (token) deleteToken.run(token);
  res.json({ ok: true });
});

// List alerts (admin dashboard polls or loads this on open)
app.get('/api/alerts', (req, res) => {
  res.json(listAlerts.all().map(rowToAlert));
});

// New SOS alert from a student device
app.post('/api/sos', async (req, res) => {
  const { name, lat, lon, accuracy, locNote } = req.body || {};
  const id = 'sos_' + Math.random().toString(36).slice(2, 10);
  const createdAt = Date.now();
  const cleanName = (name && String(name).trim()) || 'Unnamed student';

  insertAlert.run({
    id,
    name: cleanName,
    lat: typeof lat === 'number' ? lat : null,
    lon: typeof lon === 'number' ? lon : null,
    accuracy: typeof accuracy === 'number' ? accuracy : null,
    loc_note: locNote || null,
    created_at: createdAt,
  });

  // Fire push notification to every registered admin device, in parallel.
  await pushToAllAdmins({
    title: '🚨 SOS Alert',
    body: lat != null
      ? `${cleanName} needs help — location attached.`
      : `${cleanName} needs help — location unavailable.`,
    data: { type: 'sos', alertId: id },
  });

  res.json({ ok: true, id, createdAt });
});

// Student device sends a better GPS fix after the initial alert (e.g. high-accuracy follow-up)
app.post('/api/sos/:id/location', (req, res) => {
  const { id } = req.params;
  const { lat, lon, accuracy } = req.body || {};
  const existing = getAlert.get(id);
  if (!existing) return res.status(404).json({ error: 'alert not found' });
  updateAlertLocation.run({ id, lat, lon, accuracy });
  res.json({ ok: true });
});

app.post('/api/sos/:id/ack', async (req, res) => {
  const { id } = req.params;
  const existing = getAlert.get(id);
  if (!existing) return res.status(404).json({ error: 'alert not found' });
  ackAlert.run({ id, ts: Date.now() });
  res.json({ ok: true });
});

app.post('/api/sos/:id/resolve', async (req, res) => {
  const { id } = req.params;
  const existing = getAlert.get(id);
  if (!existing) return res.status(404).json({ error: 'alert not found' });
  resolveAlert.run({ id, ts: Date.now() });
  res.json({ ok: true });
});

app.post('/api/sos/:id/cancel', (req, res) => {
  const { id } = req.params;
  cancelAlert.run({ id });
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, firebaseReady });
});

async function pushToAllAdmins(notificationPayload) {
  if (!firebaseReady) {
    console.warn('[push] Firebase not configured — skipping push, alert is still saved to dashboard.');
    return;
  }
  const tokens = allTokens.all().map((r) => r.token);
  if (tokens.length === 0) {
    console.warn('[push] No admin devices registered yet — nothing to push to.');
    return;
  }

  const message = {
    notification: {
      title: notificationPayload.title,
      body: notificationPayload.body,
    },
    data: Object.fromEntries(
      Object.entries(notificationPayload.data || {}).map(([k, v]) => [k, String(v)])
    ),
    webpush: {
      headers: { Urgency: 'high' },
      notification: {
        requireInteraction: true,
        icon: '/icons/icon-192.png',
        vibrate: [200, 100, 200, 100, 200],
      },
      fcmOptions: { link: '/admin.html' },
    },
    tokens,
  };

  try {
    const result = await admin.messaging().sendEachForMulticast(message);
    console.log(`[push] sent: ${result.successCount} ok, ${result.failureCount} failed`);
    result.responses.forEach((r, i) => {
      if (!r.success) {
        console.warn('[push] failed token, removing:', tokens[i], r.error && r.error.message);
        // Clean up dead tokens (uninstalled app, expired, etc.)
        deleteToken.run(tokens[i]);
      }
    });
  } catch (err) {
    console.error('[push] error sending multicast:', err.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Campus SOS server listening on port ${PORT}`);
  console.log(`Firebase push: ${firebaseReady ? 'ENABLED' : 'DISABLED (check .env)'}`);
});
