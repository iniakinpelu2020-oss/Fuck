(function () {
  const MCP = {
    connections: new Map(), // name -> {config, ws, status, tools, lastError}
    init() {
      document.getElementById('btnMcpConnect').addEventListener('click', () => this.connectFromConfig());
      document.getElementById('btnMcpDiscover').addEventListener('click', () => this.discoverAll());
      const cfg = AppState.mcpServers && AppState.mcpServers.length ? AppState.mcpServers : [
        { name: 'local-tools', url: 'ws://localhost:3002/mcp', transport: 'websocket' }
      ];
      document.getElementById('mcpConfigInput').value = JSON.stringify(cfg, null, 2);
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
      const entry = { config: cfg, ws: null, status: 'disconnected', tools: [], lastError: null };
      this.connections.set(cfg.name, entry);
      if ((cfg.transport || 'websocket') !== 'websocket') {
        entry.status = 'unsupported transport';
        entry.lastError = 'Browser client supports websocket transport in this implementation.';
        return;
      }
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
        // optional initialize handshake
        await this.rpc(cfg.name, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'AetherIDE', version: '1.0' } }, 4000).catch(()=>null);
        await this.discoverTools(cfg.name).catch(()=>{});
      } catch (e) {
        entry.status = 'error';
        entry.lastError = e.message;
      }
    },
    rpc(name, method, params = {}, timeoutMs = 8000) {
      const entry = this.connections.get(name);
      if (!entry?.ws || entry.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('MCP server not connected'));
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
    async callTool(serverName, toolName, args = {}) {
      const methods = ['tools/call', 'tools.call', 'callTool'];
      let lastErr = null;
      for (const m of methods) {
        try { return await this.rpc(serverName, m, { name: toolName, arguments: args }); }
        catch (e) { lastErr = e; }
      }
      throw lastErr || new Error('Tool call failed');
    },
    render() {
      const el = document.getElementById('mcpStatus');
      if (!this.connections.size) {
        el.textContent = 'No active connections. Save config and click Connect / Refresh.';
        return;
      }
      const lines = [];
      for (const [name, entry] of this.connections.entries()) {
        lines.push(`Server: ${name}`);
        lines.push(`  URL: ${entry.config.url}`);
        lines.push(`  Status: ${entry.status}`);
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
