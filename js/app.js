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
        AppState.upsertFile('scripts/example.sh', "#!/usr/bin/env bash\necho 'Run this in the connected terminal bridge'\n");
        AppState.upsertFile('notes.txt', 'Welcome to Apex IDE.\n\n- Open a local folder with the Directory Picker.\n- Configure API keys in the Agent tab.\n- Connect MCP servers, index RAG context, and manage integrations in the Vault.\n');
        AppState.setActiveFile('src/index.js');
        AppState.emit('workspace:changed');
      } else {
        const readme = AppState.files.get('README.md');
        if (readme && /^# (Aether|Apex) IDE/m.test(readme.content || '') && /Edit files in the center panel/.test(readme.content || '')) {
          AppState.upsertFile('README.md', 'Welcome to Apex IDE.\n\n- Open a local folder with the Directory Picker.\n- Configure API keys in the Agent tab.\n- Connect MCP servers, index RAG context, and manage integrations in the Vault.\n', { dirty: false });
        }
        AppState.setActiveFile(AppState.activeFilePath || AppState.files.keys().next().value || null);
      }

      document.getElementById('terminalWsUrl').value = AppState.settings.terminalWs || '';
      this.syncWorkspaceLabels();
      AppState.subscribe((evt, payload) => {
        if (evt === 'workspace:changed' || evt === 'workspace:reset') this.syncWorkspaceLabels();
        if (evt === 'file:active' && this.isMobile()) this.setMobilePane('center');
      });
      window.addEventListener('resize', () => this.applyMobilePane(this.currentMobilePane || 'left'));
      this.currentMobilePane = 'left';
      this.applyMobilePane('left');
      Utils.toast('Apex IDE ready', 'success');
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
      document.getElementById('btnToggleTerminal').addEventListener('click', () => {
        TerminalPanel.toggle();
        if (this.isMobile()) this.setMobilePane('center');
      });
      const btnExplorer = document.getElementById('btnPanelExplorer');
      const btnAgent = document.getElementById('btnPanelAgent');
      if (btnExplorer) btnExplorer.addEventListener('click', () => {
        if (this.isMobile()) return this.setMobilePane('left');
        document.getElementById('leftPanel')?.scrollIntoView({ block: 'nearest' });
      });
      if (btnAgent) btnAgent.addEventListener('click', () => {
        if (this.isMobile()) {
          const agentTab = document.querySelector('.right-tab[data-right-tab="agent"]');
          if (agentTab) agentTab.click();
          return this.setMobilePane('right');
        }
        const agentTab = document.querySelector('.right-tab[data-right-tab="agent"]');
        if (agentTab) agentTab.click();
        document.getElementById('rightPanel')?.scrollIntoView({ block: 'nearest' });
      });
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
        btn.addEventListener('click', () => this.setMobilePane(btn.dataset.paneTarget));
      });
    },
    setMobilePane(pane) {
      this.currentMobilePane = pane || 'left';
      this.applyMobilePane(this.currentMobilePane);
    },
    applyMobilePane(pane) {
      const mobile = this.isMobile();
      const left = document.getElementById('leftPanel');
      const center = document.getElementById('centerPane');
      const right = document.getElementById('rightPanel');
      if (!left || !center || !right) return;
      if (!mobile) {
        left.classList.remove('mobile-hidden');
        center.classList.remove('mobile-hidden');
        right.classList.remove('mobile-hidden');
        document.querySelectorAll('.mobile-pane-btn').forEach(b => b.classList.toggle('active', b.dataset.paneTarget === pane));
        return;
      }
      const active = pane || 'left';
      left.classList.toggle('mobile-hidden', active !== 'left');
      center.classList.toggle('mobile-hidden', active !== 'center');
      right.classList.toggle('mobile-hidden', active !== 'right');
      document.querySelectorAll('.mobile-pane-btn').forEach(b => b.classList.toggle('active', b.dataset.paneTarget === active));
      if (active === 'center') {
        setTimeout(() => { if (window.TerminalPanel && TerminalPanel.fit) TerminalPanel.fit.fit(); }, 40);
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
