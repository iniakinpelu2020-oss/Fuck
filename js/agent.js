(function () {
  const Agent = {
    init() {
      document.querySelectorAll('#agent-send-btn, #agent-send-btn-inline, #btnSendChat, [data-agent-send]').forEach((btn) => {
        if (btn.dataset.sendBound) return;
        btn.dataset.sendBound = '1';
        btn.addEventListener('click', () => this.sendFromUI());
      });
      document.getElementById('btnRunAgent').addEventListener('click', () => this.sendFromUI());
      const btnN8n = document.getElementById('btnTriggerN8n');
      if (btnN8n) btnN8n.addEventListener('click', () => this.triggerN8nFromUI());
      document.getElementById('btnIndexWorkspace').addEventListener('click', async () => { await RAG.indexWorkspace(); this.updateKeyStatus(); });
      document.getElementById('chatInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          this.sendFromUI();
        }
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
      AppState.subscribe((evt) => { if (evt === 'rag:indexed' || evt === 'rag:cleared' || evt === 'workspace:changed') this.updateKeyStatus(); });
      const bridge = window.ApexWorkflowBridge || window.AetherWorkflowBridge;
      if (bridge && typeof bridge.subscribe === 'function') {
        bridge.subscribe((state) => this.onN8nStatus(state));
      }
      AppState.subscribe((evt, payload) => { if (evt === 'n8n:status') this.onN8nStatus(payload); });
      this.updateKeyStatus();
      this.addMessage('assistant', 'Agent ready. Configure API keys, index workspace for RAG, and provide instructions. Edits can be auto-applied from JSON edit blocks.\n\nn8n-local-instance: configure webhook/auth in Vault, then use "Trigger n8n" or commands like `/n8n <message>` to send a JSON payload to your local n8n workflow.');
    },

    persistAgentSettings() {
      AppState.settings.agentEndpoint = document.getElementById('agentEndpoint').value.trim();
      AppState.settings.agentModel = document.getElementById('agentModel').value.trim();
      AppState.settings.agentProvider = document.getElementById('agentProvider').value;
      AppState.saveSettings();
    },

    updateKeyStatus() {
      const keys = AppState.apiKeys || [];
      const el = document.getElementById('agentKeyStatus');
      if (!el) return;
      const keyText = keys.length
        ? `Custom API keys: ${keys.length} (active #${(AppState.apiKeyIndex % keys.length) + 1})`
        : 'Apex Managed AI Active (or add custom keys below to override)';
      let ragText = '';
      if (window.RAG && RAG.stats) ragText = ` · RAG chunks: ${RAG.stats.chunks || 0}`;
      el.textContent = keyText + ragText;
      el.className = 'badge badge-success';
      el.title = keys.length
        ? 'Custom multi-key rotation enabled (overrides managed proxy when used)'
        : 'Using built-in Apex managed AI proxy (/api/chat). Add custom keys to override.';
    },

    escapeHtml(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); },

    renderMessageContent(content) {
      const text = String(content ?? '');
      const parts = text.split(/(```(?:json:edits|json)[\s\S]*?```)/gi);
      return parts.map(part => {
        const m = part.match(/^```((?:json:edits|json))\s*([\s\S]*?)```$/i);
        if (m) {
          const lang = m[1].toLowerCase();
          const body = m[2].replace(/\n$/, '');
          const cls = lang === 'json:edits' ? 'json-edits' : 'json-edits';
          const label = lang === 'json:edits' ? 'json:edits diff' : 'json';
          return `<details class="json-edits-card" ${lang === 'json:edits' ? 'open' : ''}><summary class="json-edits-summary"><span class="json-edits-dot"></span>${this.escapeHtml(label)}</summary><pre class="${cls}"><code>${this.escapeHtml(body)}</code></pre></details>`;
        }
        return `<span>${this.escapeHtml(part)}</span>`;
      }).join('');
    },

    addMessage(role, content, meta = '') {
      const wrap = document.getElementById('chatMessages');
      if (!wrap) return null;
      const div = document.createElement('div');
      div.className = `chat-msg ${role}`;
      const who = role === 'user' ? 'You' : (role === 'system' ? 'System' : 'Agent');
      const icon = role === 'user'
        ? '<span class="msg-avatar msg-avatar-user">U</span>'
        : '<span class="msg-avatar msg-avatar-agent">A</span>';
      const metaHtml = meta ? `<span class="badge badge-muted" style="margin-left:auto">${this.escapeHtml(meta)}</span>` : '';
      div.innerHTML = `<div class="meta">${icon}<span>${who}</span>${metaHtml}</div><pre class="chat-content">${this.renderMessageContent(content)}</pre>`;
      wrap.appendChild(div);
      wrap.scrollTop = wrap.scrollHeight;
      return div;
    },

    formatN8nBody(body) {
      if (body == null) return '(no response body)';
      if (typeof body === 'string') return body || '(empty response)';
      try { return JSON.stringify(body, null, 2); } catch { return String(body); }
    },

    onN8nStatus(state) {
      if (!state) return;
      if (state.status === 'sending') {
        this.addMessage('assistant', `n8n trigger: sending request...\nURL: ${state.url || '(not set)'}\nEvent: ${state.event || 'manual'}`, 'n8n');
      } else if (state.status === 'success' || state.status === 'error') {
        const lines = [];
        lines.push(`n8n trigger ${state.status === 'success' ? 'completed' : 'failed'}`);
        lines.push(`HTTP: ${state.httpStatus != null ? state.httpStatus : 'n/a'}`);
        if (state.url) lines.push(`URL: ${state.url}`);
        lines.push('');
        lines.push('Execution / response data:');
        lines.push(this.formatN8nBody(state.body));
        this.addMessage('assistant', lines.join('\n'), 'n8n');
      }
    },

    async triggerN8nFromUI() {
      const input = document.getElementById('chatInput');
      const prompt = (input?.value || '').trim();
      if (input) input.value = '';
      const message = prompt.replace(/^\/(?:n8n|trigger)\s*/i, '').trim() || prompt || 'Hello from Apex IDE';
      await this.triggerN8n(message, { from: 'agent-ui' });
    },

    async triggerN8n(message, extra = {}) {
      const bridge = window.ApexWorkflowBridge || window.AetherWorkflowBridge;
      if (!bridge || typeof bridge.trigger !== 'function') {
        this.addMessage('assistant', 'n8n bridge is not available.', 'n8n');
        return;
      }
      this.addMessage('user', message, 'n8n trigger');
      const sessionId = `apex_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const payload = {
        message,
        session_id: sessionId,
        user_id: 'apex-user',
        source: 'apex-agent',
        prompt: message,
        workspace: AppState.workspaceName || null,
        activeFile: AppState.activeFilePath || null,
        ...extra
      };
      try {
        await bridge.trigger('agent_chat', payload, { source: 'agent-chat' });
      } catch (e) {
        if (e && e.message && !String(e.message).includes('HTTP')) {
          this.addMessage('assistant', `n8n trigger error: ${e.message}`, 'n8n');
        }
      }
    },

    async sendFromUI() {
      const input = document.getElementById('chatInput');
      const prompt = input.value.trim();
      if (!prompt) return;
      if (/^\/(?:n8n|trigger)\b/i.test(prompt) || /^trigger\s+n8n\b/i.test(prompt)) {
        input.value = '';
        const message = prompt.replace(/^\/(?:n8n|trigger)\b/i, '').replace(/^trigger\s+n8n\b/i, '').trim() || 'Hello from Apex IDE';
        await this.triggerN8n(message, { from: 'agent-command' });
        return;
      }
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
      if (provider === 'openai-compatible') {
        const hasCustomKeys = Array.isArray(AppState.apiKeys) && AppState.apiKeys.length > 0;
        return hasCustomKeys ? 'https://api.openai.com/v1/chat/completions' : '/api/chat';
      }
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
        const body = { max_tokens: 4096, system, messages: [{ role: 'user', content: userContent }] };
        if (model) body.model = model;
        else body.model = 'claude-3-5-sonnet-latest';
        return body;
      }
      const body = { temperature: 0.2, messages: [{ role: 'system', content: system }, { role: 'user', content: userContent }] };
      if (model) body.model = model;
      return body;
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
      const endpointOverride = document.getElementById('agentEndpoint').value.trim();
      const endpoint = this.getEndpoint(provider, endpointOverride);
      if (!endpoint) throw new Error('No API endpoint configured for selected provider.');
      const customKeys = (AppState.apiKeys && AppState.apiKeys.length) ? [...AppState.apiKeys] : [];
      // Use built-in managed proxy when no custom keys and no endpoint override for OpenAI-compatible mode.
      const useManagedProxy = provider === 'openai-compatible' && customKeys.length === 0 && !endpointOverride;
      const keys = customKeys.length ? customKeys : [''];
      const total = keys.length;
      const system = AppState.settings.systemPrompt || '';
      let lastError = null;

      for (let attempt = 0; attempt < total; attempt++) {
        const idx = customKeys.length ? (AppState.apiKeyIndex + attempt) % total : 0;
        const key = keys[idx];
        const body = this.buildRequestBody(provider, model, system, promptText);
        const headers = this.getHeaders(provider, key);
        try {
          const res = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(body)
          });
          if ((res.status === 429 || res.status === 402 || res.status === 403) && customKeys.length > 1) {
            AppState.apiKeyIndex = (idx + 1) % total;
            this.updateKeyStatus();
            lastError = new Error(`Rate/auth limit on key index ${idx} (${res.status}). Rotating...`);
            continue;
          }
          if (!res.ok) {
            const t = await res.text();
            const prefix = useManagedProxy ? 'Managed proxy error' : 'API error';
            throw new Error(`${prefix} ${res.status}: ${t.slice(0, 500)}`);
          }
          const data = await res.json();
          if (customKeys.length) AppState.apiKeyIndex = idx;
          this.updateKeyStatus();
          return this.extractAssistantText(provider, data);
        } catch (e) {
          lastError = e;
          if (attempt === total - 1) break;
        }
      }
      throw lastError || new Error('All API keys failed.');
    },

    collectWorkspaceSummary(limitFiles = 12, limitChars = 2000) {
      const active = AppState.getActiveFile();
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
      this.addMessage('assistant', answer + (suffix ? `\n\n${suffix}` : ''), 'chat');
      return { text: answer, actions, execution: execSummary };
    }
  };
  window.Agent = Agent;
})();
