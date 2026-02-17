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
const SLOT_COUNT = 7;
const state = {
  bossHp: BOSS_MAX_HP,
  maxHp: BOSS_MAX_HP,
  crystalCount: 0,
  totalCrystalsReceived: 0,
  slots: Array(SLOT_COUNT).fill(false),
  recentEvents: [],
  gameOver: false,
  hpDamageEnabled: true, // Phase 1: crystals reduce HP. Phase 2: crystals do not.
};

function getState() {
  return {
    bossHp: state.bossHp,
    maxHp: state.maxHp,
    crystalCount: state.crystalCount,
    totalCrystalsReceived: state.totalCrystalsReceived,
    slots: [...state.slots],
    recentEvents: [...state.recentEvents],
    gameOver: state.gameOver,
    hpDamageEnabled: state.hpDamageEnabled,
  };
}

function addEvent(ev) {
  state.recentEvents.unshift(ev);
  if (state.recentEvents.length > MAX_RECENT_EVENTS) state.recentEvents.pop();
}

function broadcastState() {
  io.emit('state', getState());
}

function sendWLED(json, cb) {
  if (!WLED_URL) return;
  const url = new URL(`${WLED_URL.replace(/\/$/, '')}/json/state`);
  const body = JSON.stringify(json);
  const lib = url.protocol === 'https:' ? https : http;
  const req = lib.request(
    url,
    { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
    (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) console.warn('WLED request failed:', res.statusCode);
      if (typeof cb === 'function') cb();
    }
  );
  req.on('error', (e) => {
    console.warn('WLED error:', e.message);
    if (typeof cb === 'function') cb();
  });
  req.setTimeout(5000, () => { req.destroy(); });
  req.write(body);
  req.end();
}

// 7 LEDs, one segment per slot. Filled = Candle Multi (fx 102) white; empty = solid black.
const WLED_CANDLE_MULTI_FX = 102;
const WLED_FILLED_COL = [[255, 255, 255]];
const WLED_EMPTY_COL = [[0, 0, 0]];
let wledSegsReady = false;

// One-time: split the default full-strip segment 0 into 7 individual segments.
// Step 1: shrink segment 0 alone (must be its own call).
// Step 2: create segments 1-6 for the remaining LEDs.
function initWLEDSegments(cb) {
  if (wledSegsReady) return cb();
  console.log('WLED init: step 1 - shrink segment 0 to LED 0');
  sendWLED({ on: true, bri: 255, seg: [{ id: 0, start: 0, stop: 1, on: true, fx: 0, col: WLED_EMPTY_COL }] }, () => {
    const segs = [];
    for (let n = 1; n < SLOT_COUNT; n++) {
      segs.push({ id: n, start: n, stop: n + 1, on: true, fx: 0, col: WLED_EMPTY_COL });
    }
    console.log('WLED init: step 2 - create segments 1-6');
    sendWLED({ seg: segs }, () => {
      wledSegsReady = true;
      console.log('WLED init: done, 7 segments ready');
      cb();
    });
  });
}

function updateWLEDFromSlots(slots) {
  if (!WLED_URL || !Array.isArray(slots)) return;
  initWLEDSegments(() => {
    // Segments already exist, just update fx + col (no start/stop needed).
    const segs = slots.slice(0, SLOT_COUNT).map((filled, n) => ({
      id: n,
      fx: filled ? WLED_CANDLE_MULTI_FX : 0,
      col: filled ? WLED_FILLED_COL : WLED_EMPTY_COL,
    }));
    const count = segs.filter((s) => s.fx === WLED_CANDLE_MULTI_FX).length;
    console.log('WLED slots:', count, 'on (Candle Multi)');
    sendWLED({ seg: segs });
  });
}

// POST /event - ESP32 full state: { type: "crystal", slots: [bool x7], count: number }
// Boss HP = maxHp - (num active crystals * HP_PER_CRYSTAL). Removal adds HP.
app.post('/event', (req, res) => {
  const body = req.body || {};
  if (body.type !== 'crystal') {
    return res.status(400).json({ ok: false, error: 'Invalid event: need type "crystal"' });
  }
  let slots = Array.isArray(body.slots) ? body.slots : null;
  if (!slots || slots.length !== SLOT_COUNT) {
    return res.status(400).json({ ok: false, error: 'Invalid event: slots must be array of 7 booleans' });
  }
  slots = slots.slice(0, SLOT_COUNT).map((s) => Boolean(s));
  const prevSlots = state.slots;
  const ts = Date.now();
  let inserts = 0;
  for (let i = 0; i < SLOT_COUNT; i++) {
    if (slots[i] && !prevSlots[i]) {
      inserts++;
      addEvent({ type: 'crystal_insert', slot: i, damage: HP_PER_CRYSTAL, ts });
    } else if (!slots[i] && prevSlots[i]) {
      addEvent({ type: 'crystal_remove', slot: i, ts });
    }
  }
  state.slots = slots;
  state.crystalCount = slots.filter(Boolean).length;
  if (state.hpDamageEnabled) {
    state.bossHp = Math.max(0, state.maxHp - state.crystalCount * HP_PER_CRYSTAL);
    state.gameOver = state.bossHp <= 0;
  }
  // Phase 2: slots/crystals update but HP unchanged
  state.totalCrystalsReceived += inserts;
  updateWLEDFromSlots(state.slots);
  broadcastState();
  res.json({
    ok: true,
    bossHp: state.bossHp,
    gameOver: state.gameOver,
    slots: state.slots,
  });
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
  broadcastState();
  res.json({ ok: true, bossHp: state.bossHp });
});

// Admin: reduce HP by 5% of max
app.post('/admin/hp/reduce', (_req, res) => {
  const damage = Math.ceil(state.maxHp * 0.05);
  state.bossHp = Math.max(0, state.bossHp - damage);
  state.gameOver = state.bossHp <= 0;
  addEvent({ type: 'admin_hp_reduce', damage, hp: state.bossHp, ts: Date.now() });
  broadcastState();
  res.json({ ok: true, bossHp: state.bossHp, damage });
});

// Admin: toggle HP damage from crystals (Phase 1 = on, Phase 2 = off)
app.post('/admin/hp-damage', (req, res) => {
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ ok: false, error: 'Invalid: need enabled (boolean)' });
  }
  state.hpDamageEnabled = enabled;
  if (enabled) {
    state.bossHp = Math.max(0, state.maxHp - state.crystalCount * HP_PER_CRYSTAL);
    state.gameOver = state.bossHp <= 0;
  }
  addEvent({ type: 'admin_hp_damage', enabled, ts: Date.now() });
  broadcastState();
  res.json({ ok: true, hpDamageEnabled: state.hpDamageEnabled });
});

// Admin: reset game
app.post('/admin/reset', (req, res) => {
  state.bossHp = state.maxHp;
  state.crystalCount = 0;
  state.totalCrystalsReceived = 0;
  state.slots = Array(SLOT_COUNT).fill(false);
  state.gameOver = false;
  state.recentEvents = [];
  addEvent({ type: 'admin_reset', ts: Date.now() });
  updateWLEDFromSlots(state.slots);
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
