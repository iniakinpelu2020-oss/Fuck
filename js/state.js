(function () {
  const STORAGE_KEYS = {
    settings: 'aether.settings.v1',
    vault: 'aether.vault.v1',
    apiKeys: 'aether.apikeys.v1',
    mcp: 'aether.mcp.v1',
    workspaceMem: 'aether.workspace.memory.v1',
    chatSessions: 'aether.chat.sessions.v1'
  };

  const DEFAULT_N8N_WEBHOOK_URL = 'https://drippydee.app.n8n.cloud/webhook/apex-agent';

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
- MCP & n8n: configured MCP tools and n8n webhooks may be invoked automatically when relevant; you can also request them via structured actions (mcp/n8n) in json:edits when appropriate. Use results fed back into context. Built-in agent tool: \`trigger_n8n_webhook\` accepts { event, payload } and POSTs JSON { event, payload, source: "apex-ide", timestamp } to the configured n8n webhook URL, returning the JSON response.

Behavior:
- Be concise, practical, and proactive. Do not invent file paths or results.
- If no edits are needed, use an empty edits array. Keep user-facing prose clean (do not rely on users reading raw JSON).`,
    ragK: 6,
    terminalWs: 'ws://localhost:3001/terminal',
    webhookUrl: ''
  };

  const State = {
    files: new Map(), // path -> {path, content, type:'file', handle?, dirty?, binary?, meta?}
    dirs: new Set(['']),
    activeFilePath: null,
    rootHandle: null,
    workspaceName: 'Memory Workspace',
    settings: (() => { const s = Utils.safeJsonParse(localStorage.getItem(STORAGE_KEYS.settings), {}); return { ...defaultSettings, ...(s && typeof s === 'object' && !Array.isArray(s) ? s : {}) }; })(),
    vault: (() => { const v = Utils.safeJsonParse(localStorage.getItem(STORAGE_KEYS.vault), []); return Array.isArray(v) ? v : []; })(),
    apiKeys: (() => { const k = Utils.safeJsonParse(localStorage.getItem(STORAGE_KEYS.apiKeys), []); return Array.isArray(k) ? k : []; })(),
    apiKeyIndex: 0,
    mcpServers: (() => { const m = Utils.safeJsonParse(localStorage.getItem(STORAGE_KEYS.mcp), []); return Array.isArray(m) ? m : []; })(),
    chatSessions: (() => { const c = Utils.safeJsonParse(localStorage.getItem(STORAGE_KEYS.chatSessions), []); return Array.isArray(c) ? c : []; })(),
    activeChatId: (() => { const id = localStorage.getItem('aether.chat.active.v1'); return (typeof id === 'string' && id) ? id : null; })(),
    listeners: new Set(),

    ensureDefaults() {
      if (!this.settings || typeof this.settings !== 'object' || Array.isArray(this.settings)) this.settings = { ...defaultSettings };
      for (const k of Object.keys(defaultSettings)) { if (this.settings[k] == null) this.settings[k] = defaultSettings[k]; }
      if (!String(this.settings.webhookUrl || '').trim()) this.settings.webhookUrl = DEFAULT_N8N_WEBHOOK_URL;
      if (!Array.isArray(this.vault)) this.vault = [];
      if (!Array.isArray(this.apiKeys)) this.apiKeys = [];
      if (!Array.isArray(this.mcpServers)) this.mcpServers = [];
      if (!Array.isArray(this.chatSessions)) this.chatSessions = [];
    },

    subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
    emit(event, payload) { for (const fn of this.listeners) try { fn(event, payload); } catch (e) { console.error(e); } },

    saveSettings() { localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(this.settings)); },
    saveVault() { localStorage.setItem(STORAGE_KEYS.vault, JSON.stringify(this.vault)); },
    saveApiKeys(keys) { this.apiKeys = keys; localStorage.setItem(STORAGE_KEYS.apiKeys, JSON.stringify(keys)); },
    saveMcp() { localStorage.setItem(STORAGE_KEYS.mcp, JSON.stringify(this.mcpServers)); },

    // Chat session management
    saveChatSessions() { localStorage.setItem(STORAGE_KEYS.chatSessions, JSON.stringify(this.chatSessions)); },
    saveActiveChatId(id) { this.activeChatId = id; localStorage.setItem('aether.chat.active.v1', id); },

    getChat(id) { if (!Array.isArray(this.chatSessions)) this.chatSessions = []; return this.chatSessions.find(s => s.id === id) || null; },
    createChat(title = 'New chat') {
      if (!Array.isArray(this.chatSessions)) this.chatSessions = [];
      const id = `chat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const session = { id, title, pinned: false, updatedAt: Date.now(), messages: [] };
      this.chatSessions.unshift(session);
      this.saveChatSessions();
      return session;
    },
    updateChat(id, patch) {
      const s = this.getChat(id);
      if (!s) return false;
      Object.assign(s, patch, { updatedAt: Date.now() });
      this.saveChatSessions();
      return true;
    },
    deleteChat(id) {
      if (!Array.isArray(this.chatSessions)) this.chatSessions = [];
      const idx = this.chatSessions.findIndex(s => s.id === id);
      if (idx === -1) return false;
      const wasActive = this.activeChatId === id;
      this.chatSessions.splice(idx, 1);
      this.saveChatSessions();
      if (wasActive) {
        this.activeChatId = this.chatSessions.length ? this.chatSessions[0].id : null;
        localStorage.setItem('aether.chat.active.v1', this.activeChatId || '');
      }
      return true;
    },
    togglePin(id) {
      const s = this.getChat(id);
      if (!s) return false;
      s.pinned = !s.pinned;
      s.updatedAt = Date.now();
      this.saveChatSessions();
      return s.pinned;
    },
    sortedChats() {
      if (!Array.isArray(this.chatSessions)) this.chatSessions = [];
      return [...this.chatSessions].sort((a, b) => {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        return b.updatedAt - a.updatedAt;
      });
    },

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

  State.ensureDefaults();
  window.AppState = State;
  window.AETHER_STORAGE_KEYS = STORAGE_KEYS;
  window.APEX_DEFAULT_N8N_WEBHOOK_URL = DEFAULT_N8N_WEBHOOK_URL;
})();
