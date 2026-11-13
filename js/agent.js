(function () {
  const Agent = {
    _lastAutoAction: null,

    init() {
      document.querySelectorAll('#agent-send-btn, #agent-send-btn-inline, #btnSendChat, [data-agent-send]').forEach((btn) => {
        if (btn.dataset.sendBound) return;
        btn.dataset.sendBound = '1';
        btn.addEventListener('click', () => this.sendFromUI());
      });
      const runBtn = document.getElementById('btnRunAgent');
      if (runBtn) runBtn.addEventListener('click', () => this.sendFromUI());
      const btnN8n = document.getElementById('btnTriggerN8n');
      if (btnN8n) btnN8n.addEventListener('click', () => this.triggerN8nFromUI());
      const idxBtn = document.getElementById('btnIndexWorkspace');
      if (idxBtn) idxBtn.addEventListener('click', async () => { await RAG.indexWorkspace(); this.updateKeyStatus(); });
      const chat = document.getElementById('chatInput');
      if (chat) {
        chat.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.sendFromUI(); }
        });
        chat.addEventListener('input', () => this.autoResizeChat());
        this.autoResizeChat();
      }
      const keys = AppState.apiKeys || [];
      const keysEl = document.getElementById('apiKeysInput');
      if (keysEl) {
        keysEl.value = keys.join('\n');
        keysEl.addEventListener('change', () => {
          const arr = keysEl.value.split(/\n+/).map(s => s.trim()).filter(Boolean);
          AppState.saveApiKeys(arr);
          this.updateKeyStatus();
        });
      }
      const ep = document.getElementById('agentEndpoint'); if (ep) ep.value = AppState.settings.agentEndpoint || '';
      const model = document.getElementById('agentModel'); if (model) model.value = AppState.settings.agentModel || '';
      const prov = document.getElementById('agentProvider'); if (prov) prov.value = AppState.settings.agentProvider || 'openai-compatible';
      ['agentEndpoint','agentModel','agentProvider'].forEach(id => {
        const el = document.getElementById(id); if (el) el.addEventListener('change', () => this.persistAgentSettings());
      });
      AppState.subscribe((evt) => { if (evt === 'rag:indexed' || evt === 'rag:cleared' || evt === 'workspace:changed') this.updateKeyStatus(); });
      const bridge = window.ApexWorkflowBridge || window.AetherWorkflowBridge;
      if (bridge && typeof bridge.subscribe === 'function') bridge.subscribe((state) => this.onN8nStatus(state));
      AppState.subscribe((evt, payload) => { if (evt === 'n8n:status') this.onN8nStatus(payload); });
      this.updateKeyStatus();
      this.addMessage('assistant', 'Hi — I\'m Apex, your autonomous agent. Ask me to search the web, write or edit code, analyze binaries, or run automations. I\'ll decide which tools to use and show progress here.\n\nConfigure models, keys, MCP, RAG, and integrations in Settings (⚙️) if needed.');
    },

    autoResizeChat() {
      const el = document.getElementById('chatInput');
      if (!el) return;
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 192) + 'px';
    },

    persistAgentSettings() {
      const ep = document.getElementById('agentEndpoint'); if (ep) AppState.settings.agentEndpoint = ep.value.trim();
      const model = document.getElementById('agentModel'); if (model) AppState.settings.agentModel = model.value.trim();
      const prov = document.getElementById('agentProvider'); if (prov) AppState.settings.agentProvider = prov.value;
      AppState.saveSettings();
    },

    updateKeyStatus() {
      const keys = AppState.apiKeys || [];
      const el = document.getElementById('agentKeyStatus');
      if (!el) return;
      el.textContent = keys.length
        ? `Custom keys: ${keys.length} (#${(AppState.apiKeyIndex % keys.length) + 1})`
        : 'Apex Managed AI Active';
      el.className = 'badge badge-success !text-[10px] !px-2 !py-0.5';
      el.title = keys.length ? 'Custom multi-key rotation enabled' : 'Using built-in managed AI proxy. Configure custom keys in Settings.';
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
          const label = lang === 'json:edits' ? 'json:edits' : 'json';
          return `<details class="json-edits-card" ${lang === 'json:edits' ? 'open' : ''}><summary class="json-edits-summary"><span class="json-edits-dot"></span>${this.escapeHtml(label)}</summary><pre class="json-edits"><code>${this.escapeHtml(body)}</code></pre></details>`;
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
      const icon = role === 'user' ? '<span class="msg-avatar msg-avatar-user">U</span>' : '<span class="msg-avatar msg-avatar-agent">A</span>';
      const metaHtml = meta ? `<span class="badge badge-muted" style="margin-left:auto">${this.escapeHtml(meta)}</span>` : '';
      div.innerHTML = `<div class="meta">${icon}<span>${who}</span>${metaHtml}</div><pre class="chat-content">${this.renderMessageContent(content)}</pre>`;
      wrap.appendChild(div);
      wrap.scrollTop = wrap.scrollHeight;
      return div;
    },

    addStatusPill(text, state = 'running') {
      const wrap = document.getElementById('chatMessages');
      if (!wrap) return null;
      const div = document.createElement('div');
      div.className = `agent-status-pill ${state}`;
      div.innerHTML = `<span class="pill-dot"></span><span class="pill-text"></span>`;
      div.querySelector('.pill-text').textContent = text;
      wrap.appendChild(div);
      wrap.scrollTop = wrap.scrollHeight;
      return div;
    },
    updateStatusPill(el, text, state = 'done') {
      if (!el) return;
      if (text) { const t = el.querySelector('.pill-text'); if (t) t.textContent = text; }
      el.className = `agent-status-pill ${state}`;
      const wrap = document.getElementById('chatMessages');
      if (wrap) wrap.scrollTop = wrap.scrollHeight;
    },

    createStreamingAssistantBubble(meta = 'chat') {
      const wrap = document.getElementById('chatMessages');
      if (!wrap) return null;
      const div = document.createElement('div');
      div.className = 'chat-msg assistant streaming';
      const metaHtml = meta ? `<span class="badge badge-muted" style="margin-left:auto">${this.escapeHtml(meta)}</span>` : '';
      div.innerHTML = `<div class="meta"><span class="msg-avatar msg-avatar-agent">A</span><span>Agent</span>${metaHtml}</div><pre class="chat-content"><span class="thinking-inline"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="thinking-label">Thinking...</span></span></pre>`;
      wrap.appendChild(div);
      wrap.scrollTop = wrap.scrollHeight;
      const contentEl = div.querySelector('.chat-content');
      let text = '';
      let started = false;
      return {
        el: div,
        append(delta) {
          if (!delta) return;
          if (!started) { started = true; contentEl.textContent = ''; }
          text += delta;
          contentEl.textContent = text;
          wrap.scrollTop = wrap.scrollHeight;
        },
        setError(msg) {
          text = String(msg || 'Error');
          contentEl.textContent = text;
          div.classList.remove('streaming');
          wrap.scrollTop = wrap.scrollHeight;
        },
        getText() { return text; },
        finalize(suffix = '') {
          const full = text + (suffix || '');
          contentEl.innerHTML = Agent.renderMessageContent(full);
          div.classList.remove('streaming');
          wrap.scrollTop = wrap.scrollHeight;
          return full;
        }
      };
    },

    formatN8nBody(body) {
      if (body == null) return '(no response body)';
      if (typeof body === 'string') return body || '(empty response)';
      try { return JSON.stringify(body, null, 2); } catch { return String(body); }
    },

    onN8nStatus(state) {
      // Autonomous/background triggers surface via status pills in run flow; avoid noisy duplicate chat spam unless explicit UI trigger context.
      if (!state) return;
      if (state.source === 'agent-chat' || state.source === 'agent-autonomous') return;
      if (state.status === 'sending') this.addStatusPill('⚡ Running n8n workflow...', 'running');
      else if (state.status === 'success' || state.status === 'error') this.addMessage('assistant', `n8n workflow ${state.status} (HTTP ${state.httpStatus ?? 'n/a'})\n${this.formatN8nBody(state.body)}`, 'n8n');
    },

    async triggerN8nFromUI() {
      const input = document.getElementById('chatInput');
      const prompt = (input?.value || '').trim();
      const message = prompt.replace(/^\/(?:n8n|trigger)\s*/i, '').trim() || prompt || 'Hello from Apex IDE';
      if (prompt && input) input.value = '';
      await this.triggerN8n(message, { from: 'settings-test', showUser: true });
    },

    async triggerN8n(message, extra = {}, opts = {}) {
      const bridge = window.ApexWorkflowBridge || window.AetherWorkflowBridge;
      if (!bridge || typeof bridge.trigger !== 'function') {
        if (opts.showErrors !== false) this.addMessage('assistant', 'n8n webhook is not configured. Add it in Settings (⚙️).', 'n8n');
        return { ok: false, error: 'not_configured' };
      }
      const url = typeof bridge.getWebhookUrl === 'function' ? bridge.getWebhookUrl() : '';
      if (!url) {
        if (opts.showErrors !== false) this.addMessage('assistant', 'n8n webhook URL is not set. Configure it in Settings (⚙️).', 'n8n');
        return { ok: false, error: 'not_configured' };
      }
      if (opts.showUser) this.addMessage('user', message, 'n8n');
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
        const res = await bridge.trigger('agent_chat', payload, { source: opts.source || 'agent-chat' });
        return { ok: true, result: res };
      } catch (e) {
        return { ok: false, error: e.message || String(e) };
      }
    },

    async sendFromUI() {
      const input = document.getElementById('chatInput');
      if (!input) return;
      const prompt = input.value.trim();
      if (!prompt) return;
      // Back-compat: explicit /n8n commands still work, but routing is autonomous by default
      if (/^\/(?:n8n|trigger)\b/i.test(prompt) || /^trigger\s+n8n\b/i.test(prompt)) {
        input.value = ''; this.autoResizeChat();
        const message = prompt.replace(/^\/(?:n8n|trigger)\b/i, '').replace(/^trigger\s+n8n\b/i, '').trim() || prompt;
        this.addMessage('user', prompt);
        const streamBubble = this.createStreamingAssistantBubble('n8n'); // immediate "Thinking..." pulse
        const pill = this.addStatusPill('⚡ Running n8n workflow...', 'running');
        const r = await this.triggerN8n(message, { from: 'agent-command' }, { source: 'agent-chat', showErrors: true });
        this.updateStatusPill(pill, r.ok ? '⚡ n8n workflow triggered' : `⚡ n8n workflow failed${r.error ? ': ' + r.error : ''}`, r.ok ? 'done' : 'error');
        if (streamBubble) streamBubble.finalize(r.ok ? 'n8n workflow triggered successfully.' : `n8n workflow failed${r.error ? ': ' + r.error : ''}`);
        return;
      }
      input.value = ''; this.autoResizeChat();
      this.addMessage('user', prompt);
      // Immediate animated "Thinking..." pulse inside assistant bubble
      const streamBubble = this.createStreamingAssistantBubble('chat');
      try {
        await this.runPrompt(prompt, { fromUI: true, streamBubble });
      } catch (e) {
        if (streamBubble) streamBubble.setError(`Error: ${e.message}`);
        else this.addMessage('assistant', `Error: ${e.message}`);
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

    buildRequestBody(provider, model, system, userContent, opts = {}) {
      if (provider === 'anthropic') {
        const body = { max_tokens: 4096, system, messages: [{ role: 'user', content: userContent }] };
        if (model) body.model = model; else body.model = 'claude-3-5-sonnet-latest';
        return body; // Anthropic streaming protocol differs; keep non-streaming for compatibility
      }
      const body = { temperature: 0.2, messages: [{ role: 'system', content: system }, { role: 'user', content: userContent }] };
      if (model) body.model = model; // omit when empty so /api/chat uses server APEX_DEFAULT_MODEL
      if (opts.stream) body.stream = true;
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

    async callWithRotation(promptText, opts = {}) {
      return this.callLLM(promptText, opts);
    },

    async readSSEStream(res, onDelta) {
      const reader = res.body && res.body.getReader ? res.body.getReader() : null;
      if (!reader) return (await res.text().catch(() => '')) || '';
      const decoder = new TextDecoder();
      let buffer = '';
      let full = '';
      const flush = (line) => {
        const s = line.replace(/\r$/, '');
        if (!s.startsWith('data:')) return;
        const data = s.slice(5).trim();
        if (!data || data === '[DONE]') return;
        let obj;
        try { obj = JSON.parse(data); } catch { return; }
        let delta = '';
        const choice = obj && obj.choices && obj.choices[0];
        if (choice) {
          const d = choice.delta;
          if (d && typeof d.content === 'string') delta = d.content;
          else if (d && Array.isArray(d.content)) delta = d.content.map(p => (typeof p === 'string' ? p : (p && (p.text || p.content)) || '')).join('');
          else if (choice.message && typeof choice.message.content === 'string' && !full) delta = choice.message.content;
          else if (typeof choice.text === 'string') delta = choice.text;
        }
        if (!delta && typeof obj?.delta === 'string') delta = obj.delta;
        if (!delta && typeof obj?.content === 'string') delta = obj.content;
        if (delta) { full += delta; if (onDelta) onDelta(delta, full); }
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) { if (line.trim()) flush(line); }
      }
      if (buffer.trim()) flush(buffer);
      return full;
    },

    async callLLM(promptText, opts = {}) {
      this.persistAgentSettings();
      const provider = (document.getElementById('agentProvider') || {}).value || 'openai-compatible';
      const model = ((document.getElementById('agentModel') || {}).value || '').trim();
      const endpointOverride = ((document.getElementById('agentEndpoint') || {}).value || '').trim();
      const endpoint = this.getEndpoint(provider, endpointOverride);
      if (!endpoint) throw new Error('No API endpoint configured for selected provider.');
      const customKeys = (AppState.apiKeys && AppState.apiKeys.length) ? [...AppState.apiKeys] : [];
      const useManagedProxy = provider === 'openai-compatible' && customKeys.length === 0 && !endpointOverride;
      const keys = customKeys.length ? customKeys : [''];
      const total = keys.length;
      const system = AppState.settings.systemPrompt || '';
      const wantStream = opts.stream !== false && provider !== 'anthropic';
      let lastError = null;
      for (let attempt = 0; attempt < total; attempt++) {
        const idx = customKeys.length ? (AppState.apiKeyIndex + attempt) % total : 0;
        const key = keys[idx];
        const body = this.buildRequestBody(provider, model, system, promptText, { stream: wantStream });
        const headers = this.getHeaders(provider, key);
        try {
          const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
          if ((res.status === 429 || res.status === 402 || res.status === 403) && customKeys.length > 1) {
            AppState.apiKeyIndex = (idx + 1) % total; this.updateKeyStatus();
            lastError = new Error(`Rate/auth limit on key index ${idx} (${res.status}). Rotating...`);
            continue;
          }
          if (!res.ok) {
            const t = await res.text();
            throw new Error(`${useManagedProxy ? 'Managed proxy error' : 'API error'} ${res.status}: ${t.slice(0, 500)}`);
          }
          const ct = (res.headers.get('content-type') || '').toLowerCase();
          if (wantStream && ct.includes('text/event-stream') && res.body) {
            if (customKeys.length) AppState.apiKeyIndex = idx;
            this.updateKeyStatus();
            const full = await this.readSSEStream(res, opts.onDelta);
            if (opts.onDelta && full) { /* streamed live */ }
            return full;
          }
          // Non-streaming JSON fallback
          const data = await res.json().catch(async () => ({ raw: await res.text().catch(() => '') }));
          if (customKeys.length) AppState.apiKeyIndex = idx;
          this.updateKeyStatus();
          const text = this.extractAssistantText(provider, data);
          if (opts.onDelta && text) opts.onDelta(text, text);
          return text;
        } catch (e) {
          lastError = e;
          if (attempt === total - 1) break;
        }
      }
      throw lastError || new Error('All API keys failed.');
    },

    collectWorkspaceSummary() {
      const active = AppState.getActiveFile();
      let out = `Workspace: ${AppState.workspaceName}\nActive file: ${AppState.activeFilePath || '(none)'}\nFiles (${AppState.files.size} total):\n`;
      out += [...AppState.files.keys()].slice(0, 80).map(p => `- ${p}`).join('\n');
      if (active) out += `\n\n--- Active File Content (${active.path}) ---\n${String(active.content || '').slice(0, 8000)}`;
      return out;
    },

    parseAgentActions(text) {
      const actions = { edits: [], terminal: [], notes: '', mcp: [], n8n: null };
      if (!text) return actions;
      const fences = [...text.matchAll(/```(?:json:edits|json)\s*([\s\S]*?)```/gi)];
      for (const m of fences) {
        const obj = Utils.safeJsonParse(m[1], null);
        if (obj && (Array.isArray(obj.edits) || Array.isArray(obj.terminal) || Array.isArray(obj.mcp) || obj.n8n || obj.notes)) {
          if (Array.isArray(obj.edits)) actions.edits.push(...obj.edits);
          if (Array.isArray(obj.terminal)) actions.terminal.push(...obj.terminal);
          if (Array.isArray(obj.mcp)) actions.mcp.push(...obj.mcp);
          if (obj.n8n) actions.n8n = obj.n8n;
          if (obj.notes) actions.notes += (actions.notes ? '\n' : '') + obj.notes;
        }
      }
      return actions;
    },

    // --- Autonomous tool routing heuristics ---
    shouldSearch(prompt) {
      const p = String(prompt || '').toLowerCase();
      if (/(https?:\/\/)/.test(p)) return false; // direct URL fetch not our search tool
      const intent = /(search|look up|lookup|google|find online|web|internet|docs|documentation|latest|current|today|news|release|version|changelog|price|weather|who is|what is|when did|how to .*(202\d|latest)|compare .* (vs|versus) .* (202\d|latest)|error .* fix .* (202\d|latest))/i;
      const live = /(202[4-9]|latest|newest|current|recent|today|now|breaking)/i;
      return intent.test(prompt) || (live.test(prompt) && /(what|who|when|which|news|release|version|docs|api)/i.test(prompt));
    },
    shouldN8n(prompt) {
      const p = String(prompt || '').toLowerCase();
      if (/^\/(?:n8n|trigger)\b/i.test(p)) return true;
      const hasConfig = !!((window.ApexWorkflowBridge && ApexWorkflowBridge.getWebhookUrl && ApexWorkflowBridge.getWebhookUrl()) || (AppState.settings && AppState.settings.webhookUrl));
      if (!hasConfig) return false;
      return /(n8n|workflow automation|run (the )?workflow|trigger (the )?workflow|zapier-like|webhook automation|automation pipeline|execute automation)/i.test(prompt);
    },
    shouldBinaryAnalyze(prompt) {
      const p = String(prompt || '').toLowerCase();
      const hasBinary = !!(window.BinaryInspector && BinaryInspector.selectedFile);
      if (!hasBinary) return false;
      return /(analy[sz]e|inspect|reverse|binary|malware|strings|imports|what('?s| is) in (this|the) (binary|apk|exe|dmg|file)|security)/i.test(prompt) || (/(binary|apk|exe|dmg)/i.test(p));
    },

    async performWebSearch(query) {
      const res = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, numResults: 5 })
      });
      const data = await res.json().catch(() => ({}));
      return data;
    },
    formatSearchResults(data) {
      if (!data) return 'No search response.';
      if (data.error && (!data.results || !data.results.length)) {
        return `Search unavailable: ${data.error}`;
      }
      const lines = [];
      if (data.answer) lines.push(`Answer: ${data.answer}`);
      const results = Array.isArray(data.results) ? data.results : [];
      if (!results.length) lines.push('No web results found.');
      results.slice(0, 6).forEach((r, i) => {
        lines.push(`\n[${i + 1}] ${r.title || '(untitled)'}`);
        if (r.url) lines.push(`Source: ${r.url}`);
        if (r.content) lines.push(String(r.content).slice(0, 500));
      });
      if (data.error && results.length) lines.push(`\n(note: ${data.error})`);
      return lines.join('\n').trim();
    },

    async runPrompt(prompt, opts = {}) {
      const useRagEl = document.getElementById('agentUseRag');
      const autoApplyEl = document.getElementById('agentAutoApply');
      const useRag = opts.useRag ?? (useRagEl ? useRagEl.checked : true);
      const autoApply = autoApplyEl ? autoApplyEl.checked : true;
      const toolNotes = [];
      let extraContext = '';
      let ragMeta = '';

      // Autonomous tool routing
      const wantsSearch = this.shouldSearch(prompt);
      if (wantsSearch) {
        const pill = this.addStatusPill('🔍 Searching web...', 'running');
        try {
          const data = await this.performWebSearch(prompt);
          const formatted = this.formatSearchResults(data);
          const ok = Array.isArray(data.results) && data.results.length > 0;
          extraContext += `\n\n--- Web Search Results (/api/search) ---\n${formatted}`;
          toolNotes.push(ok ? `Web search: ${data.results.length} result(s)` : (data.error ? `Web search: ${data.error}` : 'Web search: no results'));
          this.updateStatusPill(pill, ok ? `🔍 Searched web (${data.results.length} sources)` : `🔍 Web search: ${data.error || 'no results'}`, ok ? 'done' : 'warn');
        } catch (e) {
          toolNotes.push(`Web search failed: ${e.message}`);
          this.updateStatusPill(pill, `🔍 Web search failed: ${e.message}`, 'error');
        }
      }

      let contextBlock = this.collectWorkspaceSummary();

      if (this.shouldBinaryAnalyze(prompt)) {
        const pill = this.addStatusPill('🧪 Analyzing binary...', 'running');
        try {
          const text = await BinaryInspector.analyze();
          extraContext += `\n\n--- Binary Inspection Output ---\n${String(text || '').slice(0, 12000)}`;
          toolNotes.push(`Binary analysis: ${BinaryInspector.selectedFile ? BinaryInspector.selectedFile.name : 'completed'}`);
          this.updateStatusPill(pill, `🧪 Binary analyzed${BinaryInspector.selectedFile ? ': ' + BinaryInspector.selectedFile.name : ''}`, 'done');
          if (window.App && App.setView) App.setView('workspace');
        } catch (e) {
          toolNotes.push(`Binary analysis failed: ${e.message}`);
          this.updateStatusPill(pill, `🧪 Binary analysis failed: ${e.message}`, 'error');
        }
      }

      // autonomous n8n trigger (if clearly requested/automation intent and configured)
      if (this.shouldN8n(prompt)) {
        const pill = this.addStatusPill('⚡ Running n8n workflow...', 'running');
        const r = await this.triggerN8n(prompt, { from: 'agent-autonomous', prompt }, { source: 'agent-autonomous', showErrors: false });
        if (r.ok) {
          toolNotes.push('n8n workflow triggered');
          extraContext += `\n\n--- n8n Automation ---\nTriggered configured n8n webhook successfully (HTTP ${r.result?.httpStatus ?? 'ok'}). Response: ${this.formatN8nBody(r.result?.body).slice(0, 2000)}`;
          this.updateStatusPill(pill, '⚡ n8n workflow triggered', 'done');
        } else {
          toolNotes.push(`n8n not triggered: ${r.error}`);
          extraContext += `\n\n--- n8n Automation ---\nNot triggered/configured: ${r.error}`;
          this.updateStatusPill(pill, `⚡ n8n not triggered (${r.error || 'unavailable'})`, r.error === 'not_configured' ? 'warn' : 'error');
        }
      }

      // MCP hint: agent decides via prompt context; we expose tools (and note availability)
      const mcpTools = (window.MCP && MCP.getAllTools) ? MCP.getAllTools() : [];
      if (mcpTools.length) {
        contextBlock += `\n\n--- Available MCP Tools ---\n` + mcpTools.map(t => `- ${t.server}:${t.name || t.id}${t.description ? ' - ' + t.description : ''}`).join('\n');
      }

      if (useRag && window.RAG) {
        try {
          const rag = await RAG.buildContext(prompt, AppState.settings.ragK);
          if (rag && rag.text) { contextBlock += `\n\n--- Retrieved RAG Context ---\n${rag.text}`; ragMeta = `${rag.results.length} snippets`; }
        } catch (e) { ragMeta = `RAG error: ${e.message}`; }
      }

      contextBlock += extraContext;
      const payload = `${prompt}\n\n=== WORKSPACE & TOOL CONTEXT ===\n${contextBlock}`;

      const streamBubble = opts.streamBubble || this.createStreamingAssistantBubble('chat');
      let answer = '';
      try {
        answer = await this.callLLM(payload, {
          stream: true,
          onDelta: (delta) => { if (streamBubble) streamBubble.append(delta); }
        });
      } catch (e) {
        if (streamBubble) streamBubble.setError(`Error: ${e.message}`);
        throw e;
      }
      // Ensure bubble shows content if non-stream fallback returned text without deltas
      if (streamBubble && answer && !streamBubble.getText()) streamBubble.append(answer);
      if (!answer && streamBubble) answer = streamBubble.getText();

      const actions = this.parseAgentActions(answer || '');
      const execSummary = [];

      if (autoApply && actions.edits.length && window.Editor) {
        this._lastAutoAction = 'edit';
        const editPill = this.addStatusPill(`📝 Applying edits to ${actions.edits.map(e=>e.path).filter(Boolean).slice(0,2).join(', ') || 'files'}...`, 'running');
        const applied = Editor.applyEdits(actions.edits);
        execSummary.push(`Applied ${applied.length} edit(s): ${applied.map(a=>a.path).join(', ')}`);
        this.updateStatusPill(editPill, `📝 Edited ${applied.length} file(s)`, 'done');
        // auto-open editor on agent changes
        if (applied.length && window.App && App.setView) App.setView('editor');
        setTimeout(() => { this._lastAutoAction = null; }, 500);
      }

      if (actions.terminal && actions.terminal.length && window.TerminalPanel) {
        for (const t of actions.terminal) {
          if (t?.command) {
            const ok = TerminalPanel.runCommand(t.command);
            execSummary.push(`${ok ? 'Sent' : 'Skipped'} terminal command: ${t.command}`);
          }
        }
      }

      // Execute MCP tool calls requested by agent (structured actions)
      if (actions.mcp && actions.mcp.length && window.MCP && MCP.callTool) {
        for (const call of actions.mcp) {
          const server = call.server || call.serverName;
          const tool = call.tool || call.name || call.toolName;
          const args = call.arguments || call.args || {};
          if (!server || !tool) continue;
          const pill = this.addStatusPill(`🔌 Calling MCP ${server}:${tool}...`, 'running');
          try {
            await MCP.callTool(server, tool, args);
            execSummary.push(`MCP ${server}:${tool} executed`);
            this.updateStatusPill(pill, `🔌 MCP ${server}:${tool} completed`, 'done');
          } catch (e) {
            execSummary.push(`MCP ${server}:${tool} failed: ${e.message}`);
            this.updateStatusPill(pill, `🔌 MCP ${server}:${tool} failed`, 'error');
          }
        }
      }

      // Execute n8n action requested by agent (structured action)
      if (actions.n8n) {
        const msg = (typeof actions.n8n === 'string') ? actions.n8n : (actions.n8n.message || actions.n8n.prompt || prompt);
        const pill = this.addStatusPill('⚡ Running n8n workflow...', 'running');
        const r = await this.triggerN8n(msg, typeof actions.n8n === 'object' ? actions.n8n : { from: 'agent-action' }, { source: 'agent-autonomous', showErrors: false });
        if (r.ok) { execSummary.push('n8n workflow triggered (agent action)'); this.updateStatusPill(pill, '⚡ n8n workflow triggered', 'done'); }
        else { execSummary.push(`n8n action failed: ${r.error}`); this.updateStatusPill(pill, `⚡ n8n action failed`, r.error === 'not_configured' ? 'warn' : 'error'); }
      }

      let suffix = '';
      if (actions.notes) suffix += `\n[Agent notes] ${actions.notes}`;
      if (execSummary.length) suffix += `\n[Execution] ${execSummary.join('; ')}`;
      if (toolNotes.length) suffix += `\n[Tools] ${toolNotes.join(' | ')}`;
      if (ragMeta) suffix += `\n[RAG] ${ragMeta}`;
      const suffixBlock = suffix ? `\n\n${suffix}` : '';
      if (streamBubble) streamBubble.finalize(suffixBlock);
      else this.addMessage('assistant', (answer || '') + suffixBlock, 'chat');
      return { text: answer || '', actions, execution: execSummary, tools: toolNotes };
    }
  };
  window.Agent = Agent;
})();
