/**
 * Freedom Fighters boss server.
 * Receives crystal events from ESP32-C3, manages boss HP, broadcasts to boss/admin
 * views via Socket.IO, and optionally drives WLED by HP tier.
 */

const express = require('express');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT) || 3000;
const BOSS_MAX_HP = Number(process.env.BOSS_MAX_HP) || 100;
const HP_PER_CRYSTAL = Number(process.env.HP_PER_CRYSTAL) || 10;
const WLED_URL = process.env.WLED_URL || '';
const MAX_RECENT_EVENTS = 20;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static('public'));

// In-memory state (consider Redis/file for persistence across restarts)
const state = {
  bossHp: BOSS_MAX_HP,
  maxHp: BOSS_MAX_HP,
  crystalCount: 0,
  totalCrystalsReceived: 0,
  recentEvents: [],
  gameOver: false,
};

function getState() {
  return {
    bossHp: state.bossHp,
    maxHp: state.maxHp,
    crystalCount: state.crystalCount,
    totalCrystalsReceived: state.totalCrystalsReceived,
    recentEvents: [...state.recentEvents],
    gameOver: state.gameOver,
  };
}

function addEvent(ev) {
  state.recentEvents.unshift(ev);
  if (state.recentEvents.length > MAX_RECENT_EVENTS) state.recentEvents.pop();
}

function broadcastState() {
  io.emit('state', getState());
}

function sendWLED(json) {
  if (!WLED_URL) return;
  const url = new URL(`${WLED_URL.replace(/\/$/, '')}/json/state`);
  const body = JSON.stringify(json);
  const lib = url.protocol === 'https:' ? https : http;
  const req = lib.request(
    url,
    { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
    (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) console.warn('WLED request failed:', res.statusCode);
    }
  );
  req.on('error', (e) => console.warn('WLED error:', e.message));
  req.setTimeout(5000, () => { req.destroy(); });
  req.write(body);
  req.end();
}

function updateWLEDFromHp() {
  if (!WLED_URL) return;
  const pct = state.maxHp ? (state.bossHp / state.maxHp) * 100 : 0;
  if (state.gameOver || state.bossHp <= 0) {
    sendWLED({ on: true, bri: 255, seg: [{ col: [[255, 0, 0]], fx: 1 }] });
    return;
  }
  if (pct > 66) {
    sendWLED({ on: true, bri: 200, seg: [{ col: [[0, 255, 0]], fx: 0 }] });
  } else if (pct > 33) {
    sendWLED({ on: true, bri: 220, seg: [{ col: [[255, 200, 0]], fx: 0 }] });
  } else {
    sendWLED({ on: true, bri: 255, seg: [{ col: [[255, 0, 0]], fx: 0 }] });
  }
}

// POST /event - ESP32 crystal events
app.post('/event', (req, res) => {
  const body = req.body || {};
  if (body.type !== 'crystal') {
    return res.status(400).json({ ok: false, error: 'Invalid event: need type "crystal" and slot number' });
  }
  const slotNum = Number(body.slot);
  if (Number.isNaN(slotNum)) {
    return res.status(400).json({ ok: false, error: 'Invalid event: slot must be a number' });
  }
  const slot = Math.max(0, Math.min(6, Math.floor(slotNum)));
  if (state.gameOver) {
    addEvent({ type: 'crystal', slot, ignored: true, reason: 'game over' });
    broadcastState();
    return res.json({ ok: true, gameOver: true });
  }
  state.totalCrystalsReceived++;
  state.crystalCount++;
  const damage = HP_PER_CRYSTAL;
  state.bossHp = Math.max(0, state.bossHp - damage);
  if (state.bossHp <= 0) state.gameOver = true;
  addEvent({ type: 'crystal', slot, damage, ts: Date.now() });
  updateWLEDFromHp();
  broadcastState();
  res.json({ ok: true, bossHp: state.bossHp, gameOver: state.gameOver });
});

// GET /state - initial load for clients
app.get('/state', (_req, res) => {
  res.json(getState());
});

// Admin: set HP
app.post('/admin/hp', (req, res) => {
  const hp = Number(req.body?.hp);
  if (Number.isNaN(hp) || hp < 0) return res.status(400).json({ ok: false, error: 'Invalid hp' });
  state.bossHp = Math.min(state.maxHp, Math.floor(hp));
  state.gameOver = state.bossHp <= 0;
  addEvent({ type: 'admin_hp', hp: state.bossHp, ts: Date.now() });
  updateWLEDFromHp();
  broadcastState();
  res.json({ ok: true, bossHp: state.bossHp });
});

// Admin: reset game
app.post('/admin/reset', (req, res) => {
  state.bossHp = state.maxHp;
  state.crystalCount = 0;
  state.totalCrystalsReceived = 0;
  state.gameOver = false;
  state.recentEvents = [];
  addEvent({ type: 'admin_reset', ts: Date.now() });
  updateWLEDFromHp();
  broadcastState();
  res.json({ ok: true, ...getState() });
});

// Admin: WLED manual override (optional)
app.post('/admin/wled', (req, res) => {
  const body = req.body || {};
  sendWLED(body);
  res.json({ ok: true });
});

io.on('connection', (socket) => {
  socket.emit('state', getState());
});

server.listen(PORT, () => {
  console.log(`Freedom Fighters server on http://0.0.0.0:${PORT}`);
  console.log(`  Boss view:  http://<pi-ip>:${PORT}/boss.html`);
  console.log(`  Admin:      http://<pi-ip>:${PORT}/admin.html`);
  if (WLED_URL) console.log(`  WLED:       ${WLED_URL}`);
  else console.log('  WLED:       disabled (set WLED_URL to enable)');
});
