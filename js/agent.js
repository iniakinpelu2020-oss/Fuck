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
      const mode = document.getElementById('agentApiMode'); if (mode) mode.value = AppState.settings.apiMode || 'managed';
      const dprov = document.getElementById('agentDirectProvider'); if (dprov) dprov.value = AppState.settings.directProvider || 'gemini';
      ['agentEndpoint','agentModel','agentProvider','agentApiMode','agentDirectProvider'].forEach(id => {
        const el = document.getElementById(id); if (el) el.addEventListener('change', () => { this.persistAgentSettings(); this.updateKeyStatus(); });
      });
      AppState.subscribe((evt) => { if (evt === 'rag:indexed' || evt === 'rag:cleared' || evt === 'workspace:changed') this.updateKeyStatus(); });
      const bridge = window.ApexWorkflowBridge || window.AetherWorkflowBridge;
      if (bridge && typeof bridge.subscribe === 'function') bridge.subscribe((state) => this.onN8nStatus(state));
      AppState.subscribe((evt, payload) => { if (evt === 'n8n:status') this.onN8nStatus(payload); });
      this.bindChatUiHandlers();
      this.updateKeyStatus();
    },

    bindChatUiHandlers() {
      if (this._chatUiHandlersBound) return;
      this._chatUiHandlersBound = true;
      const wrap = document.getElementById('chatMessages');
      if (!wrap) return;

      const closeAllMoreMenus = (except = null) => {
        wrap.querySelectorAll('.msg-more-menu').forEach(m => { if (m !== except) m.classList.add('hidden'); });
        wrap.querySelectorAll('[data-msg-action="more"]').forEach(b => { if (!except || !except.previousElementSibling || b !== except.previousElementSibling) b.setAttribute('aria-expanded', 'false'); });
      };
      document.addEventListener('click', (ev) => {
        if (!ev.target.closest('.msg-more-wrap')) closeAllMoreMenus();
      });

      const flashCopied = (btn) => {
        if (!btn) return;
        const tip = btn.querySelector('.msg-action-tooltip');
        btn.classList.add('show-tooltip');
        if (tip) tip.classList.add('show');
        clearTimeout(btn._tipTimer);
        btn._tipTimer = setTimeout(() => { btn.classList.remove('show-tooltip'); if (tip) tip.classList.remove('show'); }, 1200);
      };

      const getMsgData = (el) => {
        const actions = el ? el.closest('.msg-actions') : null;
        const enc = actions ? actions.getAttribute('data-raw-md') : '';
        return this.decodeMsgData(enc);
      };

      const stopSpeech = (speakBtn = null) => {
        try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch {}
        wrap.querySelectorAll('[data-msg-action="speak"].speaking').forEach(b => {
          b.classList.remove('speaking');
          b.setAttribute('title', 'Read aloud');
          b.setAttribute('aria-label', 'Read aloud');
          b.innerHTML = this._iconSpeaker();
        });
      };

      wrap.addEventListener('click', async (e) => {
        const msgActionBtn = e.target.closest('[data-msg-action]');
        if (msgActionBtn) {
          const action = msgActionBtn.getAttribute('data-msg-action');
          // let copy-code buttons inside actions? none. but guard:
          if (action) {
            e.preventDefault();
            const msgEl = msgActionBtn.closest('.chat-msg.assistant');
            const raw = getMsgData(msgActionBtn);

            if (action === 'thumb-up' || action === 'thumb-down') {
              const up = msgEl ? msgEl.querySelector('[data-msg-action="thumb-up"]') : null;
              const down = msgEl ? msgEl.querySelector('[data-msg-action="thumb-down"]') : null;
              if (action === 'thumb-up') {
                const active = msgActionBtn.classList.toggle('active');
                msgActionBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
                if (active && down) { down.classList.remove('active'); down.setAttribute('aria-pressed', 'false'); }
              } else {
                const active = msgActionBtn.classList.toggle('active');
                msgActionBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
                if (active && up) { up.classList.remove('active'); up.setAttribute('aria-pressed', 'false'); }
              }
              return;
            }

            if (action === 'regenerate') {
              await this.regenerateAssistantMessage(msgEl);
              return;
            }

            if (action === 'copy') {
              try {
                await navigator.clipboard.writeText(raw);
                flashCopied(msgActionBtn);
                if (window.Utils && Utils.toast) Utils.toast('Copied', 'success');
              } catch {
                if (window.Utils && Utils.toast) Utils.toast('Copy failed', 'error');
              }
              return;
            }

            if (action === 'more') {
              const menu = msgActionBtn.parentElement ? msgActionBtn.parentElement.querySelector('.msg-more-menu') : null;
              if (menu) {
                const willOpen = menu.classList.contains('hidden');
                closeAllMoreMenus(willOpen ? menu : null);
                menu.classList.toggle('hidden', !willOpen);
                msgActionBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
              }
              return;
            }

            if (action === 'copy-raw') {
              try {
                await navigator.clipboard.writeText(raw);
                if (window.Utils && Utils.toast) Utils.toast('Copied raw Markdown', 'success');
              } catch {
                if (window.Utils && Utils.toast) Utils.toast('Copy failed', 'error');
              }
              closeAllMoreMenus();
              return;
            }

            if (action === 'export-md') {
              try {
                const blob = new Blob([raw], { type: 'text/markdown;charset=utf-8' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `apex-response-${Date.now()}.md`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              } catch (err) {
                if (window.Utils && Utils.toast) Utils.toast('Export failed', 'error');
              }
              closeAllMoreMenus();
              return;
            }

            if (action === 'speak') {
              const isSpeaking = msgActionBtn.classList.contains('speaking');
              if (isSpeaking) {
                stopSpeech();
                return;
              }
              stopSpeech();
              try {
                if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) throw new Error('Speech synthesis not supported');
                const text = this.stripMarkdownToPlainText(raw);
                if (!text) { if (window.Utils && Utils.toast) Utils.toast('Nothing to read', 'info'); return; }
                const u = new SpeechSynthesisUtterance(text);
                u.onend = () => stopSpeech();
                u.onerror = () => stopSpeech();
                msgActionBtn.classList.add('speaking');
                msgActionBtn.setAttribute('title', 'Stop reading');
                msgActionBtn.setAttribute('aria-label', 'Stop reading');
                msgActionBtn.innerHTML = this._iconStop();
                window.speechSynthesis.speak(u);
              } catch {
                if (window.Utils && Utils.toast) Utils.toast('Read aloud unavailable', 'error');
              }
              return;
            }
          }
        }

        const copyBtn = e.target.closest('[data-copy-code="1"]');
        if (copyBtn) {
          e.preventDefault();
          const card = copyBtn.closest('.code-card');
          const codeEl = card ? card.querySelector('pre code') : null;
          const text = codeEl ? codeEl.textContent : '';
          try {
            await navigator.clipboard.writeText(text);
            copyBtn.textContent = 'Copied!';
            copyBtn.classList.add('copied');
            clearTimeout(copyBtn._copyTimer);
            copyBtn._copyTimer = setTimeout(() => { copyBtn.textContent = 'Copy'; copyBtn.classList.remove('copied'); }, 2000);
          } catch {
            copyBtn.textContent = 'Copy failed';
            copyBtn.classList.remove('copied');
            clearTimeout(copyBtn._copyTimer);
            copyBtn._copyTimer = setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
          }
          return;
        }

        const actionBtn = e.target.closest('[data-edit-action]');
        if (actionBtn) {
          e.preventDefault(); e.stopPropagation();
          const card = actionBtn.closest('.edit-card');
          const action = actionBtn.getAttribute('data-edit-action');
          let payload = null;
          try {
            const raw = card ? (card.getAttribute('data-edit-json') || '') : '';
            if (raw) payload = JSON.parse(decodeURIComponent(raw));
          } catch {}
          if (!payload) {
            const jsonEl = card ? card.querySelector('.edit-card-json') : null;
            try { payload = jsonEl ? JSON.parse(jsonEl.textContent || '{}') : null; } catch {}
          }
          if (!payload || !payload.path) return;
          if (action === 'preview') {
            const body = card ? card.querySelector('.edit-card-body') : null;
            if (body) body.classList.toggle('collapsed');
            try {
              if (window.Editor && typeof Editor.openOrCreate === 'function') {
                Editor.openOrCreate(payload.path, payload.content == null ? '' : String(payload.content));
                if (window.App && App.setView) App.setView('editor');
              }
            } catch {}
          } else if (action === 'apply') {
            try {
              if (window.Editor && typeof Editor.applyEdits === 'function') {
                const applied = Editor.applyEdits([{ path: payload.path, content: payload.content == null ? '' : String(payload.content) }]) || [];
                if (applied.length) {
                  actionBtn.textContent = 'Applied';
                  actionBtn.disabled = true;
                  const badge = card ? card.querySelector('.edit-card-badge') : null;
                  if (badge) badge.textContent = 'Applied';
                  if (card) card.dataset.applied = '1';
                  if (window.App && App.setView) App.setView('editor');
                  Utils.toast(`Applied ${payload.path}`, 'success');
                }
              }
            } catch (err) {
              Utils.toast(`Apply failed: ${err && err.message ? err.message : err}`, 'error');
            }
          }
          return;
        }

        const toggle = e.target.closest('[data-edit-toggle]');
        if (toggle && !e.target.closest('button')) {
          const card = toggle.closest('.edit-card');
          const body = card ? card.querySelector('.edit-card-body') : null;
          if (body) body.classList.toggle('collapsed');
        }
      });
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
      const mode = document.getElementById('agentApiMode'); if (mode) AppState.settings.apiMode = mode.value || 'managed';
      const dprov = document.getElementById('agentDirectProvider'); if (dprov) AppState.settings.directProvider = dprov.value || 'gemini';
      AppState.saveSettings();
    },

    updateKeyStatus() {
      const keys = Array.isArray(AppState.apiKeys) ? AppState.apiKeys : [];
      const el = document.getElementById('agentKeyStatus');
      if (!el) return;
      const mode = (AppState.settings && AppState.settings.apiMode) || 'managed';
      const dprov = String((AppState.settings && AppState.settings.directProvider) || 'gemini').toLowerCase();
      if (mode === 'direct') {
        const cfg = (typeof this.getDirectProviderConfig === 'function') ? this.getDirectProviderConfig(dprov) : { name: dprov };
        const name = cfg && cfg.name ? cfg.name : (dprov === 'openrouter' ? 'OpenRouter' : (dprov === 'groq' ? 'Groq' : (dprov === 'custom' ? 'Custom (OpenAI-compatible)' : 'Gemini')));
        const endpointOverride = String((AppState.settings && AppState.settings.agentEndpoint) || ((document.getElementById('agentEndpoint') || {}).value || '')).trim();
        if (dprov === 'custom' && !endpointOverride) {
          el.textContent = `Direct ${name} • endpoint required`;
          el.className = 'badge badge-warning !text-[10px] !px-2 !py-0.5';
          el.title = 'Custom Direct Provider requires an API endpoint override (base URL) in Settings.';
        } else if (keys.length) {
          el.textContent = `Direct ${name} • ${keys.length} key${keys.length===1?'':'s'} (#${(AppState.apiKeyIndex % keys.length) + 1})`;
          el.className = 'badge badge-success !text-[10px] !px-2 !py-0.5';
          el.title = 'Direct browser API mode (requests sent from browser to provider endpoint).';
        } else {
          el.textContent = `Direct ${name} • API key required`;
          el.className = 'badge badge-warning !text-[10px] !px-2 !py-0.5';
          el.title = 'Direct browser API mode requires an API key in Settings.';
        }
      } else {
        el.textContent = keys.length
          ? `Managed Proxy • BYOK ${keys.length} (#${(AppState.apiKeyIndex % keys.length) + 1})`
          : 'Managed AI Proxy Active';
        el.className = 'badge badge-success !text-[10px] !px-2 !py-0.5';
        el.title = keys.length ? 'Managed proxy with custom key rotation' : 'Using built-in managed AI proxy (/api/chat).';
      }
    },

    getAgentMode() {
      try {
        const sel = document.getElementById('agentModeSelect');
        if (sel && sel.value) {
          const v = String(sel.value).toLowerCase();
          if (v === 'chat' || v === 'agent' || v === 'edit') return v;
        }
      } catch {}
      const s = (window.AppState && AppState.settings && AppState.settings.agentMode) ? String(AppState.settings.agentMode).toLowerCase() : 'agent';
      return (s === 'chat' || s === 'agent' || s === 'edit') ? s : 'agent';
    },

    getEffectiveSystemPrompt(mode) {
      const m = mode || this.getAgentMode();
      const base = String((window.AppState && AppState.settings && AppState.settings.systemPrompt) || '').trim();
      const mcpInstr = '\n\n--- Autonomous MCP tool calling ---\n' +
        'When you need to use an MCP tool, emit either (1) native OpenAI-compatible tool_calls, (2) a fenced ```json:mcp``` block, or (3) a raw JSON object {"name":"mcp__<server>__<tool>","arguments":{...}}. ' +
        'The runtime intercepts it, executes via MCPClient.callTool(server, tool, args), renders a compact tool-execution status pill, appends the tool result to conversation history, and continues your turn automatically (up to 5 tool hops) until you produce a final plain-English response. Do not repeat the same tool call unnecessarily.';
      if (m === 'chat') {
        return base + mcpInstr + '\n\n--- Response Mode: Chat ---\n' +
          'Reply in clear, helpful plain English. Use standard fenced Markdown code blocks (```language ... ```). ' +
          'Do NOT emit ```json:edits``` blocks and do not claim to have modified files or run commands unless results are explicitly provided in context. ' +
          'If the user asks for code changes, provide the code in normal Markdown fenced blocks with explanations.';
      }
      return base + mcpInstr + '\n\n--- Response Mode: Agent/Edit (workspace actions enabled) ---\n' +
        'When you need to create, update, or modify workspace files, return a fenced ```json:edits``` block with this shape:\n' +
        '{"edits":[{"path":"relative/path","content":"new full file content"}],"terminal":[{"command":"..."}],"notes":"short summary"}\n' +
        'Prefer precise, minimal edits. If no edits are needed, use an empty edits array or omit the block. Keep user-facing prose clean; the UI will present file changes as structured cards.';
    },

    escapeHtml(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); },

    stripActionBlocks(text) {
      let s = String(text ?? '');
      // Remove json:edits fences and json fences that contain tool/action payloads
      s = s.replace(/```json:edits\s*[\s\S]*?```/gi, '');
      s = s.replace(/```json:mcp\s*[\s\S]*?```/gi, '');
      s = s.replace(/```json\s*([\s\S]*?)```/gi, (m, body) => {
        const obj = Utils.safeJsonParse(body, null);
        if (obj && (obj.edits || obj.terminal || obj.mcp || obj.n8n)) return '';
        return m; // keep non-action json as normal markdown code block (rendered later)
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
        const afterLang = tail.replace(/^```(?:json:edits|json)\b[^\n]*\n?/i, '');
        if (!/```(?:\s*)$/.test(afterLang)) {
          // no closing fence yet for this action block start -> hide from start of trailing fence
          s = s.slice(0, last);
        }
      }
      return s.replace(/\n{3,}/g, '\n\n');
    },

    extractActionJsonEditsBlocks(text) {
      const blocks = [];
      const re = /```json:edits\s*([\s\S]*?)```/gi;
      let m;
      while ((m = re.exec(String(text || ''))) !== null) {
        const obj = Utils.safeJsonParse(m[1], null);
        if (obj && typeof obj === 'object' && (Array.isArray(obj.edits) || obj.terminal || obj.mcp || obj.n8n || obj.notes)) blocks.push(obj);
      }
      // also accept plain ```json fences that are clearly edit/action payloads
      const re2 = /```json\s*([\s\S]*?)```/gi;
      while ((m = re2.exec(String(text || ''))) !== null) {
        const obj = Utils.safeJsonParse(m[1], null);
        if (obj && typeof obj === 'object' && Array.isArray(obj.edits)) blocks.push(obj);
      }
      return blocks;
    },

    renderMarkdownWithCodeBlocks(content) {
      try {
      const src = String(content == null ? '' : content).replace(/\r\n?/g, '\n');
      const parts = src.split(/(```[\s\S]*?```)/g);
      let html = '';
      for (const part of parts) {
        if (!part) continue;
        const fence = part.match(/^```([^\n`]*)\n?([\s\S]*?)```$/);
        if (fence) {
          const rawLang = String(fence[1] || '').trim();
          const langToken = (rawLang.split(/\s+/)[0] || '').trim().toLowerCase();
          const langLabel = rawLang || 'plain';
          const highlightLang = (langLabel.toLowerCase() === 'json' ? 'json' : langToken) || 'plaintext';
          const code = String(fence[2] || '').replace(/\n$/, '');
          let highlighted = this.escapeHtml(code);
          try {
            if (window.hljs) {
              if (highlightLang && highlightLang !== 'plaintext' && highlightLang !== 'plain' && hljs.getLanguage && hljs.getLanguage(highlightLang)) {
                highlighted = hljs.highlight(code, { language: highlightLang, ignoreIllegals: true }).value;
              } else if (hljs.highlightAuto) {
                const auto = hljs.highlightAuto(code);
                highlighted = auto && auto.value ? auto.value : highlighted;
              }
            }
          } catch { highlighted = this.escapeHtml(code); }
          html += `<div class="code-card" data-lang="${this.escapeHtml(langLabel)}">` +
            `<div class="code-card-bar"><span class="code-card-lang">${this.escapeHtml(langLabel)}</span>` +
            `<button type="button" class="code-copy-btn" data-copy-code="1" aria-label="Copy code">Copy</button></div>` +
            `<pre class="code-card-pre"><code class="hljs language-${this.escapeHtml(highlightLang || 'plaintext')}">${highlighted}</code></pre></div>`;
        } else {
          html += this.renderInlineMarkdown(part);
        }
      }
      return `<div class="chat-md">${html || ''}</div>`;
      } catch (e) {
        console.error('[Agent.renderMarkdownWithCodeBlocks]', e);
        return `<div class="chat-md"><pre class="chat-content">${this.escapeHtml(String(content == null ? '' : content))}</pre></div>`;
      }
    },

    renderInlineMarkdown(text) {
      try {
      const lines = String(text == null ? '' : text).split('\n');
      let out = '';
      let inUl = false, inOl = false;
      const flush = () => { if (inUl) { out += '</ul>'; inUl = false; } if (inOl) { out += '</ol>'; inOl = false; } };
      const inline = (s) => {
        let x = this.escapeHtml(s);
        // inline code first
        x = x.replace(/`([^`\n]+)`/g, (_, c) => `<code class="inline-code">${c}</code>`);
        // bold / italic (simple)
        x = x.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        x = x.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
        // links [text](url)
        x = x.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
        return x;
      };
      for (const raw of lines) {
        const line = raw;
        const h = line.match(/^(#{1,4})\s+(.*)$/);
        if (h) { flush(); const lvl = h[1].length; out += `<h${lvl}>${inline(h[2])}</h${lvl}>`; continue; }
        const ul = line.match(/^\s*[-*]\s+(.*)$/);
        if (ul) { if (inOl) { out += '</ol>'; inOl = false; } if (!inUl) { out += '<ul>'; inUl = true; } out += `<li>${inline(ul[1])}</li>`; continue; }
        const ol = line.match(/^\s*\d+\.\s+(.*)$/);
        if (ol) { if (inUl) { out += '</ul>'; inUl = false; } if (!inOl) { out += '<ol>'; inOl = true; } out += `<li>${inline(ol[1])}</li>`; continue; }
        if (!line.trim()) { flush(); out += ''; continue; }
        const bq = line.match(/^>\s?(.*)$/);
        if (bq) { flush(); out += `<blockquote>${inline(bq[1])}</blockquote>`; continue; }
        flush();
        out += `<p>${inline(line)}</p>`;
      }
      flush();
      return out;
      } catch (e) {
        console.error('[Agent.renderInlineMarkdown]', e);
        return `<p>${this.escapeHtml(String(text == null ? '' : text)).replace(/\n/g, '<br>')}</p>`;
      }
    },

    renderEditCards(actions, opts = {}) {
      const edits = (actions && Array.isArray(actions.edits)) ? actions.edits : [];
      if (!edits.length) return '';
      const appliedSet = new Set(((opts.applied || []).map(a => a && a.path).filter(Boolean)));
      const cards = edits.map((e, idx) => {
        const path = String(e.path || `edit-${idx + 1}`);
        const content = String(e.content == null ? '' : e.content);
        const wasApplied = appliedSet.has(path);
        const lang = (window.Utils && Utils.detectLang) ? Utils.detectLang(path) : 'text';
        const id = `editcard_${Date.now().toString(36)}_${idx}_${Math.random().toString(36).slice(2,6)}`;
        const preview = content.length > 12000 ? content.slice(0, 12000) + '\n… (truncated preview)' : content;
        const escPath = this.escapeHtml(path);
        const escId = this.escapeHtml(id);
        let payloadAttr = '';
        try { payloadAttr = encodeURIComponent(JSON.stringify({ path, content })); } catch { payloadAttr = ''; }
        return `<div class="edit-card" data-edit-id="${escId}" data-edit-path="${escPath}" data-applied="${wasApplied ? '1' : '0'}" data-edit-json="${this.escapeHtml(payloadAttr)}">` +
          `<div class="edit-card-header" data-edit-toggle="${escId}">` +
            `<div class="edit-card-title"><span class="json-edits-dot"></span><span class="path" title="${escPath}">${escPath}</span></div>` +
            `<div class="flex items-center gap-2">` +
              `<span class="edit-card-badge">${wasApplied ? 'Applied' : 'Change'}</span>` +
              `<div class="edit-card-actions">` +
                `<button type="button" class="edit-card-btn" data-edit-action="preview" data-edit-id="${escId}">Preview</button>` +
                `<button type="button" class="edit-card-btn primary" data-edit-action="apply" data-edit-id="${escId}" ${wasApplied ? 'disabled' : ''}>${wasApplied ? 'Applied' : 'Apply'}</button>` +
              `</div>` +
            `</div>` +
          `</div>` +
          `<div class="edit-card-body collapsed" id="${escId}"><pre><code class="language-${this.escapeHtml(lang)}">${this.escapeHtml(preview)}</code></pre></div>` +
          `<div class="edit-card-meta">${this.escapeHtml(lang)} · ${content.length} chars</div>` +
        `</div>`;
      }).join('');
      return `<div class="edit-cards">${cards}</div>`;
    },

    renderMessageContent(content, opts = {}) {
      const mode = (opts && opts.mode) || this.getAgentMode();
      const raw = String(content ?? '');
      const isStreaming = !!(opts && opts.streaming);
      if (opts && opts.raw === true) {
        return `<pre class="chat-content">${this.escapeHtml(raw)}</pre>`;
      }

      if (mode === 'chat') {
        const text = isStreaming ? this.streamDisplayText(raw) : this.stripActionBlocks(raw);
        if (isStreaming && !text.trim()) return `<pre class="chat-content"></pre>`;
        return this.renderMarkdownWithCodeBlocks(text);
      }

      // Agent/Edit: show prose as markdown, render json:edits as collapsible file-change cards
      const blocks = this.extractActionJsonEditsBlocks(raw);
      const merged = { edits: [] };
      for (const b of blocks) {
        if (Array.isArray(b.edits)) merged.edits.push(...b.edits.filter(e => e && e.path));
      }
      const prose = isStreaming ? this.streamDisplayText(raw) : this.stripActionBlocks(raw);
      let html = '';
      if (merged.edits.length) html += this.renderEditCards(merged, { applied: opts.applied || [] });
      if (prose.trim()) html += this.renderMarkdownWithCodeBlocks(prose);
      if (!html) html = `<pre class="chat-content"></pre>`;
      return html;
    },

    stripMarkdownToPlainText(md) {
      let s = String(md || '').replace(/\r\n?/g, '\n');
      // remove fenced code blocks but keep inner text
      s = s.replace(/```[^\n`]*\n?([\s\S]*?)```/g, (_, inner) => '\n' + String(inner || '') + '\n');
      // inline code
      s = s.replace(/`([^`]+)`/g, '$1');
      // images/links
      s = s.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');
      s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
      // headings / blockquotes / lists markers
      s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');
      s = s.replace(/^\s{0,3}>\s?/gm, '');
      s = s.replace(/^\s*[-*+]\s+/gm, '');
      s = s.replace(/^\s*\d+\.\s+/gm, '');
      // emphasis / strike / html
      s = s.replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1');
      s = s.replace(/<[^>]+>/g, '');
      // collapse whitespace
      s = s.replace(/\n{3,}/g, '\n\n').trim();
      return s;
    },

    encodeMsgData(text) {
      try { return btoa(unescape(encodeURIComponent(String(text || '')))); } catch { try { return btoa(String(text || '')); } catch { return ''; } }
    },

    decodeMsgData(data) {
      if (!data) return '';
      try { return decodeURIComponent(escape(atob(String(data)))); } catch { try { return atob(String(data)); } catch { return ''; } }
    },

    attachMessageActions(msgEl, content) {
      try {
        if (!msgEl || msgEl.querySelector('.msg-actions')) return;
        const raw = String(content == null ? '' : content);
        const footer = document.createElement('div');
        footer.className = 'msg-actions-footer';
        footer.innerHTML = (typeof this.renderMessageActions === 'function') ? this.renderMessageActions(raw) : '';
        msgEl.appendChild(footer);
      } catch (e) { console.error('[Agent.attachMessageActions]', e); }
    },

    renderMessageActions(rawContent) {
      const enc = this.escapeHtml(this.encodeMsgData(rawContent || ''));
      return `<div class="msg-actions" data-raw-md="${enc}">
        <div class="msg-actions-left">
          <button type="button" class="msg-action-btn" data-msg-action="thumb-up" title="Good response" aria-label="Good response" aria-pressed="false">${this._iconThumbUp()}</button>
          <button type="button" class="msg-action-btn" data-msg-action="thumb-down" title="Bad response" aria-label="Bad response" aria-pressed="false">${this._iconThumbDown()}</button>
          <button type="button" class="msg-action-btn" data-msg-action="regenerate" title="Regenerate" aria-label="Regenerate">${this._iconRefresh()}</button>
          <button type="button" class="msg-action-btn" data-msg-action="copy" title="Copy" aria-label="Copy response">${this._iconCopy()}<span class="msg-action-tooltip">Copied</span></button>
          <div class="msg-more-wrap">
            <button type="button" class="msg-action-btn" data-msg-action="more" title="More" aria-label="More actions" aria-expanded="false">${this._iconMore()}</button>
            <div class="msg-more-menu hidden" role="menu">
              <button type="button" class="msg-more-item" data-msg-action="copy-raw" role="menuitem">Copy raw Markdown</button>
              <button type="button" class="msg-more-item" data-msg-action="export-md" role="menuitem">Export as .md</button>
            </div>
          </div>
        </div>
        <div class="msg-actions-right">
          <button type="button" class="msg-action-btn" data-msg-action="speak" title="Read aloud" aria-label="Read aloud">${this._iconSpeaker()}</button>
        </div>
      </div>
      <div class="msg-disclaimer">Apex Studio is AI and can make mistakes.</div>`;
    },

    _iconThumbUp() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14Z"/><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>'; },
    _iconThumbDown() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3H10Z"/><path d="M17 2h3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-3"/></svg>'; },
    _iconRefresh() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>'; },
    _iconCopy() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'; },
    _iconMore() { return '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>'; },
    _iconSpeaker() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>'; },
    _iconStop() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>'; },

    isWelcomeMessage(role, content) {
      if (role !== 'assistant') return false;
      const c = String(content || '');
      return /^Hi — I'm Apex\b/.test(c) && c.includes('your autonomous agent');
    },

    ensureActiveChatSession() {
      try {
        if (!window.AppState) return null;
        if (!Array.isArray(AppState.chatSessions)) AppState.chatSessions = [];
        let session = (AppState.activeChatId && AppState.getChat) ? AppState.getChat(AppState.activeChatId) : null;
        if (!session) {
          session = (typeof AppState.createChat === 'function') ? AppState.createChat('New chat') : null;
          if (session && typeof AppState.saveActiveChatId === 'function') AppState.saveActiveChatId(session.id);
        }
        return session || null;
      } catch { return null; }
    },

    persistMessage(role, content, meta = '', badges = []) {
      if (this.isWelcomeMessage(role, content)) return;
      try {
        this.ensureActiveChatSession();
        const id = AppState && AppState.activeChatId;
        if (!id || !AppState.chatSessions) return;
        const s = AppState.getChat(id);
        if (!s) return;
        if (!Array.isArray(s.messages)) s.messages = [];
        s.messages.push({ role, content, meta, badges: Array.isArray(badges) ? badges : [], ts: Date.now() });
        s.updatedAt = Date.now();
        AppState.saveChatSessions();
        if (window.App && typeof App.renderChatHistory === 'function') App.renderChatHistory();
      } catch (e) { /* persistence should not break chat */ }
    },

    renderBadges(badges) {
      try {
        const arr = Array.isArray(badges) ? badges.filter(Boolean) : [];
        if (!arr.length) return '';
        return `<div class="chat-badges">${arr.map(b => `<span class="chat-badge">${this.escapeHtml(String(b ?? ''))}</span>`).join('')}</div>`;
      } catch { return ''; }
    },

    addMessage(role, content, meta = '', badges = [], opts = {}) {
      if (role !== 'assistant' || !opts.welcomePlaceholder) this.ensureActiveChatSession();
      const wrap = document.getElementById('chatMessages');
      if (!wrap) {
        console.warn('[Agent.addMessage] chatMessages container missing', { role, meta });
        return null;
      }

      // Only remove welcome placeholder when explicitly requested (e.g. full re-render/reset)
      if (opts.removeWelcomePlaceholder) {
        wrap.querySelectorAll('[data-welcome-placeholder="1"]').forEach(el => el.remove());
      }

      const div = document.createElement('div');
      div.className = `chat-msg ${role}`;
      if (opts.welcomePlaceholder) div.dataset.welcomePlaceholder = '1';
      const who = role === 'user' ? 'You' : (role === 'system' ? 'System' : 'Agent');
      const icon = role === 'user' ? '<span class="msg-avatar msg-avatar-user">U</span>' : '<span class="msg-avatar msg-avatar-agent">A</span>';
      const metaHtml = meta ? `<span class="badge badge-muted" style="margin-left:auto">${this.escapeHtml(meta)}</span>` : '';
      const mode = (opts && opts.mode) || this.getAgentMode();
      let bodyHtml = '';
      try {
        bodyHtml = (role === 'assistant')
          ? `<div class="chat-content">${this.renderMessageContent(content, { mode, applied: opts.applied || [] })}</div>`
          : `<pre class="chat-content">${this.escapeHtml(String(content ?? ''))}</pre>`;
      } catch (e) {
        console.error('[Agent.addMessage] render error', e);
        bodyHtml = `<pre class="chat-content">${this.escapeHtml(String(content ?? ''))}</pre>`;
      }
      div.innerHTML = `<div class="meta">${icon}<span>${who}</span>${metaHtml}</div>${bodyHtml}${(typeof this.renderBadges === 'function') ? this.renderBadges(badges) : ''}`;
      wrap.appendChild(div);
      try {
        if (role === 'assistant' && !opts.welcomePlaceholder && typeof this.attachMessageActions === 'function') { try { this.attachMessageActions(div, content); } catch (e) { console.error('[Agent.addMessage] attach actions failed', e); } }
      } catch (e) { console.error('[Agent.addMessage] attach actions failed', e); }
      try { wrap.scrollTop = wrap.scrollHeight; } catch {}

      // Persist message to active chat session (never persist welcome/placeholder or when explicitly disabled)
      const shouldPersist = opts.persist !== false && !opts.welcomePlaceholder;
      if (shouldPersist) this.persistMessage(role, content, meta, badges);
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

    createStreamingAssistantBubble(meta = 'chat', opts = {}) {
      const wrap = document.getElementById('chatMessages');
      if (!wrap) {
        console.warn('[Agent.createStreamingAssistantBubble] chatMessages container missing');
        return null;
      }
      this.ensureActiveChatSession();
      // Keep persistent welcome card at top; only remove when explicitly requested
      if (opts.removeWelcomePlaceholder) {
        wrap.querySelectorAll('[data-welcome-placeholder="1"]').forEach(el => el.remove());
      }
      const div = document.createElement('div');
      div.className = 'chat-msg assistant streaming';
      const metaHtml = meta ? `<span class="badge badge-muted" style="margin-left:auto">${this.escapeHtml(meta)}</span>` : '';
      div.innerHTML = `<div class="meta"><span class="msg-avatar msg-avatar-agent">A</span><span>Agent</span>${metaHtml}</div><div class="chat-content"><pre class="chat-content"><span class="thinking-inline"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="thinking-label">Thinking...</span></span></pre></div><div class="chat-badges"></div>`;
      wrap.appendChild(div);
      wrap.scrollTop = wrap.scrollHeight;
      const contentEl = div.querySelector('.chat-content');
      const badgesEl = div.querySelector('.chat-badges');
      let text = '';
      let started = false;
      let finalized = false;
      const bubbleMode = (opts && opts.mode) || this.getAgentMode();
      return {
        el: div,
        append(delta) {
          if (!delta) return;
          if (!started) { started = true; contentEl.innerHTML = '<pre class="chat-content"></pre>'; }
          text += delta;
          const pre = contentEl.querySelector('pre.chat-content') || contentEl;
          if (pre && pre.tagName === 'PRE') pre.textContent = Agent.streamDisplayText(text);
          else contentEl.textContent = Agent.streamDisplayText(text);
          wrap.scrollTop = wrap.scrollHeight;
        },
        setError(msg) {
          text = String(msg || 'Error');
          contentEl.innerHTML = `<pre class="chat-content">${Agent.escapeHtml(text)}</pre>`;
          div.classList.remove('streaming');
          wrap.scrollTop = wrap.scrollHeight;
        },
        getText() { return text; },
        finalize(displayText = null, badges = [], fopts = {}) {
          if (finalized) return (displayText != null ? String(displayText) : text);
          finalized = true;
          const full = (displayText != null ? String(displayText) : text);
          const mode = (fopts && fopts.mode) || bubbleMode || Agent.getAgentMode();
          try {
            contentEl.innerHTML = Agent.renderMessageContent(full, { mode, applied: (fopts && fopts.applied) || [] });
          } catch (e) {
            console.error('[Agent.stream] finalize render error', e);
            contentEl.innerHTML = `<pre class="chat-content">${Agent.escapeHtml(full)}</pre>`;
          }
          const badgeArr = Array.isArray(badges) ? badges : [];
          if (badgesEl) badgesEl.innerHTML = (typeof Agent.renderBadges === 'function') ? Agent.renderBadges(badgeArr) : '';
          div.classList.remove('streaming');
          try { if (typeof Agent.attachMessageActions === 'function') Agent.attachMessageActions(div, full); } catch (e) { console.error('[Agent.stream] attach actions failed', e); }
          wrap.scrollTop = wrap.scrollHeight;
          if ((opts.persist !== false) && (fopts.persist !== false)) Agent.persistMessage('assistant', full, meta || 'chat', badgeArr);
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

    getSavedN8nConfig() {
      try {
        const saved = (AppState && AppState.settings && typeof AppState.settings === 'object') ? AppState.settings : {};
        let stored = {};
        try { stored = Utils.safeJsonParse(localStorage.getItem('aether.settings.v1'), {}) || {}; } catch {}
        if (!stored || typeof stored !== 'object' || Array.isArray(stored)) stored = {};
        const readSaved = (...keys) => {
          for (const k of keys) {
            const v = (saved && saved[k] != null) ? saved[k] : stored[k];
            if (v != null && String(v).trim() !== '') return String(v).trim();
          }
          return '';
        };
        let credUrl = '', credHeaderName = '', credToken = '';
        try {
          const cred = (window.Integrations && typeof Integrations.getN8nCredential === 'function') ? Integrations.getN8nCredential() : null;
          if (cred) {
            credUrl = String(cred.url || '').trim();
            const parsed = (typeof Integrations.parseN8nSecret === 'function') ? (Integrations.parseN8nSecret(cred.secret) || {}) : {};
            credHeaderName = String(parsed.headerName || '').trim();
            credToken = String(parsed.token || '').trim();
          }
        } catch {}
        const url = readSaved('webhookUrl', 'n8nWebhookUrl') || credUrl || ((window.ApexWorkflowBridge || window.AetherWorkflowBridge) && typeof (window.ApexWorkflowBridge || window.AetherWorkflowBridge).getWebhookUrl === 'function' ? String((window.ApexWorkflowBridge || window.AetherWorkflowBridge).getWebhookUrl() || '').trim() : '');
        const authHeaderName = readSaved('authHeaderName', 'n8nAuthHeaderName', 'n8nAuthHeader') || credHeaderName || '';
        const authHeaderValue = readSaved('authHeaderValue', 'n8nAuthHeaderValue', 'n8nAuthToken', 'authToken') || credToken || '';
        return { url, authHeaderName, authHeaderValue };
      } catch { return { url: '', authHeaderName: '', authHeaderValue: '' }; }
    },

    async triggerN8n(message, extra = {}, opts = {}) {
      const bridge = window.ApexWorkflowBridge || window.AetherWorkflowBridge;
      if (!bridge || typeof bridge.trigger !== 'function') {
        if (opts.showErrors !== false) this.addMessage('assistant', 'n8n webhook is not configured. Add it in Settings (⚙️).', 'n8n');
        return { ok: false, error: 'not_configured' };
      }
      const cfg = this.getSavedN8nConfig();
      const url = String(cfg.url || '').trim();
      if (!url) {
        if (opts.showErrors !== false) this.addMessage('assistant', 'n8n webhook URL is not set. Configure it in Settings (⚙️).', 'n8n');
        return { ok: false, error: 'not_configured' };
      }
      if (opts.showUser) this.addMessage('user', message, 'n8n');
      const sessionId = `apex_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const safeMsg = String(message == null ? '' : message).trim() || 'Run automation task';
      const payload = {
        task: safeMsg,
        instruction: safeMsg,
        message: safeMsg,
        prompt: safeMsg,
        session_id: sessionId,
        user_id: 'apex-user',
        source: 'apex-agent',
        workspace: (window.AppState && AppState.workspaceName) || null,
        activeFile: (window.AppState && AppState.activeFilePath) || null,
        timestamp: new Date().toISOString(),
        ...(extra && typeof extra === 'object' && !Array.isArray(extra) ? extra : {})
      };
      try {
        const res = await bridge.trigger('agent_automation', payload, {
          source: opts.source || 'agent-chat',
          url,
          authHeaderName: cfg.authHeaderName,
          authHeaderValue: cfg.authHeaderValue,
          authToken: cfg.authHeaderValue
        });
        return { ok: true, result: res };
      } catch (e) {
        return { ok: false, error: e.message || String(e) };
      }
    },

    async regenerateAssistantMessage(msgEl) {
      if (!msgEl || this.isGenerating) return;
      const prompt = this._lastUserPrompt || '';
      if (!prompt.trim()) { if (window.Utils && Utils.toast) Utils.toast('No previous prompt to regenerate', 'info'); return; }
      const attachments = Array.isArray(this._lastUserAttachments) ? this._lastUserAttachments : [];
      const wrap = document.getElementById('chatMessages');
      if (!wrap) return;
      // stop speech if this message is being read
      try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch {}
      msgEl.remove();
      this.setGenerating(true);
      const currentMode = this.getAgentMode();
      const streamBubble = this.createStreamingAssistantBubble('chat', { mode: currentMode });
      try {
        await this.runPrompt(prompt, { fromUI: false, streamBubble, attachments: attachments.slice() });
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        console.error('Agent regenerate error:', e);
        try { if (window.AppState && typeof AppState.saveChatSessions === 'function') AppState.saveChatSessions(); } catch {}
        if (streamBubble) streamBubble.setError(`Error: ${msg}`);
        else this.addMessage('assistant', `Error: ${msg}`, 'error', [], { mode: currentMode });
      } finally {
        this.setGenerating(false);
      }
    },

    async sendFromUI() {
      if (this.isGenerating) return;
      const input = document.getElementById('chatInput');
      if (!input) return;
      const prompt = input.value.trim();
      const chatAttachments = (window.Workspace && typeof Workspace.getPending === 'function') ? (Workspace.getPending() || []) : [];
      if (!prompt && !chatAttachments.length) return;

      // Ensure active chat session is bound before rendering/persisting this turn
      this.ensureActiveChatSession();
      if (window.App && typeof App.setView === 'function') { try { App.setView('agent'); } catch {} }

      // Auto-title new chat sessions from the first user prompt (fallback immediately, refine in background)
      try {
        const chatId = window.AppState && AppState.activeChatId;
        if (chatId && prompt) {
          const s = AppState.getChat ? AppState.getChat(chatId) : null;
          if (s && String(s.title || '') === 'New chat') {
            this.autoTitleChatSession(chatId, prompt);
          }
        }
      } catch {}

      // Back-compat: explicit /n8n or "trigger n8n" commands only
      if (this.isExplicitN8nCommand(prompt)) {
        this.setGenerating(true);
        try {
          input.value = ''; this.autoResizeChat();
          const message = prompt.replace(/^\/(?:n8n|trigger)\b/i, '').replace(/^trigger\s+n8n\b/i, '').trim() || prompt;
          const attachmentLabel = chatAttachments.length ? `\n\n[${chatAttachments.length} attached file${chatAttachments.length === 1 ? '' : 's'} queued: ${chatAttachments.map(a => a && a.name).filter(Boolean).join(', ')}]` : '';
          this.addMessage('user', prompt + attachmentLabel);
          const streamBubble = this.createStreamingAssistantBubble('n8n', { mode: this.getAgentMode() }); // immediate "Thinking..." pulse
          const pill = this.addStatusPill('⚡ Running n8n workflow...', 'running');
          const r = await this.triggerN8n(message, { from: 'agent-command' }, { source: 'agent-chat', showErrors: true });
          this.updateStatusPill(pill, r.ok ? '⚡ n8n workflow triggered' : `⚡ n8n workflow failed${r.error ? ': ' + r.error : ''}`, r.ok ? 'done' : 'error');
          if (streamBubble) streamBubble.finalize(r.ok ? 'n8n workflow triggered successfully.' : `n8n workflow failed${r.error ? ': ' + r.error : ''}`, [], { mode: 'chat' });
        } finally {
          this.setGenerating(false);
        }
        return;
      }

      this.setGenerating(true);
      input.value = ''; this.autoResizeChat();
      if (chatAttachments.length && window.Workspace && typeof Workspace.clearPending === 'function') {
        try { Workspace.clearPending(); } catch {}
      }
      const userDisplay = prompt || (chatAttachments.length ? `[Attached ${chatAttachments.length} file${chatAttachments.length === 1 ? '' : 's'}: ${chatAttachments.map(a => a && a.name).filter(Boolean).join(', ')}]` : '');
      this.addMessage('user', userDisplay);
      // Save last prompt/attachments for Regenerate
      this._lastUserPrompt = prompt;
      this._lastUserAttachments = Array.isArray(chatAttachments) ? chatAttachments.slice() : [];
      // Immediate animated "Thinking..." pulse inside assistant bubble
      const currentMode = this.getAgentMode();
      const streamBubble = this.createStreamingAssistantBubble('chat', { mode: currentMode });
      try {
        await this.runPrompt(prompt, { fromUI: true, streamBubble, attachments: chatAttachments });
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        console.error('Agent send error:', e);
        // Strip any dangling tool_calls without matching tool responses before persisting state
        try { if (window.AppState && typeof AppState.saveChatSessions === 'function') AppState.saveChatSessions(); } catch {}
        if (streamBubble) streamBubble.setError(`Error: ${msg}`);
        else this.addMessage('assistant', `Error: ${msg}`, 'error', [], { mode: currentMode });
      } finally {
        this.setGenerating(false);
      }
    },

    sleep(ms) { return new Promise(r => setTimeout(r, ms)); },

    truncateForModel(text, maxChars = 12000) {
      const str = String(text == null ? '' : text);
      if (str.length <= maxChars) return str;
      return str.slice(0, maxChars) + `\n\n[truncated to ${maxChars} chars; original ${str.length} chars]`;
    },

    async fetchWithRetry(url, options = {}, retries = 1, delayMs = 1000) {
      let lastErr = null;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          return await fetch(url, options);
        } catch (e) {
          lastErr = e;
          const msg = String((e && e.message) || e || '');
          const transient = e instanceof TypeError || /failed to fetch|networkerror|network request failed|load failed/i.test(msg);
          if (attempt < retries && transient) {
            await this.sleep(delayMs);
            continue;
          }
          throw e;
        }
      }
      throw lastErr || new TypeError(`Failed to fetch ${url}`);
    },

    formatFetchError(err, url, res = null, bodyText = '') {
      const u = String(url || '(unknown URL)');
      if (res) {
        const status = res.status;
        const statusText = res.statusText ? (' ' + res.statusText) : '';
        const detail = String(bodyText || '').slice(0, 500);
        return `HTTP ${status}${statusText} at ${u}${detail ? ': ' + detail : ''}`;
      }
      const msg = String((err && err.message) || err || 'Request failed');
      if (err instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(msg)) {
        return `Network request failed to ${u}: ${msg}`;
      }
      return `${msg} (URL: ${u})`;
    },

    getDirectProviderConfig(dprov) {
      const p = String(dprov || 'gemini').toLowerCase();
      if (p === 'openrouter') {
        return { name: 'OpenRouter', provider: 'openai-compatible', endpoint: 'https://openrouter.ai/api/v1/chat/completions', model: 'openai/gpt-4o-mini' };
      }
      if (p === 'groq') {
        return { name: 'Groq', provider: 'openai-compatible', endpoint: 'https://api.groq.com/openai/v1/chat/completions', model: 'llama-3.3-70b-versatile' };
      }
      if (p === 'openai-compatible') {
        return { name: 'OpenAI', provider: 'openai-compatible', endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini' };
      }
      if (p === 'custom') {
        return { name: 'Custom (OpenAI-compatible)', provider: 'openai-compatible', endpoint: '', model: '', requiresEndpointOverride: true };
      }
      // Gemini OpenAI-compatible endpoint (browser-direct)
      return { name: 'Gemini', provider: 'openai-compatible', endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', model: 'gemini-3.8-flash' };
    },

    normalizeCustomDirectEndpoint(url) {
      let u = String(url || '').trim();
      if (!u) return '';
      u = u.replace(/\s+/g, '').replace(/\/+$/, '');
      if (!u) return '';
      if (/\/chat\/completions$/i.test(u)) return u;
      // If user pastes a base /v1 URL, append /chat/completions automatically
      if (/\/v1$/i.test(u)) return u + '/chat/completions';
      // If it already contains /chat/completions path segment, keep as-is
      if (/\/chat\/completions(\/|\?|#|$)/i.test(u)) return u.replace(/\/+$/, '');
      // Otherwise append /chat/completions to the provided base URL
      return u + '/chat/completions';
    },

    getLlmTarget() {
      const s = (window.AppState && AppState.settings) ? AppState.settings : {};
      const mode = s.apiMode || 'managed';
      const endpointOverride = ((document.getElementById('agentEndpoint') || {}).value || '').trim();
      const modelInput = ((document.getElementById('agentModel') || {}).value || '').trim();
      const providerSel = ((document.getElementById('agentProvider') || {}).value || 'openai-compatible').trim();
      const keys = Array.isArray(AppState.apiKeys) ? AppState.apiKeys.filter(k => String(k || '').trim()) : [];

      if (mode === 'direct') {
        const dropdownVal = String(((document.getElementById('agentProvider') || {}).value || '')).toLowerCase();
        const dprov = dropdownVal || String(s.directProvider || 'gemini').toLowerCase();
        const cfg = this.getDirectProviderConfig(dprov);
        let provider = cfg.provider || 'openai-compatible';
        let endpoint = endpointOverride || cfg.endpoint || '';
        let model = modelInput || cfg.model || '';
        let endpointMissingForCustom = false;

        if (dprov === 'custom') {
          provider = 'openai-compatible';
          if (!endpointOverride) {
            endpointMissingForCustom = true;
            endpoint = '';
          } else {
            endpoint = this.normalizeCustomDirectEndpoint(endpointOverride);
          }
          // Use configured Model name for custom direct provider
          model = modelInput || '';
        } else if (endpointOverride) {
          // Advanced override for built-in direct providers
          provider = providerSel || provider;
        }

        return {
          mode: 'direct',
          provider,
          endpoint,
          model,
          keys: keys.length ? keys : [''],
          requiresKey: true,
          label: `Direct ${cfg.name}`,
          directProvider: dprov,
          endpointMissingForCustom
        };
      }

      // Managed mode
      const endpoint = endpointOverride || (providerSel === 'anthropic' ? 'https://api.anthropic.com/v1/messages' : '/api/chat');
      return {
        mode: 'managed',
        provider: providerSel || 'openai-compatible',
        endpoint,
        model: modelInput || '',
        keys: keys.length ? keys : [''],
        requiresKey: providerSel === 'anthropic' || !!endpointOverride,
        label: endpointOverride ? 'Custom Endpoint' : 'Managed AI Proxy',
        directProvider: null,
        endpointMissingForCustom: false
      };
    },

    getEndpoint(provider, override) {
      // legacy helper (kept for compatibility)
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

  makeChatTitleFromPrompt(prompt, maxLen = 36) {
      try {
        let s = String(prompt == null ? '' : prompt).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
        if (!s) return 'New chat';
        s = s.replace(/^(please|can you|could you|would you|hey|hi|hello|help me|i need you to|i want you to)\b[:,\s-]*/i, '').trim() || s;
        if (s.length > maxLen) s = s.slice(0, Math.max(1, maxLen - 1)).trimEnd() + '…';
        return s || 'New chat';
      } catch { return 'New chat'; }
    },

    async autoTitleChatSession(chatId, prompt) {
      try {
        if (!chatId || !window.AppState || typeof AppState.getChat !== 'function') return;
        const session = AppState.getChat(chatId);
        if (!session || String(session.title || '') !== 'New chat') return;

        const fallback = this.makeChatTitleFromPrompt(prompt, 36);
        if (typeof AppState.updateChat === 'function') {
          AppState.updateChat(chatId, { title: fallback });
        } else {
          session.title = fallback;
          session.updatedAt = Date.now();
          if (typeof AppState.saveChatSessions === 'function') AppState.saveChatSessions();
        }
        if (window.App && typeof App.renderChatHistory === 'function') App.renderChatHistory();

        const userPrompt = String(prompt == null ? '' : prompt).trim();
        if (!userPrompt) return;

        let resp = null;
        try {
          resp = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: '@cf/qwen/qwen2.5-coder-32b-instruct',
              stream: false,
              max_tokens: 20,
              temperature: 0.2,
              messages: [
                { role: 'system', content: 'You generate short chat titles. Return only the title text.' },
                { role: 'user', content: "Summarize the user's message into a concise 3-5 word chat title. No quotes, no punctuation, plain words only.\n\nMessage: " + userPrompt.slice(0, 500) }
              ]
            })
          });
        } catch { return; }
        if (!resp || !resp.ok) return;
        const ct = String(resp.headers.get('content-type') || '').toLowerCase();
        if (ct.includes('text/event-stream')) return;
        const data = await resp.json().catch(() => null);
        let title = (typeof this.extractAssistantText === 'function') ? this.extractAssistantText('openai-compatible', data) : '';
        if (!title && data && Array.isArray(data.choices)) title = (((data.choices[0] || {}).message || {}).content || '');
        title = String(title || '').split('\n')[0].replace(/["'`\u201c\u201d\u2018\u2019]/g, '').replace(/[.!?:;,]+$/g, '').replace(/\s+/g, ' ').trim();
        if (!title) return;
        const words = title.split(/\s+/).filter(Boolean).slice(0, 6);
        if (words.length) title = words.join(' ');
        if (!title || /^new chat$/i.test(title)) return;

        const current = AppState.getChat(chatId);
        if (!current) return;
        const curTitle = String(current.title || '');
        if (curTitle !== fallback && curTitle !== 'New chat') return;
        if (typeof AppState.updateChat === 'function') {
          AppState.updateChat(chatId, { title });
        } else {
          current.title = title;
          current.updatedAt = Date.now();
          if (typeof AppState.saveChatSessions === 'function') AppState.saveChatSessions();
        }
        if (window.App && typeof App.renderChatHistory === 'function') App.renderChatHistory();
      } catch { /* non-fatal */ }
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
      const agentEndpointVal = String((document.getElementById('agentEndpoint') || { value: '' }).value || '').trim();
      const target = this.getLlmTarget(undefined, undefined, undefined, agentEndpointVal || undefined);
      // Persist the dropdown provider so it survives reload
      if (target.directProvider && target.directProvider !== 'openai-compatible') {
        AppState.settings.directProvider = target.directProvider;
        this.persistAgentSettings();
      }
      const provider = target.provider || 'openai-compatible';
      const endpoint = target.endpoint;
      const model = target.model || '';

      if (target.mode === 'direct' && String(target.directProvider || '').toLowerCase() === 'custom' && !String(((document.getElementById('agentEndpoint') || {}).value || '')).trim()) {
        throw new Error('Custom (OpenAI-compatible) Direct Provider requires an API endpoint override. Enter your base URL (e.g. https://api.example.com/v1) in Settings.');
      }
      if (!endpoint) throw new Error('No API endpoint configured. Set API Mode/endpoint in Settings.');

      const customKeys = Array.isArray(AppState.apiKeys) ? AppState.apiKeys.filter(k => String(k || '').trim()) : [];
      if (target.mode === 'direct' && !customKeys.length) {
        const dprov = String(target.directProvider || (AppState.settings && AppState.settings.directProvider) || 'provider').toLowerCase();
        const dname = dprov === 'custom' ? 'Custom (OpenAI-compatible)' : (dprov === 'openrouter' ? 'OpenRouter' : (dprov === 'groq' ? 'Groq' : (dprov === 'gemini' ? 'Gemini' : dprov)));
        throw new Error(`Direct ${dname} mode requires an API key in Settings (endpoint: ${endpoint || '(not set)'}).`);
      }
      const keys = customKeys.length ? customKeys : [''];
      const total = keys.length;
      const system = (opts && Object.prototype.hasOwnProperty.call(opts, 'system'))
        ? String(opts.system == null ? '' : opts.system)
        : ((typeof this.getEffectiveSystemPrompt === 'function') ? this.getEffectiveSystemPrompt(this.getAgentMode()) : String((AppState.settings && AppState.settings.systemPrompt) || ''));
      // Enable SSE streaming (stream: true) for live token rendering by default on OpenAI-compatible endpoints
      const wantStream = opts.stream !== false && provider !== 'anthropic' && !opts.disableStream;
      let lastError = null;

      for (let attempt = 0; attempt < total; attempt++) {
        const idx = customKeys.length ? (AppState.apiKeyIndex + attempt) % total : 0;
        const key = keys[idx];
        const body = this.buildRequestBody(provider, model, system, promptTextOrMessages, { stream: wantStream, tools: opts.tools, tool_choice: opts.tool_choice });
        const headers = this.getHeaders(provider, key);
        try {
          // 1 automatic retry after 1s on transient network drops
          const res = await this.fetchWithRetry(endpoint, { method: 'POST', headers, body: JSON.stringify(body) }, 1, 1000);

          if ((res.status === 429 || res.status === 402 || res.status === 403) && customKeys.length > 1) {
            AppState.apiKeyIndex = (idx + 1) % total; this.updateKeyStatus();
            const t = await res.text().catch(() => '');
            lastError = new Error(`Rate/auth limit on key index ${idx}: ${this.formatFetchError(null, endpoint, res, t)}`);
            continue;
          }
          if (!res.ok) {
            const t = await res.text().catch(() => '');
            throw new Error(`${target.label || 'API'}: ${this.formatFetchError(null, endpoint, res, t)}`);
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
          // Format network errors with exact failing URL
          if (e instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(String((e && e.message) || e || ''))) {
            lastError = new Error(this.formatFetchError(e, endpoint, null, ''));
          } else {
            lastError = e;
          }

          // If tools caused the failure (400/422), retry once without tools (with retry wrapper)
          const msg = String((lastError && lastError.message) || '');
          if (opts.tools && opts.tools.length && (/\b400\b/.test(msg) || /\b422\b/.test(msg))) {
            try {
              console.warn('LLM call failed with tools, retrying without tools:', msg);
              const retryBody = this.buildRequestBody(provider, model, system, promptTextOrMessages, { stream: wantStream });
              const retryRes = await this.fetchWithRetry(endpoint, { method: 'POST', headers, body: JSON.stringify(retryBody) }, 1, 1000);
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
              lastError = new Error(`${target.label || 'API'} (no-tools retry): ${this.formatFetchError(null, endpoint, retryRes, rt)}`);
            } catch (re) {
              lastError = (re instanceof TypeError || /failed to fetch/i.test(String((re && re.message) || re || '')))
                ? new Error(this.formatFetchError(re, endpoint, null, ''))
                : re;
            }
          }

          if (customKeys.length > 1 && attempt < total - 1) continue;
          if (attempt === total - 1) break;
        }
      }
      throw lastError || new Error(`All API attempts failed (endpoint: ${endpoint}).`);
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
      const src = String(text || '');
      const fences = [...src.matchAll(/```(json:edits|json:mcp|json)\s*([\s\S]*?)```/gi)];
      for (const m of fences) {
        const lang = String(m[1] || '').toLowerCase();
        const obj = Utils.safeJsonParse(m[2], null);
        if (!obj) continue;
        if (lang === 'json:mcp') {
          const calls = Array.isArray(obj) ? obj : (Array.isArray(obj.calls) ? obj.calls : [obj]);
          for (const c of calls) if (c && (c.name || c.tool || c.server)) actions.mcp.push(c);
          continue;
        }
        if (obj && (Array.isArray(obj.edits) || Array.isArray(obj.terminal) || Array.isArray(obj.mcp) || obj.n8n || obj.notes)) {
          if (Array.isArray(obj.edits)) actions.edits.push(...obj.edits);
          if (Array.isArray(obj.terminal)) actions.terminal.push(...obj.terminal);
          if (Array.isArray(obj.mcp)) actions.mcp.push(...obj.mcp);
          if (obj.n8n) actions.n8n = obj.n8n;
          if (obj.notes) actions.notes += (actions.notes ? '\n' : '') + obj.notes;
        }
      }
      // raw MCP tool invocation object: {"name":"mcp__server__tool","arguments":{...}}
      try {
        const trimmed = src.trim();
        if (/^\{[\s\S]*\}$/.test(trimmed)) {
          const obj = Utils.safeJsonParse(trimmed, null);
          if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
            const nm = String(obj.name || obj.tool || '');
            if (/^mcp__/.test(nm) || (obj.server && (obj.tool || obj.name))) actions.mcp.push(obj);
          }
        }
      } catch {}
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
    isExplicitN8nCommand(prompt) {
      const p = String(prompt || '').trim();
      return /^\/(?:n8n|trigger)\b/i.test(p) || /^trigger\s+n8n\b/i.test(p);
    },
    hasExplicitN8nIntent(prompt) {
      const p = String(prompt || '').trim();
      if (!p) return false;
      if (this.isExplicitN8nCommand(p)) return true;
      const lower = p.toLowerCase();
      // Require explicit intent to run/trigger an automation/workflow (uses saved n8n config; no chat URL/payload needed).
      const mentionsN8n = /\bn8n\b|\bn\s*8\s*n\b/.test(lower);
      const actionVerb = /\b(run|trigger|execute|start|launch|fire|invoke|dispatch|kick\s*off|test|activate|send)\b/.test(lower);
      const workflowWord = /\bworkflow(s)?\b|\bautomation(s)?\b|\bwebhook\b/.test(lower);
      if (!actionVerb) return false;
      if (!mentionsN8n && !workflowWord) return false;
      // Must clearly refer to running a configured automation/workflow (n8n mention OR "my/the ... workflow/automation")
      const explicitTarget = mentionsN8n || /\b(my|the|our|saved|configured)\b[^\n]{0,40}\b(workflow|automation|webhook)s?\b/.test(lower) || /\b(workflow|automation|webhook)s?\b[^\n]{0,20}\b(now|for me)\b/.test(lower);
      if (!explicitTarget) return false;

      // Exclude questions/how-to/explanations/coding requests unless clearly asking to run it now
      const asksToRunNow = /\b(now|right now|for me|please run|please trigger|please execute|please start|go ahead and run|go ahead and trigger|run it|trigger it|start it)\b/.test(lower);
      const isInformational = /^\s*(what|how|why|when|where|who|which|explain|describe|help me understand|tell me about|can you explain|could you explain|difference between|compare)\b/i.test(p);
      const isAuthoringRequest = /^\s*(write|create|build|make|generate|code|implement|add|fix|debug|refactor|update|modify|review|analyze|inspect|scan|design|set up|configure)\b/i.test(p);
      if ((isInformational || isAuthoringRequest) && !asksToRunNow) return false;

      // Simple greetings/chit-chat safety
      if (/^\s*(hi|hello|hey|yo|thanks|thank you|ok|okay)[!.,\s]*$/i.test(p)) return false;

      return true;
    },
    shouldN8n(prompt) {
      const cfg = (typeof this.getSavedN8nConfig === 'function') ? this.getSavedN8nConfig() : {};
      const hasConfig = !!String(cfg.url || (AppState && AppState.settings && AppState.settings.webhookUrl) || '').trim();
      if (!hasConfig) return false;
      if (this.isExplicitN8nCommand(prompt)) return true;
      return this.hasExplicitN8nIntent(prompt);
    },
    shouldBinaryAnalyze(prompt) {
      const p = String(prompt || '').toLowerCase();
      const hasBinary = !!(window.BinaryInspector && BinaryInspector.selectedFile);
      if (!hasBinary) return false;
      return /(analy[sz]e|inspect|reverse|binary|malware|strings|imports|what('?s| is) in (this|the) (binary|apk|exe|dmg|file)|security)/i.test(prompt) || (/(binary|apk|exe|dmg)/i.test(p));
    },

    async performWebSearch(query) {
      const url = '/api/search';
      try {
        const res = await this.fetchWithRetry(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, numResults: 5 })
        }, 1, 1000);
        if (!res.ok) {
          const t = await res.text().catch(() => '');
          return { error: this.formatFetchError(null, url, res, t), results: [] };
        }
        const data = await res.json().catch(() => ({}));
        return data;
      } catch (e) {
        return { error: this.formatFetchError(e, url, null, ''), results: [] };
      }
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
        if (/^Web search/i.test(s)) {
          const m = s.match(/^Web search(?:\s*\(([^)]+)\))?:\s*(.*)$/i);
          if (m && m[2] && /\d+\s+result/.test(m[2])) badges.push(`✓ Web search${m[1] ? `: ${m[1]}` : ''}`);
          else if (m && m[2] && /no results/i.test(m[2])) badges.push(`✓ Web search${m[1] ? `: ${m[1]}` : ''} (no results)`);
          else if (/^Web search:/i.test(s)) badges.push(`✓ ${s}`);
          else badges.push('✓ Web search');
        }
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
        const searchPreview = this.formatToolArgsPreview({ query: prompt }, 60);
        const pill = this.addStatusPill(`🔍 Searching web${searchPreview ? `: ${searchPreview}` : ''}...`, 'running');
        try {
          const data = await this.performWebSearch(prompt);
          const formatted = this.formatSearchResults(data);
          const ok = Array.isArray(data.results) && data.results.length > 0;
          extraContext += `\n\n--- Web Search Results (/api/search) ---\n${formatted}`;
          toolNotes.push(ok ? `Web search${searchPreview ? ` (${searchPreview})` : ''}: ${data.results.length} result(s)` : (data.error ? `Web search${searchPreview ? ` (${searchPreview})` : ''}: ${data.error}` : `Web search${searchPreview ? ` (${searchPreview})` : ''}: no results`));
          this.updateStatusPill(pill, ok ? `🔍 Searched web${searchPreview ? `: ${searchPreview}` : ''} (${data.results.length} sources)` : `🔍 Web search${searchPreview ? `: ${searchPreview}` : ''}: ${data.error || 'no results'}`, ok ? 'done' : 'warn');
        } catch (e) {
          toolNotes.push(`Web search${searchPreview ? ` (${searchPreview})` : ''} failed: ${e.message}`);
          this.updateStatusPill(pill, `🔍 Web search failed: ${e.message}`, 'error');
        }
      }

      let contextBlock = this.collectWorkspaceSummary();
      const attachments = Array.isArray(opts.attachments) ? opts.attachments : [];
      if (attachments.length && window.Workspace && typeof Workspace.buildAgentAttachmentContext === 'function') {
        const attText = Workspace.buildAgentAttachmentContext(attachments);
        if (attText) contextBlock += `\n\n${attText}`;
      }
      if (attachments.length) execSummary.push(`Attached ${attachments.length} file${attachments.length === 1 ? '' : 's'}`);

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
                function: {
                  name: tc.function && tc.function.name,
                  arguments: this.serializeToolArgs(tc.function ? tc.function.arguments : '{}')
                }
              }))
            });

            for (const tc of toolCalls) {
              const fname = tc.function && tc.function.name ? String(tc.function.name) : '';
              const fargsRaw = tc.function ? tc.function.arguments : '{}';
              const fargs = (typeof this.normalizeToolCallArgs === 'function')
                ? this.normalizeToolCallArgs(fargsRaw)
                : (Utils.safeJsonParse(fargsRaw, {}) || {});
              const argPreview = (typeof this.formatToolArgsPreview === 'function') ? this.formatToolArgsPreview(fargs) : '';
              let toolResultText = '';
              try {
                const mcpTarget = (typeof this.parseMcpPrefixedToolName === 'function') ? this.parseMcpPrefixedToolName(fname) : null;
                if (mcpTarget && (window.MCPClient || window.MCP) && typeof (window.MCPClient || window.MCP).callTool === 'function') {
                  const pillLabel = `🔌 MCP ${mcpTarget.server}:${mcpTarget.tool}${argPreview ? ` (${argPreview})` : ''}...`;
                  const pill = this.addStatusPill(pillLabel, 'running');
                  try {
                    const result = await (window.MCPClient || window.MCP).callTool(mcpTarget.server, mcpTarget.tool, fargs);
                    toolResultText = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
                    execSummary.push(`MCP ${mcpTarget.server}:${mcpTarget.tool}${argPreview ? ` [${argPreview}]` : ''} (tool_call) result: ${this.formatN8nBody(result).slice(0, 500)}`);
                    this.updateStatusPill(pill, `🔌 MCP ${mcpTarget.server}:${mcpTarget.tool} completed`, 'done');
                  } catch (e) {
                    toolResultText = `Error: ${e.message || e}`;
                    execSummary.push(`MCP ${mcpTarget.server}:${mcpTarget.tool}${argPreview ? ` [${argPreview}]` : ''} (tool_call) failed: ${e.message || e}`);
                    this.updateStatusPill(pill, `🔌 MCP ${mcpTarget.server}:${mcpTarget.tool} failed`, 'error');
                  }
                } else if (fname === 'run_shell' || fname === 'terminal' || fname === ':terminal') {
                  const cmd = (fargs && (fargs.command || fargs.cmd)) ? String(fargs.command || fargs.cmd) : (argPreview || '');
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
                content: this.truncateForModel(typeof toolResultText === 'string' ? toolResultText : JSON.stringify(toolResultText), 12000)
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

      // autonomous MCP tool loop for text/json:mcp/raw MCP invocations (up to 5 hops)
      try {
        let _mcpHops = 0;
        const _mcpClient = window.MCPClient || window.MCP;
        while (_mcpHops < 5 && _mcpClient && typeof _mcpClient.callTool === 'function') {
          const _acts = this.parseAgentActions(answer || '');
          const _calls = Array.isArray(_acts.mcp) ? _acts.mcp : [];
          if (!_calls.length) break;
          _mcpHops++;
          const _results = [];
          for (const call of _calls) {
            let server = call.server || call.serverName; let tool = call.tool || call.name || call.toolName;
            const args = (typeof this.normalizeToolCallArgs === 'function') ? this.normalizeToolCallArgs(call.arguments || call.args || call.input || {}) : (call.arguments || call.args || {});
            if ((!server || !tool) && call.name) {
              const p = (typeof this.parseMcpPrefixedToolName === 'function') ? this.parseMcpPrefixedToolName(call.name) : null;
              if (p) { server = p.server; tool = p.tool; }
            }
            if (!server || !tool) continue;
            const pill = this.addStatusPill(`🔌 MCP ${server}:${tool}...`, 'running');
            try {
              const result = await _mcpClient.callTool(server, tool, args);
              const txt = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
              this.updateStatusPill(pill, `🔌 MCP ${server}:${tool} completed`, 'done');
              execSummary.push(`MCP ${server}:${tool} result: ${txt.slice(0, 500)}`);
              _results.push(`[MCP ${server}:${tool} RESULT]\n${txt}`);
            } catch (e) {
              const msg = e && e.message ? e.message : String(e);
              this.updateStatusPill(pill, `🔌 MCP ${server}:${tool} failed`, 'error');
              _results.push(`[MCP ${server}:${tool} ERROR]\n${msg}`);
            }
          }
          if (!_results.length) break;
          const cont = prompt + '\n\n[Autonomous MCP tool execution results]\n' + _results.join('\n\n').slice(0, 12000) + '\n\nContinue with these results and provide the final plain-English response. Do not repeat the same tool call unless necessary.';
          const cres = await this.callLLM(cont, { stream: true, onDelta: (d) => { if (streamBubble) streamBubble.append(d); } });
          answer = (cres && typeof cres === 'object') ? (cres.text || answer) : (String(cres || '') || answer);
        }
      } catch (e) { console.error('Autonomous MCP text loop error', e); }

      // 3) Execute structured actions (edits, in-browser/remote commands, MCP, n8n) from text blocks
      const actions = this.parseAgentActions(answer || '');
      actions.mcp = []; // executed in autonomous loop
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
      if (actions.mcp && actions.mcp.length && (window.MCPClient || window.MCP) && (window.MCPClient || window.MCP).callTool) {
        for (const call of actions.mcp) {
          let server = call.server || call.serverName;
          let tool = call.tool || call.name || call.toolName;
          const rawArgs = call.arguments || call.args || {};
          const args = this.normalizeToolCallArgs(rawArgs);
          const argPreview = this.formatToolArgsPreview(args);
          if ((!server || !tool) && call.name) {
            const parsed = (typeof this.parseMcpPrefixedToolName === 'function') ? this.parseMcpPrefixedToolName(call.name) : null;
            if (parsed) { server = parsed.server; tool = parsed.tool; }
          }
          if (!server || !tool) continue;
          const pill = this.addStatusPill(`🔌 MCP ${server}:${tool}${argPreview ? ` (${argPreview})` : ''}...`, 'running');
          try {
            const result = await (window.MCPClient || window.MCP).callTool(server, tool, args);
            execSummary.push(`MCP ${server}:${tool}${argPreview ? ` [${argPreview}]` : ''} result: ${this.formatN8nBody(result).slice(0, 500)}`);
            this.updateStatusPill(pill, `🔌 MCP ${server}:${tool} completed`, 'done');
          } catch (e) {
            execSummary.push(`MCP ${server}:${tool}${argPreview ? ` [${argPreview}]` : ''} failed: ${e.message}`);
            this.updateStatusPill(pill, `🔌 MCP ${server}:${tool} failed`, 'error');
          }
        }
      }

      // n8n action requested by agent (only when user explicitly asked to run n8n automation/workflow)
      if (actions.n8n && this.hasExplicitN8nIntent(prompt)) {
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
