export async function onRequest(context) {
  const { request, env } = context;
  if (!env || !env.API_WORKER || typeof env.API_WORKER.fetch !== 'function') {
    return new Response(JSON.stringify({ error: 'API_WORKER service binding is not configured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }
  return env.API_WORKER.fetch(request);
}
