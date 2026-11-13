const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

const GOOGLE_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/models';
const DEFAULT_UPSTREAM_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'gemini-3.8-flash';

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

function streamResponse(upstream) {
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      ...CORS_HEADERS,
    },
  });
}

function parseApiKeys(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeModelId(id) {
  if (!id) return '';
  return String(id).trim();
}

function baseModelName(id) {
  const s = normalizeModelId(id);
  return s.startsWith('models/') ? s.slice('models/'.length) : s;
}

function isDiscoveryEligibleChatModel(id) {
  const name = baseModelName(id).toLowerCase();
  if (!name) return false;
  if (!name.includes('gemini')) return false;
  if (name.includes('embedding')) return false;
  if (name.includes('imagen')) return false;
  if (name.includes('veo')) return false;
  if (name.includes('tts')) return false;
  if (name.includes('aqa')) return false;
  return true;
}

function sortDiscoveredModels(models, failedModel) {
  const failed = baseModelName(failedModel).toLowerCase();
  const seen = new Set();
  const filtered = [];
  for (const m of models || []) {
    const id = normalizeModelId(typeof m === 'string' ? m : (m && (m.id || m.name)));
    if (!id) continue;
    const base = baseModelName(id).toLowerCase();
    if (!isDiscoveryEligibleChatModel(id)) continue;
    if (base === failed) continue;
    if (seen.has(base)) continue;
    seen.add(base);
    filtered.push(id);
  }
  const score = (id) => {
    const b = baseModelName(id).toLowerCase();
    if (b.includes('flash')) return 0;
    if (b.includes('pro')) return 1;
    return 2;
  };
  filtered.sort((a, b) => {
    const sa = score(a), sb = score(b);
    if (sa !== sb) return sa - sb;
    return baseModelName(a).localeCompare(baseModelName(b));
  });
  return filtered;
}

function extractModelsFromPayload(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.data)) return data.data;
  if (Array.isArray(data.models)) return data.models;
  if (Array.isArray(data.items)) return data.items;
  return [];
}

async function fetchDiscoveredModels(authHeaderValue) {
  try {
    const res = await fetch(GOOGLE_MODELS_URL, {
      method: 'GET',
      headers: {
        'Authorization': authHeaderValue,
      },
    });
    const text = await res.text();
    if (!res.ok) return [];
    let data;
    try { data = JSON.parse(text); } catch { return []; }
    return extractModelsFromPayload(data);
  } catch {
    return [];
  }
}

async function doChatRequest(upstreamUrl, authHeaderValue, payloadObj) {
  const res = await fetch(upstreamUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': authHeaderValue,
    },
    body: JSON.stringify(payloadObj),
  });
  return res;
}

function shouldReturnStream(res, wantStream) {
  if (!res.ok) return false;
  if (!wantStream) return false;
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  return ct.includes('text/event-stream') || !!res.body;
}

async function tryModel(upstreamUrl, authHeaderValue, basePayload, model, wantStream) {
  // Primary/single-model attempt: on 503 or 429 retry once after 1.5s on the same model.
  let lastRes = null;
  let lastText = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const payloadObj = { ...basePayload, model, stream: wantStream };
    let res;
    try {
      res = await doChatRequest(upstreamUrl, authHeaderValue, payloadObj);
    } catch (err) {
      lastRes = null;
      lastText = JSON.stringify({ error: 'Upstream request failed', message: String(err && err.message || err) });
      if (attempt < 1) { await sleep(1500); continue; }
      return { type: 'error', status: 502, text: lastText, headers: null };
    }

    if ((res.status === 429 || res.status === 503) && attempt < 1) {
      lastRes = res;
      lastText = await res.text();
      await sleep(1500);
      continue;
    }

    if (shouldReturnStream(res, wantStream)) {
      return { type: 'stream', response: streamResponse(res) };
    }

    const text = await res.text();
    return { type: 'final', status: res.status, text, headers: res.headers, ok: res.ok };
  }

  return { type: 'final', status: (lastRes && lastRes.status) || 502, text: lastText, headers: lastRes && lastRes.headers, ok: false };
}

async function tryWithDiscoveryFallback(upstreamUrl, authHeaderValue, basePayload, primaryModel, wantStream) {
  // 1) Try requested/primary model with smart retry (503/429 -> retry once after 1.5s)
  const primary = await tryModel(upstreamUrl, authHeaderValue, basePayload, primaryModel, wantStream);
  if (primary.type === 'stream') return primary;
  if (primary.type === 'error') return primary;
  if (primary.ok) return primary;

  const status = primary.status;
  // 2) If still 503/429/404, fetch live models and try next available discovered models with stream: true
  if (status === 503 || status === 429 || status === 404) {
    const discovered = await fetchDiscoveredModels(authHeaderValue);
    const candidates = sortDiscoveredModels(discovered, primaryModel);
    let last = primary;
    for (const candidate of candidates) {
      const attempt = await tryModel(upstreamUrl, authHeaderValue, basePayload, candidate, true);
      if (attempt.type === 'stream') return attempt;
      if (attempt.type === 'error') { last = attempt; continue; }
      if (attempt.ok) return attempt;
      last = attempt;
      // try next candidate on 503/429/404; for other errors also stop falling through? keep trying to be resilient
      if (attempt.status === 401 || attempt.status === 403) break;
    }
    return last;
  }

  return primary;
}

function finalToResponse(result) {
  if (!result) return jsonResponse({ error: 'Upstream request failed' }, 502);
  if (result.type === 'stream') return result.response;
  if (result.type === 'error') return jsonResponse(result.text && result.text[0] === '{' ? JSON.parseSafe?.(result.text) || { error: 'Upstream request failed', detail: result.text } : { error: 'Upstream request failed' }, result.status || 502);
  const ct = (result.headers && result.headers.get && result.headers.get('Content-Type')) || 'application/json; charset=utf-8';
  return new Response(result.text || '', {
    status: result.status || 502,
    headers: { 'Content-Type': ct, ...CORS_HEADERS },
  });
}

function safeJsonParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const incomingAuth = request.headers.get('Authorization');
  const serverKeys = parseApiKeys(env.APEX_API_KEYS);
  const auths = [];
  if (incomingAuth && incomingAuth.trim()) auths.push(incomingAuth.trim());
  for (const k of serverKeys) auths.push(`Bearer ${k}`);
  for (const auth of auths) {
    const models = await fetchDiscoveredModels(auth);
    const filtered = sortDiscoveredModels(models, '');
    if (filtered.length) {
      return jsonResponse({ ok: true, models: filtered, source: GOOGLE_MODELS_URL }, 200);
    }
  }
  // Return raw discovery attempt info if nothing filtered (still helpful)
  if (auths.length) {
    const models = await fetchDiscoveredModels(auths[0]);
    return jsonResponse({ ok: false, models: models.map(m => (typeof m === 'string' ? m : m?.id || m?.name)).filter(Boolean), source: GOOGLE_MODELS_URL }, 200);
  }
  return jsonResponse({ ok: false, error: 'No API key available for model discovery', models: [] }, 503);
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

  const upstreamUrl = (env.APEX_API_URL && String(env.APEX_API_URL).trim()) || DEFAULT_UPSTREAM_URL;
  const primaryModel = normalizeModelId(payload.model) || (env.APEX_DEFAULT_MODEL && String(env.APEX_DEFAULT_MODEL).trim()) || DEFAULT_MODEL;

  const basePayload = { ...payload };
  if (basePayload.reasoning_effort == null) basePayload.reasoning_effort = 'low';
  if (basePayload.stream == null) basePayload.stream = true;
  const wantStream = !!basePayload.stream;

  const incomingAuth = request.headers.get('Authorization');

  // BYOK: forward user-provided Authorization header (same header used for discovery if needed)
  if (incomingAuth && incomingAuth.trim()) {
    const result = await tryWithDiscoveryFallback(upstreamUrl, incomingAuth.trim(), basePayload, primaryModel, wantStream);
    if (result.type === 'stream') return result.response;
    const ct = (result.headers && result.headers.get && result.headers.get('Content-Type')) || 'application/json; charset=utf-8';
    return new Response(result.text || '', { status: result.status || 502, headers: { 'Content-Type': ct, ...CORS_HEADERS } });
  }

  const serverKeys = parseApiKeys(env.APEX_API_KEYS);
  if (!serverKeys.length) {
    return jsonResponse({ error: 'No server API keys configured. Set APEX_API_KEYS or provide a custom Authorization header.' }, 503);
  }

  let last = null;
  for (let i = 0; i < serverKeys.length; i++) {
    const auth = `Bearer ${serverKeys[i]}`;
    const result = await tryWithDiscoveryFallback(upstreamUrl, auth, basePayload, primaryModel, wantStream);
    if (result.type === 'stream') return result.response;
    last = result;
    if (result.status === 401 || result.status === 403) {
      // rotate to next key
      continue;
    }
    if (result.status === 429 || result.status === 503) {
      // exhausted retries/discovery for this key -> try next key
      continue;
    }
    // other status (including 404 after discovery failed, 400, 5xx etc.): return immediately
    const ct = (result.headers && result.headers.get && result.headers.get('Content-Type')) || 'application/json; charset=utf-8';
    return new Response(result.text || '', { status: result.status || 502, headers: { 'Content-Type': ct, ...CORS_HEADERS } });
  }

  if (last) {
    const ct = (last.headers && last.headers.get && last.headers.get('Content-Type')) || 'application/json; charset=utf-8';
    return new Response(last.text || JSON.stringify({ error: 'All server API keys exhausted' }), {
      status: last.status || 502,
      headers: { 'Content-Type': ct, ...CORS_HEADERS },
    });
  }

  return jsonResponse({ error: 'All server API keys failed' }, 502);
}
