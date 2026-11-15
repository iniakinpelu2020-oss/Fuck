'use strict';

const express = require('express');
const cors = require('cors');
const http = require('http');
const { spawn } = require('child_process');
const os = require('os');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || '0.0.0.0';
const TERMINAL_TOKEN = String(process.env.TERMINAL_TOKEN || '').trim();
const DEFAULT_TIMEOUT_MS = Number(process.env.COMMAND_TIMEOUT_MS || 600000); // 10m
const MAX_TIMEOUT_MS = Number(process.env.MAX_COMMAND_TIMEOUT_MS || 3600000); // 1h
const MAX_OUTPUT_CHARS = Number(process.env.MAX_OUTPUT_CHARS || 200000);

const app = express();
app.use(cors({ origin: true, credentials: false }));
app.use(express.json({ limit: process.env.JSON_LIMIT || '2mb' }));
app.use(express.urlencoded({ extended: false }));

function sendJson(res, status, obj) {
  res.status(status);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.json(obj);
}

function safeToken(v) {
  return String(v == null ? '' : v).trim();
}

function extractTokenFromReq(req) {
  // query: ?token=...
  const q = req.query || {};
  const qToken = safeToken(q.token || q.access_token || q.t || '');
  if (qToken) return qToken;

  // headers
  const h = req.headers || {};
  const auth = safeToken(h.authorization || h.Authorization || '');
  if (auth) {
    if (/^bearer\s+/i.test(auth)) return safeToken(auth.replace(/^bearer\s+/i, ''));
    return auth;
  }
  const xTok = safeToken(h['x-terminal-token'] || h['x-runner-token'] || h['x-auth-token'] || '');
  if (xTok) return xTok;

  // body fallback (exec POST)
  try {
    const b = req.body || {};
    const bTok = safeToken(b.token || b.authToken || b.accessToken || b.runnerToken || '');
    if (bTok) return bTok;
  } catch {}

  return '';
}

function isAuthorized(reqOrToken, tokenFromWs) {
  if (!TERMINAL_TOKEN) return true; // no token configured -> open (user can secure via env)
  const provided = typeof reqOrToken === 'string' ? safeToken(reqOrToken) : extractTokenFromReq(reqOrToken);
  const alt = safeToken(tokenFromWs || '');
  return (provided && provided === TERMINAL_TOKEN) || (alt && alt === TERMINAL_TOKEN);
}

function clampTimeout(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return Math.max(1000, Math.min(DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));
  return Math.max(1000, Math.min(Math.round(n), MAX_TIMEOUT_MS));
}

function resolveShell() {
  if (process.env.SHELL) return process.env.SHELL;
  if (process.platform === 'win32') return process.env.COMSPEC || 'cmd.exe';
  return 'bash';
}

function appendCapped(buf, chunk, maxChars) {
  const s = String(chunk == null ? '' : chunk);
  if (!s) return { text: buf, truncated: false };
  let text = buf + s;
  let truncated = false;
  if (text.length > maxChars) {
    text = text.slice(text.length - maxChars);
    truncated = true;
  }
  return { text, truncated };
}

function runCommandExec(command, opts = {}) {
  const cmd = String(command == null ? '' : command);
  const timeoutMs = clampTimeout(opts.timeoutMs != null ? opts.timeoutMs : DEFAULT_TIMEOUT_MS);
  const cwd = opts.cwd ? String(opts.cwd) : (process.env.WORKDIR || process.cwd());
  const shell = resolveShell();
  const startedAt = Date.now();

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let output = '';
    let outTrunc = false, errTrunc = false, allTrunc = false;
    let finished = false;
    let timedOut = false;
    let killedByTimeout = false;

    let child;
    try {
      if (process.platform === 'win32') {
        child = spawn(shell, ['/d', '/s', '/c', cmd], { cwd, env: process.env, windowsHide: true });
      } else {
        child = spawn(shell, ['-lc', cmd], { cwd, env: process.env });
      }
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      return resolve({ ok: false, stdout: '', stderr: msg, output: msg, code: 1, exitCode: 1, mode: 'http', timeoutMs, durationMs: 0, cwd, error: msg });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killedByTimeout = true;
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000).unref?.();
    }, timeoutMs);

    function onData(kind, chunk) {
      const s = chunk == null ? '' : String(chunk);
      if (kind === 'stdout') {
        const r = appendCapped(stdout, s, MAX_OUTPUT_CHARS); stdout = r.text; outTrunc = outTrunc || r.truncated;
      } else if (kind === 'stderr') {
        const r = appendCapped(stderr, s, MAX_OUTPUT_CHARS); stderr = r.text; errTrunc = errTrunc || r.truncated;
      }
      const ro = appendCapped(output, s, MAX_OUTPUT_CHARS * 2); output = ro.text; allTrunc = allTrunc || ro.truncated;
    }

    child.stdout && child.stdout.on('data', (d) => onData('stdout', d));
    child.stderr && child.stderr.on('data', (d) => onData('stderr', d));

    child.on('error', (e) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const msg = e && e.message ? e.message : String(e);
      const fullErr = (stderr ? stderr + '\n' : '') + msg;
      resolve({
        ok: false,
        stdout,
        stderr: fullErr,
        output: output || (stdout + (fullErr ? '\n' + fullErr : '')),
        code: 1,
        exitCode: 1,
        mode: 'http',
        timeoutMs,
        timedOut,
        durationMs: Date.now() - startedAt,
        cwd,
        truncated: { stdout: outTrunc, stderr: errTrunc, output: allTrunc },
        error: msg
      });
    });

    child.on('close', (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const exitCode = (code == null ? (signal ? 1 : 0) : Number(code));
      let finalStderr = stderr;
      if (timedOut) {
        const msg = `[terminal-server] Command timed out after ${Math.round(timeoutMs / 1000)}s`;
        finalStderr = (finalStderr ? finalStderr + '\n' : '') + msg;
      }
      const finalOutput = output || (stdout + (finalStderr ? (stdout ? '\n' : '') + finalStderr : ''));
      resolve({
        ok: !timedOut && exitCode === 0,
        stdout,
        stderr: finalStderr,
        output: finalOutput,
        code: timedOut ? 124 : exitCode,
        exitCode: timedOut ? 124 : exitCode,
        signal: signal || null,
        mode: 'http',
        timeoutMs,
        timedOut,
        killedByTimeout,
        durationMs: Date.now() - startedAt,
        cwd,
        truncated: { stdout: outTrunc, stderr: errTrunc, output: allTrunc }
      });
    });
  });
}

// --- Health / info ---
app.get('/health', (req, res) => {
  return sendJson(res, 200, {
    ok: true,
    service: 'apex-terminal-server',
    mode: ['http', 'ws'],
    auth: TERMINAL_TOKEN ? 'token-required' : 'open',
    time: new Date().toISOString(),
    pid: process.pid,
    node: process.version,
    platform: process.platform
  });
});

app.get('/', (req, res) => {
  return sendJson(res, 200, {
    ok: true,
    service: 'apex-terminal-server',
    endpoints: {
      health: 'GET /health',
      exec: 'POST /exec (or /run)',
      websocket: 'ws://<host>/  or  wss://<host>/?token=<TERMINAL_TOKEN>'
    },
    auth: TERMINAL_TOKEN ? 'Provide ?token=... or Authorization: Bearer <token> (or x-terminal-token)' : 'TERMINAL_TOKEN not set (server accepts requests without token)',
    messageFormats: {
      httpExecRequest: { command: 'echo hello', token: '<optional if query/header set>', timeoutMs: 120000, cwd: '<optional>' },
      wsExecRequest: { type: 'exec', id: 'client-id', command: 'echo hello', timeoutMs: 120000, cwd: '<optional>', token: '<optional if query set>' },
      wsExecResult: { type: 'result', id: 'client-id', stdout: '...', stderr: '...', output: '...', code: 0, ok: true, done: true }
    }
  });
});

async function handleExecRequest(req, res) {
  if (!isAuthorized(req)) {
    return sendJson(res, 401, { ok: false, error: 'Unauthorized', message: 'Invalid or missing token. Provide ?token=..., Authorization: Bearer <token>, or x-terminal-token.' });
  }
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const command = body.command != null ? String(body.command) : (body.cmd != null ? String(body.cmd) : (body.script != null ? String(body.script) : ''));
  if (!String(command).trim()) {
    return sendJson(res, 400, { ok: false, error: 'Missing command', message: 'Request body must include { "command": "..." }' });
  }
  const timeoutMs = clampTimeout(body.timeoutMs != null ? body.timeoutMs : body.timeout);
  const cwd = body.cwd ? String(body.cwd) : undefined;
  try {
    const result = await runCommandExec(command, { timeoutMs, cwd });
    return sendJson(res, result.ok ? 200 : 200, result);
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    return sendJson(res, 500, { ok: false, stdout: '', stderr: msg, output: msg, code: 1, exitCode: 1, error: msg, mode: 'http' });
  }
}

app.post('/exec', handleExecRequest);
app.post('/run', handleExecRequest);
app.post('/api/exec', handleExecRequest); // compatibility alias

app.all('*', (req, res) => {
  return sendJson(res, 404, { ok: false, error: 'Not found', path: req.path, method: req.method });
});

// --- WebSocket interactive/exec bridge (matches js/terminal.js expectations) ---
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

function wsSend(ws, obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify(obj)); } catch {}
}

function startExecStream(ws, payload) {
  const id = payload && payload.id != null ? String(payload.id) : '';
  const command = payload && payload.command != null ? String(payload.command) : (payload && payload.cmd != null ? String(payload.cmd) : '');
  if (!String(command).trim()) {
    wsSend(ws, { type: 'result', id, ok: false, code: 1, exitCode: 1, stdout: '', stderr: 'Missing command', output: 'Missing command', error: 'Missing command', done: true });
    return;
  }
  const timeoutMs = clampTimeout(payload.timeoutMs != null ? payload.timeoutMs : payload.timeout);
  const cwd = payload && payload.cwd ? String(payload.cwd) : (process.env.WORKDIR || process.cwd());
  const shell = resolveShell();
  let child;
  try {
    if (process.platform === 'win32') {
      child = spawn(shell, ['/d', '/s', '/c', command], { cwd, env: process.env, windowsHide: true });
    } else {
      child = spawn(shell, ['-lc', command], { cwd, env: process.env });
    }
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    wsSend(ws, { type: 'result', id, ok: false, code: 1, exitCode: 1, stdout: '', stderr: msg, output: msg, error: msg, done: true });
    return;
  }

  ws._activeExec = ws._activeExec || new Map();
  const key = id || `__exec_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  ws._activeExec.set(key, child);
  wsSend(ws, { type: 'start', id, command, timeoutMs, cwd });

  let stdout = '', stderr = '', output = '';
  let timedOut = false;
  let finished = false;

  const timer = setTimeout(() => {
    timedOut = true;
    try { child.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000).unref?.();
  }, timeoutMs);

  function emitChunk(kind, chunk) {
    const s = chunk == null ? '' : String(chunk);
    if (!s) return;
    if (kind === 'stdout') {
      const r = appendCapped(stdout, s, MAX_OUTPUT_CHARS); stdout = r.text;
      wsSend(ws, { type: 'stdout', id, stdout: s, data: s });
    } else {
      const r = appendCapped(stderr, s, MAX_OUTPUT_CHARS); stderr = r.text;
      wsSend(ws, { type: 'stderr', id, stderr: s, data: s });
    }
    const ro = appendCapped(output, s, MAX_OUTPUT_CHARS * 2); output = ro.text;
  }

  child.stdout && child.stdout.on('data', (d) => emitChunk('stdout', d));
  child.stderr && child.stderr.on('data', (d) => emitChunk('stderr', d));

  child.on('error', (e) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    ws._activeExec && ws._activeExec.delete(key);
    const msg = e && e.message ? e.message : String(e);
    stderr = stderr ? (stderr + '\n' + msg) : msg;
    output = output || (stdout + (stderr ? '\n' + stderr : ''));
    wsSend(ws, { type: 'result', id, ok: false, code: 1, exitCode: 1, stdout, stderr, output, error: msg, done: true });
  });

  child.on('close', (code, signal) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    ws._activeExec && ws._activeExec.delete(key);
    let finalStderr = stderr;
    if (timedOut) {
      const msg = `[terminal-server] Command timed out after ${Math.round(timeoutMs / 1000)}s`;
      finalStderr = finalStderr ? (finalStderr + '\n' + msg) : msg;
    }
    const exitCode = timedOut ? 124 : (code == null ? (signal ? 1 : 0) : Number(code));
    const ok = !timedOut && exitCode === 0;
    const finalOutput = output || (stdout + (finalStderr ? (stdout ? '\n' : '') + finalStderr : ''));
    wsSend(ws, {
      type: 'result',
      id,
      ok,
      code: exitCode,
      exitCode,
      stdout,
      stderr: finalStderr,
      output: finalOutput,
      signal: signal || null,
      timedOut,
      done: true
    });
  });
}

server.on('upgrade', (request, socket, head) => {
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    const qToken = safeToken(url.searchParams.get('token') || url.searchParams.get('access_token') || '');
    // allow Authorization header on upgrade (some clients/proxies support it)
    const auth = safeToken(request.headers['authorization'] || '');
    const headerToken = /^bearer\s+/i.test(auth) ? safeToken(auth.replace(/^bearer\s+/i, '')) : auth;
    const ok = isAuthorized(qToken || headerToken || '');
    if (!ok) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, { token: qToken || headerToken || '' });
    });
  } catch (e) {
    try { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {}
    try { socket.destroy(); } catch {}
  }
});

wss.on('connection', (ws, request, ctx) => {
  ws._connectedAt = Date.now();
  ws._activeExec = new Map();

  wsSend(ws, { type: 'ready', ok: true, service: 'apex-terminal-server', mode: 'ws', message: 'Connected', time: new Date().toISOString() });

  ws.on('message', (raw) => {
    let msg = null;
    let text = '';
    try {
      if (typeof raw === 'string') text = raw;
      else if (Buffer.isBuffer(raw)) text = raw.toString('utf8');
      else text = String(raw || '');
    } catch { text = ''; }

    try { msg = JSON.parse(text); } catch { msg = null; }

    if (!msg || typeof msg !== 'object') {
      // treat raw text as exec command for compatibility
      const cmd = String(text || '').trim();
      if (cmd) startExecStream(ws, { type: 'exec', id: `raw_${Date.now()}`, command: cmd });
      return;
    }

    // per-message token (optional if already authorized via query/header)
    if (TERMINAL_TOKEN) {
      const mTok = safeToken(msg.token || msg.authToken || msg.accessToken || '');
      if (mTok && mTok !== TERMINAL_TOKEN) {
        wsSend(ws, { type: 'error', ok: false, error: 'Unauthorized', message: 'Invalid token in message' });
        return;
      }
    }

    const type = String(msg.type || '').toLowerCase();

    if (type === 'exec' || type === 'run' || type === 'command') {
      startExecStream(ws, msg);
      return;
    }

    if (type === 'input') {
      // No persistent PTY in this minimal server. If a client sends input for an interactive program,
      // acknowledge receipt; exec-based commands are handled via type:"exec".
      wsSend(ws, { type: 'input_ack', ok: true });
      return;
    }

    if (type === 'ping') {
      wsSend(ws, { type: 'pong', time: Date.now() });
      return;
    }

    if (msg.command || msg.cmd) {
      startExecStream(ws, { type: 'exec', id: msg.id, command: msg.command || msg.cmd, timeoutMs: msg.timeoutMs || msg.timeout, cwd: msg.cwd });
      return;
    }

    wsSend(ws, { type: 'error', ok: false, error: 'Unsupported message', message: 'Expected {type:"exec", id, command} or {type:"input", data}' });
  });

  ws.on('close', () => {
    try {
      for (const child of (ws._activeExec || new Map()).values()) {
        try { child.kill('SIGTERM'); } catch {}
      }
      ws._activeExec && ws._activeExec.clear();
    } catch {}
  });

  ws.on('error', () => {
    // ignore; close handler will clean up
  });
});

server.listen(PORT, HOST, () => {
  const authMode = TERMINAL_TOKEN ? 'token-required' : 'open';
  console.log(`[apex-terminal-server] listening on http://${HOST}:${PORT} (${authMode})`);
});
