(function () {
  const Agent = {
    _lastAutoAction: null,
    isGenerating: false,

    setGenerating(state) {
      this.isGenerating = !!state;
      const btns = [
        document.getElementById('agent-send-btn-inline'),
        document.getElementById('agent-send-btn'),
        document.querySelector('[data-agent-send="inline"]'),
        document.querySelector('#btnSendChat')
      ];
      btns.forEach(btn => {
        if (!btn) return;
        btn.disabled = this.isGenerating;
        if (this.isGenerating) {
          btn.classList.add('opacity-50', 'cursor-not-allowed', 'pointer-events-none');
          btn.setAttribute('aria-disabled', 'true');
        } else {
          btn.classList.remove('opacity-50', 'cursor-not-allowed', 'pointer-events-none');
          btn.removeAttribute('aria-disabled');
        }
      });
      const input = document.getElementById('chatInput');
      if (input) input.setAttribute('aria-busy', this.isGenerating ? 'true' : 'false');
    },

    init() {
      document.querySelectorAll('#agent-send-btn, #agent-send-btn-inline, #btnSendChat, [data-agent-send]').forEach((btn) => {
        if (btn.dataset.sendBound) return;
        btn.dataset.sendBound = '1';
        btn.addEventListener('click', () => { if (!this.isGenerating) this.sendFromUI(); });
      });
      const runBtn = document.getElementById('btnRunAgent');
      if (runBtn) runBtn.addEventListener('click', () => { if (!this.isGenerating) this.sendFromUI(); });
      const btnN8n = document.getElementById('btnTriggerN8n');
      if (btnN8n) btnN8n.addEventListener('click', () => { if (!this.isGenerating) this.triggerN8nFromUI(); });
      const idxBtn = document.getElementById('btnIndexWorkspace');
      if (idxBtn) idxBtn.addEventListener('click', async () => { await RAG.indexWorkspace(); this.updateKeyStatus(); });
      const chat = document.getElementById('chatInput');
      if (chat) {
        chat.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!this.isGenerating) this.sendFromUI(); }
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
        : 'Apex Studio Managed AI Active';
      el.className = 'badge badge-success !text-[10px] !px-2 !py-0.5';
      el.title = keys.length ? 'Custom multi-key rotation enabled' : 'Using built-in managed AI proxy. Configure custom keys in Settings.';
    },

    escapeHtml(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); },

    stripActionBlocks(text) {
      let s = String(text ?? '');
      // Remove json:edits fences and json fences that contain tool/action payloads
      s = s.replace(/```json:edits\s*[\s\S]*?```/gi, '');
      s = s.replace(/```json\s*([\s\S]*?)```/gi, (m, body) => {
        const obj = Utils.safeJsonParse(body, null);
        if (obj && (obj.edits || obj.terminal || obj.mcp || obj.n8n)) return '';
        // collapse other JSON blocks to a compact details element
        const trimmed = String(body || '').trim();
        if (!trimmed) return '';
        return `<details class="json-edits-card"><summary class="json-edits-summary"><span class="json-edits-dot"></span>json</summary><pre class="json-edits"><code>${this.escapeHtml(trimmed)}</code></pre></details>`;
      });
      // Clean excessive blank lines left by stripping
      s = s.replace(/\n{3,}/g, '\n\n').trim();
      return s;
    },

    streamDisplayText(text) {
      let s = String(text ?? '');
      // strip complete action blocks
      s = s.replace(/```json:edits\s*[\s\S]*?```/gi, '');
      s = s.replace(/```json\s*([\s\S]*?)```/gi, (m, body) => {
        const obj = Utils.safeJsonParse(body, null);
        if (obj && (obj.edits || obj.terminal || obj.mcp || obj.n8n)) return '';
        return m; // keep non-action json visible (will render on finalize)
      });
      // hide incomplete trailing action fence during streaming so raw JSON doesn't flash
      const fenceRe = /```(?:json:edits|json)\b/gi;
      let m, last = -1;
      while ((m = fenceRe.exec(s)) !== null) last = m.index;
      if (last >= 0) {
        const tail = s.slice(last);
        if (!/```\s*$/.test(tail.replace(/```(?:json:edits|json)\b/i, ''))) {
          // no closing fence yet for this action block start -> hide from start of trailing fence
          s = s.slice(0, last);
        }
      }
      return s.replace(/\n{3,}/g, '\n\n');
    },

    renderMessageContent(content, opts = {}) {
      const stripped = (opts.raw === true) ? String(content ?? '') : this.stripActionBlocks(content);
      // stripActionBlocks may return HTML for collapsed non-action json blocks; handle mixed content safely
      const parts = String(stripped).split(/(<details class="json-edits-card">[\s\S]*?<\/details>)/gi);
      return parts.map(part => {
        if (/^<details class="json-edits-card">/i.test(part)) return part;
        return `<span>${this.escapeHtml(part)}</span>`;
      }).join('');
    },

    renderBadges(badges) {
      const arr = (badges || []).filter(Boolean);
      if (!arr.length) return '';
      return `<div class="chat-badges">${arr.map(b => `<span class="chat-badge">${this.escapeHtml(b)}</span>`).join('')}</div>`;
    },

    addMessage(role, content, meta = '', badges = []) {
      const wrap = document.getElementById('chatMessages');
      if (!wrap) return null;
      const div = document.createElement('div');
      div.className = `chat-msg ${role}`;
      const who = role === 'user' ? 'You' : (role === 'system' ? 'System' : 'Agent');
      const icon = role === 'user' ? '<span class="msg-avatar msg-avatar-user">U</span>' : '<span class="msg-avatar msg-avatar-agent">A</span>';
      const metaHtml = meta ? `<span class="badge badge-muted" style="margin-left:auto">${this.escapeHtml(meta)}</span>` : '';
      div.innerHTML = `<div class="meta">${icon}<span>${who}</span>${metaHtml}</div><pre class="chat-content">${this.renderMessageContent(content)}</pre>${this.renderBadges(badges)}`;
      wrap.appendChild(div);
      wrap.scrollTop = wrap.scrollHeight;

      // Persist message to active chat session
      try {
        const id = AppState.activeChatId;
        if (id && AppState.chatSessions) {
          const s = AppState.getChat(id);
          if (s) {
            if (!s.messages) s.messages = [];
            s.messages.push({ role, content, meta, badges, ts: Date.now() });
            s.updatedAt = Date.now();
            AppState.saveChatSessions();
            if (window.App && typeof App.renderChatHistory === 'function') App.renderChatHistory();
          }
        }
      } catch (e) { /* persistence should not break chat */ }

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
      div.innerHTML = `<div class="meta"><span class="msg-avatar msg-avatar-agent">A</span><span>Agent</span>${metaHtml}</div><pre class="chat-content"><span class="thinking-inline"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="thinking-label">Thinking...</span></span></pre><div class="chat-badges"></div>`;
      wrap.appendChild(div);
      wrap.scrollTop = wrap.scrollHeight;
      const contentEl = div.querySelector('.chat-content');
      const badgesEl = div.querySelector('.chat-badges');
      let text = '';
      let started = false;
      return {
        el: div,
        append(delta) {
          if (!delta) return;
          if (!started) { started = true; contentEl.textContent = ''; }
          text += delta;
          contentEl.textContent = Agent.streamDisplayText(text);
          wrap.scrollTop = wrap.scrollHeight;
        },
        setError(msg) {
          text = String(msg || 'Error');
          contentEl.textContent = text;
          div.classList.remove('streaming');
          wrap.scrollTop = wrap.scrollHeight;
        },
        getText() { return text; },
        finalize(displayText = null, badges = []) {
          const full = (displayText != null ? String(displayText) : text);
          contentEl.innerHTML = Agent.renderMessageContent(full);
          if (badgesEl) badgesEl.innerHTML = Agent.renderBadges(badges);
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
      if (this.isGenerating) return;
      this.setGenerating(true);
      try {
        const input = document.getElementById('chatInput');
        const prompt = (input?.value || '').trim();
        const message = prompt.replace(/^\/(?:n8n|trigger)\s*/i, '').trim() || prompt || 'Hello from Apex Studio';
        if (prompt && input) { input.value = ''; this.autoResizeChat(); }
        this.addMessage('user', message, 'n8n');
        const streamBubble = this.createStreamingAssistantBubble('n8n');
        const pill = this.addStatusPill('⚡ Running n8n workflow...', 'running');
        const r = await this.triggerN8n(message, { from: 'settings-test' }, { source: 'agent-chat', showErrors: true });
        this.updateStatusPill(pill, r.ok ? '⚡ n8n workflow triggered' : `⚡ n8n workflow failed${r.error ? ': ' + r.error : ''}`, r.ok ? 'done' : 'error');
        if (streamBubble) streamBubble.finalize(r.ok ? 'n8n workflow triggered successfully.' : `n8n workflow failed${r.error ? ': ' + r.error : ''}`);
      } finally {
        this.setGenerating(false);
      }
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
      if (this.isGenerating) return;
      const input = document.getElementById('chatInput');
      if (!input) return;
      const prompt = input.value.trim();
      if (!prompt) return;

      // Back-compat: explicit /n8n commands still work, but routing is autonomous by default
      if (/^\/(?:n8n|trigger)\b/i.test(prompt) || /^trigger\s+n8n\b/i.test(prompt)) {
        this.setGenerating(true);
        try {
          input.value = ''; this.autoResizeChat();
          const message = prompt.replace(/^\/(?:n8n|trigger)\b/i, '').replace(/^trigger\s+n8n\b/i, '').trim() || prompt;
          this.addMessage('user', prompt);
          const streamBubble = this.createStreamingAssistantBubble('n8n'); // immediate "Thinking..." pulse
          const pill = this.addStatusPill('⚡ Running n8n workflow...', 'running');
          const r = await this.triggerN8n(message, { from: 'agent-command' }, { source: 'agent-chat', showErrors: true });
          this.updateStatusPill(pill, r.ok ? '⚡ n8n workflow triggered' : `⚡ n8n workflow failed${r.error ? ': ' + r.error : ''}`, r.ok ? 'done' : 'error');
          if (streamBubble) streamBubble.finalize(r.ok ? 'n8n workflow triggered successfully.' : `n8n workflow failed${r.error ? ': ' + r.error : ''}`);
        } finally {
          this.setGenerating(false);
        }
        return;
      }

      this.setGenerating(true);
      input.value = ''; this.autoResizeChat();
      this.addMessage('user', prompt);
      // Immediate animated "Thinking..." pulse inside assistant bubble
      const streamBubble = this.createStreamingAssistantBubble('chat');
      try {
        await this.runPrompt(prompt, { fromUI: true, streamBubble });
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        console.error('Agent send error:', e);
        if (streamBubble) streamBubble.setError(`Error: ${msg}`);
        else this.addMessage('assistant', `Error: ${msg}`);
      } finally {
        this.setGenerating(false);
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

    // --- LLM tool-calling (OpenAI-compatible) & MCP tool schema ---
    getMcpToolSpecs() {
      const specs = [];
      if (!(window.MCP && typeof MCP.getAllTools === 'function')) return specs;
      let tools = [];
      try { tools = MCP.getAllTools() || []; } catch { tools = []; }
      if (!Array.isArray(tools)) return specs;
      for (const t of tools) {
        try {
          const server = String((t && (t.server || '')) || '').trim();
          const name = String((t && (t.name || t.id || '')) || '').trim();
          if (!server || !name) continue;
          // Sanitize to valid OpenAI tool name: alphanumeric, underscore, hyphen (max 64 chars)
          const rawPrefixed = `mcp__${server}__${name}`;
          const prefixed = rawPrefixed.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
          if (!prefixed) continue;
          const desc = String((t && t.description) || `MCP tool ${name} on server ${server}`).slice(0, 500);
          let params = (t && (t.inputSchema || t.parameters || t.input_schema || t.schema)) || { type: 'object', properties: {} };
          // Ensure valid JSON schema object for OpenAI tools
          if (!params || typeof params !== 'object' || Array.isArray(params)) params = { type: 'object', properties: {} };
          // Remove $schema and other non-standard top-level keys that some providers reject
          const cleanParams = { type: 'object', properties: {} };
          if (params.type && typeof params.type === 'string') cleanParams.type = params.type;
          if (params.properties && typeof params.properties === 'object' && !Array.isArray(params.properties)) cleanParams.properties = params.properties;
          if (Array.isArray(params.required)) cleanParams.required = params.required.filter(x => typeof x === 'string');
          if (params.description && typeof params.description === 'string') cleanParams.description = params.description;
          specs.push({
            type: 'function',
            function: {
              name: prefixed,
              description: desc || 'MCP tool',
              parameters: cleanParams
            },
            _mcp: { server, tool: name }
          });
        } catch { /* skip malformed tool spec */ }
      }
      return specs;
    },

    getBuiltinToolSpecs() {
      // Expose remote/local shell as a callable tool so LLM can request execution via tool_calls
      return [{
        type: 'function',
        function: {
          name: 'run_shell',
          description: 'Execute a terminal/shell command in the configured Remote Runner (if set) or in the browser sandbox. Returns command output.',
          parameters: {
            type: 'object',
            properties: {
              command: { type: 'string', description: 'Shell command to execute' }
            },
            required: ['command']
          }
        },
        _builtin: { name: 'run_shell' }
      }];
    },

    getLlmTools() {
      const tools = [];
      // Dynamic MCP tools from enabled/discovered servers (only include when actually available)
      try {
        const mcpSpecs = this.getMcpToolSpecs();
        if (Array.isArray(mcpSpecs) && mcpSpecs.length) tools.push(...mcpSpecs);
      } catch { /* ignore */ }
      // Do NOT include builtin shell tool by default - it forces every request to send `tools`
      // which many upstreams/proxies reject. Shell execution is handled via structured actions.
      // Validate: ensure every tool has valid name, description, parameters
      return tools.filter(t => {
        try {
          if (!t || t.type !== 'function' || !t.function) return false;
          const fn = t.function;
          if (!fn.name || typeof fn.name !== 'string') return false;
          if (!/^[a-zA-Z0-9_-]{1,64}$/.test(fn.name)) return false;
          if (typeof fn.description !== 'string') fn.description = String(fn.description || '');
          if (!fn.parameters || typeof fn.parameters !== 'object' || Array.isArray(fn.parameters)) {
            fn.parameters = { type: 'object', properties: {} };
          }
          return true;
        } catch { return false; }
      });
    },

    parseMcpPrefixedToolName(name) {
      const s = String(name || '');
      const m = s.match(/^mcp__(.+?)__(.+)$/);
      if (!m) return null;
      return { server: m[1], tool: m[2] };
    },

    normalizeToolCallArgs(rawArgs) {
      if (rawArgs == null) return {};
      if (typeof rawArgs === 'object') return Array.isArray(rawArgs) ? { value: rawArgs } : rawArgs;
      if (typeof rawArgs === 'string') {
        const s = rawArgs.trim();
        if (!s) return {};
        const parsed = Utils.safeJsonParse(s, null);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        if (parsed != null) return { value: parsed };
        return { raw: s };
      }
      return { value: rawArgs };
    },

    buildRequestBody(provider, model, system, userContentOrMessages, opts = {}) {
      // Accepts a plain prompt string (legacy) or a full messages array (native tool loop)
      if (provider === 'anthropic') {
        const content = Array.isArray(userContentOrMessages)
          ? String((userContentOrMessages[userContentOrMessages.length - 1] || {}).content || '')
          : String(userContentOrMessages || '');
        const body = { max_tokens: 4096, system, messages: [{ role: 'user', content }] };
        body.model = model || 'claude-3-5-sonnet-latest';
        return body; // Anthropic streaming/tool protocol differs; keep simple for compatibility
      }
      const messages = Array.isArray(userContentOrMessages)
        ? userContentOrMessages
        : [
            { role: 'system', content: String(system || '') },
            { role: 'user', content: String(userContentOrMessages || '') }
          ];
      const body = { temperature: 0.2, messages };
      if (model) body.model = model; // omit when empty so /api/chat can apply server default
      if (opts.stream) body.stream = true;
      if (Array.isArray(opts.tools) && opts.tools.length) {
        // strip internal metadata before sending
        body.tools = opts.tools.map(t => ({ type: t.type || 'function', function: t.function }));
        if (opts.tool_choice) body.tool_choice = opts.tool_choice;
      }
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
      if (!reader) return { text: (await res.text().catch(() => '')) || '', toolCalls: [] };
      const decoder = new TextDecoder();
      let buffer = '';
      let full = '';
      const toolCallsMap = new Map(); // index -> {id,type,function:{name,arguments}}

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
          const d = choice.delta || {};
          // content delta
          if (typeof d.content === 'string') delta = d.content;
          else if (Array.isArray(d.content)) delta = d.content.map(p => (typeof p === 'string' ? p : (p && (p.text || p.content)) || '')).join('');
          else if (choice.message && typeof choice.message.content === 'string' && !full) delta = choice.message.content;
          else if (typeof choice.text === 'string') delta = choice.text;

          // tool_calls delta (OpenAI streaming)
          if (Array.isArray(d.tool_calls)) {
            for (const tc of d.tool_calls) {
              const idx = (tc && tc.index != null) ? Number(tc.index) : toolCallsMap.size;
              const cur = toolCallsMap.get(idx) || { id: tc.id || `call_${idx}`, type: tc.type || 'function', function: { name: '', arguments: '' } };
              if (tc.id) cur.id = tc.id;
              if (tc.type) cur.type = tc.type;
              if (tc.function) {
                if (tc.function.name) cur.function.name = (cur.function.name || '') + tc.function.name;
                if (tc.function.arguments) cur.function.arguments = (cur.function.arguments || '') + tc.function.arguments;
              }
              toolCallsMap.set(idx, cur);
            }
          }
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

      const toolCalls = Array.from(toolCallsMap.entries()).sort((a,b)=>a[0]-b[0]).map(([_, v]) => v).filter(tc => tc && tc.function && tc.function.name);
      return { text: full, toolCalls };
    },

    async callLLM(promptTextOrMessages, opts = {}) {
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
      const wantStream = opts.stream !== false && provider !== 'anthropic' && !opts.disableStream;
      let lastError = null;

      for (let attempt = 0; attempt < total; attempt++) {
        const idx = customKeys.length ? (AppState.apiKeyIndex + attempt) % total : 0;
        const key = keys[idx];
        const body = this.buildRequestBody(provider, model, system, promptTextOrMessages, { stream: wantStream, tools: opts.tools, tool_choice: opts.tool_choice });
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
            const out = await this.readSSEStream(res, opts.onDelta);
            return { text: out.text || '', toolCalls: out.toolCalls || [], raw: null };
          }
          // Non-streaming JSON fallback
          const data = await res.json().catch(async () => ({ raw: await res.text().catch(() => '') }));
          if (customKeys.length) AppState.apiKeyIndex = idx;
          this.updateKeyStatus();
          const text = this.extractAssistantText(provider, data);
          const toolCalls = Array.isArray(data?.choices?.[0]?.message?.tool_calls) ? data.choices[0].message.tool_calls : [];
          if (opts.onDelta && text) opts.onDelta(text, text);
          return { text: text || '', toolCalls, raw: data };
        } catch (e) {
          lastError = e;
          // If tools caused the failure (400/422), retry once without tools
          const msg = String(e && e.message || '');
          if (opts.tools && opts.tools.length && (/\b400\b/.test(msg) || /\b422\b/.test(msg))) {
            try {
              console.warn('LLM call failed with tools, retrying without tools:', msg);
              const retryBody = this.buildRequestBody(provider, model, system, promptTextOrMessages, { stream: wantStream });
              const retryRes = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(retryBody) });
              if (retryRes.ok) {
                const rct = (retryRes.headers.get('content-type') || '').toLowerCase();
                if (wantStream && rct.includes('text/event-stream') && retryRes.body) {
                  if (customKeys.length) AppState.apiKeyIndex = idx;
                  this.updateKeyStatus();
                  const out = await this.readSSEStream(retryRes, opts.onDelta);
                  return { text: out.text || '', toolCalls: [], raw: null, toolsStripped: true };
                }
                const rdata = await retryRes.json().catch(async () => ({ raw: await retryRes.text().catch(() => '') }));
                if (customKeys.length) AppState.apiKeyIndex = idx;
                this.updateKeyStatus();
                const rtext = this.extractAssistantText(provider, rdata);
                if (opts.onDelta && rtext) opts.onDelta(rtext, rtext);
                return { text: rtext || '', toolCalls: [], raw: rdata, toolsStripped: true };
              }
              const rt = await retryRes.text().catch(() => '');
              lastError = new Error(`${useManagedProxy ? 'Managed proxy error' : 'API error'} ${retryRes.status}: ${rt.slice(0, 500)}`);
            } catch (re) { lastError = re; }
          }
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

    buildActionBadges(execSummary = [], toolNotes = [], applied = [], cmdResults = [], extras = []) {
      const badges = [];
      // tool/search/automation notes
      for (const n of (toolNotes || [])) {
        const s = String(n || '');
        if (/^Web search:s*d+/i.test(s)) badges.push(`✓ Searched web`);
        else if (/^Web search:/i.test(s)) badges.push(`✓ Web search`);
        else if (/n8n workflow triggered/i.test(s)) badges.push(`✓ n8n workflow`);
        else if (/Binary analysis/i.test(s)) badges.push(`✓ Binary analyzed`);
      }
      for (const a of (applied || [])) {
        badges.push(`${a.created ? '✓ Created' : '✓ Updated'} ${a.path}`);
      }
      for (const r of (cmdResults || [])) {
        if (!r || !r.cmd) continue;
        const short = r.cmd.length > 42 ? r.cmd.slice(0, 39) + '…' : r.cmd;
        if (r.mode === 'browser' && !r.remote) badges.push(`✓ Ran in sandbox: ${short}`);
        else if (r.remote) badges.push(`✓ Ran remotely: ${short}`);
        else badges.push(`✓ Ran: ${short}`);
      }
      for (const e of (extras || [])) { if (e) badges.push(e); }
      // de-dupe preserving order
      const seen = new Set();
      return badges.filter(b => { const k = b.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 10);
    },

    async runPrompt(prompt, opts = {}) {
      const streamBubble = opts.streamBubble || this.createStreamingAssistantBubble('chat');
      const useRagEl = document.getElementById('agentUseRag');
      const autoApplyEl = document.getElementById('agentAutoApply');
      const useRag = opts.useRag ?? (useRagEl ? useRagEl.checked : true);
      const autoApply = autoApplyEl ? autoApplyEl.checked : true;
      const toolNotes = [];
      let extraContext = '';
      let ragMeta = '';
      const execSummary = [];
      const cmdResults = [];
      let nativeToolCallsAccum = [];

      // 1) Unified autonomous tool routing (pre-LLM): web search, binary context, n8n, MCP, RAG
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

      // Binary inspector: automatically include loaded/parsed binary analysis in agent context
      if (window.BinaryInspector) {
        let binText = (BinaryInspector.lastAnalysis && BinaryInspector.lastAnalysis.text) ? BinaryInspector.lastAnalysis.text : '';
        const needsAnalyze = !binText && BinaryInspector.selectedFile && this.shouldBinaryAnalyze(prompt);
        if (needsAnalyze) {
          const pill = this.addStatusPill('🧪 Analyzing binary...', 'running');
          try {
            binText = await BinaryInspector.analyze();
            toolNotes.push(`Binary analysis: ${BinaryInspector.selectedFile ? BinaryInspector.selectedFile.name : 'completed'}`);
            this.updateStatusPill(pill, `🧪 Binary analyzed${BinaryInspector.selectedFile ? ': ' + BinaryInspector.selectedFile.name : ''}`, 'done');
            if (window.App && App.setView) App.setView('workspace');
          } catch (e) {
            toolNotes.push(`Binary analysis failed: ${e.message}`);
            this.updateStatusPill(pill, `🧪 Binary analysis failed: ${e.message}`, 'error');
          }
        } else if (binText) {
          toolNotes.push(`Binary context: ${(BinaryInspector.lastAnalysis && BinaryInspector.lastAnalysis.name) || (BinaryInspector.selectedFile && BinaryInspector.selectedFile.name) || 'loaded'}`);
        }
        if (binText) {
          extraContext += `\n\n--- Binary Inspection Output ---\n${String(binText).slice(0, 12000)}`;
        }
      }

      // n8n automation: auto-trigger when relevant and feed JSON response back to agent
      if (this.shouldN8n(prompt)) {
        const pill = this.addStatusPill('⚡ Running n8n workflow...', 'running');
        const r = await this.triggerN8n(prompt, { from: 'agent-autonomous', prompt }, { source: 'agent-autonomous', showErrors: false });
        if (r.ok) {
          toolNotes.push('n8n workflow triggered');
          extraContext += `\n\n--- n8n Automation Result (JSON) ---\nHTTP ${r.result?.httpStatus ?? 'ok'}\n${this.formatN8nBody(r.result?.body).slice(0, 4000)}`;
          this.updateStatusPill(pill, '⚡ n8n workflow triggered', 'done');
        } else {
          toolNotes.push(`n8n not triggered: ${r.error}`);
          extraContext += `\n\n--- n8n Automation ---\nNot triggered/configured: ${r.error}`;
          this.updateStatusPill(pill, `⚡ n8n not triggered (${r.error || 'unavailable'})`, r.error === 'not_configured' ? 'warn' : 'error');
        }
      }

      // MCP: expose available tools (configured in Settings/Vault) for autonomous decisions (context + dynamic tool schema)
      const mcpTools = (window.MCP && MCP.getAllTools) ? MCP.getAllTools() : [];
      const llmTools = (typeof this.getLlmTools === 'function') ? this.getLlmTools() : [];
      if (mcpTools.length) {
        contextBlock += `\n\n--- Available MCP Tools ---\n` + mcpTools.map(t => `- ${t.server}:${t.name || t.id} (function tool name: mcp__${t.server}__${t.name || t.id})${t.description ? ' - ' + t.description : ''}`).join('\n');
      }
      if (llmTools.length) {
        contextBlock += `\n\n--- Available Function Tools (LLM schema) ---\n` + llmTools.map(t => `- ${(t.function && t.function.name) || t.name || '(unnamed)'}`).join('\n');
      }

      // RAG: auto-retrieved snippets
      if (useRag && window.RAG) {
        try {
          const rag = await RAG.buildContext(prompt, AppState.settings.ragK);
          if (rag && rag.text) { contextBlock += `\n\n--- Retrieved RAG Context ---\n${rag.text}`; ragMeta = `${rag.results.length} snippets`; }
        } catch (e) { ragMeta = `RAG error: ${e.message}`; }
      }

      contextBlock += extraContext;
      const system = AppState.settings.systemPrompt || '';
      const userPayload = `${prompt}\n\n=== WORKSPACE & TOOL CONTEXT ===\n${contextBlock}`;

      // 2) LLM call with dynamic MCP tool schema; handle tool_calls loop (routed to MCP JSON-RPC tools/call)
      let answer = '';
      try {
        const provider = (document.getElementById('agentProvider') || {}).value || 'openai-compatible';
        if (provider === 'openai-compatible' && llmTools.length) {
          let messages = [
            { role: 'system', content: system },
            { role: 'user', content: userPayload }
          ];
          const maxRounds = 4;
          for (let round = 0; round < maxRounds; round++) {
            const res = await this.callLLM(messages, {
              stream: round === 0,
              onDelta: round === 0 ? (delta) => { if (streamBubble) streamBubble.append(delta); } : undefined,
              tools: llmTools
            });
            const text = (res && typeof res === 'object') ? (res.text || '') : String(res || '');
            const toolCalls = (res && Array.isArray(res.toolCalls)) ? res.toolCalls : [];
            if (round === 0) answer = text;
            else if (text) answer = (answer ? answer + '\n\n' : '') + text;

            if (!toolCalls.length) break;
            nativeToolCallsAccum.push(...toolCalls);

            messages.push({
              role: 'assistant',
              content: text || '',
              tool_calls: toolCalls.map(tc => ({
                id: tc.id,
                type: tc.type || 'function',
                function: { name: tc.function && tc.function.name, arguments: tc.function && tc.function.arguments }
              }))
            });

            for (const tc of toolCalls) {
              const fname = tc.function && tc.function.name ? String(tc.function.name) : '';
              const fargsRaw = tc.function ? tc.function.arguments : '{}';
              const fargs = (typeof this.normalizeToolCallArgs === 'function')
                ? this.normalizeToolCallArgs(fargsRaw)
                : (Utils.safeJsonParse(fargsRaw, {}) || {});
              let toolResultText = '';
              try {
                const mcpTarget = (typeof this.parseMcpPrefixedToolName === 'function') ? this.parseMcpPrefixedToolName(fname) : null;
                if (mcpTarget && window.MCP && typeof MCP.callTool === 'function') {
                  const pill = this.addStatusPill(`🔌 MCP ${mcpTarget.server}:${mcpTarget.tool}...`, 'running');
                  try {
                    const result = await MCP.callTool(mcpTarget.server, mcpTarget.tool, fargs);
                    toolResultText = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
                    execSummary.push(`MCP ${mcpTarget.server}:${mcpTarget.tool} (tool_call) result: ${this.formatN8nBody(result).slice(0, 500)}`);
                    this.updateStatusPill(pill, `🔌 MCP ${mcpTarget.server}:${mcpTarget.tool} completed`, 'done');
                  } catch (e) {
                    toolResultText = `Error: ${e.message || e}`;
                    execSummary.push(`MCP ${mcpTarget.server}:${mcpTarget.tool} (tool_call) failed: ${e.message || e}`);
                    this.updateStatusPill(pill, `🔌 MCP ${mcpTarget.server}:${mcpTarget.tool} failed`, 'error');
                  }
                } else if (fname === 'run_shell' || fname === 'terminal' || fname === ':terminal') {
                  const cmd = (fargs && (fargs.command || fargs.cmd)) ? String(fargs.command || fargs.cmd) : '';
                  if (cmd && window.TerminalPanel && typeof TerminalPanel.executeCommand === 'function') {
                    const configured = TerminalPanel.getConfiguredUrl ? TerminalPanel.getConfiguredUrl() : '';
                    const willRemote = !!(TerminalPanel.getHttpRunnerUrl && TerminalPanel.getHttpRunnerUrl()) || (TerminalPanel.socket && TerminalPanel.socket.readyState === WebSocket.OPEN) || !!configured;
                    const pill = this.addStatusPill(willRemote ? `▶ Running remotely: ${cmd.slice(0,40)}` : `▶ Running: ${cmd.slice(0,40)}`, 'running');
                    const r = await TerminalPanel.executeCommand(cmd);
                    const ok = r && r.ok !== false;
                    const out = String((r && (r.stdout || r.output)) || '').trim();
                    const err = String((r && r.stderr) || '').trim();
                    toolResultText = (out || '') + (err ? (out ? '\n[stderr]\n' : '[stderr]\n') + err : '');
                    if (!toolResultText) toolResultText = ok ? '(no output)' : (err || r?.error || r?.message || 'Command failed');
                    const usedRemote = (r && (r.mode === 'remote' || r.mode === 'remote-http')) || (TerminalPanel.socket && TerminalPanel.socket.readyState === WebSocket.OPEN) || !!(TerminalPanel.getHttpRunnerUrl && TerminalPanel.getHttpRunnerUrl());
                    cmdResults.push({ cmd, ...(r || {}), remote: usedRemote });
                    execSummary.push(`${ok ? 'Ran' : 'Failed'} command (${usedRemote ? 'remote' : 'browser'}): ${cmd}${!ok && err ? ` — ${err.slice(0,120)}` : ''}`);
                    const failMsg = !ok ? (err || r?.error || r?.message || 'Command failed').slice(0, 60) : '';
                    this.updateStatusPill(pill, ok ? (usedRemote ? '✓ Ran remotely' : `✓ Ran: ${cmd.slice(0,36)}`) : `✗ ${failMsg || 'Command failed'}`, ok ? 'done' : 'error');
                  } else {
                    toolResultText = 'Error: terminal not available or missing command';
                  }
                } else {
                  toolResultText = `Unknown or unsupported tool: ${fname}`;
                }
              } catch (e) {
                toolResultText = `Tool execution error: ${e.message || e}`;
              }
              messages.push({
                role: 'tool',
                tool_call_id: tc.id || `call_${Math.random().toString(36).slice(2)}`,
                content: String(toolResultText).slice(0, 12000)
              });
            }
          }
        } else {
          const res = await this.callLLM(userPayload, {
            stream: true,
            onDelta: (delta) => { if (streamBubble) streamBubble.append(delta); }
          });
          answer = (res && typeof res === 'object') ? (res.text || '') : String(res || '');
          nativeToolCallsAccum = (res && Array.isArray(res.toolCalls)) ? res.toolCalls : [];
        }
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        console.error('Agent runPrompt error:', e);
        if (streamBubble) streamBubble.setError(`Error: ${msg}`);
        throw e;
      }
      if (streamBubble && answer && !streamBubble.getText()) streamBubble.append(answer);
      if (!answer && streamBubble) answer = streamBubble.getText();

      // 3) Execute structured actions (edits, in-browser/remote commands, MCP, n8n) from text blocks
      const actions = this.parseAgentActions(answer || '');
      let applied = [];

      // Workspace & Editor: apply edits, auto-open editor, RAG auto-indexes via state events
      if (autoApply && actions.edits.length && window.Editor) {
        this._lastAutoAction = 'edit';
        const editPill = this.addStatusPill(`📝 Applying edits...`, 'running');
        applied = Editor.applyEdits(actions.edits) || [];
        execSummary.push(`Applied ${applied.length} edit(s): ${applied.map(a=>a.path).join(', ')}`);
        this.updateStatusPill(editPill, `📝 Edited ${applied.length} file(s)`, 'done');
        if (applied.length && window.App && App.setView) App.setView('editor');
        setTimeout(() => { this._lastAutoAction = null; }, 500);
      }

      // Terminal/runner: in-browser execution engine or remote bridge; capture real stdout/stderr for agent response
      if (actions.terminal && actions.terminal.length && window.TerminalPanel) {
        for (const t of actions.terminal) {
          if (!t?.command) continue;
          const willHttp = !!(TerminalPanel.getHttpRunnerUrl && TerminalPanel.getHttpRunnerUrl());
          const willRemoteWs = TerminalPanel.socket && TerminalPanel.socket.readyState === WebSocket.OPEN;
          const pill = this.addStatusPill((willHttp || willRemoteWs) ? `▶ Running remotely: ${String(t.command).slice(0, 40)}` : `▶ Running: ${String(t.command).slice(0, 40)}`, 'running');
          try {
            const res = await TerminalPanel.executeCommand(t.command);
            const usedRemote = (res && (res.mode === 'remote' || res.mode === 'remote-http')) || willRemoteWs || willHttp;
            cmdResults.push({ cmd: t.command, ...res, remote: usedRemote });
            const ok = res && res.ok !== false;
            const out = String((res && (res.stdout || res.output)) || '').trim();
            const err = String((res && res.stderr) || '').trim();
            execSummary.push(`${ok ? 'Ran' : 'Failed'} command (${usedRemote ? 'remote' : 'browser'}): ${t.command}`);
            if (out) execSummary.push(`stdout: ${out.slice(0, 800)}${out.length > 800 ? '…' : ''}`);
            if (err) execSummary.push(`stderr: ${err.slice(0, 800)}${err.length > 800 ? '…' : ''}`);
            const failMsg = !ok ? (err || res?.error || res?.message || 'Command failed').slice(0, 60) : '';
            this.updateStatusPill(pill, ok ? (usedRemote ? `✓ Ran remotely` : `✓ Ran: ${String(t.command).slice(0, 36)}`) : `✗ ${failMsg || 'Command failed'}`, ok ? 'done' : 'error');
          } catch (e) {
            const msg = e && e.message ? e.message : String(e);
            cmdResults.push({ cmd: t.command, ok: false, stderr: msg, stdout: '', mode: 'browser' });
            execSummary.push(`Command error: ${t.command} — ${msg}`);
            this.updateStatusPill(pill, `✗ ${String(msg).slice(0, 50) || 'Command error'}`, 'error');
          }
        }
      }

      // MCP tool calls requested by agent in structured action blocks
      if (actions.mcp && actions.mcp.length && window.MCP && MCP.callTool) {
        for (const call of actions.mcp) {
          let server = call.server || call.serverName;
          let tool = call.tool || call.name || call.toolName;
          const args = call.arguments || call.args || {};
          if ((!server || !tool) && call.name) {
            const parsed = (typeof this.parseMcpPrefixedToolName === 'function') ? this.parseMcpPrefixedToolName(call.name) : null;
            if (parsed) { server = parsed.server; tool = parsed.tool; }
          }
          if (!server || !tool) continue;
          const pill = this.addStatusPill(`🔌 MCP ${server}:${tool}...`, 'running');
          try {
            const result = await MCP.callTool(server, tool, args);
            execSummary.push(`MCP ${server}:${tool} result: ${this.formatN8nBody(result).slice(0, 500)}`);
            this.updateStatusPill(pill, `🔌 MCP ${server}:${tool} completed`, 'done');
          } catch (e) {
            execSummary.push(`MCP ${server}:${tool} failed: ${e.message}`);
            this.updateStatusPill(pill, `🔌 MCP ${server}:${tool} failed`, 'error');
          }
        }
      }

      // n8n action requested by agent
      if (actions.n8n) {
        const msg = (typeof actions.n8n === 'string') ? actions.n8n : (actions.n8n.message || actions.n8n.prompt || prompt);
        const pill = this.addStatusPill('⚡ Running n8n workflow...', 'running');
        const r = await this.triggerN8n(msg, typeof actions.n8n === 'object' ? actions.n8n : { from: 'agent-action' }, { source: 'agent-autonomous', showErrors: false });
        if (r.ok) {
          execSummary.push(`n8n workflow result: ${this.formatN8nBody(r.result?.body).slice(0, 500)}`);
          this.updateStatusPill(pill, '⚡ n8n workflow triggered', 'done');
        } else {
          execSummary.push(`n8n action failed: ${r.error}`);
          this.updateStatusPill(pill, `⚡ n8n action failed`, r.error === 'not_configured' ? 'warn' : 'error');
        }
      }

      // Live Preview: auto-render when web app built/updated or requested
      const wantsPreview = /\b(run|preview|open|serve|launch|show|render|view)\b.*\b(app|site|page|project|html|preview|browser)\b/i.test(prompt)
        || /\b(build|create|make|generate|scaffold)\b.*\b(website|web app|landing page|html|page|ui|interface|app)\b/i.test(prompt)
        || applied.some(a => /\.html?$/i.test(a.path));
      if (wantsPreview && window.App && App.renderPreview) {
        const ok = App.renderPreview();
        if (ok) execSummary.push('Opened live preview');
      }

      // 4) Finalize chat with clean prose (raw JSON action blocks stripped) + compact status badges
      let display = this.stripActionBlocks(answer || '');
      if (actions.notes) {
        const notes = String(actions.notes).trim();
        if (notes) display = (display ? display + '\n\n' : '') + notes;
      }
      if (cmdResults.length) {
        const blocks = cmdResults.map(r => {
          const isRemote = r.remote || r.mode === 'remote' || r.mode === 'remote-http';
          const head = `$ ${r.cmd}${isRemote ? '  (remote runner)' : '  (browser runner)'}${r.code != null ? ` [exit ${r.code}]` : ''}`;
          const out = String(r.stdout || r.output || '').replace(/\s+$/,'');
          const err = String(r.stderr || '').replace(/\s+$/,'');
          let b = head;
          if (out) b += `\n${out}`;
          if (err) b += `\n[stderr]\n${err}`;
          if (!out && !err) b += '\n(no output)';
          return b;
        }).join('\n\n');
        display = (display ? display + '\n\n' : '') + '[Command output]\n' + blocks;
      }
      const extras = [];
      if (wantsPreview && execSummary.some(e => /live preview/i.test(e))) extras.push('✓ Live preview');
      const badges = this.buildActionBadges(execSummary, toolNotes, applied, cmdResults, extras);

      if (streamBubble) streamBubble.finalize(display, badges);
      else this.addMessage('assistant', display, 'chat', badges);

      return { text: answer || '', display, actions, execution: execSummary, tools: toolNotes, applied, cmdResults, nativeToolCalls: nativeToolCallsAccum };
    }

  };
  window.Agent = Agent;
})();
