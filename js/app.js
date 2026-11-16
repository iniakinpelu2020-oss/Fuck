(function () {
  const App = {
    init() {
      this.bindTabs();
      this.bindHeader();
      this.bindSettings();
      this.bindMobile();
      this.bindDownloadApp();
      this.restoreSettingsUI();
      // Default Attach Workspace Context to unchecked on load
      try {
        if (AppState.settings) AppState.settings.attachWorkspaceContext = false;
        const ac = document.getElementById('agentAttachWorkspaceContext') || document.getElementById('attachWorkspaceContext');
        if (ac) ac.checked = false;
        if (typeof AppState.saveSettings === 'function') AppState.saveSettings();
      } catch {}

      FileTree.init();
      Editor.init();
      TerminalPanel.init();
      BinaryInspector.init();
      RAG.init();
      MCP.init();
      Integrations.init();
      if (window.Workspace && Workspace.init) Workspace.init();
      Agent.init();
      try { if (window.FirebaseSync && typeof FirebaseSync.init === 'function') FirebaseSync.init(); } catch(e) { console.error('Firebase init', e); }

      // Chat history: always start a fresh page load on a new blank chat unless URL specifies one
      this.bindChatHistory();
      this.renderChatHistory();
      const requestedChatId = (() => {
        try {
          const url = new URL(window.location.href);
          const q = (url.searchParams.get('chat') || url.searchParams.get('chatId') || '').trim();
          if (q) return q;
          const hash = String(url.hash || '').replace(/^#/, '').trim();
          if (!hash) return '';
          const hp = new URLSearchParams(hash);
          const hq = (hp.get('chat') || hp.get('chatId') || '').trim();
          if (hq) return hq;
          // also accept direct hash id form like #chat_<id>
          if (/^chat_[a-z0-9_]+$/i.test(hash)) return hash;
          return '';
        } catch { return ''; }
      })();
      if (requestedChatId && AppState.getChat(requestedChatId)) {
        AppState.saveActiveChatId(requestedChatId);
      } else {
        // Fresh load/new tab: initialize a brand-new empty chat session (keep history intact)
        const fresh = AppState.createChat('New chat');
        AppState.saveActiveChatId(fresh.id);
      }
      this.renderChatHistory();
      this.loadActiveChat();

      if (AppState.files.size === 0) {
        AppState.workspaceName = 'Workspace';
        AppState.activeFilePath = null;
        AppState.emit('workspace:changed');
      } else {
        AppState.setActiveFile(AppState.activeFilePath || AppState.files.keys().next().value || null);
      }

      // Sync runner UI from saved settings (no hardcoded defaults)
      const savedTerminalUrl = (AppState.settings && AppState.settings.terminalWs != null) ? String(AppState.settings.terminalWs).trim() : '';
      const tws = document.getElementById('terminalWsUrl');
      if (tws) tws.value = savedTerminalUrl;
      this.bindPreview();
      this.bindKeyboardViewport();
      this.syncWorkspaceLabels();
      AppState.subscribe((evt, payload) => {
        if (evt === 'workspace:changed' || evt === 'workspace:reset') this.syncWorkspaceLabels();
        if (evt === 'file:active') this.onAgentFileActivity(payload?.path);
        if (evt === 'file:changed') this.onAgentFileActivity(payload?.path, true);
      });
      window.addEventListener('resize', () => this.applyView(this.currentView || 'agent'));
      this.currentView = 'agent';
      this.currentMobilePane = 'right';
      this.applyView('agent');
      Utils.toast('Apex Studio ready', 'success');
    },

    isMobile() { return window.innerWidth <= 900; },

    syncWorkspaceLabels() {
      const text = AppState.workspaceName || 'No folder opened';
      const label = document.getElementById('workspaceLabel');
      const mirror = document.getElementById('workspaceLabelMirror');
      if (label) label.textContent = text;
      if (mirror) mirror.textContent = text;
    },

    bindPreview() {
      const refresh = document.getElementById('btnPreviewRefresh');
      const close = document.getElementById('btnPreviewClose');
      if (refresh) refresh.addEventListener('click', () => this.renderPreview());
      if (close) close.addEventListener('click', () => this.hidePreview());
    },
    hidePreview() {
      const pane = document.getElementById('previewPane');
      if (pane) pane.classList.add('hidden');
      const status = document.getElementById('previewStatus');
      if (status) status.textContent = 'idle';
    },
    resolveWorkspacePath(basePath, ref) {
      if (!ref) return '';
      const r = String(ref).trim();
      if (/^(https?:|data:|blob:|mailto:|#)/i.test(r)) return null;
      const clean = r.split('#')[0].split('?')[0];
      if (!clean) return null;
      if (clean.startsWith('/')) return clean.replace(/^\/+/, '');
      const baseDir = basePath && basePath.includes('/') ? basePath.slice(0, basePath.lastIndexOf('/')) : '';
      const parts = (baseDir ? baseDir + '/' : '') + clean;
      const segs = [];
      for (const part of parts.split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') segs.pop(); else segs.push(part);
      }
      return segs.join('/');
    },
    buildPreviewHtml(entryPath) {
      let path = entryPath || (AppState.activeFilePath && /\.html?$/i.test(AppState.activeFilePath) ? AppState.activeFilePath : null);
      if (!path) {
        // prefer index.html in root or common locations
        const candidates = ['index.html', 'public/index.html', 'src/index.html', 'app/index.html', 'www/index.html'];
        path = candidates.find(p => AppState.files.has(p)) || [...AppState.files.keys()].find(p => /(^|\/)index\.html$/i.test(p));
      }
      if (!path || !AppState.files.has(path)) return null;
      let html = String(AppState.files.get(path).content || '');
      const replaceCss = (match, pre, href, post) => {
        const resolved = this.resolveWorkspacePath(path, href);
        if (!resolved || !AppState.files.has(resolved)) return match;
        const css = String(AppState.files.get(resolved).content || '');
        return `<style data-preview-src="${Utils.escapeHtml(resolved)}">${css}</style>`;
      };
      html = html.replace(/(<link[^>]+href=["'])([^"']+)(["'][^>]*>)/gi, (m, pre, href, post) => {
        if (!/rel=["']?stylesheet["']?/i.test(m) && !/\.css(\?|#|$)/i.test(href)) return m;
        return replaceCss(m, pre, href, post);
      });
      html = html.replace(/(<script[^>]+src=["'])([^"']+)(["'][^>]*>\s*<\/script>)/gi, (m, pre, src, post) => {
        if (/\btype=["']module["']/i.test(m)) return m; // modules in srcdoc are tricky; leave as-is
        const resolved = this.resolveWorkspacePath(path, src);
        if (!resolved || !AppState.files.has(resolved)) return m;
        const js = String(AppState.files.get(resolved).content || '').replace(/<\/script>/gi, '<\\/script>');
        return `<script data-preview-src="${Utils.escapeHtml(resolved)}">${js}<\/script>`;
      });
      return { path, html };
    },
    renderPreview(entryPath) {
      const pane = document.getElementById('previewPane');
      const frame = document.getElementById('previewFrame');
      const status = document.getElementById('previewStatus');
      if (!pane || !frame) return false;
      const built = this.buildPreviewHtml(entryPath);
      if (!built) {
        Utils.toast('No HTML file found to preview', 'error');
        if (status) status.textContent = 'no html';
        return false;
      }
      frame.srcdoc = built.html;
      pane.classList.remove('hidden');
      if (status) status.textContent = built.path;
      this.setView('editor');
      Utils.toast(`Preview: ${built.path}`, 'success');
      return true;
    },

    bindKeyboardViewport() {
      const wrap = document.getElementById('agentComposerWrap');
      if (!wrap || !window.visualViewport) return;
      const onResize = () => {
        if (!this.isMobile()) { wrap.style.paddingBottom = ''; return; }
        const vv = window.visualViewport;
        const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
        // keep above mobile nav (4.75rem) and keyboard when open
        if (kb > 80) {
          wrap.style.paddingBottom = `calc(${Math.round(kb)}px + env(safe-area-inset-bottom, 0px))`;
        } else {
          wrap.style.paddingBottom = '';
        }
        const cm = document.getElementById('chatMessages');
        if (cm) cm.scrollTop = cm.scrollHeight;
      };
      window.visualViewport.addEventListener('resize', onResize);
      window.visualViewport.addEventListener('scroll', onResize);
      window.addEventListener('resize', onResize);
    },

    bindTabs() {
      document.querySelectorAll('.left-tab').forEach(btn => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('.left-tab').forEach(b => { b.classList.remove('bg-gray-800'); b.classList.remove('active'); });
          btn.classList.add('bg-gray-800');
          btn.classList.add('active');
          const tab = btn.dataset.leftTab;
          document.querySelectorAll('.left-tab-panel').forEach(p => p.classList.add('hidden'));
          const panel = document.getElementById(`tab-${tab}`);
          if (panel) panel.classList.remove('hidden');
        });
      });
      document.querySelectorAll('.right-tab').forEach(btn => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('.right-tab').forEach(b => { b.classList.remove('bg-gray-800'); b.classList.remove('active'); });
          btn.classList.add('bg-gray-800');
          btn.classList.add('active');
          const tab = btn.dataset.rightTab;
          document.querySelectorAll('.right-tab-panel').forEach(p => p.classList.add('hidden'));
          const panel = document.getElementById(`tab-${tab}`);
          if (panel) panel.classList.remove('hidden');
        });
      });
    },

    bindHeader() {
      const btnTerminal = document.getElementById('btnToggleTerminal');
      if (btnTerminal) btnTerminal.addEventListener('click', () => {
        this.setView('editor');
        if (window.TerminalPanel && TerminalPanel.toggle) TerminalPanel.toggle();
      });
      const btnExplorer = document.getElementById('btnPanelExplorer');
      const btnAgent = document.getElementById('btnPanelAgent');
      if (btnExplorer) btnExplorer.addEventListener('click', () => this.setView('workspace'));
      if (btnAgent) btnAgent.addEventListener('click', () => this.setView('agent'));
      const btnOpenSettings = document.getElementById('btnOpenSettings');
      if (btnOpenSettings) btnOpenSettings.addEventListener('click', () => this.openSettings());
      const btnNewChatTop = document.getElementById('btnNewChat');
      if (btnNewChatTop && !btnNewChatTop.dataset.boundNewChat) {
        btnNewChatTop.dataset.boundNewChat = '1';
        btnNewChatTop.addEventListener('click', () => {
          const newBtn = document.getElementById('btnDrawerNewChat');
          if (newBtn) newBtn.click(); else this.createNewChat();
        });
      }

      // Workspace multi-file upload
      const wsBtn = document.getElementById('btnUploadWorkspaceFiles');
      const wsInput = document.getElementById('workspaceFileUploadInput');
      if (wsBtn && wsInput && !wsBtn.dataset.boundUpload) {
        wsBtn.dataset.boundUpload = '1';
        wsBtn.addEventListener('click', () => wsInput.click());
      }
      if (wsInput && !wsInput.dataset.boundUpload) {
        wsInput.dataset.boundUpload = '1';
        wsInput.addEventListener('change', async () => {
          try {
            if (wsInput.files && wsInput.files.length && window.Workspace && Workspace.handleFiles) {
              await Workspace.handleFiles(wsInput.files, { attachToChat: false, source: 'workspace-upload' });
            }
          } finally {
            wsInput.value = '';
          }
        });
      }

      // Agent mode selector (Chat / Agent / Edit)
      const modeSel = document.getElementById('agentModeSelect');
      if (modeSel && !modeSel.dataset.boundMode) {
        modeSel.dataset.boundMode = '1';
        modeSel.addEventListener('change', () => {
          const v = String(modeSel.value || 'agent').toLowerCase();
          AppState.settings.agentMode = ['chat', 'agent', 'edit'].includes(v) ? v : 'agent';
          AppState.saveSettings();
        });
      }
      // sync initial
      if (modeSel) {
        const m = String((AppState.settings && AppState.settings.agentMode) || 'agent').toLowerCase();
        modeSel.value = ['chat', 'agent', 'edit'].includes(m) ? m : 'agent';
      }

      // Header quick model switcher
      this.bindHeaderModelSwitcher();
    },

    /* ---------- Header Model Quick Switch ---------- */
    HEADER_PRESETS: {
      'managed-qwen': { label: 'Managed Workers AI (Qwen 2.5 Coder 32B)', type: 'managed', model: '@cf/qwen/qwen2.5-coder-32b-instruct' },
      'managed-llama': { label: 'Managed Workers AI (Llama 3.3 70B Fast)', type: 'managed', model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' },
      'local': { label: 'Local Server (localhost / Custom Tunnel)', type: 'local' }
    },

    normalizeLocalBaseUrl(url) {
      let u = String(url || '').trim();
      if (!u) return 'http://localhost:11434/v1';
      u = u.replace(/\s+/g, '');
      // keep trailing slash handling consistent for base building
      return u.replace(/\/+$/, '');
    },

    getLocalModelsUrl() {
      const s = (window.AppState && AppState.settings) ? AppState.settings : {};
      let base = this.normalizeLocalBaseUrl(s.localServerBaseUrl || 'http://localhost:11434/v1');
      // common forms: http://host:11434/v1, http://host:11434, http://host:11434/v1/chat/completions
      base = base.replace(/\/chat\/completions$/i, '');
      if (/\/models$/i.test(base)) return base;
      if (/\/v1$/i.test(base)) return base + '/models';
      return base + '/v1/models';
    },

    inferHeaderPresetFromSettings() {
      const s = (window.AppState && AppState.settings) ? AppState.settings : {};
      const p = String(s.headerPreset || '').trim();
      if (p && this.HEADER_PRESETS[p]) return p;
      const mode = String(s.apiMode || 'managed').toLowerCase();
      const model = String(s.agentModel || '').trim();
      const endpoint = String(s.agentEndpoint || '').trim();
      if (mode === 'managed' && !endpoint) {
        if (model === '@cf/meta/llama-3.3-70b-instruct-fp8-fast') return 'managed-llama';
        if (!model || model === '@cf/qwen/qwen2.5-coder-32b-instruct') return 'managed-qwen';
        // custom managed model via settings -> default to qwen preset selection but don't force overwrite
        return 'managed-qwen';
      }
      if (mode === 'direct' && String(s.directProvider || '').toLowerCase() === 'custom') return 'local';
      return 'managed-qwen';
    },

    setHeaderStatus(state, title) {
      const dot = document.getElementById('headerModelStatusDot');
      if (!dot) return;
      dot.classList.remove('ok', 'bad', 'checking', 'neutral');
      dot.classList.add(state || 'neutral');
      if (title) dot.setAttribute('title', title);
    },

    syncHeaderModelUI() {
      const s = (window.AppState && AppState.settings) ? AppState.settings : {};
      const preset = this.inferHeaderPresetFromSettings();
      const presetSel = document.getElementById('headerModelPreset');
      const localSel = document.getElementById('headerLocalModelSelect');
      if (presetSel && presetSel.value !== preset) presetSel.value = preset;
      if (localSel) {
        const isLocal = preset === 'local';
        localSel.classList.toggle('hidden', !isLocal);
        const savedModel = String(s.localServerModel || s.agentModel || '').trim();
        if (isLocal && savedModel) {
          const has = [...localSel.options].some(o => o.value === savedModel);
          if (!has) {
            const opt = document.createElement('option');
            opt.value = savedModel;
            opt.textContent = savedModel;
            localSel.appendChild(opt);
          }
          localSel.value = savedModel;
        }
      }
    },

    async applyHeaderPreset(presetId, opts = {}) {
      const preset = this.HEADER_PRESETS[presetId] || this.HEADER_PRESETS['managed-qwen'];
      const s = AppState.settings || (AppState.settings = {});
      s.headerPreset = presetId;
      if (preset.type === 'managed') {
        s.apiMode = 'managed';
        s.agentEndpoint = '';
        s.agentProvider = 'openai-compatible';
        s.agentModel = preset.model || '';
      } else if (preset.type === 'local') {
        s.apiMode = 'direct';
        s.directProvider = 'custom';
        s.agentProvider = 'openai-compatible';
        s.localServerBaseUrl = this.normalizeLocalBaseUrl(s.localServerBaseUrl || 'http://localhost:11434/v1');
        s.agentEndpoint = s.localServerBaseUrl;
        // keep previously selected local model if any; if empty, leave blank until /v1/models loads
        if (s.localServerModel) s.agentModel = s.localServerModel;
      }
      AppState.saveSettings();
      this.restoreSettingsUI();
      this.syncHeaderModelUI();
      if (window.Agent) {
        try { if (typeof Agent.persistAgentSettings === 'function') Agent.persistAgentSettings(); } catch {}
        try { if (typeof Agent.updateKeyStatus === 'function') Agent.updateKeyStatus(); } catch {}
      }
      if (opts.check !== false) await this.refreshHeaderModelStatus({ reloadLocalModels: preset.type === 'local' });
    },

    async fetchLocalModels() {
      const url = this.getLocalModelsUrl();
      const res = await fetch(url, { method: 'GET', cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json().catch(() => ({}));
      let models = [];
      if (Array.isArray(data)) models = data;
      else if (Array.isArray(data?.data)) models = data.data;
      else if (Array.isArray(data?.models)) models = data.models;
      else if (Array.isArray(data?.result?.data)) models = data.result.data;
      const ids = [];
      const seen = new Set();
      for (const m of models) {
        let id = '';
        if (typeof m === 'string') id = m;
        else if (m && typeof m === 'object') id = m.id || m.name || m.model || '';
        id = String(id || '').trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
      }
      return ids;
    },

    populateLocalModelSelect(models, opts = {}) {
      const sel = document.getElementById('headerLocalModelSelect');
      if (!sel) return;
      const s = (window.AppState && AppState.settings) ? AppState.settings : {};
      const prev = String(s.localServerModel || s.agentModel || sel.value || '').trim();
      sel.innerHTML = '';
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = models && models.length ? 'Select local model…' : 'No local models found';
      sel.appendChild(placeholder);
      for (const id of (models || [])) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = id;
        sel.appendChild(opt);
      }
      const chosen = (models || []).includes(prev) ? prev : ((models || [])[0] || '');
      if (chosen) sel.value = chosen;
      if (opts.applySelection) {
        if (chosen) {
          s.localServerModel = chosen;
          s.agentModel = chosen;
          AppState.saveSettings();
          const settingsModel = document.getElementById('agentModel'); if (settingsModel) settingsModel.value = chosen;
          if (window.Agent && typeof Agent.persistAgentSettings === 'function') Agent.persistAgentSettings();
        }
      }
    },

    async refreshHeaderModelStatus(opts = {}) {
      const preset = this.inferHeaderPresetFromSettings();
      this.setHeaderStatus('checking', 'Checking connection…');
      try {
        if (preset === 'local') {
          const url = this.getLocalModelsUrl();
          let ok = false;
          let models = [];
          try {
            models = await this.fetchLocalModels();
            ok = true;
          } catch (e) {
            // fallback: at least check base endpoint reachability via OPTIONS/HEAD-like GET failure details
            try {
              const base = this.normalizeLocalBaseUrl((AppState.settings && AppState.settings.localServerBaseUrl) || 'http://localhost:11434/v1');
              const ping = await fetch(base.replace(/\/chat\/completions$/i, ''), { method: 'GET', cache: 'no-store' });
              ok = ping.ok || ping.status < 500;
            } catch {}
            if (!ok) throw e;
          }
          if (opts.reloadLocalModels !== false) this.populateLocalModelSelect(models, { applySelection: !String((AppState.settings && (AppState.settings.localServerModel || AppState.settings.agentModel)) || '').trim() || opts.forceSelectFirst });
          this.syncHeaderModelUI();
          this.setHeaderStatus(ok ? 'ok' : 'bad', ok ? `Local server reachable (${url})` : `Local server unreachable (${url})`);
          return ok;
        }

        // Managed Workers AI presets route through /api/chat; health ping /api/models or /v1/models
        let ok = false;
        let title = 'Managed endpoint unreachable';
        for (const path of ['/api/models', '/v1/models']) {
          try {
            const res = await fetch(path, { method: 'GET', cache: 'no-store' });
            if (res.status === 200) {
              ok = true;
              title = `Managed endpoint reachable (${path})`;
              break;
            }
            title = `Managed endpoint responded with HTTP ${res.status} (${path})`;
          } catch (e) {
            title = `Managed endpoint unreachable (${path}): ${String((e && e.message) || e || 'network error')}`;
          }
        }
        this.setHeaderStatus(ok ? 'ok' : 'bad', title);
        return ok;
      } catch (e) {
        const msg = String((e && e.message) || e || 'unreachable');
        this.setHeaderStatus('bad', `Unreachable: ${msg}`);
        return false;
      }
    },

    bindHeaderModelSwitcher() {
      const presetSel = document.getElementById('headerModelPreset');
      const refreshBtn = document.getElementById('btnHeaderModelRefresh');
      const localSel = document.getElementById('headerLocalModelSelect');
      if (presetSel && !presetSel.dataset.boundPreset) {
        presetSel.dataset.boundPreset = '1';
        presetSel.addEventListener('change', async () => {
          await this.applyHeaderPreset(presetSel.value || 'managed-qwen');
        });
      }
      if (refreshBtn && !refreshBtn.dataset.boundRefresh) {
        refreshBtn.dataset.boundRefresh = '1';
        refreshBtn.addEventListener('click', async (e) => {
          e.preventDefault();
          await this.refreshHeaderModelStatus({ reloadLocalModels: true });
        });
      }
      if (localSel && !localSel.dataset.boundLocalModel) {
        localSel.dataset.boundLocalModel = '1';
        localSel.addEventListener('change', () => {
          const val = String(localSel.value || '').trim();
          const s = AppState.settings || (AppState.settings = {});
          s.headerPreset = 'local';
          s.apiMode = 'direct';
          s.directProvider = 'custom';
          s.agentProvider = 'openai-compatible';
          s.localServerBaseUrl = this.normalizeLocalBaseUrl(s.localServerBaseUrl || 'http://localhost:11434/v1');
          s.agentEndpoint = s.localServerBaseUrl;
          s.localServerModel = val;
          s.agentModel = val;
          AppState.saveSettings();
          this.restoreSettingsUI();
          this.syncHeaderModelUI();
          if (window.Agent) {
            try { if (typeof Agent.persistAgentSettings === 'function') Agent.persistAgentSettings(); } catch {}
            try { if (typeof Agent.updateKeyStatus === 'function') Agent.updateKeyStatus(); } catch {}
          }
          this.refreshHeaderModelStatus({ reloadLocalModels: false });
        });
      }

      // Ensure agent chat view and active session are ready so messages render immediately
      try {
        this.setView('agent');
        if (window.Agent && typeof Agent.ensureActiveChatSession === 'function') {
          Agent.ensureActiveChatSession();
        } else if (!AppState.activeChatId || !AppState.getChat(AppState.activeChatId)) {
          const s = AppState.createChat('New chat');
          AppState.saveActiveChatId(s.id);
        }
      } catch {}

      // Initial sync/check (non-blocking)
      const initialPreset = this.inferHeaderPresetFromSettings();
      if (AppState.settings) AppState.settings.headerPreset = initialPreset;
      this.syncHeaderModelUI();
      setTimeout(() => { this.refreshHeaderModelStatus({ reloadLocalModels: initialPreset === 'local' }); }, 0);
    },

    bindSettings() {
      document.getElementById('btnCloseSettings')?.addEventListener('click', () => this.closeSettings());
      const cancel = document.getElementById('btnCloseSettingsSecondary');
      if (cancel) cancel.addEventListener('click', () => this.closeSettings());
      document.getElementById('settingsModal')?.addEventListener('click', (e) => { if (e.target.id === 'settingsModal') this.closeSettings(); });
      document.getElementById('btnSaveSettings')?.addEventListener('click', () => {
        // Read current Settings modal values (exact .value.trim() for runner URL)
        const terminalInput = document.getElementById('settingTerminalWs');
        const terminalUrl = (terminalInput?.value || '').trim();
        const timeoutInput = document.getElementById('settingCommandTimeout');
        const timeoutSecRaw = Number(timeoutInput ? timeoutInput.value : (AppState.settings.commandTimeoutSec != null ? AppState.settings.commandTimeoutSec : 600));
        const commandTimeoutSec = (Number.isFinite(timeoutSecRaw) && timeoutSecRaw > 0) ? Math.min(3600, Math.max(1, Math.round(timeoutSecRaw))) : 600;

        // Agent / RAG / runtime settings
        AppState.settings.systemPrompt = (document.getElementById('settingSystemPrompt')?.value || '');
        AppState.settings.ragK = Number(document.getElementById('settingRagK')?.value || 6);
        AppState.settings.terminalWs = terminalUrl;
        AppState.settings.commandTimeoutSec = commandTimeoutSec;
        AppState.settings.webhookUrl = (document.getElementById('settingWebhookUrl')?.value || '').trim();
        AppState.settings.githubToken = (document.getElementById('settingGithubToken')?.value || '').trim();
        const apiModeEl = document.getElementById('agentApiMode'); if (apiModeEl) AppState.settings.apiMode = apiModeEl.value || 'managed';
        const directProvEl = document.getElementById('agentDirectProvider'); if (directProvEl) AppState.settings.directProvider = directProvEl.value || 'gemini';
        const ep = document.getElementById('agentEndpoint'); if (ep) AppState.settings.agentEndpoint = (ep.value || '').trim();
        const model = document.getElementById('agentModel'); if (model) AppState.settings.agentModel = (model.value || '').trim();
        const prov = document.getElementById('agentProvider'); if (prov) AppState.settings.agentProvider = prov.value || 'openai-compatible';
        const autoApplyEl = document.getElementById('agentAutoApply');
        if (autoApplyEl) AppState.settings.autoApplyEdits = !!autoApplyEl.checked;
        // Persist API keys from Settings modal
        try {
          const keysEl = document.getElementById('apiKeysInput');
          if (keysEl) {
            const arr = String(keysEl.value || '').split(/\n+/).map(x => x.trim()).filter(Boolean);
            if (typeof AppState.saveApiKeys === 'function') AppState.saveApiKeys(arr);
            else AppState.apiKeys = arr;
          }
        } catch {}
        if (AppState.settings.apiMode === 'direct' && AppState.settings.directProvider === 'custom' && !String(AppState.settings.agentEndpoint || '').trim()) {
          if (window.Utils && Utils.toast) Utils.toast('Custom (OpenAI-compatible) Direct Provider requires an API endpoint override. Enter your base URL (e.g. https://api.example.com/v1) in Settings.', 'error');
        }
        AppState.saveSettings();

        // Persist MCP Servers configuration from Settings modal so Save Settings does not revert it
        try {
          const mcpInput = document.getElementById('mcpConfigInput');
          if (mcpInput && window.MCP && typeof MCP.saveConfigFromUI === 'function') {
            MCP.saveConfigFromUI();
          } else if (mcpInput && window.Utils && Utils.safeJsonParse) {
            const parsed = Utils.safeJsonParse(mcpInput.value, null);
            if (Array.isArray(parsed)) {
              AppState.mcpServers = parsed;
              if (AppState.saveMcp) AppState.saveMcp();
            }
          }
        } catch (e) {
          // Keep other settings saved; surface MCP config issues without reverting Runner URL
          if (window.Utils && Utils.toast) Utils.toast(`MCP config not saved: ${e.message}`, 'error');
        }

        // Update active runtime config and runner UI immediately from saved value
        const tws = document.getElementById('terminalWsUrl');
        if (tws) tws.value = terminalUrl;
        if (window.TerminalPanel) {
          TerminalPanel.remoteUrl = terminalUrl;
          if (typeof TerminalPanel.applyRunnerConfig === 'function') {
            TerminalPanel.applyRunnerConfig(terminalUrl, { silent: true });
          } else if (typeof TerminalPanel.persistUrl === 'function') {
            TerminalPanel.persistUrl(terminalUrl);
            if (!terminalUrl && typeof TerminalPanel.disconnect === 'function') TerminalPanel.disconnect(true);
          }
        }

        // Sync header quick-switch preset/status with updated Settings values
        try {
          if (String(AppState.settings.apiMode || '') === 'direct' && String(AppState.settings.directProvider || '') === 'custom' && String(AppState.settings.agentEndpoint || '').trim()) {
            AppState.settings.localServerBaseUrl = String(AppState.settings.agentEndpoint || '').trim();
          }
          AppState.settings.headerPreset = this.inferHeaderPresetFromSettings();
          this.syncHeaderModelUI();
          if (window.Agent && typeof Agent.updateKeyStatus === 'function') Agent.updateKeyStatus();
          this.refreshHeaderModelStatus({ reloadLocalModels: AppState.settings.headerPreset === 'local' });
        } catch {}

        this.closeSettings();
        if (window.Utils && Utils.toast) Utils.toast('Settings saved', 'success');
      });
    },

    bindDownloadApp() {
      const wrap = document.getElementById('downloadAppWrap');
      if (!wrap) return;
      const isNative = !!(window.Capacitor || window.__TAURI__ || (window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform()));
      if (isNative) {
        wrap.classList.add('hidden');
        wrap.setAttribute('aria-hidden', 'true');
        return;
      }
      wrap.classList.remove('hidden');
      wrap.setAttribute('aria-hidden', 'false');

      const links = {
        android: 'https://github.com/iniakinpelu2020-oss/Fuck/releases/download/latest/Apex-Studio-Android.apk',
        windows: 'https://github.com/iniakinpelu2020-oss/Fuck/releases/download/latest/Apex-Studio-Windows.exe',
        macos: 'https://github.com/iniakinpelu2020-oss/Fuck/releases/download/latest/Apex-Studio-macOS.dmg'
      };

      const detectPlatform = () => {
        const ua = String((navigator && (navigator.userAgent || navigator.vendor)) || (window.opera || '') || '');
        if (/android/i.test(ua)) return 'android';
        if (/Win/i.test(ua)) return 'windows';
        if (/Macintosh|Mac OS X/i.test(ua) && !/iPhone|iPad|iPod/i.test(ua)) return 'macos';
        return 'windows';
      };

      const primary = detectPlatform();
      const primaryUrl = links[primary] || links.windows;
      const btn = document.getElementById('btnDownloadApp');
      const caret = document.getElementById('btnDownloadAppMenu');
      const menu = document.getElementById('downloadAppMenu');
      if (!btn || !caret || !menu) return;

      const setMenuOpen = (open) => {
        menu.classList.toggle('hidden', !open);
        caret.setAttribute('aria-expanded', open ? 'true' : 'false');
      };

      if (!btn.dataset.boundDownload) {
        btn.dataset.boundDownload = '1';
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          setMenuOpen(false);
          window.location.href = primaryUrl;
        });
      }

      if (!caret.dataset.boundDownloadMenu) {
        caret.dataset.boundDownloadMenu = '1';
        caret.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const open = menu.classList.contains('hidden');
          setMenuOpen(open);
        });
      }

      menu.querySelectorAll('.download-app-item').forEach((a) => {
        if (a.dataset.boundDownloadItem) return;
        a.dataset.boundDownloadItem = '1';
        a.addEventListener('click', () => setMenuOpen(false));
      });

      if (!document.body.dataset.downloadAppOutsideBound) {
        document.body.dataset.downloadAppOutsideBound = '1';
        document.addEventListener('click', (e) => {
          const w = document.getElementById('downloadAppWrap');
          const m = document.getElementById('downloadAppMenu');
          const c = document.getElementById('btnDownloadAppMenu');
          if (!w || !m || !c) return;
          if (w.contains(e.target)) return;
          m.classList.add('hidden');
          c.setAttribute('aria-expanded', 'false');
        });
        document.addEventListener('keydown', (e) => {
          if (e.key !== 'Escape') return;
          const m = document.getElementById('downloadAppMenu');
          const c = document.getElementById('btnDownloadAppMenu');
          if (m) m.classList.add('hidden');
          if (c) c.setAttribute('aria-expanded', 'false');
        });
      }
    },

    bindMobile() {
      document.querySelectorAll('.mobile-pane-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const t = btn.dataset.paneTarget;
          if (t === 'right') this.setView('agent');
          else if (t === 'left') this.setView('workspace');
          else if (t === 'center') this.setView('editor');
        });
      });
    },
    setView(view) {
      this.currentView = view || 'agent';
      if (this.currentView === 'agent') this.currentMobilePane = 'right';
      else if (this.currentView === 'workspace') this.currentMobilePane = 'left';
      else if (this.currentView === 'editor') this.currentMobilePane = 'center';
      this.applyView(this.currentView);
    },
    applyView(view) {
      const app = document.getElementById('app');
      const mobile = this.isMobile();
      const left = document.getElementById('leftPanel');
      const center = document.getElementById('centerPane');
      const right = document.getElementById('rightPanel');
      if (!left || !center || !right) return;
      const v = view || 'agent';
      if (app) app.dataset.view = v;
      // header active states
      const map = { agent: 'btnPanelAgent', workspace: 'btnPanelExplorer', editor: 'btnToggleTerminal' };
      ['btnPanelAgent','btnPanelExplorer','btnToggleTerminal'].forEach(id => {
        const el = document.getElementById(id); if (el) el.classList.toggle('active', id === map[v]);
      });
      if (mobile) {
        const active = v === 'agent' ? 'right' : (v === 'workspace' ? 'left' : 'center');
        left.classList.toggle('mobile-hidden', active !== 'left');
        center.classList.toggle('mobile-hidden', active !== 'center');
        right.classList.toggle('mobile-hidden', active !== 'right');
        document.querySelectorAll('.mobile-pane-btn').forEach(b => b.classList.toggle('active', b.dataset.paneTarget === active));
        if (active === 'center') setTimeout(() => { if (window.TerminalPanel && TerminalPanel.fit) TerminalPanel.fit.fit(); }, 40);
        return;
      }
      // Desktop: agent-first primary view
      if (v === 'agent') {
        right.classList.remove('mobile-hidden');
        left.classList.add('mobile-hidden');
        center.classList.add('mobile-hidden');
      } else if (v === 'workspace') {
        left.classList.remove('mobile-hidden');
        center.classList.remove('mobile-hidden');
        right.classList.add('mobile-hidden');
      } else { // editor
        left.classList.remove('mobile-hidden');
        center.classList.remove('mobile-hidden');
        right.classList.remove('mobile-hidden');
        setTimeout(() => { if (window.TerminalPanel && TerminalPanel.fit) TerminalPanel.fit.fit(); }, 40);
      }
      document.querySelectorAll('.mobile-pane-btn').forEach(b => b.classList.toggle('active', (v === 'agent' && b.dataset.paneTarget === 'right') || (v === 'workspace' && b.dataset.paneTarget === 'left') || (v === 'editor' && b.dataset.paneTarget === 'center')));
    },
    setMobilePane(pane) { // compat
      if (pane === 'right') this.setView('agent'); else if (pane === 'left') this.setView('workspace'); else this.setView('editor');
    },
    applyMobilePane(pane) { this.applyView(this.currentView || (pane === 'right' ? 'agent' : pane === 'left' ? 'workspace' : 'editor')); },
    onAgentFileActivity(path, edited = false) {
      if (!path) return;
      // auto-open/highlight editor when agent creates or modifies files
      if (edited || (window.Agent && Agent._lastAutoAction === 'edit')) {
        this.setView('editor');
      }
    },

    restoreSettingsUI() {
      const s = (window.AppState && AppState.settings) ? AppState.settings : {};
      const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = (val == null ? '' : val); };

      // Read runner URL directly from saved settings/localStorage state (no hardcoded fallback)
      const terminalUrl = (s.terminalWs != null ? String(s.terminalWs) : '').trim();

      setVal('settingSystemPrompt', s.systemPrompt || '');
      setVal('settingRagK', s.ragK || 6);
      setVal('settingTerminalWs', terminalUrl);
      setVal('settingCommandTimeout', (s.commandTimeoutSec != null ? s.commandTimeoutSec : 600));
      setVal('settingWebhookUrl', s.webhookUrl || '');
      setVal('settingGithubToken', s.githubToken || '');
      setVal('agentApiMode', s.apiMode || 'managed');
      setVal('agentDirectProvider', s.directProvider || 'gemini');
      setVal('agentEndpoint', s.agentEndpoint || '');
      setVal('agentModel', s.agentModel || '');
      setVal('agentProvider', s.agentProvider || 'openai-compatible');
      const keysEl = document.getElementById('apiKeysInput');
      if (keysEl && Array.isArray(AppState.apiKeys)) keysEl.value = AppState.apiKeys.join('\n');
      const autoApplyEl = document.getElementById('agentAutoApply');
      if (autoApplyEl) autoApplyEl.checked = (typeof s.autoApplyEdits === 'boolean') ? s.autoApplyEdits : true;

      // Restore MCP Servers configuration so Settings modal reflects persisted state
      const mcpInput = document.getElementById('mcpConfigInput');
      if (mcpInput) {
        const servers = (window.AppState && Array.isArray(AppState.mcpServers)) ? AppState.mcpServers : [];
        const fallback = servers.length ? servers : [{ name: 'local-tools', url: 'ws://localhost:3002/mcp', transport: 'websocket' }];
        try { mcpInput.value = JSON.stringify(servers.length ? servers : fallback, null, 2); } catch { mcpInput.value = '[]'; }
      }

      // Agent response mode (Chat / Agent / Edit)
      const modeSel = document.getElementById('agentModeSelect');
      if (modeSel) {
        const m = String(s.agentMode || 'agent').toLowerCase();
        modeSel.value = ['chat', 'agent', 'edit'].includes(m) ? m : 'agent';
      }

      // Keep header/runner input and active runtime in sync with saved value
      const tws = document.getElementById('terminalWsUrl');
      if (tws) tws.value = terminalUrl;
      try {
        if (window.TerminalPanel) {
          TerminalPanel.remoteUrl = terminalUrl;
          if (typeof TerminalPanel.applyRunnerConfig === 'function') {
            TerminalPanel.applyRunnerConfig(terminalUrl, { silent: true });
          } else if (typeof TerminalPanel.persistUrl === 'function') {
            TerminalPanel.persistUrl(terminalUrl);
          }
        }
      } catch {}
    },

    openSettings() {
      this.restoreSettingsUI();
      const m = document.getElementById('settingsModal');
      m.classList.remove('hidden');
      m.classList.add('flex');
    },
    closeSettings() {
      const m = document.getElementById('settingsModal');
      m.classList.add('hidden');
      m.classList.remove('flex');
    },

    /* ---------- Navigation Drawer / Chat History ---------- */
    bindChatHistory() {
      const hamburger = document.getElementById('btnHamburger');
      const backdrop = document.getElementById('navDrawerBackdrop');
      const drawer = document.getElementById('navDrawer');
      const newBtn = document.getElementById('btnDrawerNewChat');
      const settingsBtn = document.getElementById('btnDrawerSettings');

      const openDrawer = () => {
        if (drawer) { drawer.classList.add('open'); drawer.setAttribute('aria-hidden', 'false'); }
        if (backdrop) { backdrop.classList.remove('hidden'); backdrop.classList.add('open'); backdrop.setAttribute('aria-hidden', 'false'); }
      };
      const closeDrawer = () => {
        if (drawer) { drawer.classList.remove('open'); drawer.setAttribute('aria-hidden', 'true'); }
        if (backdrop) { backdrop.classList.remove('open'); backdrop.setAttribute('aria-hidden', 'true'); setTimeout(() => { if (backdrop && !backdrop.classList.contains('open')) backdrop.classList.add('hidden'); }, 200); }
      };
      this.openNavDrawer = openDrawer;
      this.closeNavDrawer = closeDrawer;

      if (hamburger) hamburger.addEventListener('click', (e) => { e.stopPropagation(); openDrawer(); });
      if (backdrop) backdrop.addEventListener('click', closeDrawer);
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawer && drawer.classList.contains('open')) closeDrawer(); });

      if (newBtn) newBtn.addEventListener('click', () => { this.createNewChat(); closeDrawer(); });
      if (settingsBtn) settingsBtn.addEventListener('click', () => { closeDrawer(); this.openSettings(); });

      // Drawer view switcher (Agent / Workspace / Editor)
      ['drawerBtnAgent','drawerBtnWorkspace','drawerBtnEditor'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', (e) => {
          e.stopPropagation();
          const target = el.dataset.paneTarget;
          closeDrawer();
          if (target === 'right') this.setView('agent');
          else if (target === 'left') this.setView('workspace');
          else if (target === 'center') this.setView('editor');
        });
      });

      // Event delegation for pin/delete/switch on chat history list
      const lists = [document.getElementById('chatHistoryPinned'), document.getElementById('chatHistoryRecent')];
      lists.forEach(list => {
        if (!list) return;
        list.addEventListener('click', (e) => {
          const item = e.target.closest('.chat-history-item');
          if (!item) return;
          const id = item.dataset.chatId;
          const pinBtn = e.target.closest('.chat-history-pin');
          const delBtn = e.target.closest('.chat-history-delete');
          const renameBtn = e.target.closest('.chat-history-rename');
          if (renameBtn) { e.stopPropagation(); this.renameChat(id); return; }
          if (pinBtn) { e.stopPropagation(); this.togglePin(id); return; }
          if (delBtn) { e.stopPropagation(); this.confirmDeleteChat(id); return; }
          this.switchChat(id);
          closeDrawer();
        });
      });
    },

    renderChatHistory() {
      const pinnedList = document.getElementById('chatHistoryPinned');
      const recentList = document.getElementById('chatHistoryRecent');
      if (!pinnedList || !recentList) return;
      try {
        if (Array.isArray(AppState.chatSessions) && typeof AppState.normalizeChatTitle === 'function') {
          let fixed = false;
          for (const s of AppState.chatSessions) {
            if (!s) continue;
            const next = AppState.normalizeChatTitle(s.title, s, 42);
            if (next !== (s.title || 'New chat')) { s.title = next; fixed = true; }
          }
          if (fixed && typeof AppState.saveChatSessions === 'function') AppState.saveChatSessions();
        }
      } catch {}
      pinnedList.innerHTML = '';
      recentList.innerHTML = '';
      const chats = AppState.sortedChats();
      const activeId = AppState.activeChatId || null;
      chats.forEach(s => {
        const el = this.buildChatItem(s, activeId === s.id);
        if (s.pinned) pinnedList.appendChild(el);
        else recentList.appendChild(el);
      });
    },

    buildChatItem(s, active) {
      const div = document.createElement('div');
      div.className = `chat-history-item ${s.pinned ? 'pinned' : ''} ${active ? 'active' : ''}`;
      div.dataset.chatId = s.id;
      const updated = s.updatedAt ? new Date(s.updatedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
      let title = s.title || 'New chat';
      try { if (window.AppState && typeof AppState.normalizeChatTitle === 'function') title = AppState.normalizeChatTitle(title, s, 42); } catch {}
      if (title !== (s.title || 'New chat')) {
        try { s.title = title; if (AppState && typeof AppState.saveChatSessions === 'function') AppState.saveChatSessions(); } catch {}
      }
      const pinSvg = s.pinned
        ? '<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1"><path d="M16 3l5 5-2 2-1 5-4 4-1 4-2-2 4-4-4-4 4-4-2-2z"/></svg>'
        : '<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3l5 5-2 2-1 5-4 4-1 4-2-2 4-4-4-4 4-4-2-2z"/></svg>';
      const trashSvg = '<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>';
      const renameSvg = '<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
      div.innerHTML = `
        <div class="min-w-0 flex-1 flex flex-col pr-1">
          <span class="chat-history-title">${this.escapeHtml(title)}</span>
          ${updated ? `<span class="chat-history-meta !ml-0">${updated}</span>` : ''}
        </div>
        <div class="chat-history-actions">
          <button class="chat-history-rename" title="Rename" aria-label="Rename chat">${renameSvg}</button>
          <button class="chat-history-pin ${s.pinned ? 'pinned' : ''}" title="${s.pinned ? 'Unpin' : 'Pin'}" aria-label="${s.pinned ? 'Unpin chat' : 'Pin chat'}">${pinSvg}</button>
          <button class="chat-history-delete" title="Delete" aria-label="Delete chat">${trashSvg}</button>
        </div>
      `;
      return div;
    },

    escapeHtml(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); },

    createNewChat() {
      try {
        if (AppState.settings) AppState.settings.attachWorkspaceContext = false;
        const ac = document.getElementById('agentAttachWorkspaceContext') || document.getElementById('attachWorkspaceContext');
        if (ac) ac.checked = false;
        if (typeof AppState.saveSettings === 'function') AppState.saveSettings();
      } catch {}
      const session = AppState.createChat('New chat');
      AppState.saveActiveChatId(session.id);
      this.renderChatHistory();
      this.setView('agent');
      this.loadActiveChat();
      Utils.toast('New chat', 'info');
    },

    switchChat(id) {
      const session = AppState.getChat(id);
      if (!session) return;
      AppState.saveActiveChatId(id);
      this.setView('agent');
      this.renderChatHistory();
      this.loadActiveChat();
    },

    loadActiveChat() {
      const wrap = document.getElementById('chatMessages');
      if (!wrap) return;
      wrap.innerHTML = '';

      // Ensure there is always an active session bound to the current view
      let session = (AppState.activeChatId && AppState.getChat(AppState.activeChatId)) ? AppState.getChat(AppState.activeChatId) : null;
      if (!session) {
        const s = AppState.createChat('New chat');
        AppState.saveActiveChatId(s.id);
        session = s;
      }
      // Keep activeChatId consistent with rendered session
      if (AppState.activeChatId !== session.id) AppState.saveActiveChatId(session.id);

      // Strip/filter any previously saved welcome messages from old sessions (never persist greeting)
      const isWelcome = (m) => m && m.role === 'assistant' && /^Hi — I'm Apex\b/.test(String(m.content || '')) && String(m.content || '').includes('your autonomous agent');
      const messages = Array.isArray(session.messages) ? session.messages.filter(m => !isWelcome(m)) : [];
      if (Array.isArray(session.messages) && messages.length !== session.messages.length) {
        session.messages = messages;
        AppState.saveChatSessions();
      }

      // Always render the single welcome card as the first element (temporary, never saved), once per render
      Agent.addMessage(
        'assistant',
        'Hi — I\'m Apex Studio, your autonomous agent. Ask me to search the web, write or edit code, analyze binaries, or run automations. I\'ll decide which tools to use and show progress here.\n\nConfigure models, keys, MCP, RAG, and integrations in Settings from the drawer (☰) if needed.',
        '',
        [],
        { persist: false, welcomePlaceholder: true, keepWelcomePlaceholder: true }
      );

      // Render session messages in chronological order (real conversation only), without re-persisting
      messages.forEach(m => {
        if (!m) return;
        const role = m.role || 'assistant';
        Agent.addMessage(role, m.content, m.meta || '', m.badges || [], { persist: false, keepWelcomePlaceholder: true });
      });

      // Ensure latest message is visible
      try { wrap.scrollTop = wrap.scrollHeight; } catch {}
      this.renderChatHistory();
    },

    togglePin(id) {
      const pinned = AppState.togglePin(id);
      this.renderChatHistory();
      Utils.toast(pinned ? 'Pinned' : 'Unpinned', 'info');
    },

    renameChat(id) {
      const session = AppState.getChat(id);
      if (!session) return;
      const current = (AppState && typeof AppState.normalizeChatTitle === 'function')
        ? AppState.normalizeChatTitle(session.title, session, 42)
        : String(session.title || 'New chat');
      const nextRaw = prompt('Rename chat', current);
      if (nextRaw == null) return;
      let next = String(nextRaw).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
      if (!next) return;
      if (typeof AppState.normalizeChatTitle === 'function') next = AppState.normalizeChatTitle(next, session, 42);
      if (!next || next === 'New chat') next = String(nextRaw).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim() || 'New chat';
      AppState.updateChat(id, { title: next });
      this.renderChatHistory();
      Utils.toast('Chat renamed', 'success');
    },

    confirmDeleteChat(id) {
      const session = AppState.getChat(id);
      if (!session) return;
      if (!confirm(`Delete conversation "${session.title || 'New chat'}"?`)) return;
      this.deleteChat(id);
    },

    deleteChat(id) {
      const wasActive = AppState.activeChatId === id;
      AppState.deleteChat(id);
      this.renderChatHistory();
      if (wasActive) {
        const next = AppState.getChat(AppState.activeChatId);
        if (next) {
          this.loadActiveChat();
        } else {
          // no sessions left -> start fresh
          const fresh = AppState.createChat('New chat');
          AppState.saveActiveChatId(fresh.id);
          this.renderChatHistory();
          this.loadActiveChat();
        }
      }
    }

  };

  window.App = App;
  async function inspectFileInBrowser(file) {
    if (!file) throw new Error('No file provided');
    const name = String(file.name || 'file');
    const size = Number(file.size || 0);
    const mimeRaw = String(file.type || '');
    const mime = mimeRaw.toLowerCase();
    const ext = (name.includes('.') ? name.split('.').pop() : '').toLowerCase();
    const fmtBytes = (window.Utils && Utils.formatBytes) ? Utils.formatBytes : (n => n + ' B');

    const textExts = new Set(['txt','md','markdown','js','mjs','cjs','ts','tsx','jsx','json','jsonc','html','htm','css','scss','sass','less','xml','svg','yml','yaml','toml','ini','cfg','conf','env','sh','bash','zsh','fish','ps1','bat','cmd','py','rb','php','java','c','h','cpp','hpp','cc','cxx','cs','go','rs','swift','kt','kts','scala','sql','graphql','gql','vue','svelte','astro','prisma','proto','dockerfile','makefile','gitignore','gitattributes','editorconfig','lock','csv','tsv','log','diff','patch','map']);
    const imageExts = new Set(['png','jpg','jpeg','gif','webp','bmp','ico','avif','svgz']);
    const archiveExts = new Set(['zip','apk','jar','ipa','aab','war','xapk','apks']);
    const binaryExts = new Set(['exe','dll','bin','dmg','pe','so','dylib','msi','sys','ocx','elf','class','dex','wasm','o','a','lib','pdb','iso','img']);

    const baseName = name.split('/').pop() || name;
    const isImage = mime.startsWith('image/') || imageExts.has(ext);
    const isPdf = mime === 'application/pdf' || ext === 'pdf';
    const isArchive = archiveExts.has(ext) || mime === 'application/zip' || mime === 'application/x-zip-compressed' || mime === 'multipart/x-zip' || mime === 'application/vnd.android.package-archive' || mime === 'application/java-archive' || mime === 'application/x-ip';
    const isBinaryNamed = binaryExts.has(ext);
    let isText = !isImage && !isPdf && !isArchive && !isBinaryNamed && (
      textExts.has(ext) ||
      mime.startsWith('text/') ||
      mime === 'application/json' || mime === 'application/javascript' || mime === 'application/typescript' ||
      mime === 'application/xml' || mime === 'application/x-yaml' || mime === 'application/yaml' ||
      mime === 'application/toml' || mime === 'application/sql' || mime === 'application/graphql' ||
      mime === 'application/xhtml+xml' || mime === 'image/svg+xml' || ext === 'svg'
    );
    if (!isImage && !isPdf && !isArchive && !isBinaryNamed && !isText) {
      if (/^(README|LICENSE|CHANGELOG|CONTRIBUTING|Dockerfile|Makefile|Procfile|Jenkinsfile|Vagrantfile)$/i.test(baseName)) isText = true;
      else if (!ext && !mime) isText = true; // extensionless unknowns: try as text
    }

    if (isText) {
      let text = '';
      try { text = await file.text(); }
      catch (e) { text = `[Failed to read text: ${e && e.message ? e.message : e}]`; }
      const label = ext || 'text';
      return {
        ok: true, file, name, size, mime: mimeRaw || 'text/plain', ext,
        fileType: label, detectedType: label, kind: 'text',
        text, report: text,
        contentForWorkspace: text,
        contentForAgent: text
      };
    }

    if (isImage) {
      let dataUrl = '';
      try {
        dataUrl = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result || ''));
          r.onerror = () => reject(r.error || new Error('Failed to read image'));
          r.readAsDataURL(file);
        });
      } catch (e) { /* ignore */ }
      const label = ext || (mime.split('/')[1] || 'image');
      const report = `[Image file: ${name}]\nDetected type: ${label}\nMIME: ${mimeRaw || 'image/*'}\nSize: ${fmtBytes(size)} (${size} bytes)${dataUrl ? '\nData URL: (loaded, ' + dataUrl.length + ' chars)' : ''}`;
      return {
        ok: true, file, name, size, mime: mimeRaw || 'image/*', ext,
        fileType: label, detectedType: label, kind: 'image',
        dataUrl, report,
        contentForWorkspace: report,
        contentForAgent: report
      };
    }

    let report = '';
    if (window.BinaryInspector && typeof BinaryInspector.analyzeToText === 'function') {
      try { report = await BinaryInspector.analyzeToText(file); }
      catch (e) { report = `Name: ${name}\nSize: ${fmtBytes(size)} (${size} bytes)\nMIME: ${mimeRaw || 'unknown'}\nAnalysis failed: ${e && e.message ? e.message : e}`; }
    } else {
      try {
        const buf = await file.arrayBuffer();
        const bytes = new Uint8Array(buf);
        const head = [...bytes.slice(0, 32)].map(b => b.toString(16).padStart(2, '0')).join(' ');
        report = `Name: ${name}\nSize: ${fmtBytes(size)} (${size} bytes)\nMIME: ${mimeRaw || 'unknown'}\nHeader (hex): ${head}\n(Binary inspector unavailable)`;
      } catch (e) {
        report = `Name: ${name}\nSize: ${fmtBytes(size)} (${size} bytes)\nMIME: ${mimeRaw || 'unknown'}\nAnalysis failed: ${e && e.message ? e.message : e}`;
      }
    }

    let kind = 'binary';
    let fileType = ext || 'binary';
    if (isArchive) { kind = 'archive'; fileType = ext || 'archive'; }
    else if (isPdf) { kind = 'pdf'; fileType = 'pdf'; }
    else if (['exe','dll','sys','ocx','msi'].includes(ext)) { kind = 'binary'; fileType = ext; }
    else if (ext === 'dmg') { kind = 'binary'; fileType = 'dmg'; }
    else { fileType = ext || (isPdf ? 'pdf' : 'binary'); kind = isPdf ? 'pdf' : 'binary'; }

    let readyLabel = null;
    const isREAType = ['exe','dll','elf','so','bin','apk'].includes(ext);
    if (isREAType) {
      try { report = reaBuildReport(file, report); } catch (_) { /* keep base report */ }
      fileType = ext || fileType;
      readyLabel = `Ready (REA ${fileType})`;
    }

    return {
      ok: true, file, name, size, mime: mimeRaw || 'application/octet-stream', ext,
      fileType, detectedType: fileType, kind,
      readyLabel,
      report,
      contentForWorkspace: report,
      contentForAgent: report
    };
  }

  window.inspectFileInBrowser = inspectFileInBrowser;


  function reaIsAutoTriggerFile(fileOrName) {
    const name = String((fileOrName && fileOrName.name) ? fileOrName.name : (fileOrName || '')).toLowerCase();
    const ext = (name.includes('.') ? name.split('.').pop() : '');
    return ['exe', 'dll', 'elf', 'so', 'bin', 'apk'].includes(ext);
  }

  function reaExtractSection(base, heading, maxLen) {
    if (!base) return '';
    const idx = base.indexOf(heading);
    if (idx < 0) return '';
    let rest = base.slice(idx + heading.length).replace(/^\s*\n/, '');
    const stops = ['\n=== Interesting Findings ===', '\n--- PE Section Size Flags ---', '\n--- Extracted Strings', '\n--- Hex Preview', '\n\nArchive entries:', '\n\nPE/EXE inspection:', '\n\nDMG/UDIF inspection:', '\n\nNo container-specific parser'];
    let end = rest.length;
    for (const st of stops) {
      const j = rest.indexOf(st);
      if (j >= 0 && j < end) end = j;
    }
    let out = rest.slice(0, end).trim();
    if (maxLen && out.length > maxLen) out = out.slice(0, maxLen) + '\n…(truncated)';
    return out;
  }

  function reaBuildReport(file, baseReport) {
    const name = String((file && file.name) || 'binary');
    const size = Number((file && file.size) || 0);
    const mime = String((file && file.type) || 'application/octet-stream');
    const ext = (name.includes('.') ? name.split('.').pop() : '').toLowerCase() || 'bin';
    const fmtBytes = (window.Utils && Utils.formatBytes) ? Utils.formatBytes : (n => n + ' B');
    const base = String(baseReport || '');

    const getLine = (prefix) => {
      const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp('^' + esc + '\\s*(.*)$', 'm');
      const m = base.match(re);
      return m ? m[1].trim() : '';
    };
    const signature = getLine('Detected signature:') || '(unknown)';
    const fingerprint = getLine('SHA-like fingerprint:') || '(unavailable)';

    const interesting = reaExtractSection(base, '=== Interesting Findings ===', 6000);
    const stringsSample = reaExtractSection(base, '--- Extracted Strings (sample, >= 7 chars, noise filtered) ---', 4000);
    const hexPreview = reaExtractSection(base, '--- Hex Preview (first 256 bytes) ---', 1200);
    const peSectionFlags = reaExtractSection(base, '--- PE Section Size Flags ---', 1200);

    let structure = base;
    const cut = structure.indexOf('\n=== Interesting Findings ===');
    if (cut >= 0) structure = structure.slice(0, cut);
    structure = structure.replace(/^Name:.*\n?/m, '').replace(/^Size:.*\n?/m, '').replace(/^MIME:.*\n?/m, '').replace(/^SHA-like fingerprint:.*\n?/m, '').replace(/^Detected signature:.*\n?/m, '').trim();
    if (structure.length > 6000) structure = structure.slice(0, 6000) + '\n…(truncated)';

    const observations = [];
    observations.push(`- File name: ${name} (${fmtBytes(size)}, ${size} bytes, MIME: ${mime || 'unknown'})`);
    observations.push(`- Static signature/fingerprint: ${signature}; ${fingerprint}`);
    if (/PE\/EXE\/DLL/i.test(signature) || /\.exe$|\.dll$/i.test(name)) observations.push('- PE container indicators observed (DOS MZ / PE signature parsed in base inspection where available).');
    if (/ZIP\/APK\/JAR\/IPA/i.test(signature) || /\.apk$|\.zip$|\.jar$|\.ipa$/i.test(name)) observations.push('- Archive/package container indicators observed (ZIP/APK-style entries/manifests inspected where available).');
    if (/ELF/i.test(signature) || /\.elf$|\.so$/i.test(name)) observations.push('- ELF/shared-object indicators observed by name/signature context; browser-native deep ELF parsing is limited to available static evidence.');
    if (/DMG\/UDIF/i.test(signature) || /\.dmg$/i.test(name)) observations.push('- Apple disk image indicators observed (UDIF/koly metadata where available).');
    if (/\.bin$/i.test(name)) observations.push('- Generic binary blob; format inferred only from header/strings/hex evidence.');
    if (/No container-specific parser matched/i.test(base)) observations.push('- No specialized container parser matched; analysis is based on generic header/strings/hex evidence.');
    if (peSectionFlags) observations.push('- One or more PE sections show large raw size ratios (possible embedded payload/installer/packed data) — see evidence.');

    const inferences = [];
    const apiSection = interesting.split('Sensitive / Network / Process Windows APIs')[1] || '';
    if (interesting && /Sensitive \/ Network \/ Process Windows APIs/i.test(interesting) && !/\(none found\)/.test(apiSection)) {
      inferences.push('- Presence of process/memory/network/registry API strings suggests capabilities consistent with those APIs (static string evidence; not proof of execution).');
    }
    const compilerSection = interesting.split('Compiler / Runtime Signatures')[1] || '';
    if (interesting && /Compiler \/ Runtime Signatures/i.test(interesting) && !/\(none found\)/.test(compilerSection)) {
      inferences.push('- Compiler/runtime/toolchain markers were observed; they may indicate build environment or packaging framework (heuristic).');
    }
    if (/UPX!|UPX0|UPX1/i.test(base)) inferences.push('- UPX markers suggest packing/compression; unpacking may be required for deeper inspection.');
    if (/\.data|\.rsrc/i.test(peSectionFlags)) inferences.push('- Large data/resource sections may contain embedded archives, installers, or resources worth carving/inspecting.');
    if (!inferences.length) inferences.push('- No strong heuristic inferences beyond directly observed static artifacts.');

    const unknowns = [
      '- Browser-native analysis only: no external decompiler/disassembler engines (Ghidra/Hopper/IDA/rizin) executed and no symbol recovery beyond observed strings/headers.',
      '- No dynamic execution, sandbox tracing, or network observation performed.',
      '- Packed, encrypted, or obfuscated regions may hide code/data; contents not unpacked or decrypted here.',
      '- For managed/.NET, stripped ELF, or complex formats, deeper semantic recovery (functions, CFG, decompilation) is unavailable in-browser.',
      '- Archive entries/manifests shown are parsed statically; embedded binaries may require separate inspection.'
    ];

    const nextProbes = [
      '1. Trace relevant capability strings/import hints to suspected feature areas (network, filesystem, crypto, process, persistence) and record offset/section evidence where available.',
      '2. If PE: inspect entry point, imports/exports, resources, overlay, and high-entropy/large sections for embedded payloads or installers.',
      '3. If archive/APK: review manifests, scripts, native libraries (.so), DEX/classes, and config files for permissions/endpoints/entry points.',
      '4. Search extracted strings for URLs, domains, registry keys, file paths, command lines, and error messages tied to behavior of interest.',
      '5. For deeper reverse engineering, analyze in authorized environments with native RE tools (Ghidra/IDA/Hopper/rizin) and, if needed, controlled dynamic instrumentation.',
      '6. Validate hypotheses against additional static/dynamic evidence; keep confirmed facts, inferences, and unknowns separate.'
    ];

    const prompt = [
      'Use REA (Reverse Engineering Assistant) workflow on this artifact.',
      '1) Identify format, architecture/runtime hints, sections/entries, imports/capabilities, strings/IOCs, and likely entry points from static evidence.',
      '2) Cite evidence (offsets, section names, header fields, string hits) for every claim.',
      '3) Separate Observations (confirmed), Inferences (heuristic), and Unknowns/limits.',
      '4) Propose focused next probes; do not claim decompilation or runtime behavior without evidence.'
    ].join('\n');

    const parts = [];
    parts.push('# REA Native Analysis (Browser)');
    parts.push('');
    parts.push('## Target');
    parts.push(`- Name: ${name}`);
    parts.push(`- Extension: .${ext}`);
    parts.push(`- Size: ${fmtBytes(size)} (${size} bytes)`);
    parts.push(`- MIME: ${mime || 'unknown'}`);
    parts.push(`- Detected signature: ${signature}`);
    parts.push(`- Fingerprint: ${fingerprint}`);
    parts.push('');
    parts.push('## Structured REA Inspection Prompt');
    parts.push(prompt);
    parts.push('');
    parts.push('## Observed Format & Structure (static evidence)');
    parts.push(structure || '(no container-specific structure extracted)');
    parts.push('');
    parts.push('## Capability & IOC Findings (extracted evidence)');
    parts.push(interesting || '(no categorized findings)');
    parts.push('');
    if (peSectionFlags) {
      parts.push('## PE Section Size Flags');
      parts.push(peSectionFlags);
      parts.push('');
    }
    parts.push('## Extracted Strings (sample)');
    parts.push(stringsSample || '(none found)');
    parts.push('');
    parts.push('## Hex Preview (first 256 bytes)');
    parts.push(hexPreview || '(unavailable)');
    parts.push('');
    parts.push('## Observations (confirmed)');
    parts.push(observations.join('\n'));
    parts.push('');
    parts.push('## Inferences (heuristic)');
    parts.push(inferences.join('\n'));
    parts.push('');
    parts.push('## Unknowns / Limits');
    parts.push(unknowns.join('\n'));
    parts.push('');
    parts.push('## Suggested Next Probes');
    parts.push(nextProbes.join('\n'));

    return parts.join('\n');
  }

  async function analyzeFileWithREA(file) {
    const target = file || (window.BinaryInspector && BinaryInspector.selectedFile);
    if (!target) throw new Error('No binary file selected');
    let base = '';
    if (window.BinaryInspector && typeof BinaryInspector.analyzeToText === 'function') {
      base = await BinaryInspector.analyzeToText(target);
    } else {
      const info = await inspectFileInBrowser(target);
      base = String((info && (info.report || info.contentForAgent || info.text)) || '');
    }
    return reaBuildReport(target, base);
  }

  async function analyzeSelectedBinaryWithREA() {
    const out = document.getElementById('binaryOutput');
    if (!window.BinaryInspector || !BinaryInspector.selectedFile) {
      if (window.Utils) Utils.toast('Select a binary/package first', 'error');
      return null;
    }
    const file = BinaryInspector.selectedFile;
    if (out) out.textContent = `Analyzing ${file.name} with REA (browser-native)...\n`;
    try {
      const report = await analyzeFileWithREA(file);
      if (out) out.textContent = report;
      if (window.BinaryInspector) {
        BinaryInspector.lastAnalysis = { name: file.name, text: report, at: Date.now(), mode: 'rea' };
      }
      if (window.Utils) Utils.toast('REA analysis complete', 'success');
      return report;
    } catch (e) {
      const msg = `REA analysis failed: ${e && e.message ? e.message : e}`;
      if (out) out.textContent = msg;
      if (window.Utils) Utils.toast(msg, 'error');
      throw e;
    }
  }

  App.reaIsAutoTriggerFile = reaIsAutoTriggerFile;
  App.analyzeFileWithREA = analyzeFileWithREA;
  App.buildREAReport = reaBuildReport;
  App.analyzeSelectedBinaryWithREA = analyzeSelectedBinaryWithREA;

  window.addEventListener('DOMContentLoaded', () => App.init());
})();
