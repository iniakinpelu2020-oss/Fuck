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

Autonomous tool routing (decide automatically, never require slash commands):
- Web search: when the user asks for live info, current events, docs, news, package/API details, or anything requiring web lookup, assume a web search tool will be used and answer using provided search results with cited source URLs/titles when available.
- Code & workspace: inspect provided workspace context and make changes by returning file edits in a fenced \`\`\`json:edits\`\`\` block with format:
{"edits":[{"path":"relative/path","content":"new full file content"}],"terminal":[{"command":"..."}],"notes":"short summary"}
  Prefer precise, minimal edits. Apply changes directly (auto-apply may be enabled). You may also explain normally.
- Binary/static analysis: if a binary/package is loaded or analysis is requested, use provided binary inspection findings; summarize risks, signatures, strings, and notable artifacts clearly.
- MCP/n8n/automation: when the request involves external workflows, integrations, or automation, indicate needed workflow actions clearly; the runtime may trigger configured n8n/MCP integrations automatically.

Behavior:
- Be concise, practical, and proactive.
- Do not invent file paths or results.
- If no edits are needed, use an empty edits array.
- When search results are provided, synthesize them and include sources.`,
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
