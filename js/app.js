(function () {
  const App = {
    init() {
      this.bindTabs();
      this.bindHeader();
      this.bindSettings();
      this.bindMobile();
      this.restoreSettingsUI();

      FileTree.init();
      Editor.init();
      TerminalPanel.init();
      BinaryInspector.init();
      RAG.init();
      MCP.init();
      Integrations.init();
      Agent.init();

      // Chat history
      this.bindChatHistory();
      this.renderChatHistory();
      this.loadActiveChat();

      if (AppState.files.size === 0) {
        AppState.workspaceName = 'Starter Workspace';
        AppState.upsertFile('src/index.js', "console.log('Hello from Apex IDE');\n");
        AppState.upsertFile('notes.txt', 'Welcome to Apex.\n\nAsk the agent to build, search, analyze, or automate.\nOpen Workspace/Editor from the top bar when needed.\nConfigure models, keys, MCP, RAG, and integrations in Settings (⚙️).\n');
        AppState.setActiveFile('src/index.js');
        AppState.emit('workspace:changed');
      } else {
        AppState.setActiveFile(AppState.activeFilePath || AppState.files.keys().next().value || null);
      }

      const tws = document.getElementById('terminalWsUrl');
      if (tws) tws.value = AppState.settings.terminalWs || '';
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
      Utils.toast('Apex ready', 'success');
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
        TerminalPanel.toggle();
      });
      const btnExplorer = document.getElementById('btnPanelExplorer');
      const btnAgent = document.getElementById('btnPanelAgent');
      if (btnExplorer) btnExplorer.addEventListener('click', () => this.setView('workspace'));
      if (btnAgent) btnAgent.addEventListener('click', () => this.setView('agent'));
      document.getElementById('btnOpenSettings').addEventListener('click', () => this.openSettings());
    },

    bindSettings() {
      document.getElementById('btnCloseSettings').addEventListener('click', () => this.closeSettings());
      const cancel = document.getElementById('btnCloseSettingsSecondary');
      if (cancel) cancel.addEventListener('click', () => this.closeSettings());
      document.getElementById('settingsModal').addEventListener('click', (e) => { if (e.target.id === 'settingsModal') this.closeSettings(); });
      document.getElementById('btnSaveSettings').addEventListener('click', () => {
        // Agent / RAG / runtime settings
        AppState.settings.systemPrompt = (document.getElementById('settingSystemPrompt').value || '');
        AppState.settings.ragK = Number(document.getElementById('settingRagK').value || 6);
        const terminalUrl = (document.getElementById('settingTerminalWs').value || '').trim();
        AppState.settings.terminalWs = terminalUrl;
        AppState.settings.webhookUrl = (document.getElementById('settingWebhookUrl').value || '').trim();
        AppState.settings.githubToken = (document.getElementById('settingGithubToken').value || '').trim();
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

        // Keep terminal/runner UI and active state in sync with persisted URL
        const tws = document.getElementById('terminalWsUrl');
        if (tws) tws.value = terminalUrl;
        if (window.TerminalPanel) {
          TerminalPanel.remoteUrl = terminalUrl;
          if (typeof TerminalPanel.applyRunnerConfig === 'function') {
            TerminalPanel.applyRunnerConfig(terminalUrl, { silent: true });
          } else if (typeof TerminalPanel.disconnect === 'function' && !terminalUrl) {
            TerminalPanel.disconnect(true);
          }
        }

        this.closeSettings();
        Utils.toast('Settings saved', 'success');
      });
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
      setVal('settingSystemPrompt', s.systemPrompt || '');
      setVal('settingRagK', s.ragK || 6);
      setVal('settingTerminalWs', s.terminalWs || '');
      setVal('settingWebhookUrl', s.webhookUrl || '');
      setVal('settingGithubToken', s.githubToken || '');

      // Restore MCP Servers configuration so Settings modal reflects persisted state
      const mcpInput = document.getElementById('mcpConfigInput');
      if (mcpInput) {
        const servers = (window.AppState && Array.isArray(AppState.mcpServers)) ? AppState.mcpServers : [];
        const fallback = servers.length ? servers : [{ name: 'local-tools', url: 'ws://localhost:3002/mcp', transport: 'websocket' }];
        try { mcpInput.value = JSON.stringify(servers.length ? servers : fallback, null, 2); } catch { mcpInput.value = '[]'; }
      }

      // Keep header/runner input in sync
      const tws = document.getElementById('terminalWsUrl');
      if (tws) tws.value = s.terminalWs || '';
      // Apply saved remote runner to active TerminalPanel so restored state is active
      try {
        if (window.TerminalPanel && typeof TerminalPanel.applyRunnerConfig === 'function') {
          TerminalPanel.applyRunnerConfig(s.terminalWs || '', { silent: true });
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
      const title = s.title || 'New chat';
      const pinSvg = s.pinned
        ? '<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1"><path d="M16 3l5 5-2 2-1 5-4 4-1 4-2-2 4-4-4-4 4-4-2-2z"/></svg>'
        : '<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3l5 5-2 2-1 5-4 4-1 4-2-2 4-4-4-4 4-4-2-2z"/></svg>';
      const trashSvg = '<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>';
      div.innerHTML = `
        <div class="min-w-0 flex-1 flex flex-col pr-1">
          <span class="chat-history-title">${this.escapeHtml(title)}</span>
          ${updated ? `<span class="chat-history-meta !ml-0">${updated}</span>` : ''}
        </div>
        <div class="chat-history-actions">
          <button class="chat-history-pin ${s.pinned ? 'pinned' : ''}" title="${s.pinned ? 'Unpin' : 'Pin'}" aria-label="${s.pinned ? 'Unpin chat' : 'Pin chat'}">${pinSvg}</button>
          <button class="chat-history-delete" title="Delete" aria-label="Delete chat">${trashSvg}</button>
        </div>
      `;
      return div;
    },

    escapeHtml(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); },

    createNewChat() {
      const session = AppState.createChat('New chat');
      AppState.saveActiveChatId(session.id);
      this.renderChatHistory();
      this.loadActiveChat();
      Utils.toast('New chat', 'info');
    },

    switchChat(id) {
      const session = AppState.getChat(id);
      if (!session) return;
      AppState.saveActiveChatId(id);
      this.renderChatHistory();
      this.loadActiveChat();
    },

    loadActiveChat() {
      const id = AppState.activeChatId;
      const wrap = document.getElementById('chatMessages');
      if (!wrap) return;
      wrap.innerHTML = '';
      if (!id) {
        // ensure a default session exists
        const s = AppState.createChat('New chat');
        AppState.saveActiveChatId(s.id);
        this.renderChatHistory();
      }
      const session = AppState.getChat(AppState.activeChatId);
      if (!session || !session.messages || !session.messages.length) {
        Agent.addMessage('assistant', 'Hi — I\'m Apex, your autonomous agent. Ask me to search the web, write or edit code, analyze binaries, or run automations. I\'ll decide which tools to use and show progress here.\n\nConfigure models, keys, MCP, RAG, and integrations in Settings (⚙️) if needed.');
        return;
      }
      session.messages.forEach(m => {
        if (m.role === 'user') Agent.addMessage('user', m.content, m.meta);
        else if (m.role === 'assistant') Agent.addMessage('assistant', m.content, m.meta, m.badges);
        else if (m.role === 'system') Agent.addMessage('system', m.content, m.meta);
      });
    },

    togglePin(id) {
      const pinned = AppState.togglePin(id);
      this.renderChatHistory();
      Utils.toast(pinned ? 'Pinned' : 'Unpinned', 'info');
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
  window.addEventListener('DOMContentLoaded', () => App.init());
})();
