const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

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
  return String(value)
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
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
    return jsonResponse({ error: 'Invalid JSON payload' }, 400);
  }

  const upstreamUrl = (env.APEX_API_URL && String(env.APEX_API_URL).trim()) || 'https://openrouter.ai/api/v1/chat/completions';
  const defaultModel = (env.APEX_DEFAULT_MODEL && String(env.APEX_DEFAULT_MODEL).trim()) || 'gemini-3.8-flash';

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return jsonResponse({ error: 'Request payload must be a JSON object' }, 400);
  }
  if (!payload.model) {
    payload.model = defaultModel;
  }

  const authHeader = request.headers.get('Authorization');
  const body = JSON.stringify(payload);
  const shouldRetry = (status) => status === 429 || status === 503;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // BYOK override: forward user-provided Authorization header as-is, with retry on 429/503.
  if (authHeader && authHeader.trim()) {
    let lastText = '';
    let lastStatus = 502;
    let lastHeaders = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const upstream = await fetch(upstreamUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': authHeader.trim(),
          },
          body,
        });
        lastText = await upstream.text();
        lastStatus = upstream.status;
        lastHeaders = upstream.headers;
        if (shouldRetry(upstream.status) && attempt < 2) {
          await sleep(400 * (attempt + 1));
          continue;
        }
        return new Response(lastText, {
          status: upstream.status,
          headers: {
            'Content-Type': upstream.headers.get('Content-Type') || 'application/json; charset=utf-8',
            ...CORS_HEADERS,
          },
        });
      } catch (err) {
        lastText = JSON.stringify({ error: 'Upstream request failed', message: String(err && err.message || err) });
        lastStatus = 502;
        if (attempt < 2) { await sleep(400 * (attempt + 1)); continue; }
        return jsonResponse({ error: 'Upstream request failed', message: String(err && err.message || err) }, 502);
      }
    }
    return new Response(lastText || JSON.stringify({ error: 'Upstream request failed' }), {
      status: lastStatus,
      headers: { 'Content-Type': (lastHeaders && lastHeaders.get('Content-Type')) || 'application/json; charset=utf-8', ...CORS_HEADERS },
    });
  }

  const keys = parseApiKeys(env.APEX_API_KEYS);
  if (!keys.length) {
    return jsonResponse({ error: 'No server API keys configured. Set APEX_API_KEYS or provide a custom Authorization header.' }, 503);
  }

  let lastResponse = null;
  let lastText = '';
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    let keyExhausted = false;
    for (let attempt = 0; attempt < 2 && !keyExhausted; attempt++) {
      try {
        const upstream = await fetch(upstreamUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${key}`,
          },
          body,
        });

        if (upstream.status === 429 || upstream.status === 503) {
          lastResponse = upstream;
          lastText = await upstream.text();
          if (attempt < 1) {
            await sleep(500 * (attempt + 1));
            continue;
          }
          keyExhausted = true;
          break; // rotate to next key after retry
        }
        if (upstream.status === 401 || upstream.status === 403) {
          lastResponse = upstream;
          lastText = await upstream.text();
          keyExhausted = true;
          break; // rotate to next key
        }

        const text = await upstream.text();
        return new Response(text, {
          status: upstream.status,
          headers: {
            'Content-Type': upstream.headers.get('Content-Type') || 'application/json; charset=utf-8',
            ...CORS_HEADERS,
          },
        });
      } catch (err) {
        lastText = JSON.stringify({ error: 'Upstream request failed', message: String(err && err.message || err) });
        if (attempt < 1) { await sleep(500 * (attempt + 1)); continue; }
        if (i === keys.length - 1) {
          return jsonResponse({ error: 'Upstream request failed', message: String(err && err.message || err) }, 502);
        }
        keyExhausted = true;
      }
    }
  }

  if (lastResponse) {
    return new Response(lastText || JSON.stringify({ error: 'All server API keys exhausted' }), {
      status: lastResponse.status,
      headers: {
        'Content-Type': lastResponse.headers.get('Content-Type') || 'application/json; charset=utf-8',
        ...CORS_HEADERS,
      },
    });
  }

  return jsonResponse({ error: 'All server API keys failed' }, 502);
}
