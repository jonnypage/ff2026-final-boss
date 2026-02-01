# Freedom Fighters 2026 – Final Boss

Interactive event: students complete missions, slot crystals into holders; microswitches on ESP32-C3 send events to a Raspberry Pi. Boss HP drops with crystals; WLED strips show effects; projector and admin views stay in sync via WebSockets.

## Hardware

- **ESP32-C3** – 7 microswitch inputs, 0.42" OLED (72x40), U8g2. POSTs crystal events to Pi.
- **WLED (ESP32)** – LED strips; receives HTTP JSON from Pi (color/effect by boss HP).
- **Raspberry Pi** – Runs Node.js server; hosts boss (projector) and admin web UIs.

## Software flow

- **ESP32-C3 → Pi:** `POST http://<pi-ip>:3000/event` with `{ "type": "crystal", "slot": 0..6 }`.
- **Pi → Browsers:** Real-time state via Socket.IO.
- **Pi → WLED:** `POST http://<wled-ip>/json/state` with effect/color by HP tier (green >66%, yellow 33–66%, red <33%, red blink when defeated).

## Quick start (Pi)

```bash
cd server
cp .env.example .env
# Edit .env: PORT, BOSS_MAX_HP, HP_PER_CRYSTAL, WLED_URL (optional)
npm install
npm start
```

- **Boss view (projector):** `http://<pi-ip>:3000/boss.html`
- **Admin:** `http://<pi-ip>:3000/admin.html`
- **Event endpoint:** `POST http://<pi-ip>:3000/event` (JSON body above)

## ESP32-C3 config

In `crystalController.ino` set:

- `WIFI_SSID` / `WIFI_PASS`
- `SERVER_URL` to `http://<pi-ip>:3000/event`

## Server API

| Method | Path | Description |
|--------|------|-------------|
| POST | `/event` | Crystal event from ESP32. Body: `{ "type": "crystal", "slot": 0..6 }`. |
| GET | `/state` | Current boss state (HP, crystals, recent events). |
| POST | `/admin/hp` | Set HP. Body: `{ "hp": number }`. |
| POST | `/admin/reset` | Reset game (HP, crystal count, events). |
| POST | `/admin/wled` | Optional WLED override. Body: WLED JSON state. |

## Environment (server)

| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 3000 | HTTP + Socket.IO port. |
| BOSS_MAX_HP | 100 | Starting boss HP. |
| HP_PER_CRYSTAL | 10 | HP deducted per crystal event. |
| WLED_URL | (empty) | WLED base URL (e.g. `http://192.168.1.51`). Omit to disable. |

## Event testing

1. Start server on Pi; open boss and admin in browser.
2. Simulate ESP32: `curl -X POST http://<pi-ip>:3000/event -H "Content-Type: application/json" -d '{"type":"crystal","slot":0}'`
3. Confirm boss HP and WLED update; admin shows recent events.
4. Use admin to set HP or reset; verify WLED and boss view.

Multiple ESP32-C3s can POST to the same `/event` endpoint; server does not distinguish devices (optional: add `deviceId` in payload later).
