/**
 * Apex Studio Cloudflare Worker (standalone)
 * - codespace_exec: forwards command execution to an explicit runner URL (no *.app.github.dev fallback),
 *   uses redirect: "manual" to avoid redirect/subrequest loops and returns clean errors.
 * - github_repo_inspect: MCP-style tool to inspect public GitHub repository trees/files via GitHub API
 *   with User-Agent: Apex-Studio.
 *
 * This file is additive and does not replace existing Cloudflare Pages Functions under /functions/api/*.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Runner-Token',
  'Access-Control-Max-Age': '86400',
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS, ...extraHeaders },
  });
}

function asString(v) { return v == null ? '' : String(v); }
function trim(v) { return asString(v).trim(); }

function isGithubDevHost(urlStr) {
  try {
    const u = new URL(urlStr);
    const h = (u.hostname || '').toLowerCase();
    return h.endsWith('.app.github.dev') || h.endsWith('.github.dev');
  } catch {
    return false;
  }
}

function normalizeRunnerExecUrl(input) {
  const raw = trim(input);
  if (!raw) throw new Error('runnerUrl (or codespaceUrl/url) is required');
  let u;
  try { u = new URL(raw); } catch { throw new Error(`Invalid runner URL: ${raw}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('runner URL must be http(s)');
  }
  // IMPORTANT: do not apply any hardcoded fallback to *.app.github.dev hosts/URLs.
  if (!/\/exec\/?$/i.test(u.pathname)) {
    u.pathname = (u.pathname.replace(/\/+$/, '') || '') + '/exec';
  }
  u.search = '';
  u.hash = '';
  return u.toString();
}

async function readBody(request) {
  const ct = (request.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('application/json')) {
    return await request.json().catch(() => ({}));
  }
  if (ct.includes('application/x-www-form-urlencoded') || ct.includes('multipart/form-data')) {
    try {
      const fd = await request.formData();
      const obj = {};
      for (const [k, v] of fd.entries()) obj[k] = typeof v === 'string' ? v : (v && v.name) || '';
      return obj;
    } catch { /* fallthrough */ }
  }
  const text = await request.text().catch(() => '');
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

function cleanRedirectError(upstream, target) {
  const loc = upstream.headers.get('location') || '';
  const status = upstream.status;
  return {
    ok: false,
    error: 'Upstream redirect blocked',
    stderr: `Upstream redirect blocked (HTTP ${status})${loc ? ` -> ${loc}` : ''}. Provide a direct runner /exec URL; automatic redirects are disabled to prevent subrequest/redirect loops.`,
    stdout: '',
    exitCode: status || 1,
    target,
    location: loc || null,
  };
}

async function codespaceExec(payload = {}, env = {}) {
  // Accept explicit URL fields only; never fall back to any hardcoded *.app.github.dev URL.
  const runnerUrl = trim(payload.runnerUrl || payload.codespaceUrl || payload.codespace_url || payload.url || payload.endpoint || (env && env.CODESPACE_URL) || '');
  const token = trim(payload.token || payload.runnerToken || payload.authToken || requestAuthFromPayload(payload) || (env && env.CODESPACE_TOKEN) || '');
  const command = payload.command == null ? '' : asString(payload.command);
  const cwd = payload.cwd == null ? '' : asString(payload.cwd);
  const timeoutRaw = Number(payload.timeoutMs != null ? payload.timeoutMs : (payload.timeout != null ? payload.timeout : (env && env.CODESPACE_TIMEOUT_MS)));
  const timeoutMs = (Number.isFinite(timeoutRaw) && timeoutRaw > 0) ? Math.min(3600000, Math.max(1000, Math.round(timeoutRaw))) : 600000;

  let target;
  try {
    target = normalizeRunnerExecUrl(runnerUrl);
  } catch (e) {
    return json({ ok: false, stdout: '', stderr: e.message, exitCode: 1, error: e.message }, 400);
  }

  // Extra safety: if caller somehow passes a github.dev host, still do not rewrite/fallback; just forward explicitly with redirect:manual.
  const body = { command, timeoutMs };
  if (cwd) body.cwd = cwd;

  const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  const timer = controller ? setTimeout(() => { try { controller.abort(); } catch {} }, timeoutMs) : null;
  try {
    const upstream = await fetch(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': token.toLowerCase().startsWith('bearer ') ? token : `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      redirect: 'manual', // critical: avoid Cloudflare redirect/subrequest loops
      signal: controller ? controller.signal : undefined,
    });

    // Handle redirects cleanly (no follow)
    if (upstream.status >= 300 && upstream.status < 400) {
      return json(cleanRedirectError(upstream, target), 502);
    }

    const ct = (upstream.headers.get('content-type') || '').toLowerCase();
    let data = null;
    let text = '';
    if (ct.includes('application/json')) {
      data = await upstream.json().catch(() => null);
      if (data == null) text = await upstream.text().catch(() => '');
    } else {
      text = await upstream.text().catch(() => '');
      try { data = JSON.parse(text); } catch { data = null; }
    }

    let stdout = '';
    let stderr = '';
    let exitCode = upstream.ok ? 0 : (upstream.status || 1);

    if (data && typeof data === 'object' && !Array.isArray(data)) {
      if (typeof data.stdout === 'string') stdout = data.stdout;
      if (typeof data.stderr === 'string') stderr = data.stderr;
      if (data.exitCode != null && Number.isFinite(Number(data.exitCode))) exitCode = Number(data.exitCode);
      else if (data.code != null && Number.isFinite(Number(data.code))) exitCode = Number(data.code);
      if (!stdout && typeof data.output === 'string') stdout = data.output;
      if (!stdout && typeof data.result === 'string') stdout = data.result;
      if (!stderr && data.error) stderr = asString(data.error);
      if (!stderr && data.message && !upstream.ok) stderr = asString(data.message);
      if (!stdout && !stderr && data.stdout == null && data.stderr == null && data.output == null && data.result == null) {
        stdout = JSON.stringify(data, null, 2);
      }
    } else {
      stdout = text || (data != null ? asString(data) : '');
      if (!upstream.ok && !stderr) stderr = `HTTP ${upstream.status}`;
    }

    if (!upstream.ok && !stderr) stderr = `HTTP ${upstream.status}`;

    return json({
      ok: upstream.ok,
      stdout: stdout == null ? '' : asString(stdout),
      stderr: stderr == null ? '' : asString(stderr),
      exitCode,
      target,
      hostIsGithubDev: isGithubDevHost(target),
    }, 200);
  } catch (err) {
    const isAbort = err && (err.name === 'AbortError' || /aborted/i.test(asString(err && (err.message || err))));
    const message = isAbort
      ? `Remote runner request timed out after ${Math.round(timeoutMs / 1000)}s`
      : asString(err && (err.message || err) || 'Upstream request failed');
    return json({ ok: false, stdout: '', stderr: message, exitCode: isAbort ? 124 : 1, error: message, target, timeoutMs, timedOut: isAbort || undefined }, isAbort ? 504 : 502);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function requestAuthFromPayload(payload) {
  const a = trim(payload && (payload.authorization || payload.Authorization));
  return a;
}

function parseGithubRepo(input) {
  let s = trim(input);
  if (!s) return null;
  s = s.replace(/^git\+/, '').replace(/\.git$/i, '');
  // URL form
  try {
    if (/^https?:\/\//i.test(s)) {
      const u = new URL(s);
      if ((u.hostname || '').toLowerCase() === 'github.com') {
        const parts = u.pathname.split('/').filter(Boolean);
        if (parts.length >= 2) return { owner: parts[0], repo: parts[1] };
      }
    }
  } catch {}
  // owner/repo form
  const m = s.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (m) return { owner: m[1], repo: m[2] };
  return null;
}

async function githubApiFetch(url, token) {
  const headers = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'Apex-Studio',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers['Authorization'] = token.toLowerCase().startsWith('bearer ') ? token : `Bearer ${token}`;
  return await fetch(url, { method: 'GET', headers, redirect: 'manual' });
}

async function githubRepoInspect(args = {}, env = {}) {
  const repoArg = trim(args.repo || args.repository || args.fullName || args.full_name || args.url || '');
  const parsed = parseGithubRepo(repoArg) || (args.owner && args.repo ? { owner: trim(args.owner), repo: trim(args.repo) } : null);
  if (!parsed || !parsed.owner || !parsed.repo) {
    return { ok: false, error: 'Provide repo as "owner/repo" (or GitHub URL) or owner+repo' };
  }
  const { owner, repo } = parsed;
  const ref = trim(args.ref || args.branch || args.sha || 'HEAD') || 'HEAD';
  const path = trim(args.path || args.filePath || '');
  const recursive = args.recursive !== false;
  const token = trim(args.token || args.githubToken || (env && (env.GITHUB_TOKEN || env.GH_TOKEN)) || '');
  const maxBytes = Math.max(1024, Math.min(Number(args.maxBytes || 200000) || 200000, 1000000));

  const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  // If a specific file path is requested, fetch file content via contents API
  if (path) {
    const contentsUrl = `${base}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`;
    const res = await githubApiFetch(contentsUrl, token);
    if (res.status >= 300 && res.status < 400) {
      return { ok: false, error: `Redirect blocked (HTTP ${res.status})`, location: res.headers.get('location') || null };
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      return { ok: false, error: (data && (data.message || data.error)) || `GitHub API error ${res.status}`, status: res.status, data };
    }
    let content = null;
    let encoding = data && data.encoding || null;
    if (data && data.type === 'file') {
      if (encoding === 'base64' && typeof data.content === 'string') {
        try {
          const bin = atob(data.content.replace(/\n/g, ''));
          // return utf-8 text when reasonable
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const slice = bytes.byteLength > maxBytes ? bytes.slice(0, maxBytes) : bytes;
          try { content = new TextDecoder('utf-8', { fatal: false }).decode(slice); }
          catch { content = bin.slice(0, maxBytes); }
          if (bytes.byteLength > maxBytes) content += `\n\n...[truncated ${bytes.byteLength - maxBytes} bytes]`;
        } catch { content = null; }
      } else if (typeof data.content === 'string') {
        content = data.content;
      }
    }
    return {
      ok: true,
      tool: 'github_repo_inspect',
      repository: `${owner}/${repo}`,
      ref,
      path,
      type: data && data.type || null,
      name: data && data.name || null,
      size: data && data.size || null,
      sha: data && data.sha || null,
      html_url: data && data.html_url || null,
      download_url: data && data.download_url || null,
      content,
      encoding,
      truncated: !!(data && data.size && data.size > maxBytes),
    };
  }

  // Otherwise fetch repo info + git tree
  const infoRes = await githubApiFetch(base, token);
  let info = null;
  if (infoRes.ok) info = await infoRes.json().catch(() => null);

  // Resolve default branch/ref for tree if HEAD used
  let treeRef = ref;
  if (ref.toUpperCase() === 'HEAD' && info && info.default_branch) treeRef = info.default_branch;

  const treeUrl = `${base}/git/trees/${encodeURIComponent(treeRef)}${recursive ? '?recursive=1' : ''}`;
  const treeRes = await githubApiFetch(treeUrl, token);
  if (treeRes.status >= 300 && treeRes.status < 400) {
    return { ok: false, error: `Redirect blocked (HTTP ${treeRes.status})`, location: treeRes.headers.get('location') || null };
  }
  const treeData = await treeRes.json().catch(() => null);
  if (!treeRes.ok) {
    return { ok: false, error: (treeData && (treeData.message || treeData.error)) || `GitHub API error ${treeRes.status}`, status: treeRes.status, data: treeData, repository: `${owner}/${repo}` };
  }

  const entries = Array.isArray(treeData && treeData.tree) ? treeData.tree : [];
  const limited = entries.slice(0, 5000).map(e => ({ path: e.path, type: e.type, mode: e.mode, size: e.size, sha: e.sha }));
  return {
    ok: true,
    tool: 'github_repo_inspect',
    repository: `${owner}/${repo}`,
    ref: treeRef,
    default_branch: info && info.default_branch || null,
    description: info && info.description || null,
    html_url: info && info.html_url || `https://github.com/${owner}/${repo}`,
    truncated: entries.length > limited.length || !!(treeData && treeData.truncated),
    count: entries.length,
    tree: limited,
  };
}

function toolList() {
  return {
    tools: [
      {
        name: 'codespace_exec',
        description: 'Execute a command on an explicitly provided remote runner/codespace URL via its /exec endpoint. No hardcoded *.app.github.dev fallback. Uses redirect: "manual" to return clean errors and avoid redirect/subrequest loops.',
        inputSchema: {
          type: 'object',
          properties: {
            runnerUrl: { type: 'string', description: 'Direct runner base URL or /exec URL (required unless env CODESPACE_URL set). No implicit github.dev fallback.' },
            command: { type: 'string', description: 'Shell command to execute' },
            token: { type: 'string', description: 'Optional bearer token for runner auth' },
            cwd: { type: 'string', description: 'Optional working directory' }
          },
          required: ['runnerUrl', 'command']
        }
      },
      {
        name: 'github_repo_inspect',
        description: 'Inspect a public GitHub repository tree or fetch a file via the GitHub API. Uses User-Agent: Apex-Studio.',
        inputSchema: {
          type: 'object',
          properties: {
            repo: { type: 'string', description: 'Repository as "owner/repo" or full GitHub URL' },
            ref: { type: 'string', description: 'Branch/tag/SHA (default: HEAD/default branch)' },
            path: { type: 'string', description: 'Optional file path to fetch contents for; omit to list tree' },
            recursive: { type: 'boolean', description: 'Recursive tree listing (default: true)' },
            maxBytes: { type: 'number', description: 'Max bytes for file content (default: 200000)' }
          },
          required: ['repo']
        }
      }
    ]
  };
}

async function handleMcpOrToolCall(payload = {}, env = {}) {
  // JSON-RPC MCP style
  if (payload && payload.jsonrpc === '2.0') {
    const id = payload.id ?? null;
    const method = trim(payload.method);
    const params = payload.params && typeof payload.params === 'object' ? payload.params : {};
    if (method === 'initialize') {
      return json({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'apex-studio-worker', version: '1.0.0' } } });
    }
    if (method === 'tools/list') {
      return json({ jsonrpc: '2.0', id, result: toolList() });
    }
    if (method === 'tools/call') {
      const name = trim(params.name);
      const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
      if (name === 'codespace_exec') {
        const res = await codespaceExec(args, env);
        const body = await res.json().catch(() => ({}));
        return json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], isError: !body.ok } });
      }
      if (name === 'github_repo_inspect') {
        const body = await githubRepoInspect(args, env);
        return json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], isError: !body.ok } });
      }
      return json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${name}` } });
    }
    if (method === 'ping') return json({ jsonrpc: '2.0', id, result: {} });
    return json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }

  // Simple REST-ish tool dispatch
  const tool = trim(payload.tool || payload.name || payload.action || '');
  const args = (payload.arguments && typeof payload.arguments === 'object') ? payload.arguments : (payload.args && typeof payload.args === 'object' ? payload.args : payload);
  if (tool === 'codespace_exec' || payload.codespace_exec) {
    return await codespaceExec(tool === 'codespace_exec' ? args : (payload.codespace_exec && typeof payload.codespace_exec === 'object' ? payload.codespace_exec : payload), env);
  }
  if (tool === 'github_repo_inspect') {
    return json(await githubRepoInspect(args, env));
  }
  return null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method === 'GET' && (pathname === '/' || pathname === '/health')) {
      return json({ ok: true, service: 'apex-studio-worker', tools: toolList().tools.map(t => t.name) });
    }

    if (request.method === 'GET' && (pathname === '/tools' || pathname === '/mcp/tools')) {
      return json(toolList());
    }

    if (request.method === 'POST') {
      const payload = await readBody(request);

      // Direct endpoint: /codespace_exec or /exec
      if (pathname === '/codespace_exec' || pathname === '/exec' || pathname === '/api/exec') {
        return await codespaceExec(payload, env);
      }

      // Direct endpoint: /github_repo_inspect
      if (pathname === '/github_repo_inspect' || pathname === '/api/github_repo_inspect') {
        return json(await githubRepoInspect(payload, env));
      }

      // MCP / generic tool endpoint
      if (pathname === '/mcp' || pathname === '/tools/call' || pathname === '/' ) {
        const handled = await handleMcpOrToolCall(payload, env);
        if (handled) return handled;
      }

      // Fallback: try to infer
      const handled = await handleMcpOrToolCall(payload, env);
      if (handled) return handled;

      return json({ ok: false, error: 'Unsupported request', hint: 'POST JSON-RPC MCP to /mcp, or {tool:"codespace_exec"| "github_repo_inspect", arguments:{...}}' }, 400);
    }

    return json({ ok: false, error: 'Not found' }, 404);
  }
};
