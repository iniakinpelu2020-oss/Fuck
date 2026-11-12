(function () {
  const Workflow = {
    nodes: [],
    edges: [],
    selectedNodeId: null,
    dragging: null,
    connectingFrom: null,
    init() {
      this.canvas = document.getElementById('workflowCanvas');
      this.svg = document.getElementById('workflowEdges');
      this.inspector = document.getElementById('nodeInspector');
      this.logEl = document.getElementById('workflowLog');

      document.querySelectorAll('.node-template').forEach(btn => {
        btn.addEventListener('click', () => this.addNode(btn.dataset.nodeType, 80 + Math.random()*120, 80 + Math.random()*120));
      });
      document.getElementById('btnWorkflowRun').addEventListener('click', () => this.runWorkflow());
      document.getElementById('btnWorkflowClear').addEventListener('click', () => { if (confirm('Clear workflow canvas?')) { this.nodes=[]; this.edges=[]; this.selectedNodeId=null; this.persist(); this.render(); this.renderInspector(); }});
      document.getElementById('btnWorkflowExport').addEventListener('click', () => Utils.download('workflow.json', JSON.stringify({ nodes: this.nodes, edges: this.edges }, null, 2)));
      this.canvas.addEventListener('click', (e) => { if (e.target === this.canvas) { this.selectedNodeId = null; this.renderSelection(); this.renderInspector(); } });
      this.canvas.addEventListener('mousemove', (e) => this.onMouseMove(e));
      window.addEventListener('mouseup', () => { this.dragging = null; });

      const saved = AppState.workflow;
      if (saved && Array.isArray(saved.nodes)) { this.nodes = saved.nodes; this.edges = saved.edges || []; }
      if (!this.nodes.length) {
        const t = this.addNode('trigger-manual', 60, 80, false);
        const a = this.addNode('action-ai', 340, 80, false);
        if (t && a) this.edges.push({ id: Utils.uid('edge'), from: t.id, to: a.id });
        this.persist();
      }
      this.render();
    },
    persist() { AppState.workflow = { nodes: this.nodes, edges: this.edges }; AppState.saveWorkflow(); },
    defaultConfig(type) {
      const map = {
        'trigger-manual': { label: 'Manual Trigger' },
        'trigger-webhook': { label: 'Webhook Trigger', path: '/hooks/run', secret: '' },
        'trigger-cron': { label: 'Cron Schedule', cron: '*/15 * * * *', note: 'Requires backend scheduler bridge for real cron execution.' },
        'trigger-file': { label: 'File Change', pattern: 'src/**/*.js' },
        'action-http': { label: 'HTTP Request', method: 'GET', url: 'https://api.example.com', headers: '{"Content-Type":"application/json"}', body: '' },
        'action-code': { label: 'Code Execution', language: 'javascript', code: "return { ok: true, activeFile: state.activeFilePath, time: new Date().toISOString() };" },
        'action-ai': { label: 'AI Agent Prompt', prompt: 'Summarize the active file and suggest improvements.', useRag: true },
        'action-terminal': { label: 'Terminal Command', command: 'npm --version' },
        'app-slack': { label: 'Slack/Webhook App', integration: '', url: '', message: 'Workflow event from Aether IDE' },
        'app-github': { label: 'GitHub API App', integration: '', endpoint: '/repos/owner/repo/issues', method: 'GET', body: '' },
        'app-custom': { label: 'Custom Integration', integration: '', payload: '{"hello":"world"}' },
      };
      return map[type] || { label: type };
    },
    addNode(type, x=60, y=60, persist=true) {
      const node = { id: Utils.uid('node'), type, x, y, config: this.defaultConfig(type) };
      this.nodes.push(node);
      if (persist) this.persist();
      this.render();
      return node;
    },
    removeNode(id) {
      this.nodes = this.nodes.filter(n => n.id !== id);
      this.edges = this.edges.filter(e => e.from !== id && e.to !== id);
      if (this.selectedNodeId === id) this.selectedNodeId = null;
      this.persist(); this.render(); this.renderInspector();
    },
    render() {
      this.canvas.innerHTML = '';
      for (const node of this.nodes) {
        const el = document.createElement('div');
        el.className = `workflow-node ${this.selectedNodeId === node.id ? 'selected' : ''}`;
        el.style.left = node.x + 'px';
        el.style.top = node.y + 'px';
        el.dataset.id = node.id;
        el.innerHTML = `
          <div class="node-header">
            <span>${Utils.escapeHtml(node.config.label || node.type)}</span>
            <button class="text-gray-400 hover:text-red-300" data-del="1" title="Delete">×</button>
          </div>
          <div class="node-body">
            <div class="text-gray-500">${Utils.escapeHtml(node.type)}</div>
            <div class="port-row">
              <div class="port-left"><span class="workflow-port" data-port="in"></span><span>in</span></div>
              <div class="port-right"><span>out</span><span class="workflow-port" data-port="out"></span></div>
            </div>
          </div>`;
        el.querySelector('[data-del]').addEventListener('click', (e) => { e.stopPropagation(); this.removeNode(node.id); });
        el.addEventListener('mousedown', (e) => this.onNodeMouseDown(e, node));
        el.addEventListener('click', (e) => { e.stopPropagation(); this.selectedNodeId = node.id; this.renderSelection(); this.renderInspector(); });
        el.querySelector('[data-port="out"]').addEventListener('mousedown', (e) => { e.stopPropagation(); this.connectingFrom = { id: node.id, startX: e.clientX, startY: e.clientY }; });
        el.querySelector('[data-port="in"]').addEventListener('mouseup', (e) => {
          e.stopPropagation();
          if (this.connectingFrom && this.connectingFrom.id !== node.id) {
            if (!this.edges.some(ed => ed.from === this.connectingFrom.id && ed.to === node.id)) {
              this.edges.push({ id: Utils.uid('edge'), from: this.connectingFrom.id, to: node.id });
              this.persist(); this.renderEdges();
            }
          }
          this.connectingFrom = null;
        });
        this.canvas.appendChild(el);
      }
      this.renderEdges();
    },
    renderSelection() {
      this.canvas.querySelectorAll('.workflow-node').forEach(el => el.classList.toggle('selected', el.dataset.id === this.selectedNodeId));
    },
    renderEdges() {
      const rect = this.canvas.getBoundingClientRect();
      const getPortPos = (nodeId, port) => {
        const el = this.canvas.querySelector(`.workflow-node[data-id="${nodeId}"] .workflow-port[data-port="${port}"]`);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left - rect.left + this.canvas.scrollLeft + r.width/2, y: r.top - rect.top + this.canvas.scrollTop + r.height/2 };
      };
      const paths = [];
      for (const edge of this.edges) {
        const a = getPortPos(edge.from, 'out'); const b = getPortPos(edge.to, 'in');
        if (!a || !b) continue;
        const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
        const d = `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
        paths.push(`<path class="edge-path" d="${d}" data-edge-id="${edge.id}"></path>`);
      }
      this.svg.innerHTML = paths.join('');
    },
    onNodeMouseDown(e, node) {
      if (e.target.closest('[data-port]') || e.target.closest('[data-del]')) return;
      const startX = e.clientX, startY = e.clientY;
      this.dragging = { id: node.id, startX, startY, origX: node.x, origY: node.y };
      this.selectedNodeId = node.id; this.renderSelection(); this.renderInspector();
    },
    onMouseMove(e) {
      if (!this.dragging) return;
      const dx = e.clientX - this.dragging.startX;
      const dy = e.clientY - this.dragging.startY;
      const node = this.nodes.find(n => n.id === this.dragging.id);
      if (!node) return;
      node.x = Math.max(0, this.dragging.origX + dx);
      node.y = Math.max(0, this.dragging.origY + dy);
      const el = this.canvas.querySelector(`.workflow-node[data-id="${node.id}"]`);
      if (el) { el.style.left = node.x + 'px'; el.style.top = node.y + 'px'; }
      this.renderEdges();
      this.persist();
    },
    renderInspector() {
      const node = this.nodes.find(n => n.id === this.selectedNodeId);
      if (!node) { this.inspector.innerHTML = '<div class="text-gray-400">Select a node to configure it.</div>'; return; }
      const cfg = node.config || {};
      const fields = Object.entries(cfg).map(([k,v]) => {
        const val = typeof v === 'string' ? v : JSON.stringify(v);
        const isLong = String(val).length > 80 || k.toLowerCase().includes('prompt') || k.toLowerCase().includes('code') || k.toLowerCase().includes('body') || k.toLowerCase().includes('payload') || k.toLowerCase().includes('headers');
        return `<label class="block mt-2 text-gray-400">${Utils.escapeHtml(k)}</label>` +
          (isLong ? `<textarea data-k="${Utils.escapeHtml(k)}" rows="4" class="w-full bg-base border border-border rounded px-2 py-1 mt-1 font-mono text-[11px]">${Utils.escapeHtml(String(val))}</textarea>`
                   : `<input data-k="${Utils.escapeHtml(k)}" class="w-full bg-base border border-border rounded px-2 py-1 mt-1" value="${Utils.escapeHtml(String(val))}" />`);
      }).join('');
      this.inspector.innerHTML = `
        <div class="text-gray-300 font-medium mb-1">${Utils.escapeHtml(node.type)}</div>
        <div class="text-[11px] text-gray-500 mb-2">ID: ${node.id}</div>
        ${fields}
        <button id="btnNodeSave" class="mt-3 w-full px-2 py-1 rounded bg-accent hover:bg-blue-600 text-white">Save Node</button>`;
      this.inspector.querySelector('#btnNodeSave').addEventListener('click', () => {
        this.inspector.querySelectorAll('[data-k]').forEach(inp => { node.config[inp.dataset.k] = inp.value; });
        this.persist(); this.render();
        Utils.toast('Node updated', 'success');
      });
    },
    log(msg) {
      const ts = new Date().toLocaleTimeString();
      this.logEl.textContent += `[${ts}] ${msg}\n`;
      this.logEl.scrollTop = this.logEl.scrollHeight;
    },
    async runWorkflow(triggerPayload = {}) {
      this.logEl.textContent = '';
      this.log('Starting workflow...');
      // find trigger nodes (or all roots)
      const incoming = new Set(this.edges.map(e => e.to));
      const starts = this.nodes.filter(n => n.type.startsWith('trigger') || !incoming.has(n.id));
      if (!starts.length) { this.log('No start/trigger nodes found.'); return; }
      const context = { trigger: triggerPayload, results: {}, state: { activeFilePath: AppState.activeFilePath } };
      const visited = new Set();
      const runNode = async (node) => {
        if (!node || visited.has(node.id)) return;
        visited.add(node.id);
        this.log(`Running: ${node.config.label || node.type} (${node.type})`);
        try {
          const result = await this.executeNode(node, context);
          context.results[node.id] = result;
          this.log(`Result: ${typeof result === 'string' ? result.slice(0, 300) : JSON.stringify(result).slice(0, 300)}`);
        } catch (e) {
          const err = { error: e.message };
          context.results[node.id] = err;
          this.log(`Error: ${e.message}`);
        }
        const nextEdges = this.edges.filter(e => e.from === node.id);
        for (const edge of nextEdges) {
          const next = this.nodes.find(n => n.id === edge.to);
          await runNode(next);
        }
      };
      for (const s of starts) await runNode(s);
      this.log('Workflow finished.');
      return context;
    },
    async executeNode(node, context) {
      const c = node.config || {};
      switch (node.type) {
        case 'trigger-manual': return { ok: true, trigger: 'manual', at: new Date().toISOString() };
        case 'trigger-webhook': return { ok: true, note: 'Webhook trigger configured; requires backend listener.', path: c.path, secret: !!c.secret };
        case 'trigger-cron': return { ok: true, note: 'Cron trigger metadata only in browser; requires backend scheduler.', cron: c.cron };
        case 'trigger-file': return { ok: true, note: 'File change trigger registered conceptually.', pattern: c.pattern, activeFile: AppState.activeFilePath };
        case 'action-http': return await this.execHttp(c);
        case 'action-code': return await this.execCode(c, context);
        case 'action-ai': return await this.execAi(c, context);
        case 'action-terminal': return await this.execTerminal(c);
        case 'app-slack':
        case 'app-github':
        case 'app-custom': return await this.execIntegration(node.type, c, context);
        default: return { ok: false, error: `Unknown node type ${node.type}` };
      }
    },
    async execHttp(c) {
      const method = (c.method || 'GET').toUpperCase();
      let headers = {}; try { headers = c.headers ? JSON.parse(c.headers) : {}; } catch { headers = {}; }
      const opts = { method, headers };
      if (!['GET','HEAD'].includes(method) && c.body) opts.body = c.body;
      const res = await fetch(c.url, opts);
      const text = await res.text();
      return { ok: res.ok, status: res.status, body: text.slice(0, 4000) };
    },
    async execCode(c, context) {
      // Run user-provided code in a constrained Function scope with explicit inputs.
      const fn = new Function('state', 'files', 'context', 'Utils', `"use strict";\n${c.code || ''}`);
      const files = Object.fromEntries([...AppState.files.values()].map(f => [f.path, f.content]));
      const state = { activeFilePath: AppState.activeFilePath, workspaceName: AppState.workspaceName };
      return await fn(state, files, context, Utils);
    },
    async execAi(c, context) {
      if (!window.Agent) throw new Error('Agent module unavailable');
      const prompt = c.prompt || 'Analyze the current workspace.';
      const response = await Agent.runPrompt(prompt, { useRag: c.useRag !== false && c.useRag !== 'false', fromWorkflow: true });
      return response;
    },
    async execTerminal(c) {
      const ok = window.TerminalPanel && TerminalPanel.runCommand(c.command || '');
      return { ok, command: c.command, note: ok ? 'Sent to connected terminal bridge' : 'Terminal bridge not connected' };
    },
    async execIntegration(type, c, context) {
      const integration = c.integration ? Integrations.getByName(c.integration) : null;
      if (type === 'app-slack') {
        const url = c.url || integration?.url;
        if (!url) return { ok: false, error: 'No webhook URL/integration configured' };
        const body = JSON.stringify({ text: c.message || 'Workflow notification', context: { activeFile: AppState.activeFilePath } });
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
        return { ok: res.ok, status: res.status };
      }
      if (type === 'app-github') {
        const token = integration?.secret || AppState.settings.githubToken;
        const base = integration?.url || 'https://api.github.com';
        const endpoint = c.endpoint || '/user';
        const method = (c.method || 'GET').toUpperCase();
        const headers = { 'Accept': 'application/vnd.github+json' };
        if (token) headers.Authorization = `Bearer ${token}`;
        const opts = { method, headers };
        if (!['GET','HEAD'].includes(method) && c.body) { opts.body = c.body; headers['Content-Type'] = 'application/json'; }
        const res = await fetch(base.replace(/\/$/, '') + endpoint, opts);
        const text = await res.text();
        return { ok: res.ok, status: res.status, body: text.slice(0, 4000) };
      }
      // custom integration: POST payload to URL if available
      const url = integration?.url || c.url;
      if (!url) return { ok: true, note: 'No URL provided; integration payload recorded.', payload: c.payload, integration: integration?.name || null };
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(integration?.secret ? { 'Authorization': `Bearer ${integration.secret}` } : {}) }, body: c.payload || '{}' });
      return { ok: res.ok, status: res.status };
    }
  };
  window.Workflow = Workflow;
})();
