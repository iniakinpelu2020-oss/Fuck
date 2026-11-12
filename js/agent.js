(function () {
  const Agent = {
    init() {
      document.getElementById('btnSendChat').addEventListener('click', () => this.sendFromUI());
      document.getElementById('btnRunAgent').addEventListener('click', () => this.sendFromUI());
      document.getElementById('btnIndexWorkspace').addEventListener('click', async () => { await RAG.indexWorkspace(); });
      document.getElementById('chatInput').addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); this.sendFromUI(); }
      });
      const keys = AppState.apiKeys || [];
      document.getElementById('apiKeysInput').value = keys.join('\n');
      document.getElementById('apiKeysInput').addEventListener('change', () => {
        const arr = document.getElementById('apiKeysInput').value.split(/\n+/).map(s => s.trim()).filter(Boolean);
        AppState.saveApiKeys(arr);
        this.updateKeyStatus();
      });
      document.getElementById('agentEndpoint').value = AppState.settings.agentEndpoint || '';
      document.getElementById('agentModel').value = AppState.settings.agentModel || '';
      document.getElementById('agentProvider').value = AppState.settings.agentProvider || 'openai-compatible';
      ['agentEndpoint','agentModel','agentProvider'].forEach(id => document.getElementById(id).addEventListener('change', () => this.persistAgentSettings()));
      this.updateKeyStatus();
      this.addMessage('assistant', 'Agent ready. Configure API keys, index workspace for RAG, and provide instructions. Edits can be auto-applied from JSON edit blocks.');
    },

    persistAgentSettings() {
      AppState.settings.agentEndpoint = document.getElementById('agentEndpoint').value.trim();
      AppState.settings.agentModel = document.getElementById('agentModel').value.trim();
      AppState.settings.agentProvider = document.getElementById('agentProvider').value;
      AppState.saveSettings();
    },

    updateKeyStatus() {
      const keys = AppState.apiKeys || [];
      document.getElementById('agentKeyStatus').textContent = keys.length ? `${keys.length} key(s) loaded. Active index: ${AppState.apiKeyIndex % keys.length}` : 'No API keys configured. Requests may fail unless endpoint allows anonymous access.';
    },

    addMessage(role, content, meta = '') {
      const wrap = document.getElementById('chatMessages');
      const div = document.createElement('div');
      div.className = `chat-msg ${role}`;
      div.innerHTML = `<div class="meta">${role === 'user' ? 'You' : 'Agent'} ${meta ? '• ' + Utils.escapeHtml(meta) : ''}</div><pre>${Utils.escapeHtml(content)}</pre>`;
      wrap.appendChild(div);
      wrap.scrollTop = wrap.scrollHeight;
    },

    async sendFromUI() {
      const input = document.getElementById('chatInput');
      const prompt = input.value.trim();
      if (!prompt) return;
      input.value = '';
      this.addMessage('user', prompt);
      try {
        await this.runPrompt(prompt, { fromUI: true });
      } catch (e) {
        this.addMessage('assistant', `Error: ${e.message}`);
      }
    },

    getEndpoint(provider, override) {
      if (override) return override;
      if (provider === 'anthropic') return 'https://api.anthropic.com/v1/messages';
      if (provider === 'openai-compatible') return 'https://api.openai.com/v1/chat/completions';
      return '';
    },

    getHeaders(provider, key) {
      if (provider === 'anthropic') {
        return { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' };
      }
      return { 'Content-Type': 'application/json', ...(key ? { 'Authorization': `Bearer ${key}` } : {}) };
    },

    buildRequestBody(provider, model, system, userContent) {
      if (provider === 'anthropic') {
        return { model: model || 'claude-3-5-sonnet-latest', max_tokens: 4096, system, messages: [{ role: 'user', content: userContent }] };
      }
      // OpenAI-compatible / custom chat completions style
      return { model: model || 'gpt-4o-mini', temperature: 0.2, messages: [{ role: 'system', content: system }, { role: 'user', content: userContent }] };
    },

    extractAssistantText(provider, data) {
      if (provider === 'anthropic') {
        const parts = data?.content || [];
        return parts.map(p => p.text || '').join('\n').trim() || JSON.stringify(data, null, 2);
      }
      const choice = data?.choices?.[0];
      if (choice?.message?.content) return choice.message.content;
      if (typeof data?.output_text === 'string') return data.output_text;
      return JSON.stringify(data, null, 2);
    },

    async callWithRotation(promptText) {
      this.persistAgentSettings();
      const provider = document.getElementById('agentProvider').value;
      const model = document.getElementById('agentModel').value.trim();
      const endpoint = this.getEndpoint(provider, document.getElementById('agentEndpoint').value.trim());
      if (!endpoint) throw new Error('No API endpoint configured for selected provider.');
      const keys = (AppState.apiKeys && AppState.apiKeys.length) ? [...AppState.apiKeys] : [''];
      const total = keys.length;
      const system = AppState.settings.systemPrompt || '';
      let lastError = null;

      for (let attempt = 0; attempt < total; attempt++) {
        const idx = (AppState.apiKeyIndex + attempt) % total;
        const key = keys[idx];
        const body = this.buildRequestBody(provider, model, system, promptText);
        try {
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: this.getHeaders(provider, key),
            body: JSON.stringify(body)
          });
          if (res.status === 429 || res.status === 402 || res.status === 403) {
            AppState.apiKeyIndex = (idx + 1) % total;
            this.updateKeyStatus();
            lastError = new Error(`Rate/auth limit on key index ${idx} (${res.status}). Rotating...`);
            continue;
          }
          if (!res.ok) {
            const t = await res.text();
            throw new Error(`API error ${res.status}: ${t.slice(0, 500)}`);
          }
          const data = await res.json();
          AppState.apiKeyIndex = idx; // stick with working key
          this.updateKeyStatus();
          return this.extractAssistantText(provider, data);
        } catch (e) {
          lastError = e;
          // network/CORS failures won't be fixable by rotation, but try next key once
          if (attempt === total - 1) break;
        }
      }
      throw lastError || new Error('All API keys failed.');
    },

    collectWorkspaceSummary(limitFiles = 12, limitChars = 2000) {
      const active = AppState.getActiveFile();
      const files = [...AppState.files.values()].filter(f => !f.binary).slice(0, limitFiles);
      let out = `Workspace: ${AppState.workspaceName}\nActive file: ${AppState.activeFilePath || '(none)'}\nFiles (${AppState.files.size} total):\n`;
      out += [...AppState.files.keys()].slice(0, 80).map(p => `- ${p}`).join('\n');
      if (active) out += `\n\n--- Active File Content (${active.path}) ---\n${String(active.content || '').slice(0, 8000)}`;
      return out;
    },

    parseAgentActions(text) {
      const actions = { edits: [], terminal: [], notes: '' };
      if (!text) return actions;
      const fences = [...text.matchAll(/```(?:json:edits|json)\s*([\s\S]*?)```/gi)];
      for (const m of fences) {
        const obj = Utils.safeJsonParse(m[1], null);
        if (obj && (Array.isArray(obj.edits) || Array.isArray(obj.terminal) || obj.notes)) {
          if (Array.isArray(obj.edits)) actions.edits.push(...obj.edits);
          if (Array.isArray(obj.terminal)) actions.terminal.push(...obj.terminal);
          if (obj.notes) actions.notes += (actions.notes ? '\n' : '') + obj.notes;
        }
      }
      return actions;
    },

    async runPrompt(prompt, opts = {}) {
      const useRag = opts.useRag ?? document.getElementById('agentUseRag').checked;
      const autoApply = document.getElementById('agentAutoApply').checked;
      let contextBlock = this.collectWorkspaceSummary();
      let ragMeta = '';
      if (useRag) {
        try {
          const rag = await RAG.buildContext(prompt, AppState.settings.ragK);
          if (rag.text) { contextBlock += `\n\n--- Retrieved RAG Context ---\n${rag.text}`; ragMeta = `${rag.results.length} snippets`; }
        } catch (e) { ragMeta = `RAG error: ${e.message}`; }
      }
      const mcpTools = MCP.getAllTools();
      if (mcpTools.length) {
        contextBlock += `\n\n--- Available MCP Tools ---\n` + mcpTools.map(t => `- ${t.server}:${t.name || t.id}${t.description ? ' - ' + t.description : ''}`).join('\n');
      }
      const payload = `${prompt}\n\n=== WORKSPACE CONTEXT ===\n${contextBlock}`;
      const answer = await this.callWithRotation(payload);
      const actions = this.parseAgentActions(answer);
      let execSummary = [];
      if (autoApply && actions.edits.length && window.Editor) {
        const applied = Editor.applyEdits(actions.edits);
        execSummary.push(`Applied ${applied.length} edit(s)`);
        // best-effort save if local handles exist
        for (const a of applied) {
          if (AppState.activeFilePath !== a.path) { /* keep active set by editor */ }
        }
      }
      if (actions.terminal && actions.terminal.length && window.TerminalPanel) {
        for (const t of actions.terminal) {
          if (t?.command) {
            const ok = TerminalPanel.runCommand(t.command);
            execSummary.push(`${ok ? 'Sent' : 'Skipped'} terminal command: ${t.command}`);
          }
        }
      }
      let suffix = '';
      if (actions.notes) suffix += `\n[Agent notes] ${actions.notes}`;
      if (execSummary.length) suffix += `\n[Execution] ${execSummary.join('; ')}`;
      if (ragMeta) suffix += `\n[RAG] ${ragMeta}`;
      this.addMessage('assistant', answer + (suffix ? `\n\n${suffix}` : ''), opts.fromWorkflow ? 'workflow' : 'chat');
      return { text: answer, actions, execution: execSummary };
    }
  };
  window.Agent = Agent;
})();
