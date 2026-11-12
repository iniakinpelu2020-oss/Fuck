(function () {
  const App = {
    init() {
      this.bindTabs();
      this.bindHeader();
      this.bindSettings();
      this.restoreSettingsUI();

      FileTree.init();
      Editor.init();
      TerminalPanel.init();
      BinaryInspector.init();
      RAG.init();
      MCP.init();
      Integrations.init();
      Workflow.init();
      Agent.init();

      // Seed sample workspace if empty
      if (AppState.files.size === 0) {
        AppState.workspaceName = 'Starter Workspace';
        AppState.upsertFile('README.md', '# Aether IDE\n\n- Edit files in the center panel.\n- Open a local folder with the Directory Picker.\n- Configure API keys in the Agent tab.\n- Use Workflow tab for automation nodes.\n');
        AppState.upsertFile('src/index.js', "console.log('Hello from Aether IDE');\n");
        AppState.upsertFile('scripts/example.sh', "#!/usr/bin/env bash\necho 'Run this in the connected terminal bridge'\n");
        AppState.setActiveFile('README.md');
        AppState.emit('workspace:changed');
      } else {
        AppState.setActiveFile(AppState.activeFilePath || AppState.files.keys().next().value || null);
      }

      document.getElementById('terminalWsUrl').value = AppState.settings.terminalWs || '';
      Utils.toast('Aether IDE ready', 'success');
    },

    bindTabs() {
      document.querySelectorAll('.left-tab').forEach(btn => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('.left-tab').forEach(b => b.classList.remove('bg-gray-800'));
          btn.classList.add('bg-gray-800');
          const tab = btn.dataset.leftTab;
          document.querySelectorAll('.left-tab-panel').forEach(p => p.classList.add('hidden'));
          document.getElementById(`tab-${tab}`).classList.remove('hidden');
        });
      });
      document.querySelectorAll('.right-tab').forEach(btn => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('.right-tab').forEach(b => b.classList.remove('bg-gray-800'));
          btn.classList.add('bg-gray-800');
          const tab = btn.dataset.rightTab;
          document.querySelectorAll('.right-tab-panel').forEach(p => p.classList.add('hidden'));
          document.getElementById(`tab-${tab}`).classList.remove('hidden');
        });
      });
    },

    bindHeader() {
      document.getElementById('btnToggleTerminal').addEventListener('click', () => TerminalPanel.toggle());
      document.getElementById('btnToggleWorkflow').addEventListener('click', () => {
        const editorView = document.getElementById('editorView');
        const workflowView = document.getElementById('workflowView');
        const showingWorkflow = !workflowView.classList.contains('hidden');
        workflowView.classList.toggle('hidden', showingWorkflow);
        editorView.classList.toggle('hidden', !showingWorkflow);
        if (!showingWorkflow) Workflow.renderEdges();
      });
      document.getElementById('btnOpenSettings').addEventListener('click', () => this.openSettings());
    },

    bindSettings() {
      document.getElementById('btnCloseSettings').addEventListener('click', () => this.closeSettings());
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
