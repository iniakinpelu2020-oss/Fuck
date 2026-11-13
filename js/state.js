(function () {
  const STORAGE_KEYS = {
    settings: 'aether.settings.v1',
    vault: 'aether.vault.v1',
    apiKeys: 'aether.apikeys.v1',
    mcp: 'aether.mcp.v1',
    workspaceMem: 'aether.workspace.memory.v1'
  };

  const defaultSettings = {
    systemPrompt: `You are Apex, an autonomous coding and workspace agent inside Apex IDE. Act decisively and helpfully in plain English.

Runtime & tool loop (browser-native, zero-config):
- Workspace & Editor: you have live read/write access to the virtual workspace via provided context. Create, update, or open files by returning a fenced \`\`\`json:edits\`\`\` block:
{"edits":[{"path":"relative/path","content":"new full file content"}],"terminal":[{"command":"..."}],"notes":"short summary"}
  Prefer precise, minimal edits. RAG auto-indexes when files change. You may also explain normally.
- Built-in execution (no "Terminal not connected" errors):
  - If a remote Terminal/Runner is connected (configured in Settings), commands may run there.
  - Otherwise commands run in-browser against the virtual workspace: supported directly are ls, cat, pwd, mkdir, touch, rm, find, grep, echo, and JavaScript via \`node -e "..."\` or \`node path/to/file.js\` (sandboxed Web Worker; console output/errors are returned).
  - For npm/npx/pip/python/bash or system package installs: there is NO Linux shell in browser mode. Do NOT rely on shell installs; instead write the code directly in workspace files, run JS with node, and for web apps create HTML/CSS/JS and the Live Preview will render it.
- Web search: when live info/docs/news/current details are needed, use provided Web Search Results (/api/search) and synthesize with cited source URLs/titles.
- Binary inspector: when a binary is loaded or analysis is requested, use provided Binary Inspection Output (headers, signatures, strings, findings, hex) in context.
- MCP & n8n: configured MCP tools and n8n webhooks may be invoked automatically when relevant; you can also request them via structured actions (mcp/n8n) in json:edits when appropriate. Use results fed back into context.

Behavior:
- Be concise, practical, and proactive. Do not invent file paths or results.
- If no edits are needed, use an empty edits array. Keep user-facing prose clean (do not rely on users reading raw JSON).`,
    ragK: 6,
    terminalWs: 'ws://localhost:3001/terminal',
    webhookUrl: '',
    githubToken: ''
  };

  const State = {
    files: new Map(), // path -> {path, content, type:'file', handle?, dirty?, binary?, meta?}
    dirs: new Set(['']),
    activeFilePath: null,
    rootHandle: null,
    workspaceName: 'Memory Workspace',
    settings: { ...defaultSettings, ...(Utils.safeJsonParse(localStorage.getItem(STORAGE_KEYS.settings), {}) || {}) },
    vault: Utils.safeJsonParse(localStorage.getItem(STORAGE_KEYS.vault), []) || [],
    apiKeys: Utils.safeJsonParse(localStorage.getItem(STORAGE_KEYS.apiKeys), []) || [],
    apiKeyIndex: 0,
    mcpServers: Utils.safeJsonParse(localStorage.getItem(STORAGE_KEYS.mcp), []) || [],
    listeners: new Set(),

    subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
    emit(event, payload) { for (const fn of this.listeners) try { fn(event, payload); } catch (e) { console.error(e); } },

    saveSettings() { localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(this.settings)); },
    saveVault() { localStorage.setItem(STORAGE_KEYS.vault, JSON.stringify(this.vault)); },
    saveApiKeys(keys) { this.apiKeys = keys; localStorage.setItem(STORAGE_KEYS.apiKeys, JSON.stringify(keys)); },
    saveMcp() { localStorage.setItem(STORAGE_KEYS.mcp, JSON.stringify(this.mcpServers)); },

    resetWorkspaceMemory() {
      this.files.clear(); this.dirs = new Set(['']); this.activeFilePath = null; this.rootHandle = null; this.workspaceName = 'Memory Workspace';
      this.emit('workspace:reset');
    },
    ensureDir(path) {
      if (!path) { this.dirs.add(''); return; }
      const parts = path.split('/').filter(Boolean);
      let cur = '';
      for (const p of parts) { cur = cur ? `${cur}/${p}` : p; this.dirs.add(cur); }
      this.dirs.add('');
    },
    upsertFile(path, content = '', extra = {}) {
      this.ensureDir(Utils.dirname(path));
      const prev = this.files.get(path) || {};
      this.files.set(path, { ...prev, path, content, type: 'file', dirty: !!extra.dirty, ...extra });
      this.emit('file:changed', { path });
    },
    deletePath(path) {
      for (const k of Array.from(this.files.keys())) {
        if (k === path || k.startsWith(path + '/')) this.files.delete(k);
      }
      for (const d of Array.from(this.dirs)) {
        if (d === path || d.startsWith(path + '/')) this.dirs.delete(d);
      }
      if (this.activeFilePath && (this.activeFilePath === path || this.activeFilePath.startsWith(path + '/'))) {
        this.activeFilePath = this.files.keys().next().value || null;
      }
      this.emit('workspace:changed');
    },
    listPaths() {
      return [...this.dirs].filter(d => d !== '').map(d => ({ path: d, type: 'dir' }))
        .concat([...this.files.values()].map(f => ({ path: f.path, type: 'file' })))
        .sort((a,b) => a.path.localeCompare(b.path));
    },
    getActiveFile() { return this.activeFilePath ? this.files.get(this.activeFilePath) : null; },
    setActiveFile(path) { this.activeFilePath = path; this.emit('file:active', { path }); },

    exportMemoryWorkspace() {
      const obj = { name: this.workspaceName, files: [...this.files.values()].map(f => ({ path: f.path, content: f.content })) };
      localStorage.setItem(STORAGE_KEYS.workspaceMem, JSON.stringify(obj));
    },
    importMemoryWorkspace() {
      const obj = Utils.safeJsonParse(localStorage.getItem(STORAGE_KEYS.workspaceMem), null);
      if (!obj) return false;
      this.resetWorkspaceMemory();
      this.workspaceName = obj.name || 'Memory Workspace';
      for (const f of (obj.files||[])) this.upsertFile(f.path, f.content || '');
      this.emit('workspace:changed');
      return true;
    }
  };

  window.AppState = State;
  window.AETHER_STORAGE_KEYS = STORAGE_KEYS;
})();
