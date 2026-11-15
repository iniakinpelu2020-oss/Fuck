# Apex Terminal Server (Render-ready)

Minimal HTTP + WebSocket remote terminal/runner compatible with Apex Studio's `js/terminal.js` expectations.

## Features
- `GET /health` for Render/uptime checks
- `POST /exec` (also `/run`, `/api/exec`) for one-shot command execution
- WebSocket endpoint for interactive/exec bridge messages:
  - send `{ "type": "exec", "id": "...", "command": "..." }`
  - receive streamed `{type:"stdout"/"stderr", ...}` and final `{type:"result", ok, code, stdout, stderr, output, done:true}`
- Auth via `TERMINAL_TOKEN` env var:
  - HTTP: `?token=...`, `Authorization: Bearer <token>`, or `x-terminal-token`
  - WS: `wss://<host>/?token=...` (recommended) or message `token`

## Local run
```bash
cd terminal-server
npm install
TERMINAL_TOKEN=change-me npm start
```

## Render deploy
- Root Directory: `terminal-server`
- Build Command: `npm install`
- Start Command: `npm start`
- Environment Variables:
  - `TERMINAL_TOKEN` (recommended)

## Apex Studio usage
- HTTP runner URL (recommended on Render): `https://<your-service>.onrender.com?token=<TERMINAL_TOKEN>`
  - Apex will POST command execs via `/api/exec` proxy (Cloudflare function) to the configured runner URL
- WebSocket shell URL: `wss://<your-service>.onrender.com/?token=<TERMINAL_TOKEN>`
  - Apex connects directly from the browser via WebSocket

> The server runs shell commands on the host. Deploy only in a trusted environment and always set `TERMINAL_TOKEN`.
