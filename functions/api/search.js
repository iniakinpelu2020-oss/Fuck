const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

function jsonResponse(body, status = 200) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });
}

function trimTrailingSlash(u) {
  return String(u || '').trim().replace(/\/+$/, '');
}

function normalizeResults(results) {
  if (!Array.isArray(results)) return [];
  return results.map((r) => ({
    title: r?.title || r?.name || '',
    url: r?.url || r?.href || r?.link || '',
    content: r?.content || r?.snippet || r?.body || r?.description || '',
    score: r?.score
  })).filter(r => r.title || r.url || r.content);
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

async function trySearxng(baseUrl, query, numResults) {
  const base = trimTrailingSlash(baseUrl);
  if (!base) return null;
  const limit = Math.max(1, Math.min(10, Number(numResults) || 5));
  const url = `${base}/search?q=${encodeURIComponent(query)}&format=json&language=en&safesearch=1&pageno=1`;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => { try { controller && controller.abort(); } catch {} }, 8000);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: controller ? controller.signal : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = null; }
    if (!res.ok) {
      // Gracefully treat 502/upstream errors as unavailable so caller can fall back without stalling
      const msg = (data && (data.error || data.message)) || `SearXNG error ${res.status}`;
      return { ok: false, provider: 'searxng', status: res.status, error: msg, results: [] };
    }
    const results = normalizeResults(data?.results).slice(0, limit);
    let answer = null;
    if (Array.isArray(data?.answers) && data.answers.length) {
      answer = data.answers.map(a => (typeof a === 'string' ? a : (a?.answer || a?.text || ''))).filter(Boolean).join('\n');
    } else if (typeof data?.answer === 'string') {
      answer = data.answer;
    }
    return { ok: true, provider: 'searxng', answer: answer || null, results };
  } catch (err) {
    const msg = (err && err.name === 'AbortError') ? 'SearXNG request timed out' : String(err && err.message || err);
    return { ok: false, provider: 'searxng', error: msg, results: [] };
  } finally {
    clearTimeout(timer);
  }
}

async function tryTavily(apiKey, query, numResults) {
  if (!apiKey) return null;
  const limit = Math.max(1, Math.min(10, Number(numResults) || 5));
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: 'basic',
        max_results: limit,
        include_answer: true,
        include_raw_content: false,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, provider: 'tavily', error: data?.error || `Tavily error ${res.status}`, results: [], upstream: data };
    }
    const results = normalizeResults(data?.results).slice(0, limit);
    return { ok: true, provider: 'tavily', answer: data?.answer || null, results };
  } catch (err) {
    return { ok: false, provider: 'tavily', error: String(err && err.message || err), results: [] };
  }
}

async function handle(context) {
  const { request, env } = context;
  let query = '';
  let numResults = 5;
  let payload = {};
  try {
    if (request.method === 'GET') {
      const u = new URL(request.url);
      query = (u.searchParams.get('q') || u.searchParams.get('query') || '').trim();
      numResults = Number(u.searchParams.get('numResults') || 5) || 5;
      payload.searxngUrl = (u.searchParams.get('searxngUrl') || u.searchParams.get('searxng_url') || '').trim();
    } else {
      payload = await request.json().catch(() => ({}));
      query = String(payload.query || payload.q || payload.prompt || '').trim();
      numResults = Number(payload.numResults || payload.max_results || 5) || 5;
    }
  } catch {
    payload = payload || {};
  }

  if (!query) return jsonResponse({ error: 'Missing query', results: [] }, 400);

  // Priority 1: SearXNG (env or request/Settings-provided URL)
  const searxngUrl = trimTrailingSlash(
    env.SEARXNG_URL || env.APEX_SEARXNG_URL || payload.searxngUrl || payload.searxng_url || payload.searxng || ''
  );
  const tavilyKey = String(env.APEX_SEARCH_API_KEY || env.TAVILY_API_KEY || '').trim();
  const explicitProvider = String(env.APEX_SEARCH_PROVIDER || '').trim().toLowerCase();

  // If SearXNG is configured, prioritize it (unless explicitly forced to tavily)
  if (searxngUrl && explicitProvider !== 'tavily') {
    const sx = await trySearxng(searxngUrl, query, numResults);
    if (sx && sx.ok) {
      return jsonResponse({ query, answer: sx.answer, results: sx.results, configured: true, provider: 'searxng' }, 200);
    }
    // Fallback to Tavily if SearXNG configured but failed and Tavily is available
    if (tavilyKey) {
      const tv = await tryTavily(tavilyKey, query, numResults);
      if (tv) {
        return jsonResponse({
          query,
          answer: tv.answer || null,
          results: tv.results || [],
          configured: true,
          provider: tv.ok ? 'tavily' : 'tavily',
          error: tv.ok ? (sx && sx.error ? `SearXNG fallback: ${sx.error}` : undefined) : (tv.error || 'Search failed'),
          searxngError: sx && sx.error ? sx.error : undefined
        }, 200);
      }
    }
    return jsonResponse({
      query,
      answer: null,
      results: [],
      configured: true,
      provider: 'searxng',
      error: (sx && sx.error) ? `SearXNG search failed: ${sx.error}` : 'SearXNG search failed'
    }, 200);
  }

  // Priority 2: Tavily (or explicit provider=tavily)
  if (tavilyKey) {
    const tv = await tryTavily(tavilyKey, query, numResults);
    if (tv) {
      return jsonResponse({ query, answer: tv.answer || null, results: tv.results || [], configured: true, provider: 'tavily', error: tv.ok ? undefined : tv.error }, 200);
    }
  }

  // Generic custom search URL fallback (if configured)
  const customSearchUrl = trimTrailingSlash(env.APEX_SEARCH_URL || '');
  if (customSearchUrl && tavilyKey) {
    try {
      const res = await fetch(customSearchUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tavilyKey}` },
        body: JSON.stringify({ query, numResults }),
      });
      const text = await res.text();
      return new Response(text, { status: res.status, headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/json; charset=utf-8', ...CORS_HEADERS } });
    } catch (err) {
      return jsonResponse({ query, results: [], error: String(err && err.message || err), configured: true }, 200);
    }
  }

  // Nothing configured
  return jsonResponse({
    query,
    results: [],
    error: 'Web search not configured. Set SEARXNG_URL (or APEX_SEARXNG_URL) or APEX_SEARCH_API_KEY (Tavily) in environment/settings.',
    configured: false
  }, 200);
}

export async function onRequestPost(context) { return handle(context); }
export async function onRequestGet(context) { return handle(context); }
