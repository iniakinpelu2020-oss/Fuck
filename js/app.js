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
        AppState.settings.systemPrompt = document.getElementById('settingSystemPrompt').value;
        AppState.settings.ragK = Number(document.getElementById('settingRagK').value || 6);
        AppState.settings.terminalWs = document.getElementById('settingTerminalWs').value.trim();
        AppState.settings.webhookUrl = document.getElementById('settingWebhookUrl').value.trim();
        AppState.settings.githubToken = document.getElementById('settingGithubToken').value.trim();
        AppState.saveSettings();
        document.getElementById('terminalWsUrl').value = AppState.settings.terminalWs || '';
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
      document.getElementById('settingSystemPrompt').value = AppState.settings.systemPrompt || '';
      document.getElementById('settingRagK').value = AppState.settings.ragK || 6;
      document.getElementById('settingTerminalWs').value = AppState.settings.terminalWs || '';
      document.getElementById('settingWebhookUrl').value = AppState.settings.webhookUrl || '';
      document.getElementById('settingGithubToken').value = AppState.settings.githubToken || '';
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
    }
  };

  window.addEventListener('DOMContentLoaded', () => App.init());
})();
