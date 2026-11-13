const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

function jsonResponse(body, status = 200) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

async function handle(context) {
  const { request, env } = context;
  let query = '';
  let numResults = 5;
  try {
    if (request.method === 'GET') {
      const u = new URL(request.url);
      query = (u.searchParams.get('q') || u.searchParams.get('query') || '').trim();
      numResults = Number(u.searchParams.get('numResults') || 5) || 5;
    } else {
      const payload = await request.json().catch(() => ({}));
      query = String(payload.query || payload.q || payload.prompt || '').trim();
      numResults = Number(payload.numResults || payload.max_results || 5) || 5;
    }
  } catch {}
  if (!query) return jsonResponse({ error: 'Missing query', results: [] }, 400);

  const apiKey = (env.APEX_SEARCH_API_KEY || env.TAVILY_API_KEY || '').trim();
  const provider = (env.APEX_SEARCH_PROVIDER || 'tavily').toLowerCase();
  if (!apiKey) {
    return jsonResponse({
      query,
      results: [],
      error: 'Web search not configured. Set APEX_SEARCH_API_KEY (Tavily) in Cloudflare environment variables.',
      configured: false
    }, 200);
  }

  try {
    if (provider === 'tavily' || !env.APEX_SEARCH_PROVIDER) {
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: apiKey,
          query,
          search_depth: 'basic',
          max_results: Math.max(1, Math.min(10, numResults)),
          include_answer: true,
          include_raw_content: false,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return jsonResponse({ query, results: [], error: data.error || `Search upstream error ${res.status}`, upstream: data }, 200);
      const results = Array.isArray(data.results) ? data.results.map(r => ({
        title: r.title || '',
        url: r.url || '',
        content: r.content || r.snippet || '',
        score: r.score
      })) : [];
      return jsonResponse({ query, answer: data.answer || null, results, configured: true }, 200);
    }
    // Generic: forward to custom provider URL if APEX_SEARCH_URL set
    const searchUrl = (env.APEX_SEARCH_URL || '').trim();
    if (searchUrl) {
      const res = await fetch(searchUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ query, numResults }),
      });
      const text = await res.text();
      return new Response(text, { status: res.status, headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/json; charset=utf-8', ...CORS_HEADERS } });
    }
    return jsonResponse({ query, results: [], error: 'Unsupported search provider configuration', configured: false }, 200);
  } catch (err) {
    return jsonResponse({ query, results: [], error: String(err && err.message || err), configured: true }, 200);
  }
}

export async function onRequestPost(context) { return handle(context); }
export async function onRequestGet(context) { return handle(context); }
