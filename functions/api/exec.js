const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

function asTrimmedString(v) {
  return (v == null ? '' : String(v)).trim();
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ stdout: '', stderr: 'Invalid JSON payload', exitCode: 1, error: 'Invalid JSON payload' }, 400);
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return jsonResponse({ stdout: '', stderr: 'Request payload must be a JSON object', exitCode: 1, error: 'Request payload must be a JSON object' }, 400);
  }

  const runnerUrl = asTrimmedString(payload.runnerUrl) || asTrimmedString(env && env.CODESPACE_URL);
  const token = (payload.token != null ? String(payload.token) : '') || asTrimmedString(env && env.CODESPACE_TOKEN);
  const command = payload.command == null ? '' : String(payload.command);
  const cwd = payload.cwd == null ? undefined : String(payload.cwd);

  if (!runnerUrl) {
    return jsonResponse({ stdout: '', stderr: 'runnerUrl is required (or set CODESPACE_URL)', exitCode: 1, error: 'runnerUrl is required' }, 400);
  }

  let target = runnerUrl;
  try {
    const u = new URL(runnerUrl);
    // If a base URL is provided, forward to its /exec endpoint
    if (!/\/exec\/?$/.test(u.pathname)) {
      u.pathname = (u.pathname.replace(/\/+$/, '') || '') + '/exec';
    }
    target = u.toString();
  } catch {
    return jsonResponse({ stdout: '', stderr: `Invalid runnerUrl: ${runnerUrl}`, exitCode: 1, error: 'Invalid runnerUrl' }, 400);
  }

  const body = { command };
  if (cwd != null && cwd !== '') body.cwd = cwd;

  try {
    const upstream = await fetch(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      redirect: 'manual',
    });

    const ct = (upstream.headers.get('content-type') || '').toLowerCase();
    let data = null;
    let text = '';
    if (ct.includes('application/json')) {
      data = await upstream.json().catch(() => null);
      if (data == null) text = await upstream.text().catch(() => '');
    } else {
      text = await upstream.text().catch(() => '');
      try { data = JSON.parse(text); } catch { data = null; }
    }

    let stdout = '';
    let stderr = '';
    let exitCode = upstream.ok ? 0 : (Number.isFinite(upstream.status) ? upstream.status : 1);

    if (data && typeof data === 'object' && !Array.isArray(data)) {
      if (typeof data.stdout === 'string') stdout = data.stdout;
      if (typeof data.stderr === 'string') stderr = data.stderr;
      if (data.exitCode != null && Number.isFinite(Number(data.exitCode))) exitCode = Number(data.exitCode);
      else if (data.code != null && Number.isFinite(Number(data.code))) exitCode = Number(data.code);
      else if (data.status != null && Number.isFinite(Number(data.status)) && !upstream.ok) exitCode = Number(data.status);

      // Back-compat with runners that return { output } / { result } / { error }
      if (!stdout && typeof data.output === 'string') stdout = data.output;
      if (!stdout && typeof data.result === 'string') stdout = data.result;
      if (!stderr && data.error) stderr = String(data.error);
      if (!stderr && data.message && !upstream.ok) stderr = String(data.message);
      if (!stdout && !stderr && typeof data.output !== 'string' && typeof data.stdout !== 'string' && typeof data.stderr !== 'string' && typeof data.result !== 'string') {
        stdout = JSON.stringify(data, null, 2);
      }
    } else {
      stdout = text || (data != null ? String(data) : '');
      if (!upstream.ok && !stderr) stderr = `HTTP ${upstream.status}`;
    }

    if (!upstream.ok && !stderr) stderr = `HTTP ${upstream.status}`;

    // Normalize: always include stdout/stderr/exitCode
    const response = {
      stdout: stdout == null ? '' : String(stdout),
      stderr: stderr == null ? '' : String(stderr),
      exitCode,
    };
    // Pass through additional fields for debugging/compat without breaking contract
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      if (data.output != null && response.stdout === '' && response.stderr !== '') response.output = String(data.output);
    }
    if (!upstream.ok) response.ok = false;

    return jsonResponse(response, 200);
  } catch (err) {
    const message = String(err && (err.message || err) || 'Upstream request failed');
    return jsonResponse({ stdout: '', stderr: message, exitCode: 1, error: message }, 502);
  }
}
