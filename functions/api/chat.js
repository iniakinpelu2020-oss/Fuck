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
  const defaultModel = (env.APEX_DEFAULT_MODEL && String(env.APEX_DEFAULT_MODEL).trim()) || 'openai/gpt-4o-mini';

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return jsonResponse({ error: 'Request payload must be a JSON object' }, 400);
  }
  if (!payload.model) {
    payload.model = defaultModel;
  }

  const authHeader = request.headers.get('Authorization');
  const body = JSON.stringify(payload);

  // BYOK override: forward user-provided Authorization header as-is.
  if (authHeader && authHeader.trim()) {
    try {
      const upstream = await fetch(upstreamUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': authHeader.trim(),
        },
        body,
      });
      const text = await upstream.text();
      return new Response(text, {
        status: upstream.status,
        headers: {
          'Content-Type': upstream.headers.get('Content-Type') || 'application/json; charset=utf-8',
          ...CORS_HEADERS,
        },
      });
    } catch (err) {
      return jsonResponse({ error: 'Upstream request failed', message: String(err && err.message || err) }, 502);
    }
  }

  const keys = parseApiKeys(env.APEX_API_KEYS);
  if (!keys.length) {
    return jsonResponse({ error: 'No server API keys configured. Set APEX_API_KEYS or provide a custom Authorization header.' }, 503);
  }

  let lastResponse = null;
  let lastText = '';
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    try {
      const upstream = await fetch(upstreamUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`,
        },
        body,
      });

      if (upstream.status === 429 || upstream.status === 401 || upstream.status === 403) {
        lastResponse = upstream;
        lastText = await upstream.text();
        continue; // rotate to next key
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
      if (i === keys.length - 1) {
        return jsonResponse({ error: 'Upstream request failed', message: String(err && err.message || err) }, 502);
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
