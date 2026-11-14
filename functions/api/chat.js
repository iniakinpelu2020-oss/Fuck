const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

const PRIMARY_MODEL = '@cf/qwen/qwen2.5-coder-32b-instruct';
const FALLBACK_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestGet() {
  return jsonResponse({ ok: true, provider: 'cloudflare-workers-ai', models: [PRIMARY_MODEL, FALLBACK_MODEL] }, 200);
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .map((m) => {
      if (!m || typeof m !== 'object') return { role: 'user', content: String(m == null ? '' : m) };
      const role = typeof m.role === 'string' && m.role ? m.role : 'user';
      let content = m.content;
      if (Array.isArray(content)) {
        content = content
          .map((p) => {
            if (typeof p === 'string') return p;
            if (p && typeof p === 'object') {
              if (typeof p.text === 'string') return p.text;
              if (typeof p.content === 'string') return p.content;
            }
            return '';
          })
          .join('');
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

function toOpenAICompletion(content, model, id) {
  return {
    id: id || makeId(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: content || '' },
        finish_reason: 'stop',
      },
    ],
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

async function toOpenAIStream(aiResult, model) {
  const id = makeId();
  const encoder = new TextEncoder();

  let reader = null;
  if (isReadableStream(aiResult)) {
    reader = aiResult.getReader();
  } else if (aiResult && typeof aiResult === 'object') {
    if (isReadableStream(aiResult.body)) reader = aiResult.body.getReader();
    else if (aiResult.body && typeof aiResult.body.getReader === 'function') reader = aiResult.body.getReader();
  }

  // Non-stream result fallback: emit as a single streamed completion.
  if (!reader) {
    const text = extractText(aiResult);
    let body = '';
    body += sseChunk({ id, model, role: 'assistant', delta: text || '' });
    body += sseChunk({ id, model, delta: '', finish_reason: 'stop' });
    body += 'data: [DONE]\n\n';
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        ...CORS_HEADERS,
      },
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
        if (chunk) {
          controller.enqueue(encoder.encode(chunk));
          sentRole = true;
        }
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
            if (data === '[DONE]') {
              finish();
              controller.close();
              return;
            }

            let obj;
            try { obj = JSON.parse(data); } catch { 
              // Some streams may emit raw text tokens; forward conservatively.
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
            } else if (typeof obj === 'string') {
              token = obj;
            }

            if (token) sendText(token);
          }
        }

        // Flush remaining buffer line if present
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
        // If streaming fails mid-way, close gracefully with a finish marker.
        try {
          const msg = String(err && (err.message || err) || 'stream error');
          sendText(`\n[Workers AI stream error: ${msg}]`);
        } catch {}
      }

      finish();
      try { controller.close(); } catch {}
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      ...CORS_HEADERS,
    },
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env || !env.AI || typeof env.AI.run !== 'function') {
    return jsonResponse(
      { error: 'Cloudflare Workers AI binding (env.AI) is not configured for this deployment.' },
      503
    );
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON payload' }, 400);
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return jsonResponse({ error: 'Request payload must be a JSON object' }, 400);
  }

  const messages = normalizeMessages(payload.messages);
  if (!messages.length) {
    return jsonResponse({ error: 'messages array is required' }, 400);
  }

  const stream = payload.stream !== false; // default to streaming for chat UX
  const aiParams = { messages, stream };

  if (payload.max_tokens != null) {
    const n = Number(payload.max_tokens);
    if (Number.isFinite(n) && n > 0) aiParams.max_tokens = Math.floor(n);
  }
  if (payload.temperature != null) {
    const n = Number(payload.temperature);
    if (Number.isFinite(n)) aiParams.temperature = n;
  }
  if (payload.top_p != null) {
    const n = Number(payload.top_p);
    if (Number.isFinite(n)) aiParams.top_p = n;
  }
  if (payload.top_k != null) {
    const n = Number(payload.top_k);
    if (Number.isFinite(n)) aiParams.top_k = Math.floor(n);
  }
  if (payload.seed != null) {
    const n = Number(payload.seed);
    if (Number.isFinite(n)) aiParams.seed = Math.floor(n);
  }
  if (typeof payload.repetition_penalty === 'number') {
    aiParams.repetition_penalty = payload.repetition_penalty;
  }

  const models = [PRIMARY_MODEL, FALLBACK_MODEL];
  let lastError = null;

  for (const model of models) {
    try {
      const result = await env.AI.run(model, aiParams);
      if (stream) {
        return await toOpenAIStream(result, model);
      }
      const text = extractText(result);
      return jsonResponse(toOpenAICompletion(text, model));
    } catch (err) {
      lastError = err;
      // Try fallback model on failure
    }
  }

  const detail = lastError && (lastError.message || String(lastError)) || 'Unknown Workers AI error';
  return jsonResponse(
    {
      error: 'Cloudflare Workers AI request failed',
      detail,
      models,
    },
    502
  );
}
