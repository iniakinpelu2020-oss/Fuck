const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

const DEFAULT_UPSTREAM_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'gemini-3.8-flash';
const FAST_FALLBACK_MODEL = 'gemini-3.8-flash-lite';
const MAX_UPSTREAM_ATTEMPTS = 2;
const PER_PROVIDER_TIMEOUT_MS = 45000;

const CF_PRIMARY_MODEL = '@cf/qwen/qwen2.5-coder-32b-instruct';
const CF_FALLBACK_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

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

function isWorkersAiModel(model) {
  const m = String(model || '').trim().toLowerCase();
  return m.startsWith('@cf/') || m === 'workers-ai-qwen' || m === 'workers-ai-llama' || m === 'managed-workers-ai-qwen' || m === 'managed-workers-ai-llama';
}

function resolveWorkersAiModels(requestedModel) {
  const m = String(requestedModel || '').trim();
  if (!m) return [CF_PRIMARY_MODEL, CF_FALLBACK_MODEL];
  if (m === '@cf/meta/llama-3.3-70b-instruct-fp8-fast' || m === 'workers-ai-llama' || m === 'managed-workers-ai-llama') {
    return [CF_FALLBACK_MODEL, CF_PRIMARY_MODEL];
  }
  if (m.startsWith('@cf/')) return [m, m === CF_PRIMARY_MODEL ? CF_FALLBACK_MODEL : CF_PRIMARY_MODEL];
  // default managed Workers AI preset
  return [CF_PRIMARY_MODEL, CF_FALLBACK_MODEL];
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .map((m) => {
      if (!m || typeof m !== 'object') return { role: 'user', content: String(m == null ? '' : m) };
      const role = typeof m.role === 'string' && m.role ? m.role : 'user';
      let content = m.content;
      if (Array.isArray(content)) {
        content = content.map((p) => {
          if (typeof p === 'string') return p;
          if (p && typeof p === 'object') {
            if (typeof p.text === 'string') return p.text;
            if (typeof p.content === 'string') return p.content;
          }
          return '';
        }).join('');
      } else if (content != null && typeof content !== 'string') {
        try { content = JSON.stringify(content); } catch { content = String(content); }
      }
      return { role, content: content == null ? '' : String(content) };
    })
    .filter((m) => m && typeof m.content === 'string');
}

function makeId() {
  try { return `chatcmpl-${crypto.randomUUID()}`; } catch { return `chatcmpl-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
}

function extractText(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (typeof result.response === 'string') return result.response;
  if (result.result && typeof result.result.response === 'string') return result.result.response;
  if (result.result && typeof result.result === 'string') return result.result;
  if (Array.isArray(result.choices) && result.choices[0]) {
    const c = result.choices[0];
    if (c.message && typeof c.message.content === 'string') return c.message.content;
    if (c.delta && typeof c.delta.content === 'string') return c.delta.content;
    if (typeof c.text === 'string') return c.text;
  }
  if (typeof result.output_text === 'string') return result.output_text;
  try { return JSON.stringify(result); } catch { return String(result); }
}

function toOpenAICompletion(content, model, id) {
  return {
    id: id || makeId(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: content || '' }, finish_reason: 'stop' }],
  };
}

function sseChunk({ id, model, delta, finish_reason = null, role }) {
  const deltaObj = {};
  if (role) deltaObj.role = role;
  if (delta != null && delta !== '') deltaObj.content = delta;
  if (!role && (delta == null || delta === '') && finish_reason == null) return '';
  return `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: deltaObj, finish_reason }],
  })}\n\n`;
}

function isReadableStream(value) {
  return value && typeof value === 'object' && typeof value.getReader === 'function';
}

async function workersAiToOpenAIStream(aiResult, model) {
  const id = makeId();
  const encoder = new TextEncoder();
  let reader = null;
  if (isReadableStream(aiResult)) reader = aiResult.getReader();
  else if (aiResult && typeof aiResult === 'object') {
    if (isReadableStream(aiResult.body)) reader = aiResult.body.getReader();
    else if (aiResult.body && typeof aiResult.body.getReader === 'function') reader = aiResult.body.getReader();
  }

  if (!reader) {
    const text = extractText(aiResult);
    let body = '';
    body += sseChunk({ id, model, role: 'assistant', delta: text || '' });
    body += sseChunk({ id, model, delta: '', finish_reason: 'stop' });
    body += 'data: [DONE]\n\n';
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', ...CORS_HEADERS },
    });
  }

  const decoder = new TextDecoder();
  const stream = new ReadableStream({
    async start(controller) {
      let buffer = '';
      let sentRole = false;
      let sentDone = false;
      const sendText = (text) => {
        if (!text) return;
        const chunk = sseChunk({ id, model, role: sentRole ? undefined : 'assistant', delta: String(text) });
        if (chunk) { controller.enqueue(encoder.encode(chunk)); sentRole = true; }
      };
      const finish = () => {
        if (sentDone) return;
        sentDone = true;
        if (!sentRole) {
          const roleChunk = sseChunk({ id, model, role: 'assistant', delta: '' });
          if (roleChunk) controller.enqueue(encoder.encode(roleChunk));
        }
        controller.enqueue(encoder.encode(sseChunk({ id, model, delta: '', finish_reason: 'stop' }) || ''));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      };
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.search(/\r?\n/)) !== -1) {
            const lineEnd = buffer[idx] === '\r' && buffer[idx + 1] === '\n' ? 2 : 1;
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + lineEnd);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (!data) continue;
            if (data === '[DONE]') { finish(); controller.close(); return; }
            let obj;
            try { obj = JSON.parse(data); } catch {
              if (data && data[0] !== '{' && data[0] !== '[') sendText(data);
              continue;
            }
            let token = '';
            if (obj && typeof obj === 'object') {
              if (typeof obj.response === 'string') token = obj.response;
              else if (typeof obj.token === 'string') token = obj.token;
              else if (typeof obj.text === 'string') token = obj.text;
              else if (obj.result && typeof obj.result.response === 'string') token = obj.result.response;
              else if (obj.result && typeof obj.result === 'string') token = obj.result;
              else if (Array.isArray(obj.choices) && obj.choices[0]) {
                const c = obj.choices[0];
                if (c.delta && typeof c.delta.content === 'string') token = c.delta.content;
                else if (c.message && typeof c.message.content === 'string') token = c.message.content;
                else if (typeof c.text === 'string') token = c.text;
              }
            } else if (typeof obj === 'string') token = obj;
            if (token) sendText(token);
          }
        }
        const tail = buffer.trim();
        if (tail.startsWith('data:')) {
          const data = tail.slice(5).trim();
          if (data && data !== '[DONE]') {
            try {
              const obj = JSON.parse(data);
              let token = '';
              if (obj && typeof obj.response === 'string') token = obj.response;
              else if (obj && typeof obj.token === 'string') token = obj.token;
              else if (obj && typeof obj.text === 'string') token = obj.text;
              if (token) sendText(token);
            } catch {}
          }
        }
      } catch (err) {
        try { sendText(`\n[Workers AI stream error: ${String(err && (err.message || err) || 'stream error')}]`); } catch {}
      }
      finish();
      try { controller.close(); } catch {}
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', ...CORS_HEADERS },
  });
}

async function handleWorkersAiRequest(payload, env) {
  if (!env || !env.AI || typeof env.AI.run !== 'function') {
    return jsonResponse({ error: 'Cloudflare Workers AI binding (env.AI) is not configured for this deployment.' }, 503);
  }
  const messages = normalizeMessages(payload.messages);
  if (!messages.length) return jsonResponse({ error: 'messages array is required' }, 400);
  const stream = payload.stream !== false;
  const aiParams = { messages, stream };
  if (payload.max_tokens != null) { const n = Number(payload.max_tokens); if (Number.isFinite(n) && n > 0) aiParams.max_tokens = Math.floor(n); }
  if (payload.temperature != null) { const n = Number(payload.temperature); if (Number.isFinite(n)) aiParams.temperature = n; }
  if (payload.top_p != null) { const n = Number(payload.top_p); if (Number.isFinite(n)) aiParams.top_p = n; }
  if (payload.top_k != null) { const n = Number(payload.top_k); if (Number.isFinite(n)) aiParams.top_k = Math.floor(n); }
  if (payload.seed != null) { const n = Number(payload.seed); if (Number.isFinite(n)) aiParams.seed = Math.floor(n); }
  if (typeof payload.repetition_penalty === 'number') aiParams.repetition_penalty = payload.repetition_penalty;

  const models = resolveWorkersAiModels(payload.model);
  let lastError = null;
  for (const model of models) {
    try {
      const result = await env.AI.run(model, aiParams);
      if (stream) return await workersAiToOpenAIStream(result, model);
      const text = extractText(result);
      return jsonResponse(toOpenAICompletion(text, model));
    } catch (err) {
      lastError = err;
    }
  }
  return jsonResponse({ error: 'Cloudflare Workers AI request failed', detail: lastError && (lastError.message || String(lastError)) || 'Unknown Workers AI error', models }, 502);
}

function buildAttemptPlan(incomingAuth, serverKeys, primaryModel) {
  const attempts = [];
  const fallbackModel = (primaryModel && primaryModel !== FAST_FALLBACK_MODEL) ? FAST_FALLBACK_MODEL : null;

  if (incomingAuth && incomingAuth.trim()) {
    const auth = incomingAuth.trim();
    attempts.push({ auth, model: primaryModel, reason: 'byok-primary' });
    if (fallbackModel) attempts.push({ auth, model: fallbackModel, reason: 'byok-fallback' });
  } else if (serverKeys.length > 0) {
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
  return jsonResponse({ ok: true, proxy: 'managed', defaultModel: DEFAULT_MODEL, workersAi: { primary: CF_PRIMARY_MODEL, fallback: CF_FALLBACK_MODEL } }, 200);
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

  // Custom OpenAI-compatible endpoint relay (server-side) to avoid browser CORS issues.
  const relayCustomEndpoint = typeof payload.customEndpoint === 'string' ? payload.customEndpoint.trim() : '';
  const relayApiKey = typeof payload.apiKey === 'string' ? payload.apiKey.trim() : '';
  if (relayCustomEndpoint && relayApiKey) {
    let target = relayCustomEndpoint.replace(/\s+/g, '').replace(/\/+$/, '');
    if (!/\/chat\/completions(\/|\?|#|$)/i.test(target)) {
      target = /\/v1$/i.test(target) ? (target + '/chat/completions') : (target + '/chat/completions');
    } else {
      target = target.replace(/\/+$/, '');
    }
    const forwardBody = { ...payload };
    delete forwardBody.customEndpoint;
    delete forwardBody.apiKey;
    const wantRelayStream = wantsStream(forwardBody);
    if (forwardBody.reasoning_effort == null) forwardBody.reasoning_effort = 'low';
    let res;
    try {
      res = await fetchWithTimeout(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${relayApiKey}` },
        body: JSON.stringify(forwardBody),
        redirect: 'manual',
      }, PER_PROVIDER_TIMEOUT_MS);
    } catch (err) {
      const msg = (err && err.name === 'AbortError') ? `Upstream timeout after ${PER_PROVIDER_TIMEOUT_MS}ms` : String(err && err.message || err || 'Upstream fetch failed');
      return jsonResponse({ error: 'Custom endpoint relay upstream error', detail: msg, endpoint: target }, 504);
    }
    if (isRedirect(res.status)) {
      const loc = res.headers.get('Location') || res.headers.get('location') || '';
      return jsonResponse({ error: 'Custom endpoint relay blocked upstream redirect', detail: `HTTP ${res.status}${loc ? ` -> ${loc}` : ''}`, endpoint: target }, 502);
    }
    if (res.ok) {
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (wantRelayStream && ct.includes('text/event-stream') && res.body) {
        return new Response(res.body, {
          status: res.status,
          headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', ...CORS_HEADERS },
        });
      }
      const text = await readTextSafe(res, 200000);
      const outCt = res.headers.get('content-type') || 'application/json; charset=utf-8';
      return new Response(text, { status: res.status, headers: { 'Content-Type': outCt, ...CORS_HEADERS } });
    }
    const errText = await readTextSafe(res, 4000);
    const ct = res.headers.get('content-type') || 'application/json; charset=utf-8';
    return new Response(errText || JSON.stringify({ error: 'Custom endpoint relay error', status: res.status }), { status: res.status || 502, headers: { 'Content-Type': ct, ...CORS_HEADERS } });
  }

  const requestedModel = normalizeModelId(payload.model);
  // Managed Workers AI presets/models: zero external API keys required.
  if (isWorkersAiModel(requestedModel)) {
    return handleWorkersAiRequest(payload, env);
  }

  const upstreamUrl = (env && env.APEX_API_URL && String(env.APEX_API_URL).trim()) || DEFAULT_UPSTREAM_URL;
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

    if ((res.status === 503 || res.status === 429) && i === 0 && i + 1 < MAX_UPSTREAM_ATTEMPTS) {
      attempts[1] = { auth: attempt.auth, model: 'gemini-2.5-flash', reason: 'fallback-503-429-gemini-2.5-flash' };
      if (attempts.length < 2) attempts.length = 2;
      continue;
    }

    const retryable = [401, 403, 404, 408, 409, 425, 429, 500, 502, 503, 504, 522, 523, 524].includes(res.status);
    if (retryable && i < attempts.length - 1) continue;

    const ct = res.headers.get('content-type') || 'application/json; charset=utf-8';
    return new Response(errText || JSON.stringify({ error: 'Upstream error', status: res.status }), {
      status: res.status || 502,
      headers: { 'Content-Type': ct, ...CORS_HEADERS },
    });
  }

  return jsonResponse({ error: 'Managed proxy failed', detail: lastError.message, status: lastError.status, model: lastError.model }, lastError.status || 502);
}
