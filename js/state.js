(function () {
  const STORAGE_KEYS = {
    settings: 'aether.settings.v1',
    vault: 'aether.vault.v1',
    apiKeys: 'aether.apikeys.v1',
    mcp: 'aether.mcp.v1',
    workspaceMem: 'aether.workspace.memory.v1',
    chatSessions: 'aether.chat.sessions.v1',
    activeChat: 'aether.chat.active.v1'
  };

  const DEFAULT_N8N_WEBHOOK_URL = 'https://drippydee.app.n8n.cloud/webhook/apex-agent';

  const defaultSettings = {
    systemPrompt: `You are Apex, a sharp AI coding collaborator inside Apex Studio. Respond naturally and helpfully in plain English.

Conversation & context:
- Match the user's tone and intent. For greetings or casual questions (e.g. "Wagwan", "How are u"), reply like a human collaborator—no workspace summaries unless they're relevant.
- Only discuss workspace files, code, or project state when the user asks about them, provides file context, or the task requires it. Never dump or summarize starter/placeholder files (like src/index.js or notes.txt) unless explicitly relevant.
- Use workspace context when it is provided; if context is missing, ask or use available tools instead of guessing.

Capabilities (when relevant):
- Workspace & Editor: read/write virtual workspace files when requested or when performing edits.
- Execution: use a connected remote runner when available (remote terminal supports shell commands; \`npx rea\` / \`rea\` from \`rea-agents\` is available on the remote runner for reverse engineering APKs, binaries, JS bundles, WASM, and network captures); otherwise browser sandbox supports ls, cat, pwd, mkdir, touch, rm, find, grep, echo, and JavaScript via \`node -e "..."\` or \`node path/to/file.js\`. No Linux shell/package installs in browser mode—write code/files directly and use Live Preview for web apps.
- Web search: use provided Web Search Results (/api/search) for live info/docs/news and cite sources.
- Binary inspector: use provided Binary Inspection Output when present.
- MCP & n8n: use configured tools/webhooks when relevant or explicitly requested; results may be fed back into context.

Behavior:
- Be concise, practical, and proactive. Do not invent file paths, file contents, command results, or actions taken.`,
    ragK: 6,
    terminalWs: '',
    commandTimeoutSec: 600,
    webhookUrl: DEFAULT_N8N_WEBHOOK_URL || '',
    n8nWebhookUrl: DEFAULT_N8N_WEBHOOK_URL || '',
    authHeaderName: '',
    authHeaderValue: '',
    apiMode: 'managed',
    directProvider: 'gemini',
    headerPreset: '',
    localServerBaseUrl: 'http://localhost:11434/v1',
    localServerModel: '',
    agentMode: 'agent',
    attachWorkspaceContext: false
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
      if (!this.settings.apiMode) this.settings.apiMode = defaultSettings.apiMode;
      if (!this.settings.directProvider) this.settings.directProvider = defaultSettings.directProvider;
      if (this.settings.commandTimeoutSec == null) this.settings.commandTimeoutSec = defaultSettings.commandTimeoutSec;
      if (!String(this.settings.webhookUrl || '').trim()) this.settings.webhookUrl = DEFAULT_N8N_WEBHOOK_URL;
      if (!String(this.settings.localServerBaseUrl || '').trim()) this.settings.localServerBaseUrl = defaultSettings.localServerBaseUrl;
      if (this.settings.localServerModel == null) this.settings.localServerModel = '';
      if (this.settings.headerPreset == null) this.settings.headerPreset = '';
      if (!['chat', 'agent', 'edit'].includes(String(this.settings.agentMode || '').toLowerCase())) this.settings.agentMode = 'agent';
      else this.settings.agentMode = String(this.settings.agentMode || 'agent').toLowerCase();
      if (typeof this.settings.attachWorkspaceContext !== 'boolean') this.settings.attachWorkspaceContext = false;
      if (!Array.isArray(this.vault)) this.vault = [];
      if (!Array.isArray(this.apiKeys)) this.apiKeys = [];
      if (!Array.isArray(this.mcpServers)) this.mcpServers = [];
      if (!Array.isArray(this.chatSessions)) this.chatSessions = [];
      this.sanitizeChatSessions();
      if (!String(this.settings.webhookUrl || '').trim()) this.settings.webhookUrl = DEFAULT_N8N_WEBHOOK_URL;
      if (!String(this.settings.n8nWebhookUrl || '').trim()) this.settings.n8nWebhookUrl = this.settings.webhookUrl;
      const hasUrl = (u) => this.mcpServers.some(x => x && String(x.url||'').replace(/\/$/,'') === u.replace(/\/$/,''));
      if (!hasUrl('https://fuck.iniakinpelu2020.workers.dev')) this.mcpServers.unshift({ name: 'apex-mcp', url: 'https://fuck.iniakinpelu2020.workers.dev', transport: 'http' });
      if (!hasUrl('https://fuck.iniakinpelu2020.workers.dev/n8n-mcp')) this.mcpServers.push({ name: 'n8n-mcp', url: 'https://fuck.iniakinpelu2020.workers.dev/n8n-mcp', transport: 'http' });
    },

    isWelcomeMessage(msg) {
      if (!msg || msg.role !== 'assistant') return false;
      const c = String(msg.content || '');
      return /^Hi — I'm Apex\b/.test(c) && c.includes('your autonomous agent');
    },

    sanitizeChatMessages(msgs) {
      const arr = Array.isArray(msgs) ? msgs : [];
      const out = [];
      for (let i = 0; i < arr.length; i++) {
        const m = arr[i];
        if (!m || typeof m !== 'object') continue;
        if (this.isWelcomeMessage(m)) continue;
        // Strip dangling assistant tool_calls with no matching tool response before next user/assistant boundary
        if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
          const ids = new Set(m.tool_calls.map(tc => tc && (tc.id || tc.tool_call_id)).filter(Boolean));
          const answered = new Set();
          for (let j = i + 1; j < arr.length; j++) {
            const t = arr[j];
            if (!t || typeof t !== 'object') continue;
            if (t.role === 'tool' && (t.tool_call_id || t.id)) answered.add(t.tool_call_id || t.id);
            if (t.role === 'assistant' || t.role === 'user' || t.role === 'system') break;
          }
          const filteredCalls = m.tool_calls.filter(tc => tc && answered.has(tc.id || tc.tool_call_id));
          if (filteredCalls.length === 0) {
            const copy = { ...m };
            delete copy.tool_calls;
            delete copy.function_call;
            out.push(copy);
          } else if (filteredCalls.length !== m.tool_calls.length) {
            out.push({ ...m, tool_calls: filteredCalls });
          } else {
            out.push(m);
          }
          continue;
        }
        // Drop orphan tool messages not matched by a preceding assistant tool_call in kept output
        if (m.role === 'tool') {
          let hasParent = false;
          for (let k = out.length - 1; k >= 0; k--) {
            const p = out[k];
            if (!p || typeof p !== 'object') continue;
            if (p.role === 'assistant' && Array.isArray(p.tool_calls)) {
              hasParent = p.tool_calls.some(tc => tc && (tc.id || tc.tool_call_id) === (m.tool_call_id || m.id));
              break;
            }
            if (p.role === 'user' || p.role === 'system') break;
          }
          if (!hasParent) continue;
        }
        out.push(m);
      }
      return out;
    },

    sanitizeChatSessions() {
      if (!Array.isArray(this.chatSessions)) this.chatSessions = [];
      let changed = false;
      for (const session of this.chatSessions) {
        if (!session || !Array.isArray(session.messages)) continue;
        const filtered = this.sanitizeChatMessages(session.messages);
        if (filtered.length !== session.messages.length) {
          session.messages = filtered;
          changed = true;
        } else {
          for (let i = 0; i < filtered.length; i++) { if (filtered[i] !== session.messages[i]) { session.messages = filtered; changed = true; break; } }
        }
      }
      if (changed) {
        try { localStorage.setItem(STORAGE_KEYS.chatSessions, JSON.stringify(this.chatSessions || [])); } catch {}
      }
      return changed;
    },

    subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
    emit(event, payload) { for (const fn of this.listeners) try { fn(event, payload); } catch (e) { console.error(e); } },

    saveSettings() { localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(this.settings)); this.emit('settings:changed'); if (window.FirebaseSync && FirebaseSync.user) try { FirebaseSync.pushConfig(); } catch {} },
    saveVault() { localStorage.setItem(STORAGE_KEYS.vault, JSON.stringify(this.vault)); if (window.FirebaseSync && FirebaseSync.user) try { FirebaseSync.pushConfig(); } catch {} },
    saveApiKeys(keys) { this.apiKeys = keys; localStorage.setItem(STORAGE_KEYS.apiKeys, JSON.stringify(keys)); if (window.FirebaseSync && FirebaseSync.user) try { FirebaseSync.pushConfig(); } catch {} },
    saveMcp() { localStorage.setItem(STORAGE_KEYS.mcp, JSON.stringify(this.mcpServers)); this.emit('mcp:changed'); if (window.FirebaseSync && FirebaseSync.user) try { FirebaseSync.pushConfig(); } catch {} },

    // Chat session management
    saveChatSessions() {
      try { this.sanitizeChatSessions(); } catch {}
      try { localStorage.setItem(STORAGE_KEYS.chatSessions, JSON.stringify(this.chatSessions || [])); } catch (e) { console.error('saveChatSessions failed', e); }
      this.emit('chats:changed');
    },
    saveActiveChatId(id) { this.activeChatId = id; try { localStorage.setItem('aether.chat.active.v1', id || ''); } catch {} this.emit('chat:active', { id }); },

    getChat(id) { if (!Array.isArray(this.chatSessions)) this.chatSessions = []; return this.chatSessions.find(s => s.id === id) || null; },
    getActiveChat() { return this.getChat(this.activeChatId); },
    createChat(title = 'New chat') {
      if (!Array.isArray(this.chatSessions)) this.chatSessions = [];
      const id = `chat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const session = { id, title, pinned: false, updatedAt: Date.now(), messages: [] };
      this.chatSessions.unshift(session);
      this.saveActiveChatId(id);
      this.saveChatSessions();
      if (window.FirebaseSync && FirebaseSync.user) try { FirebaseSync.pushChat(session); } catch {}
      return session;
    },
    updateChat(id, patch) {
      const session = this.getChat(id);
      if (!session) return false;
      Object.assign(session, patch, { updatedAt: Date.now() });
      this.saveChatSessions();
      if (window.FirebaseSync && FirebaseSync.user) try { FirebaseSync.pushChat(session); } catch {}
      return true;
    },
    deleteChat(id) {
      if (!Array.isArray(this.chatSessions)) this.chatSessions = [];
      const idx = this.chatSessions.findIndex(s => s.id === id);
      if (idx === -1) return false;
      const wasActive = this.activeChatId === id;
      this.chatSessions.splice(idx, 1);
      this.saveChatSessions();
      if (window.FirebaseSync && FirebaseSync.user) try { FirebaseSync.deleteChat(id); } catch {}
      if (wasActive) {
        this.activeChatId = this.chatSessions.length ? this.chatSessions[0].id : null;
        this.saveActiveChatId(this.activeChatId || '');
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
