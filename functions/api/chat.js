const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

const DEFAULT_UPSTREAM_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'gemini-3.8-flash';
const FAST_FALLBACK_MODEL = 'gemini-3.8-flash';
const MAX_UPSTREAM_ATTEMPTS = 2;
const PER_PROVIDER_TIMEOUT_MS = 45000;

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

function parseApiKeys(value) {
  if (!value) return [];
  return String(value).split(',').map((k) => k.trim()).filter(Boolean);
}

function normalizeModelId(id) {
  return id ? String(id).trim() : '';
}

function isRedirect(status) {
  return status >= 300 && status < 400;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => {
    try { controller.abort(new Error('timeout')); } catch {}
  }, timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readTextSafe(res, max = 2000) {
  try {
    const text = await res.text();
    return typeof text === 'string' ? text.slice(0, max) : '';
  } catch {
    return '';
  }
}

function wantsStream(payload) {
  if (!payload || typeof payload !== 'object') return true;
  if (Object.prototype.hasOwnProperty.call(payload, 'stream')) return !!payload.stream;
  return true;
}

function buildAttemptPlan(incomingAuth, serverKeys, primaryModel) {
  const attempts = [];
  const fallbackModel = (primaryModel && primaryModel !== FAST_FALLBACK_MODEL) ? FAST_FALLBACK_MODEL : null;

  if (incomingAuth && incomingAuth.trim()) {
    const auth = incomingAuth.trim();
    attempts.push({ auth, model: primaryModel, reason: 'byok-primary' });
    if (fallbackModel) attempts.push({ auth, model: fallbackModel, reason: 'byok-fallback' });
  } else if (serverKeys.length > 0) {
    // Fastest model first with first key; second attempt uses fallback model or rotates key (max 2 total)
    attempts.push({ auth: `Bearer ${serverKeys[0]}`, model: primaryModel, reason: 'server-primary' });
    if (fallbackModel) {
      attempts.push({ auth: `Bearer ${serverKeys[0]}`, model: fallbackModel, reason: 'server-fallback-model' });
    } else if (serverKeys.length > 1) {
      attempts.push({ auth: `Bearer ${serverKeys[1]}`, model: primaryModel, reason: 'server-fallback-key' });
    }
  }

  return attempts.slice(0, MAX_UPSTREAM_ATTEMPTS);
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestGet() {
  return jsonResponse({ ok: true, proxy: 'managed', defaultModel: DEFAULT_MODEL }, 200);
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON payload' }, 400);
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return jsonResponse({ error: 'Request payload must be a JSON object' }, 400);
  }

  const upstreamUrl = (env && env.APEX_API_URL && String(env.APEX_API_URL).trim()) || DEFAULT_UPSTREAM_URL;
  // Read body.model from the incoming request payload (Settings override); fall back to env/default only if blank.
  const requestedModel = normalizeModelId(payload.model);
  const primaryModel = requestedModel || (env && env.APEX_DEFAULT_MODEL && String(env.APEX_DEFAULT_MODEL).trim()) || DEFAULT_MODEL;
  const incomingAuth = request.headers.get('Authorization');
  const serverKeys = parseApiKeys(env && env.APEX_API_KEYS);

  if (!(incomingAuth && incomingAuth.trim()) && serverKeys.length === 0) {
    return jsonResponse({ error: 'No server API keys configured. Set APEX_API_KEYS or provide Authorization.' }, 503);
  }

  const attempts = buildAttemptPlan(incomingAuth, serverKeys, primaryModel);
  if (!attempts.length) {
    return jsonResponse({ error: 'No upstream attempt available' }, 503);
  }

  const wantStream = wantsStream(payload);
  let lastError = { status: 502, message: 'Upstream request failed' };

  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    const body = { ...payload, model: attempt.model };
    if (!Object.prototype.hasOwnProperty.call(body, 'stream')) body.stream = wantStream;
    if (body.reasoning_effort == null) body.reasoning_effort = 'low';

    let res;
    try {
      res = await fetchWithTimeout(upstreamUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': attempt.auth,
        },
        body: JSON.stringify(body),
        redirect: 'manual',
      }, PER_PROVIDER_TIMEOUT_MS);
    } catch (err) {
      const msg = (err && err.name === 'AbortError') ? `Upstream timeout after ${PER_PROVIDER_TIMEOUT_MS}ms` : String(err && err.message || err || 'Upstream fetch failed');
      lastError = { status: 504, message: msg, attempt: attempt.reason, model: attempt.model };
      if (i < attempts.length - 1) continue;
      return jsonResponse({ error: 'Managed proxy upstream error', detail: lastError.message, model: attempt.model, attempts: attempts.length }, 504);
    }

    if (isRedirect(res.status)) {
      const loc = res.headers.get('Location') || res.headers.get('location') || '';
      lastError = { status: 502, message: `Upstream redirect blocked (HTTP ${res.status})${loc ? ` -> ${loc}` : ''}`, attempt: attempt.reason, model: attempt.model };
      // Do not follow redirects; try next capped attempt if available
      if (i < attempts.length - 1) continue;
      return jsonResponse({ error: 'Managed proxy blocked upstream redirect', detail: lastError.message, model: attempt.model }, 502);
    }

    if (res.ok) {
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (body.stream && ct.includes('text/event-stream') && res.body) {
        return new Response(res.body, {
          status: res.status,
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            ...CORS_HEADERS,
          },
        });
      }
      const text = await readTextSafe(res, 200000);
      const outCt = res.headers.get('content-type') || 'application/json; charset=utf-8';
      return new Response(text, {
        status: res.status,
        headers: { 'Content-Type': outCt, ...CORS_HEADERS },
      });
    }

    const errText = await readTextSafe(res, 4000);
    lastError = {
      status: res.status || 502,
      message: errText || `Upstream HTTP ${res.status}`,
      attempt: attempt.reason,
      model: attempt.model,
    };

    // Retry on next capped attempt for transient/auth/availability/rate/timeout-like upstream statuses
    const retryable = [401, 403, 404, 408, 409, 425, 429, 500, 502, 503, 504, 522, 523, 524].includes(res.status);
    if (retryable && i < attempts.length - 1) continue;

    // Non-retryable or no attempts left: return upstream error (capped, no loops)
    const ct = res.headers.get('content-type') || 'application/json; charset=utf-8';
    // If upstream returned JSON/text, pass it through but ensure CORS
    return new Response(errText || JSON.stringify({ error: 'Upstream error', status: res.status }), {
      status: res.status || 502,
      headers: { 'Content-Type': ct, ...CORS_HEADERS },
    });
  }

  return jsonResponse({ error: 'Managed proxy failed', detail: lastError.message, status: lastError.status, model: lastError.model }, lastError.status || 502);
}
