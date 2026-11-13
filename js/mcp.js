(function () {
  const MCP = {
    connections: new Map(),
    init() {
      const btnConnect = document.getElementById('btnMcpConnect');
      const btnDiscover = document.getElementById('btnMcpDiscover');
      if (btnConnect) btnConnect.addEventListener('click', () => this.connectFromConfig());
      if (btnDiscover) btnDiscover.addEventListener('click', () => this.discoverAll());
      const cfg = AppState.mcpServers && AppState.mcpServers.length ? AppState.mcpServers : [
        { name: 'local-tools', url: 'ws://localhost:3002/mcp', transport: 'websocket' }
      ];
      const cfgInput = document.getElementById('mcpConfigInput');
      if (cfgInput) cfgInput.value = JSON.stringify(cfg, null, 2);
      this.render();
    },
    saveConfigFromUI() {
      const raw = document.getElementById('mcpConfigInput').value;
      const parsed = Utils.safeJsonParse(raw, null);
      if (!Array.isArray(parsed)) throw new Error('MCP config must be a JSON array');
      AppState.mcpServers = parsed;
      AppState.saveMcp();
      return parsed;
    },
    detectTransport(cfg) {
      const url = String(cfg && cfg.url || '').trim().toLowerCase();
      const t = String(cfg && cfg.transport || '').trim().toLowerCase();
      if (url.startsWith('ws://') || url.startsWith('wss://') || t === 'websocket' || t === 'ws') return 'websocket';
      if (url.startsWith('http://') || url.startsWith('https://') || t === 'http' || t === 'https' || t === 'streamable-http' || t === 'streamable_http' || t === 'sse') return 'http';
      if (t === 'websocket') return 'websocket';
      return url.startsWith('ws') ? 'websocket' : (url.startsWith('http') ? 'http' : 'websocket');
    },
    async connectFromConfig() {
      try {
        const servers = this.saveConfigFromUI();
        for (const s of servers) await this.connectServer(s);
        Utils.toast('MCP connect attempts completed', 'success');
      } catch (e) {
        Utils.toast(`MCP config error: ${e.message}`, 'error');
      }
      this.render();
    },
    async connectServer(cfg) {
      if (!cfg?.name || !cfg?.url) return;
      const existing = this.connections.get(cfg.name);
      if (existing?.ws) try { existing.ws.close(); } catch {}
      const transport = this.detectTransport(cfg);
      const entry = { config: cfg, ws: null, status: 'disconnected', tools: [], lastError: null, transport, sessionId: null, protocolVersion: null };
      this.connections.set(cfg.name, entry);

      if (transport === 'websocket') {
        try {
          entry.status = 'connecting';
          const ws = new WebSocket(cfg.url);
          entry.ws = ws;
          await new Promise((resolve, reject) => {
            const to = setTimeout(() => reject(new Error('connection timeout')), 5000);
            ws.onopen = () => { clearTimeout(to); resolve(); };
            ws.onerror = () => { clearTimeout(to); reject(new Error('websocket error')); };
          });
          entry.status = 'connected';
          const init = await this.rpc(cfg.name, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ApexIDE', version: '1.0' } }, 8000).catch(() => null);
          if (init && init.protocolVersion) entry.protocolVersion = init.protocolVersion;
          await this.discoverTools(cfg.name).catch(() => {});
        } catch (e) {
          entry.status = 'error';
          entry.lastError = e.message;
        }
        return;
      }

      if (transport === 'http') {
        try {
          entry.status = 'connecting';
          const init = await this.rpc(cfg.name, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ApexIDE', version: '1.0' } }, 10000);
          if (init && init.protocolVersion) entry.protocolVersion = init.protocolVersion;
          // Streamable HTTP: clients should send notifications/initialized after initialize; fire-and-forget
          this.notifyHttp(cfg.name, 'notifications/initialized', {}).catch(() => {});
          entry.status = 'connected';
          entry.lastError = null;
          await this.discoverTools(cfg.name).catch(() => {});
        } catch (e) {
          entry.status = 'error';
          entry.lastError = e.message;
        }
        return;
      }

      entry.status = 'unsupported transport';
      entry.lastError = `Browser client does not support transport: ${transport}`;
    },

    async parseHttpRpcResponse(res, id) {
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      const text = await res.text();
      const trimmed = text.trim();
      if (!trimmed) return null;

      if (ct.includes('text/event-stream') || trimmed.startsWith('event:') || trimmed.startsWith('data:')) {
        const events = trimmed.split(/\n\n+/);
        for (const ev of events) {
          const dataLines = ev.split(/\n/).filter(l => /^data:\s?/i.test(l)).map(l => l.replace(/^data:\s?/i, ''));
          if (!dataLines.length) continue;
          const dataStr = dataLines.join('\n').trim();
          if (!dataStr || dataStr === '[DONE]') continue;
          try {
            const msg = JSON.parse(dataStr);
            if (Array.isArray(msg)) {
              const found = msg.find(x => x && (id == null || x.id === id));
              if (found) return found;
            } else if (msg && (id == null || msg.id === id)) {
              return msg;
            }
          } catch {}
        }
      }

      try {
        const msg = JSON.parse(trimmed);
        if (Array.isArray(msg)) return msg.find(x => x && (id == null || x.id === id)) || msg[0] || null;
        return msg;
      } catch (e) {
        throw new Error(`Invalid JSON-RPC response: ${trimmed.slice(0, 200)}`);
      }
    },

    async rpcHttp(name, method, params = {}, timeoutMs = 12000, isNotification = false) {
      const entry = this.connections.get(name);
      if (!entry || !entry.config || !entry.config.url) throw new Error('MCP server not configured');
      const id = isNotification ? null : Utils.uid('rpc');
      const payload = isNotification ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params };
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = setTimeout(() => { try { controller && controller.abort(); } catch {} }, timeoutMs);
      try {
        const headers = {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream'
        };
        if (entry.sessionId) headers['Mcp-Session-Id'] = entry.sessionId;
        const res = await fetch(entry.config.url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: controller ? controller.signal : undefined
        });
        const sessionId = res.headers.get('mcp-session-id') || res.headers.get('Mcp-Session-Id');
        if (sessionId) entry.sessionId = sessionId;

        if (isNotification) {
          // 202 Accepted / 204 / 200 are fine for notifications
          if (!res.ok && res.status !== 202 && res.status !== 204) {
            const t = await res.text().catch(() => '');
            throw new Error(`HTTP ${res.status}${t ? ': ' + t.slice(0, 200) : ''}`);
          }
          return null;
        }

        if (!res.ok) {
          let errMsg = `HTTP ${res.status}`;
          try {
            const msg = await this.parseHttpRpcResponse(res, id);
            if (msg && msg.error) errMsg = msg.error.message || JSON.stringify(msg.error);
            else if (msg && msg.message) errMsg = msg.message;
          } catch {
            try { const t = await res.clone().text(); if (t) errMsg += ': ' + t.slice(0, 300); } catch {}
          }
          throw new Error(errMsg);
        }

        if (res.status === 202 || res.status === 204) return null;
        const msg = await this.parseHttpRpcResponse(res, id);
        if (!msg) throw new Error('Empty JSON-RPC response');
        if (msg.error) throw new Error(msg.error.message || JSON.stringify(msg.error));
        return msg.result;
      } catch (e) {
        if (e && e.name === 'AbortError') throw new Error(`RPC timeout: ${method}`);
        throw e;
      } finally {
        clearTimeout(timer);
      }
    },

    async notifyHttp(name, method, params = {}) {
      const entry = this.connections.get(name);
      if (!entry || this.detectTransport(entry.config) !== 'http') return null;
      try { return await this.rpcHttp(name, method, params, 8000, true); } catch { return null; }
    },

    rpc(name, method, params = {}, timeoutMs = 8000) {
      const entry = this.connections.get(name);
      if (!entry) return Promise.reject(new Error('MCP server not connected'));
      const transport = entry.transport || this.detectTransport(entry.config);

      if (transport === 'http') {
        return this.rpcHttp(name, method, params, timeoutMs, false);
      }

      if (!entry.ws || entry.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('MCP server not connected'));
      const id = Utils.uid('rpc');
      const payload = { jsonrpc: '2.0', id, method, params };
      return new Promise((resolve, reject) => {
        const ws = entry.ws;
        const timer = setTimeout(() => { cleanup(); reject(new Error(`RPC timeout: ${method}`)); }, timeoutMs);
        const onMsg = (ev) => {
          let msg; try { msg = JSON.parse(ev.data); } catch { return; }
          if (msg.id !== id) return;
          cleanup();
          if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else resolve(msg.result);
        };
        const onClose = () => { cleanup(); reject(new Error('Connection closed')); };
        const cleanup = () => { clearTimeout(timer); ws.removeEventListener('message', onMsg); ws.removeEventListener('close', onClose); };
        ws.addEventListener('message', onMsg);
        ws.addEventListener('close', onClose);
        ws.send(JSON.stringify(payload));
      });
    },
    async discoverTools(name) {
      const entry = this.connections.get(name);
      if (!entry) return [];
      const methods = ['tools/list', 'tools.list', 'listTools'];
      for (const m of methods) {
        try {
          const res = await this.rpc(name, m, {});
          const tools = res?.tools || res?.items || (Array.isArray(res) ? res : []);
          entry.tools = tools;
          entry.status = 'connected';
          entry.lastError = null;
          this.render();
          return tools;
        } catch (e) { entry.lastError = e.message; }
      }
      this.render();
      return entry.tools || [];
    },
    async discoverAll() {
      for (const name of this.connections.keys()) await this.discoverTools(name);
      if (!this.connections.size) Utils.toast('No MCP servers configured/connected', 'error');
      else Utils.toast('MCP tool discovery finished', 'success');
      this.render();
    },
    getAllTools() {
      const all = [];
      for (const [name, entry] of this.connections.entries()) {
        for (const t of (entry.tools || [])) all.push({ server: name, ...t });
      }
      return all;
    },
    normalizeToolArgs(args) {
      let a = args;
      if (a == null) return {};
      if (typeof a === 'string') {
        const parsed = (window.Utils && Utils.safeJsonParse) ? Utils.safeJsonParse(a, null) : null;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) a = { ...parsed };
        else return { input: a };
      }
      if (typeof a !== 'object' || Array.isArray(a)) return {};
      const out = { ...a };
      const owner = out.owner != null ? String(out.owner).trim() : (out.org != null ? String(out.org).trim() : '');
      let repo = out.repo != null ? String(out.repo).trim() : (out.repository != null ? String(out.repository).trim() : '');
      if (owner && repo && !repo.includes('/')) {
        repo = `${owner}/${repo}`;
      } else if (owner && !repo) {
        repo = owner;
      }
      if (repo) out.repo = repo;
      return out;
    },
    async callTool(serverName, toolName, args = {}) {
      const methods = ['tools/call', 'tools.call', 'callTool'];
      const cleanArgs = this.normalizeToolArgs(args);
      let lastErr = null;
      for (const m of methods) {
        try { return await this.rpc(serverName, m, { name: toolName, arguments: cleanArgs }); }
        catch (e) { lastErr = e; }
      }
      throw lastErr || new Error('Tool call failed');
    },
    render() {
      const el = document.getElementById('mcpStatus');
      if (!el) return;
      if (!this.connections.size) {
        el.textContent = 'No active connections. Save config and click Connect / Refresh.';
        return;
      }
      const lines = [];
      for (const [name, entry] of this.connections.entries()) {
        lines.push(`Server: ${name}`);
        lines.push(`  URL: ${entry.config.url}`);
        if (entry.transport) lines.push(`  Transport: ${entry.transport}`);
        lines.push(`  Status: ${entry.status}`);
        if (entry.protocolVersion) lines.push(`  Protocol: ${entry.protocolVersion}`);
        if (entry.sessionId) lines.push(`  Session: ${entry.sessionId}`);
        if (entry.lastError) lines.push(`  Last error: ${entry.lastError}`);
        lines.push(`  Tools (${(entry.tools||[]).length}):`);
        for (const t of (entry.tools || [])) {
          lines.push(`   - ${t.name || t.id || '(unnamed)'}${t.description ? ': ' + t.description : ''}`);
        }
        lines.push('');
      }
      el.textContent = lines.join('\n');
    }
  };
  window.MCP = MCP;
})();
