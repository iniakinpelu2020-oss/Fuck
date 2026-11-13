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
  if (!payload.model) payload.model = defaultModel;
  // Low-latency generation: start streaming first tokens immediately unless explicitly set.
  if (payload.reasoning_effort == null) payload.reasoning_effort = 'low';
  // Enable real-time SSE streaming by default for low-latency chat UX.
  if (payload.stream == null) payload.stream = true;

  const authHeader = request.headers.get('Authorization');
  const body = JSON.stringify(payload);
  const wantStream = !!payload.stream;
  const shouldRetry = (status) => status === 429 || status === 503;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function forward(headers, maxAttempts, rotateOnAuthError) {
    let lastResponse = null;
    let lastText = '';
    let lastHeaders = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const upstream = await fetch(upstreamUrl, {
          method: 'POST',
          headers,
          body,
        });

        if (shouldRetry(upstream.status) && attempt < maxAttempts - 1) {
          lastResponse = upstream;
          lastText = await upstream.text();
          lastHeaders = upstream.headers;
          await sleep(400 * (attempt + 1));
          continue;
        }
        if (rotateOnAuthError && (upstream.status === 401 || upstream.status === 403)) {
          lastResponse = upstream;
          lastText = await upstream.text();
          lastHeaders = upstream.headers;
          return { rotate: true, lastResponse, lastText, lastHeaders };
        }

        if (upstream.ok && wantStream && upstream.body) {
          return { response: streamResponse(upstream) };
        }

        const text = await upstream.text();
        return {
          response: new Response(text, {
            status: upstream.status,
            headers: {
              'Content-Type': upstream.headers.get('Content-Type') || 'application/json; charset=utf-8',
              ...CORS_HEADERS,
            },
          }),
        };
      } catch (err) {
        lastText = JSON.stringify({ error: 'Upstream request failed', message: String(err && err.message || err) });
        lastResponse = null;
        lastHeaders = null;
        if (attempt < maxAttempts - 1) {
          await sleep(400 * (attempt + 1));
          continue;
        }
        return {
          response: jsonResponse({ error: 'Upstream request failed', message: String(err && err.message || err) }, 502),
        };
      }
    }
    return {
      response: new Response(lastText || JSON.stringify({ error: 'Upstream request failed' }), {
        status: (lastResponse && lastResponse.status) || 502,
        headers: {
          'Content-Type': (lastHeaders && lastHeaders.get('Content-Type')) || 'application/json; charset=utf-8',
          ...CORS_HEADERS,
        },
      }),
    };
  }

  // BYOK override: forward user-provided Authorization header as-is, with retry on 429/503.
  if (authHeader && authHeader.trim()) {
    const out = await forward(
      { 'Content-Type': 'application/json', 'Authorization': authHeader.trim() },
      3,
      false
    );
    return out.response;
  }

  const keys = parseApiKeys(env.APEX_API_KEYS);
  if (!keys.length) {
    return jsonResponse({ error: 'No server API keys configured. Set APEX_API_KEYS or provide a custom Authorization header.' }, 503);
  }

  let lastResponse = null;
  let lastText = '';
  let lastHeaders = null;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    let keyDone = false;
    for (let attempt = 0; attempt < 2 && !keyDone; attempt++) {
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
          lastHeaders = upstream.headers;
          if (attempt < 1) {
            await sleep(500 * (attempt + 1));
            continue;
          }
          keyDone = true; // rotate to next key after retry
          break;
        }
        if (upstream.status === 401 || upstream.status === 403) {
          lastResponse = upstream;
          lastText = await upstream.text();
          lastHeaders = upstream.headers;
          keyDone = true; // rotate to next key
          break;
        }

        if (upstream.ok && wantStream && upstream.body) {
          return streamResponse(upstream);
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
        lastResponse = null;
        lastHeaders = null;
        if (attempt < 1) {
          await sleep(500 * (attempt + 1));
          continue;
        }
        if (i === keys.length - 1) {
          return jsonResponse({ error: 'Upstream request failed', message: String(err && err.message || err) }, 502);
        }
        keyDone = true;
      }
    }
  }

  if (lastResponse) {
    return new Response(lastText || JSON.stringify({ error: 'All server API keys exhausted' }), {
      status: lastResponse.status,
      headers: {
        'Content-Type': (lastHeaders && lastHeaders.get('Content-Type')) || 'application/json; charset=utf-8',
        ...CORS_HEADERS,
      },
    });
  }

  return jsonResponse({ error: 'All server API keys failed' }, 502);
}
