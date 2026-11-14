const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
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

  try {
    const ct = (request.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('multipart/form-data')) {
      return jsonResponse({ ok: false, error: 'Expected multipart/form-data', stderr: 'Expected multipart/form-data' }, 400);
    }

    const form = await request.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') {
      return jsonResponse({ ok: false, error: 'Missing file', stderr: 'Missing file field' }, 400);
    }

    const runnerUrl = asTrimmedString(form.get('runnerUrl')) || asTrimmedString(env && env.CODESPACE_URL);
    const token = asTrimmedString(form.get('token')) || asTrimmedString(env && env.CODESPACE_TOKEN);
    const filename = asTrimmedString(form.get('filename')) || (file && file.name) || 'upload.bin';
    const cwd = form.get('cwd') == null ? '' : String(form.get('cwd'));

    if (!runnerUrl) {
      return jsonResponse({ ok: false, error: 'runnerUrl is required (or set CODESPACE_URL)', stderr: 'runnerUrl is required' }, 400);
    }

    let target = runnerUrl;
    try {
      const u = new URL(runnerUrl);
      // If a base URL is provided, forward to its /upload endpoint
      if (!/\/upload\/?$/.test(u.pathname)) {
        u.pathname = (u.pathname.replace(/\/+$/, '') || '') + '/upload';
      }
      target = u.toString();
    } catch {
      return jsonResponse({ ok: false, error: 'Invalid runnerUrl', stderr: `Invalid runnerUrl: ${runnerUrl}` }, 400);
    }

    const upstreamForm = new FormData();
    upstreamForm.set('file', file, filename);
    if (cwd) upstreamForm.set('cwd', cwd);
    upstreamForm.set('filename', filename);

    const upstream = await fetch(target, {
      method: 'POST',
      headers: {
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
      },
      body: upstreamForm,
      redirect: 'manual',
    });

    const rct = (upstream.headers.get('content-type') || '').toLowerCase();
    let data = null;
    let text = '';
    if (rct.includes('application/json')) {
      data = await upstream.json().catch(() => null);
      if (data == null) text = await upstream.text().catch(() => '');
    } else {
      text = await upstream.text().catch(() => '');
      try { data = JSON.parse(text); } catch { data = null; }
    }

    const payload = (data && typeof data === 'object' && !Array.isArray(data)) ? { ...data } : {};
    if (!('ok' in payload)) payload.ok = upstream.ok;
    if (!('stdout' in payload)) payload.stdout = payload.ok ? (payload.path || payload.message || text || 'uploaded') : '';
    if (!('stderr' in payload)) payload.stderr = payload.ok ? '' : (payload.error || payload.message || text || `HTTP ${upstream.status}`);
    if (!('exitCode' in payload)) payload.exitCode = payload.ok ? 0 : (Number.isFinite(upstream.status) ? upstream.status : 1);
    if (!payload.filename) payload.filename = filename;
    if (!payload.size && file && typeof file.size === 'number') payload.size = file.size;
    if (!payload.runnerUrl) payload.runnerUrl = runnerUrl;

    return jsonResponse(payload, 200);
  } catch (err) {
    const message = String(err && (err.message || err) || 'Upload failed');
    return jsonResponse({ ok: false, stdout: '', stderr: message, exitCode: 1, error: message }, 502);
  }
}
