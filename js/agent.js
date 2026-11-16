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

    getEffectiveSystemPrompt(mode, prompt = '') {
      let m = mode || this.getAgentMode();
      const p = String(prompt == null ? '' : prompt);
      // REA / reverse-engineering intent: force agent/terminal-tool mode, never chat mode
      if (this.shouldForceAgentModeForIntent(p)) m = 'agent';
      const base = String((window.AppState && AppState.settings && AppState.settings.systemPrompt) || '').trim();
      const collab = '\n\nCollaborate like a sharp human teammate. For casual greetings or general questions, reply naturally and directly; do not summarize workspace files, starter files, or project state unless the user asks about them or relevant context is explicitly provided.';
      const mcpInstr = '\n\n--- Autonomous tool calling & execution ---\n' +
        'You can and should invoke tools when helpful. Available tools may include discovered MCP tools (e.g. mcp__apex-mcp__codespace_exec, mcp__apex-mcp__github_repo_inspect, mcp__apex-mcp__web_fetch, mcp__n8n-mcp__*), the built-in trigger_n8n_workflow tool, and workspace/terminal tools. ' +
        'Emit either (1) native OpenAI-compatible tool_calls, (2) a fenced ```json:mcp``` block, or (3) a raw JSON tool object {"name":"...","arguments":{...}}. ' +
        'The runtime executes tool calls (MCP / runner / webhook / workspace), renders inline tool-execution badges with collapsible output, appends tool results to conversation history, and continues automatically (up to 5 tool hops) until you produce a final plain-English response. Do not repeat the same tool call unnecessarily. ' +
        'Guidance: for browser-native web projects use workspace file tools/actions (write_file, edit_file, or ```json:edits```). When the user asks to run shell commands, install packages, execute Python/Node scripts, or test backend code, call codespace_exec via MCP / Remote Terminal Runner (or available terminal execution tool). When the user asks to trigger, run, or send data to an n8n automation workflow, call trigger_n8n_workflow with the appropriate JSON payload. Never claim commands/workflows ran unless a tool result confirms it.';
      const reaInstr = (typeof this.getReaSystemInstructions === 'function') ? this.getReaSystemInstructions(p) : '';
      if (m === 'chat') {
        return base + collab + mcpInstr + reaInstr + '\n\n--- Response Mode: Chat ---\n' +
          'Reply in clear, helpful plain English. Use standard fenced Markdown code blocks (```language ... ```). ' +
          'Do NOT emit ```json:edits``` blocks and do not claim to have modified files or run commands unless results are explicitly provided in context. ' +
          'If the user asks for code changes, provide the code in normal Markdown fenced blocks with explanations.';
      }
      return base + collab + mcpInstr + reaInstr + '\n\n--- Response Mode: Agent/Edit (workspace actions enabled) ---\n' +
        'When you need to create, update, or modify workspace files, return a fenced ```json:edits``` block with this shape:\n' +
        '{"edits":[{"path":"relative/path","content":"new full file content"}],"terminal":[{"command":"..."}],"notes":"short summary"}\n' +
        'Prefer precise, minimal edits. If no edits are needed, use an empty edits array or omit the block. Keep user-facing prose clean; the UI will present file changes as structured cards.\n' +
        'Workspace context may be partial: you receive file names by default and file contents only when relevant or explicitly requested/attached. If you need to inspect or modify a file not shown in context, read it via available tools/runtime capabilities before making assumptions.';
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
      s = s.replace(/^\s*(\d+)\.\s+/gm, '$1. ');
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
        const html = arr.map(b => {
          const s = String(b ?? '');
          if (s.indexOf('tool-exec-badge') !== -1 || (s.trim().startsWith('<') && s.indexOf('>') !== -1)) return s;
          return '<span class="chat-badge">' + this.escapeHtml(s) + '</span>';
        }).join('');
        return '<div class="chat-badges">' + html + '</div>';
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
        const res = await bridge.trigger(opts.event || 'agent_automation', payload, {
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
      let currentMode = this.getAgentMode();
      try {
        if (this.shouldForceAgentModeForIntent(prompt)) {
          currentMode = 'agent';
          if (AppState && AppState.settings) AppState.settings.agentMode = 'agent';
          const sel = document.getElementById('agentModeSelect'); if (sel) sel.value = 'agent';
          try { if (AppState && typeof AppState.saveSettings === 'function') AppState.saveSettings(); } catch {}
        }
      } catch {}
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

      // Auto-title new/bad chat sessions from the first user prompt (fallback immediately, refine in background)
      try {
        const chatId = window.AppState && AppState.activeChatId;
        if (chatId && prompt) {
          const s = AppState.getChat ? AppState.getChat(chatId) : null;
          const t = s ? String(s.title || '') : '';
          if (s && (!t || t === 'New chat' || /^[{\[]/.test(t.trim()))) {
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
      // Immediate animated "Thinking..." pulse inside assistant bubble (REA/RE intent forces agent mode)
      let currentMode = this.getAgentMode();
      try {
        if (this.shouldForceAgentModeForIntent(prompt)) {
          currentMode = 'agent';
          if (AppState && AppState.settings) AppState.settings.agentMode = 'agent';
          const sel = document.getElementById('agentModeSelect'); if (sel) sel.value = 'agent';
          try { if (AppState && typeof AppState.saveSettings === 'function') AppState.saveSettings(); } catch {}
        }
      } catch {}
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

    formatMcpToolCatalogCompact(tools) {
      try {
        const list = Array.isArray(tools) ? tools : [];
        const lines = [];
        for (const t of list) {
          try {
            const server = String((t && t.server) || '').trim();
            const name = String((t && (t.name || t.id)) || '').trim();
            if (!server || !name) continue;
            const fullName = `mcp__${server}__${name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
            let params = [];
            const schema = (t && (t.inputSchema || t.parameters || t.input_schema || t.schema)) || null;
            if (schema && typeof schema === 'object') {
              if (Array.isArray(schema.required) && schema.required.length) params = schema.required.map(x => String(x));
              else if (schema.properties && typeof schema.properties === 'object') params = Object.keys(schema.properties);
            }
            params = params.filter(Boolean).slice(0, 6).map(p => String(p).replace(/[^a-zA-Z0-9_]/g, '').slice(0, 24) || 'arg');
            const paramStr = params.join(', ');
            let desc = String((t && (t.description || t.summary || '')) || '').replace(/\s+/g, ' ').trim();
            if (desc) {
              const m = desc.match(/^(.+?[.!?])(\s|$)/);
              desc = (m ? m[1] : desc).slice(0, 120).trim();
            }
            const line = desc ? `- ${fullName}(${paramStr}): ${desc}` : `- ${fullName}(${paramStr})`;
            lines.push(line);
          } catch {}
        }
        let out = lines.join('\n');
        if (out.length > 7000) out = out.slice(0, 7000) + '\n- ... (catalog truncated)';
        return out || '- (no MCP tools)';
      } catch { return '- (MCP catalog unavailable)'; }
    },

    estimateTokensFromPayload(payload) {
      try {
        const str = typeof payload === 'string' ? payload : JSON.stringify(payload || '');
        return Math.ceil(str.length / 3.5);
      } catch { return 0; }
    },

    trimMessagesToTokenBudget(messages, maxInputTokens = 24000) {
      try {
        if (!Array.isArray(messages) || messages.length <= 2) return Array.isArray(messages) ? messages : [];
        let msgs = messages.map(m => (m && typeof m === 'object') ? { ...m } : m);
        const est = () => this.estimateTokensFromPayload(msgs);
        let guard = 0;
        while (est() > maxInputTokens && msgs.length > 2 && guard++ < 200) {
          let removed = false;
          for (let i = 0; i < msgs.length - 1; i++) {
            const role = msgs[i] && msgs[i].role;
            if (role !== 'system') {
              const tcIds = new Set();
              if (role === 'assistant' && Array.isArray(msgs[i].tool_calls)) {
                for (const tc of msgs[i].tool_calls) { if (tc && tc.id) tcIds.add(tc.id); }
              }
              msgs.splice(i, 1);
              if (tcIds.size) {
                while (i < msgs.length && msgs[i] && msgs[i].role === 'tool' && tcIds.has(msgs[i].tool_call_id)) msgs.splice(i, 1);
              }
              removed = true;
              break;
            }
          }
          if (!removed) break;
        }
        return msgs;
      } catch { return Array.isArray(messages) ? messages : []; }
    },

    getBuiltinToolSpecs(opts = {}) {
      const specs = [];
      specs.push({
        type: 'function',
        function: {
          name: 'write_file',
          description: 'Create or overwrite a workspace file in the in-browser project with full content (browser-native web projects).',
          parameters: { type: 'object', properties: { path: { type: 'string', description: 'Relative workspace file path' }, content: { type: 'string', description: 'Full file content' } }, required: ['path', 'content'] }
        },
        _builtin: { name: 'write_file' }
      });
      specs.push({
        type: 'function',
        function: {
          name: 'edit_file',
          description: 'Edit/replace a workspace file in the in-browser project by writing updated full content.',
          parameters: { type: 'object', properties: { path: { type: 'string', description: 'Relative workspace file path' }, content: { type: 'string', description: 'New full file content' } }, required: ['path', 'content'] }
        },
        _builtin: { name: 'edit_file' }
      });
      specs.push({
        type: 'function',
        function: {
          name: 'run_shell',
          description: 'Execute a terminal/shell command in the configured Remote Runner (if set) or in the browser sandbox. Returns command output.',
          parameters: { type: 'object', properties: { command: { type: 'string', description: 'Shell command to execute' } }, required: ['command'] }
        },
        _builtin: { name: 'run_shell' }
      });
      specs.push({
        type: 'function',
        function: {
          name: 'codespace_exec',
          description: 'Execute a command via MCP/Remote Terminal Runner (preferred for shell commands, package installs, Python/Node scripts, backend tests). Falls back to local/remote runner execution when direct MCP tool is unavailable.',
          parameters: { type: 'object', properties: { command: { type: 'string', description: 'Command to execute' }, cwd: { type: 'string', description: 'Optional working directory' } }, required: ['command'] }
        },
        _builtin: { name: 'codespace_exec' }
      });
      let hasN8n = false;
      try { const cfg = (typeof this.getSavedN8nConfig === 'function') ? this.getSavedN8nConfig() : null; hasN8n = !!(cfg && String(cfg.url || '').trim()); } catch {}
      if (hasN8n) {
        specs.push({
          type: 'function',
          function: {
            name: 'trigger_n8n_workflow',
            description: 'Trigger/run the configured n8n automation workflow by POSTing a JSON payload to the saved n8n Integration Webhook URL with its configured Auth header.',
            parameters: { type: 'object', properties: { payload: { type: 'object', description: 'JSON payload/data to send to the n8n webhook' }, message: { type: 'string', description: 'Optional message to include' }, event: { type: 'string', description: 'Optional event name' } } }
          },
          _builtin: { name: 'trigger_n8n_workflow' }
        });
      }
      return specs;
    },

    getLlmTools() {
      const tools = [];
      try {
        const mcpSpecs = this.getMcpToolSpecs();
        if (Array.isArray(mcpSpecs) && mcpSpecs.length) tools.push(...mcpSpecs);
      } catch {}
      try {
        const builtins = this.getBuiltinToolSpecs();
        if (Array.isArray(builtins) && builtins.length) tools.push(...builtins);
      } catch {}
      const seen = new Set();
      const deduped = [];
      for (const tool of tools) {
        try {
          const name = tool && tool.function && tool.function.name ? String(tool.function.name) : '';
          if (!name || seen.has(name)) continue;
          seen.add(name);
          deduped.push(tool);
        } catch {}
      }
      return deduped.filter(tool => {
        try {
          if (!tool || tool.type !== 'function' || !tool.function) return false;
          const fn = tool.function;
          if (!fn.name || typeof fn.name !== 'string') return false;
          if (!/^[a-zA-Z0-9_-]{1,64}$/.test(fn.name)) return false;
          if (typeof fn.description !== 'string') fn.description = String(fn.description || fn.name || '');
          if (!fn.parameters || typeof fn.parameters !== 'object' || Array.isArray(fn.parameters)) fn.parameters = { type: 'object', properties: {} };
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

    formatToolArgsPreview(args, maxLen = 40) {
      if (!args || typeof args !== 'object') return '';
      try {
        const entries = Object.entries(args);
        if (!entries.length) return '';
        const lim = Math.max(8, Number(maxLen) || 40);
        return entries
          .slice(0, 3)
          .map(([k, v]) => {
            let val = '';
            if (typeof v === 'string') val = v;
            else {
              try { val = JSON.stringify(v); } catch { val = String(v == null ? '' : v); }
            }
            if (val && val.length > lim) val = val.slice(0, Math.max(1, lim - 3)) + '...';
            return `${k}: ${val}`;
          })
          .join(', ');
      } catch {
        return '';
      }
    },

    formatToolResultForUi(value, maxLen = 280) {
      try {
        let text = '';
        if (value == null) text = '';
        else if (typeof value === 'string') text = value;
        else {
          try { text = JSON.stringify(value); } catch { text = String(value); }
        }
        text = String(text || '').replace(/\s+/g, ' ').trim();
        const lim = Math.max(20, Number(maxLen) || 280);
        if (text.length > lim) text = text.slice(0, lim - 3) + '...';
        return text || '(no output)';
      } catch {
        try { return String(value == null ? '' : value).slice(0, 280); } catch { return '(unavailable)'; }
      }
    },

    toolResultToText(value) {
      try {
        if (value == null) return '';
        if (typeof value === 'string') return value;
        if (value && typeof value === 'object') {
          if (Array.isArray(value.content)) {
            const parts = value.content.map(part => {
              if (!part) return '';
              if (typeof part === 'string') return part;
              if (part.type === 'text' && typeof part.text === 'string') return part.text;
              if (typeof part.text === 'string') return part.text;
              try { return JSON.stringify(part); } catch { return String(part); }
            }).filter(Boolean);
            if (parts.length) return parts.join('\n');
          }
          if (typeof value.text === 'string') return value.text;
          if (typeof value.stdout === 'string' || typeof value.stderr === 'string') {
            const out = String(value.stdout || '').trim();
            const err = String(value.stderr || '').trim();
            let s = out || '';
            if (err) s += (s ? '\n[stderr]\n' : '[stderr]\n') + err;
            if (!s && value.error) s = String(value.error);
            return s;
          }
          try { return JSON.stringify(value, null, 2); } catch { return String(value); }
        }
        return String(value);
      } catch { try { return String(value); } catch { return ''; } }
    },

    formatToolBadge(label, detail, ok = true) {
      const esc = (s) => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
      const base = esc(String(label || 'Tool executed').trim());
      const det = String(detail || '').trim();
      const body = det ? '<pre class="tool-badge-output">' + esc(det) + '</pre>' : '';
      return '<details class="tool-exec-badge"><summary><span class="tool-badge-status ' + (ok ? 'ok' : 'err') + '">' + (ok ? '✓' : '✗') + '</span><span class="tool-badge-text">' + base + '</span></summary>' + body + '</details>';
    },

    async executeBuiltinToolCall(toolName, args = {}, ctx = {}) {
      const name = String(toolName || '').trim();
      const a = (args && typeof args === 'object' && !Array.isArray(args)) ? args : {};
      if (name === 'write_file' || name === 'edit_file') {
        const path = String(a.path || a.filePath || a.file || '').replace(/^\/+/, '').trim();
        const content = (a.content != null) ? String(a.content) : (a.text != null ? String(a.text) : null);
        if (!path) return { ok: false, error: 'Missing path', text: 'Missing path', badge: this.formatToolBadge(name + ': missing path', 'Missing path', false) };
        if (content == null) return { ok: false, error: 'Missing content', text: 'Missing content', badge: this.formatToolBadge(name + ': ' + path, 'Missing content', false) };
        if (!window.Editor || typeof Editor.applyEdits !== 'function') return { ok: false, error: 'Editor unavailable', text: 'Editor unavailable', badge: this.formatToolBadge(name + ': ' + path, 'Editor unavailable', false) };
        const existed = !!(window.AppState && AppState.files && AppState.files.has(path));
        const pill = this.addStatusPill((existed ? '📝 Editing ' : '📝 Writing ') + path + '...', 'running');
        try {
          const applied = Editor.applyEdits([{ path, content }]) || [];
          const ok = applied.length > 0;
          this.updateStatusPill(pill, ok ? (existed ? '📝 Edited ' : '📝 Wrote ') + path : '📝 Failed ' + path, ok ? 'done' : 'error');
          if (ok && window.App && App.setView) App.setView('editor');
          const msg = ok ? ((existed ? 'Edited file: ' : 'Created file: ') + path) : ('Failed to write file: ' + path);
          return { ok, text: msg, applied: applied[0] || null, badge: this.formatToolBadge(existed ? 'Edited file' : 'Wrote file', path, ok) };
        } catch (e) {
          const msg = e && e.message ? e.message : String(e);
          this.updateStatusPill(pill, '📝 File edit failed', 'error');
          return { ok: false, error: msg, text: msg, badge: this.formatToolBadge('Edit file', path + '\n' + msg, false) };
        }
      }
      if (name === 'codespace_exec' || name === 'run_shell' || name === 'terminal' || name === ':terminal' || name === 'shell') {
        const cmd = String(a.command || a.cmd || a.code || '').trim();
        if (!cmd) return { ok: false, error: 'Missing command', text: 'Missing command', badge: this.formatToolBadge('Ran terminal command', 'Missing command', false) };
        if (name === 'codespace_exec' && window.MCP && typeof MCP.getAllTools === 'function' && typeof MCP.callTool === 'function') {
          try {
            const tools = MCP.getAllTools() || [];
            const m = tools.find(x => String(x && (x.name || x.id) || '').toLowerCase() === 'codespace_exec');
            if (m && m.server) {
              const pill = this.addStatusPill('▶ Running remotely (MCP): ' + cmd.slice(0,40), 'running');
              const result = await MCP.callTool(m.server, m.name || m.id || 'codespace_exec', { command: cmd, ...(a.cwd ? { cwd: a.cwd } : {}) });
              const text = this.toolResultToText(result);
              const ok = !(result && typeof result === 'object' && (result.isError || result.error || result.ok === false));
              this.updateStatusPill(pill, ok ? '✓ Ran terminal command (MCP)' : '✗ Terminal command failed (MCP)', ok ? 'done' : 'error');
              return { ok, text: text || '(no output)', raw: result, cmd, badge: this.formatToolBadge('Ran terminal command', ('$ ' + cmd + '\n' + (text || '(no output)')).slice(0, 4000), ok) };
            }
          } catch (e) { /* fallback */ }
        }
        if (!window.TerminalPanel || typeof TerminalPanel.executeCommand !== 'function') {
          return { ok: false, error: 'Terminal not available', text: 'Terminal not available', cmd, badge: this.formatToolBadge('Ran terminal command', '$ ' + cmd + '\nTerminal not available', false) };
        }
        const configured = TerminalPanel.getConfiguredUrl ? TerminalPanel.getConfiguredUrl() : '';
        const willRemote = !!(TerminalPanel.getHttpRunnerUrl && TerminalPanel.getHttpRunnerUrl()) || (TerminalPanel.socket && TerminalPanel.socket.readyState === WebSocket.OPEN) || !!configured;
        const pill = this.addStatusPill((willRemote ? '▶ Running remotely: ' : '▶ Running: ') + cmd.slice(0,40), 'running');
        try {
          const r = await TerminalPanel.executeCommand(cmd);
          const ok = r && r.ok !== false;
          const out = String((r && (r.stdout || r.output)) || '').trim();
          const err = String((r && r.stderr) || '').trim();
          let text = out || '';
          if (err) text += (text ? '\n[stderr]\n' : '[stderr]\n') + err;
          if (!text) text = ok ? '(no output)' : (err || r?.error || r?.message || 'Command failed');
          const failMsg = !ok ? (err || r?.error || r?.message || 'Command failed').slice(0, 60) : '';
          this.updateStatusPill(pill, ok ? '✓ Ran terminal command' : '✗ ' + (failMsg || 'Command failed'), ok ? 'done' : 'error');
          return { ok, text, raw: r, cmd, badge: this.formatToolBadge('Ran terminal command', ('$ ' + cmd + '\n' + text).slice(0, 4000), ok) };
        } catch (e) {
          const msg = e && e.message ? e.message : String(e);
          this.updateStatusPill(pill, '✗ Command failed', 'error');
          return { ok: false, error: msg, text: msg, cmd, badge: this.formatToolBadge('Ran terminal command', ('$ ' + cmd + '\n' + msg).slice(0, 4000), false) };
        }
      }
      if (name === 'trigger_n8n_workflow' || name === 'trigger_n8n' || name === 'n8n_trigger_workflow') {
        let payload = a.payload;
        if (payload == null) {
          const rest = { ...a }; delete rest.payload;
          payload = Object.keys(rest).length ? rest : {};
        }
        if (typeof payload === 'string') {
          const parsed = Utils.safeJsonParse(payload, null);
          payload = (parsed && typeof parsed === 'object') ? parsed : { message: payload };
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) payload = { value: payload };
        if (a.message && payload.message == null) payload.message = String(a.message);
        const event = a.event || payload.event || 'agent_tool';
        const pill = this.addStatusPill('⚡ Triggering n8n workflow...', 'running');
        try {
          const fallbackMsg = String((ctx && ctx.prompt) || payload.message || 'Run automation workflow');
          const r = await this.triggerN8n(payload.message || fallbackMsg, payload, { source: 'agent-autonomous', showErrors: false, event });
          const ok = !!(r && r.ok);
          const body = r && r.result ? r.result.body : (r && r.error ? r.error : null);
          const text = ok ? this.formatN8nBody(body) : (r && r.error ? String(r.error) : 'Trigger failed');
          this.updateStatusPill(pill, ok ? '⚡ Triggered n8n workflow' : '⚡ n8n workflow failed', ok ? 'done' : (r && r.error === 'not_configured' ? 'warn' : 'error'));
          return { ok, text, raw: r, badge: this.formatToolBadge('Triggered n8n workflow', String(text || '').slice(0, 4000), ok) };
        } catch (e) {
          const msg = e && e.message ? e.message : String(e);
          this.updateStatusPill(pill, '⚡ n8n workflow failed', 'error');
          return { ok: false, error: msg, text: msg, badge: this.formatToolBadge('Triggered n8n workflow', msg, false) };
        }
      }
      return { ok: false, error: 'Unsupported builtin tool: ' + name, text: 'Unsupported builtin tool: ' + name };
    },

    async executeToolCallByName(toolName, args = {}, ctx = {}) {
      const name = String(toolName || '');
      const mcpTarget = (typeof this.parseMcpPrefixedToolName === 'function') ? this.parseMcpPrefixedToolName(name) : null;
      if (mcpTarget && (window.MCPClient || window.MCP) && typeof (window.MCPClient || window.MCP).callTool === 'function') {
        const argPreview = (typeof this.formatToolArgsPreview === 'function') ? this.formatToolArgsPreview(args) : '';
        const pill = this.addStatusPill('🔌 MCP ' + mcpTarget.server + ':' + mcpTarget.tool + (argPreview ? ' (' + argPreview + ')' : '') + '...', 'running');
        try {
          const result = await (window.MCPClient || window.MCP).callTool(mcpTarget.server, mcpTarget.tool, args);
          const text = this.toolResultToText(result);
          this.updateStatusPill(pill, '🔌 MCP ' + mcpTarget.server + ':' + mcpTarget.tool + ' completed', 'done');
          return { ok: true, text: text || '(no output)', raw: result, badge: this.formatToolBadge('MCP: ' + mcpTarget.server + ':' + mcpTarget.tool, (text || '(no output)').slice(0, 4000), true) };
        } catch (e) {
          const msg = e && e.message ? e.message : String(e);
          this.updateStatusPill(pill, '🔌 MCP ' + mcpTarget.server + ':' + mcpTarget.tool + ' failed', 'error');
          return { ok: false, error: msg, text: msg, raw: null, badge: this.formatToolBadge('MCP: ' + mcpTarget.server + ':' + mcpTarget.tool, msg, false) };
        }
      }
      if (ctx && ctx.server && ctx.tool && (window.MCPClient || window.MCP) && typeof (window.MCPClient || window.MCP).callTool === 'function') {
        const server = String(ctx.server), tool = String(ctx.tool);
        const pill = this.addStatusPill('🔌 MCP ' + server + ':' + tool + '...', 'running');
        try {
          const result = await (window.MCPClient || window.MCP).callTool(server, tool, args);
          const text = this.toolResultToText(result);
          this.updateStatusPill(pill, '🔌 MCP ' + server + ':' + tool + ' completed', 'done');
          return { ok: true, text: text || '(no output)', raw: result, badge: this.formatToolBadge('MCP: ' + server + ':' + tool, (text || '(no output)').slice(0, 4000), true) };
        } catch (e) {
          const msg = e && e.message ? e.message : String(e);
          this.updateStatusPill(pill, '🔌 MCP ' + server + ':' + tool + ' failed', 'error');
          return { ok: false, error: msg, text: msg, raw: null, badge: this.formatToolBadge('MCP: ' + server + ':' + tool, msg, false) };
        }
      }
      return this.executeBuiltinToolCall(name, args, ctx);
    },

    formatSearchResults(data) {
      try {
        if (!data) return 'No search response.';
        const toText = (v) => {
          if (v == null) return '';
          if (typeof v === 'string') return v;
          if (typeof v === 'number' || typeof v === 'boolean') return String(v);
          if (Array.isArray(v)) return v.map(toText).filter(Boolean).join('; ');
          try { return JSON.stringify(v); } catch { return String(v); }
        };
        const errText = toText(data.error);
        const results = Array.isArray(data.results) ? data.results : [];
        if (errText && !results.length) {
          return `Search unavailable: ${errText}`;
        }
        const lines = [];
        const answer = toText(data.answer);
        if (answer) lines.push(`Answer: ${answer}`);
        if (!results.length) lines.push('No web results found.');
        results.slice(0, 6).forEach((r, i) => {
          const item = (r && typeof r === 'object') ? r : { title: r };
          const title = toText(item.title || item.name || '(untitled)').trim() || '(untitled)';
          const url = toText(item.url || item.link || item.href).trim();
          const snippet = toText(item.content || item.snippet || item.description || item.text).trim();
          lines.push(`\n[${i + 1}] ${title}`);
          if (url) lines.push(`Source: ${url}`);
          if (snippet) lines.push(snippet.slice(0, 500));
        });
        if (errText && results.length) lines.push(`\n(note: ${errText})`);
        return lines.join('\n').trim() || 'No web results found.';
      } catch (e) {
        return `Search results formatting error: ${e && e.message ? e.message : e}`;
      }
    },

    serializeToolArgs(v) {
      if (typeof v === 'string') return v;
      try { return JSON.stringify(v == null ? {} : v); } catch { return '{}'; }
    },

    buildRequestBody(provider, model, system, userContentOrMessages, opts = {}) {
      // Accepts a plain prompt string (legacy) or a full messages array (native tool loop)
      const configuredMax = Number(opts.max_tokens || opts.maxTokens || (AppState && AppState.settings && (AppState.settings.maxTokens || AppState.settings.max_tokens)) || 4096) || 4096;
      if (provider === 'anthropic') {
        const content = Array.isArray(userContentOrMessages)
          ? String((userContentOrMessages[userContentOrMessages.length - 1] || {}).content || '')
          : String(userContentOrMessages || '');
        const msgs = [{ role: 'user', content }];
        const estIn = (typeof this.estimateTokensFromPayload === 'function') ? this.estimateTokensFromPayload({ system, messages: msgs, model: model || 'claude-3-5-sonnet-latest' }) : 0;
        const clamped = Math.min(configuredMax, Math.max(1024, 31500 - estIn));
        const body = { max_tokens: clamped, system, messages: msgs };
        body.model = model || 'claude-3-5-sonnet-latest';
        return body; // Anthropic streaming/tool protocol differs; keep simple for compatibility
      }
      let messages = Array.isArray(userContentOrMessages)
        ? userContentOrMessages
        : [
            { role: 'system', content: String(system || '') },
            { role: 'user', content: String(userContentOrMessages || '') }
          ];
      if (typeof this.trimMessagesToTokenBudget === 'function') messages = this.trimMessagesToTokenBudget(messages, 24000);
      const toolsForBody = (Array.isArray(opts.tools) && opts.tools.length) ? opts.tools.map(t => ({ type: t.type || 'function', function: t.function })) : null;
      const estIn = (typeof this.estimateTokensFromPayload === 'function') ? this.estimateTokensFromPayload({ model: model || '', messages, tools: toolsForBody }) : 0;
      const clampedMax = Math.min(configuredMax, Math.max(1024, 31500 - estIn));
      const body = { temperature: 0.2, messages, max_tokens: clampedMax };
      if (model) body.model = model; // omit when empty so /api/chat can apply server default
      if (opts.stream) body.stream = true;
      if (toolsForBody) {
        body.tools = toolsForBody;
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

  makeChatTitleFromPrompt(prompt, maxLen = 42) {
      try {
        let s = String(prompt == null ? '' : prompt).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
        if (!s) return 'New chat';
        s = s.replace(/^(please|can you|could you|would you|hey|hi|hello|help me|i need you to|i want you to)\b[:,\s-]*/i, '').trim() || s;
        s = s.replace(/^[{\[]+\s*/, '').trim() || s;
        if (s.length > maxLen) s = s.slice(0, maxLen).trimEnd();
        return s || 'New chat';
      } catch { return 'New chat'; }
    },

    isBadChatTitle(title) {
      try {
        const t = String(title == null ? '' : title).trim();
        return !t || t === 'New chat' || /^[{\[]/.test(t);
      } catch { return true; }
    },

    normalizeGeneratedChatTitle(raw, prompt, maxLen = 42) {
      try {
        let t = raw;
        if (t && typeof t === 'object') {
          t = t.title || t.name || t.chat_title || t.chatTitle || '';
        }
        if (typeof t === 'string') {
          let s = t.trim();
          // AI auto-title response may be JSON like {"title":"..."}
          if (s.startsWith('{') || s.startsWith('[')) {
            try {
              const parsed = JSON.parse(s);
              if (parsed && typeof parsed === 'object') {
                const cand = Array.isArray(parsed) ? (parsed[0] && (parsed[0].title || parsed[0].name)) : (parsed.title || parsed.name || parsed.chat_title || parsed.chatTitle || '');
                if (cand != null) s = String(cand).trim();
              }
            } catch {}
          }
          s = s.split('\n')[0].replace(/["'`\u201c\u201d\u2018\u2019]/g, '').replace(/[.!?:;,]+$/g, '').replace(/\s+/g, ' ').trim();
          if (s && !/^[{\[]/.test(s) && !/^new chat$/i.test(s)) {
            const words = s.split(/\s+/).filter(Boolean).slice(0, 8);
            if (words.length) s = words.join(' ');
            if (s.length > maxLen) s = s.slice(0, maxLen).trimEnd();
            if (s) return s;
          }
        }
      } catch {}
      return this.makeChatTitleFromPrompt(prompt, maxLen);
    },

    async autoTitleChatSession(chatId, prompt) {
      try {
        if (!chatId || !window.AppState || typeof AppState.getChat !== 'function') return;
        const session = AppState.getChat(chatId);
        if (!session) return;
        const cur = String(session.title || '');
        const isBadTitle = (t) => !t || t.trim() === '' || t === 'New chat' || /^[{\[]/.test(String(t).trim());
        if (!isBadTitle(cur)) return;

        const fallback = this.makeChatTitleFromPrompt(prompt, 42);
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
              max_tokens: 24,
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
        let rawTitle = (typeof this.extractAssistantText === 'function') ? this.extractAssistantText('openai-compatible', data) : '';
        if (!rawTitle && data && Array.isArray(data.choices)) rawTitle = (((data.choices[0] || {}).message || {}).content || '');
        if (!rawTitle && data && data.title) rawTitle = data.title;
        const normalized = this.normalizeGeneratedChatTitle(rawTitle, userPrompt, 42);
        if (!normalized || normalized === fallback || /^new chat$/i.test(normalized) || /^[{\[]/.test(String(normalized).trim())) return;

        const current = AppState.getChat(chatId);
        if (!current) return;
        const curTitle = String(current.title || '');
        if (curTitle !== fallback && curTitle !== 'New chat' && !/^[{\[]/.test(curTitle.trim())) return;
        if (typeof AppState.updateChat === 'function') {
          AppState.updateChat(chatId, { title: normalized });
        } else {
          current.title = normalized;
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
      const _promptHint = (opts && Object.prototype.hasOwnProperty.call(opts, 'promptHint')) ? opts.promptHint : '';
      const system = (opts && Object.prototype.hasOwnProperty.call(opts, 'system'))
        ? String(opts.system == null ? '' : opts.system)
        : ((typeof this.getEffectiveSystemPrompt === 'function') ? this.getEffectiveSystemPrompt(this.getAgentMode(), _promptHint) : String((AppState.settings && AppState.settings.systemPrompt) || ''));
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

    collectWorkspaceSummary(prompt = '', opts = {}) {
      const mode = String(opts.mode || this.getAgentMode() || 'agent').toLowerCase();
      const attachSetting = !!(opts.attachWorkspaceContext ?? (AppState && AppState.settings && AppState.settings.attachWorkspaceContext));
      const attachEl = (typeof document !== 'undefined') ? (document.getElementById('attachWorkspaceContext') || document.getElementById('agentAttachWorkspaceContext')) : null;
      const attach = attachSetting || !!(attachEl && attachEl.checked);
      const attachments = Array.isArray(opts.attachments) ? opts.attachments : [];
      const hasAttachments = attachments.length > 0;
      const starterPaths = new Set(['src/index.js', 'notes.txt']);
      const allFiles = (AppState && AppState.files instanceof Map) ? [...AppState.files.keys()].sort() : [];
      const active = (AppState && typeof AppState.getActiveFile === 'function') ? AppState.getActiveFile() : null;
      const wsName = (AppState && AppState.workspaceName) || 'Workspace';
      const text = String(prompt == null ? '' : prompt);
      const lower = text.toLowerCase();
      const trimmed = text.trim();

      // Strict cap when Attach Workspace Context is checked to stay within Managed Workers AI limits (~32k tokens total)
      const MAX_CONTEXT_CHARS = attach ? 12000 : 16000; // ~3k tokens attached bundle, ~4k otherwise
      const MAX_TREE_ENTRIES = attach ? 140 : 180;
      const MAX_TREE_CHARS = attach ? 3500 : 5000;
      const MAX_FILE_CONTENT_CHARS = attach ? 2500 : 4000;
      const MAX_BINARY_SUMMARY_CHARS = attach ? 800 : 1200;
      const LARGE_FILE_SKIP_CHARS = 40000; // skip oversized files

      const norm = (p) => String(p || '').replace(/^\/+/, '').trim();
      const isExcludedWorkspacePath = (p) => {
        const path = norm(p);
        if (!path) return true;
        const lowerPath = path.toLowerCase();
        const baseLower = (path.split('/').pop() || '').toLowerCase();
        if (lowerPath === 'node_modules' || lowerPath.startsWith('node_modules/') || lowerPath.includes('/node_modules/')) return true;
        if (lowerPath === '.git' || lowerPath.startsWith('.git/') || lowerPath.includes('/.git/')) return true;
        if (baseLower === 'package-lock.json' || baseLower === 'pnpm-lock.yaml' || baseLower === 'yarn.lock' || baseLower === 'bun.lockb' || baseLower === 'composer.lock') return true;
        return false;
      };

      const files = allFiles.filter(p => !isExcludedWorkspacePath(p));

      const mentionsPath = (p) => {
        const path = norm(p);
        if (!path) return false;
        const pathLower = path.toLowerCase();
        if (lower.includes(pathLower)) return true;
        const base = path.split('/').pop();
        if (base && lower.includes(String(base).toLowerCase())) return true;
        return false;
      };

      const anyMentioned = files.filter(mentionsPath);
      const activePath = active && active.path ? norm(active.path) : '';
      const activeVisible = !!(activePath && files.includes(activePath));
      const mentionsActiveRef = /\b(active file|current file|this file|open file|selected file|in editor|the file i('?m| am)? (in|editing|viewing))\b/i.test(text);
      const mentionsActive = !!(activeVisible && (mentionsPath(activePath) || mentionsActiveRef));
      const explicitFileRef = anyMentioned.length > 0 || mentionsActive;
      const inspectEditIntent = /\b(inspect|read|open|show|view|see|look at|check|review|explain|describe|summari[sz]e|what('?s| is) in|contents?|inside|print|cat|edit|modify|update|change|fix|refactor|rewrite|rename|implement|add|remove|delete|create|write|append|debug|test|run|build|diff|compare)\b/i.test(text);
      const asksAboutWorkspace = /\b(what files|which files|list files|show files|file tree|project files|workspace files|project structure|workspace structure|what('?s| is) in (this|the|my) (project|workspace|repo|folder|directory)|what do i have|what's here)\b/i.test(text);

      const isCasualConversation = /^(?:hi|hello|hey|yo|wagwan|sup|howdy|hola|good\s+(?:morning|afternoon|evening|night)|gm|gn|morning|afternoon|evening|how are (?:you|u|ya)(?: doing| today)?|how'?s it going|what'?s up|wassup|whats up|wyd|is that all|that'?s all|anything else|thanks?|thank you|thx|ty|ok|okay|k|kk|cool|nice|great|awesome|sure|alright|aight|bet|got it|understood|perfect|sounds good|lol|haha|lmao|yes|no|yep|yeah|nah|nope)[\s!?.…]*$/i.test(trimmed);
      const hasFileToken = /(?:^|[\s"'`(])(?:\.?\/)?[\w@.-]+\/[\w@./-]+|\b[\w.-]+\.(?:js|jsx|ts|tsx|mjs|cjs|json|html|htm|css|scss|sass|less|md|markdown|txt|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|sh|bash|zsh|fish|yml|yaml|toml|xml|svg|sql|csv|vue|svelte|astro|env|lock)\b/i.test(text);
      const hasCodingOrWorkspaceTaskIntent = asksAboutWorkspace || hasFileToken || /\b(code|coding|file|files|folder|folders|directory|directories|dir\b|path|paths|project|projects|workspace|workspaces|repo|repository|repositories|codebase|source|src\b|bug|bugs|error|errors|exception|exceptions|crash|crashes|fix|fixing|debug|debugging|refactor|refactoring|rewrite|rewriting|implement|implementing|implementation|function|functions|func\b|class\b|classes|method|methods|variable|variables|constant|constants|component|components|module|modules|import|imports|export|exports|package|packages|dependency|dependencies|library|libraries|framework|api|apis|endpoint|endpoints|route|routes|server|servers|client|clients|database|databases|db\b|query|queries|schema|script|scripts|build|compile|compiling|test|tests|testing|lint|linting|format|formatting|run|running|execute|executing|deploy|deployment|install|installing|setup|configure|config|configuration|terminal|command|commands|shell|git|github|commit|branch|merge|pull|push|npm|pnpm|yarn|bun|pip|node|deno|python|java\b|rust\b|golang|php\b|ruby\b|typescript|javascript|html|css|scss|sass|jsx|tsx|json|yaml|yml|toml|sql|markdown|react|next|vue|svelte|angular|tailwind|vite|webpack|app|apps|application|applications|website|webpage|page|pages|ui|ux|interface|layout|style|styles|button|form|input|feature|features|logic|algorithm|create|creating|add|adding|write|writing|edit|editing|update|updating|modify|modifying|change|changing|rename|renaming|move|moving|delete|deleting|remove|removing|replace|replacing|generate|generating|scaffold|scaffolding|open|opening|read|reading|show|showing|list|listing|find|finding|search|searching|grep|inspect|inspecting|review|reviewing|analy[sz]e|analyzing)\b/i.test(text);

      // Never inject workspace files/tree on casual greetings/conversational messages unless explicitly opted-in or referenced.
      if (!attach && !hasAttachments && !explicitFileRef) {
        if (isCasualConversation) return '';
        if (mode === 'chat') {
          if (!asksAboutWorkspace) return '';
        } else {
          if (!hasCodingOrWorkspaceTaskIntent) return '';
        }
      }

      const clampTotal = (s) => {
        const str = String(s || '');
        if (str.length <= MAX_CONTEXT_CHARS) return str;
        return str.slice(0, Math.max(0, MAX_CONTEXT_CHARS - 48)) + '\n\n[workspace context truncated to budget]';
      };

      // Compact file-tree list (names only), budgeted
      const treeEntries = [];
      let treeChars = 0;
      for (let i = 0; i < files.length && treeEntries.length < MAX_TREE_ENTRIES; i++) {
        const line = `- ${files[i]}`;
        if (treeChars + line.length + 1 > MAX_TREE_CHARS) break;
        treeEntries.push(line);
        treeChars += line.length + 1;
      }
      let treeStr = treeEntries.join('\n') || '- (empty)';
      const hiddenCount = Math.max(0, files.length - treeEntries.length);
      if (hiddenCount > 0) treeStr += `\n- ... (${hiddenCount} more)`;

      let out = `Workspace: ${wsName}\nActive file: ${activeVisible ? activePath : '(none)'}\nFiles (${files.length} total):\n${treeStr}`;

      // Chat mode: workspace-structure question with no explicit file refs/attachments/toggle -> tree only, no contents
      if (mode === 'chat' && !attach && !hasAttachments && !explicitFileRef) {
        return clampTotal(out);
      }

      const includeContentFor = [];
      const pushUnique = (p) => { const n = norm(p); if (n && files.includes(n) && !includeContentFor.includes(n)) includeContentFor.push(n); };
      const fileSize = (p) => {
        const f = AppState.files.get(norm(p));
        if (!f) return 0;
        if (f.binary) return String((f.meta && (f.meta.summary || f.meta.report)) || '').length;
        return String(f.content == null ? '' : f.content).length;
      };

      if (attach) {
        // Prioritize only currently open editor file plus compact file-tree list (skip large files)
        if (activeVisible) {
          const f = AppState.files.get(activePath);
          const len = f ? (f.binary ? String((f.meta && (f.meta.summary || f.meta.report)) || '').length : String(f.content == null ? '' : f.content).length) : 0;
          if (f && len <= LARGE_FILE_SKIP_CHARS) pushUnique(activePath);
        }
      } else {
        const canIncludePath = (p) => {
          const path = norm(p);
          if (!path || !files.includes(path)) return false;
          const f = AppState.files.get(path);
          if (!f) return false;
          const isStarter = starterPaths.has(path);
          const mentioned = mentionsPath(path) || (path === activePath && mentionsActive);
          if (mode === 'chat') {
            return mentioned;
          }
          // Agent/Edit: file tree by default; include contents only when user asks to inspect/edit them.
          // Never inject full contents of starter placeholder files unless explicitly asked to inspect/edit them.
          if (isStarter) return mentioned && (inspectEditIntent || asksAboutWorkspace || mentionsActiveRef);
          if (mentioned) return inspectEditIntent || asksAboutWorkspace || mentionsActiveRef;
          return false;
        };

        if (explicitFileRef && activeVisible && canIncludePath(activePath)) pushUnique(activePath);
        for (const p of anyMentioned.slice(0, 4)) {
          if (!p || includeContentFor.includes(p)) continue;
          if (canIncludePath(p)) pushUnique(p);
        }
      }

      // Append file contents/summaries in priority order within total budget
      let remaining = Math.max(0, MAX_CONTEXT_CHARS - out.length);
      for (const p of includeContentFor) {
        if (remaining <= 120) break;
        const f = AppState.files.get(p);
        if (!f) continue;
        if (f.binary) {
          const rawSummary = String((f.meta && (f.meta.summary || f.meta.report)) || '[binary file]');
          const summary = rawSummary.length > MAX_BINARY_SUMMARY_CHARS ? rawSummary.slice(0, MAX_BINARY_SUMMARY_CHARS) + '\n… (truncated)' : rawSummary;
          const block = `\n\n--- File Summary (${p}) ---\n${summary}`;
          if (block.length > remaining) {
            const allowed = Math.max(0, remaining - (`\n\n--- File Summary (${p}) ---\n`).length - 40);
            if (allowed > 40) out += `\n\n--- File Summary (${p}) ---\n${summary.slice(0, allowed)}\n… (truncated)`;
            break;
          }
          out += block;
          remaining -= block.length;
          continue;
        }

        const content = String(f.content == null ? '' : f.content);
        if (content.length > LARGE_FILE_SKIP_CHARS) {
          const block = `\n\n--- File Content (${p}) ---\n[omitted: file too large for context (${content.length} chars)]`;
          if (block.length <= remaining) { out += block; remaining -= block.length; }
          continue;
        }
        const maxForThis = Math.min(MAX_FILE_CONTENT_CHARS, Math.max(0, remaining - (`\n\n--- File Content (${p}) ---\n`).length - 40));
        if (maxForThis <= 0) break;
        const snippet = content.length > maxForThis ? content.slice(0, maxForThis) + '\n… (truncated)' : content;
        const block = `\n\n--- File Content (${p}) ---\n${snippet}`;
        if (block.length > remaining) {
          if (maxForThis > 40) {
            const tighter = content.slice(0, Math.max(0, remaining - (`\n\n--- File Content (${p}) ---\n`).length - 20)) + '\n… (truncated)';
            out += `\n\n--- File Content (${p}) ---\n${tighter}`;
          }
          break;
        }
        out += block;
        remaining -= block.length;
      }

      return clampTotal(out);
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
    isReaMention(prompt) {
      const s = String(prompt || '');
      return /\brea\b/i.test(s)
        || /\binspect-artifact\b/i.test(s)
        || /\baudit-release-exposure\b/i.test(s);
    },
    isReverseEngineeringIntent(prompt) {
      const s = String(prompt || '');
      return /\brea\b/i.test(s)
        || /reverse engineer/i.test(s)
        || /\bdecompile\b/i.test(s)
        || /\bapk\b/i.test(s)
        || /\bbinary\b/i.test(s)
        || /\bdisassemble\b/i.test(s)
        || /\bstrings\b/i.test(s)
        || /\baudit-release-exposure\b/i.test(s)
        || /\binspect-artifact\b/i.test(s);
    },
    shouldForceAgentModeForIntent(prompt) {
      return this.isReverseEngineeringIntent(prompt);
    },
    getReaSystemInstructions(prompt) {
      if (!this.isReaMention(prompt)) return '';
      return '\n\n--- REA / Reverse-Engineering Execution (MANDATORY when rea/REA is mentioned) ---\n' +
        'Whenever the user mentions `rea` or `REA` (e.g. "use rea on app.apk", "run rea inspect-artifact ...", "check this with rea"), you MUST immediately invoke the remote terminal tool to run REA using `npx -y rea-agents@latest <subcommand> <target>` (default to `inspect-artifact` or `analyze` if no specific subcommand is named). Do NOT ask clarifying questions first and do NOT give generic advice instead of running it. Execute the command now via a terminal action (e.g. a ```json:edits``` block with `"terminal":[{"command":"npx -y rea-agents@latest inspect-artifact <target>"}]`) or the available shell/terminal tool so it runs on the remote runner.\n\n' +
        'REA subcommand cheat-sheet (pick the right command automatically; do not run `--help`):\n' +
        '- `inspect-artifact <target>`: general artifact inspection (default starting point)\n' +
        '- `analyze <target>`: broad analysis\n' +
        '- `search-android-classes <apk> [query/options]`: search Android classes/DEX\n' +
        '- `inspect-android-class <apk> <class>`: inspect a specific Android class\n' +
        '- `identify-flutter-build <target>`: detect Flutter build artifacts\n' +
        '- `inspect-binary-hardening <binary>`: check binary hardening/protections\n' +
        '- `inspect-byte-entropy <target>`: entropy/packing signals\n' +
        '- `analyze-web-bundle <bundle>`: inspect JS/web bundles\n' +
        '- `audit-release-exposure <target>`: audit release exposure/secrets/config risks\n' +
        '- `inspect-sqlite-database <db>`: inspect SQLite databases\n' +
        '- `inspect-pcap-capture <pcap>`: inspect network captures\n' +
        '- `search <target> <pattern/options>`: search within artifact\n' +
        '- `trace <target> [options]`: trace behavior/flow where supported\n\n' +
        'After running the initial `rea` inspection, summarize findings—strictly keeping **Confirmed Facts**, **Inferences**, and **Unknowns** separate—and present actionable **Suggested Next Probes** tailored to the target type (and execute the next logical `rea` probe if asked):\n' +
        '1. Trace relevant capability strings/import hints to suspected feature areas (network, filesystem, crypto, process, persistence) and record offset/section evidence where available.\n' +
        '2. If PE: inspect entry point, imports/exports, resources, overlay, and high-entropy/large sections for embedded payloads or installers.\n' +
        '3. If archive/APK: review manifests, scripts, native libraries (.so), DEX/classes, and config files for permissions/endpoints/entry points.\n' +
        '4. Search extracted strings for URLs, domains, registry keys, file paths, command lines, and error messages tied to behavior of interest.\n' +
        '5. For deeper reverse engineering, analyze in authorized environments with native RE tools (Ghidra/IDA/Hopper/rizin) and, if needed, controlled dynamic instrumentation.\n' +
        '6. Validate hypotheses against additional static/dynamic evidence; keep confirmed facts, inferences, and unknowns separate.';
    },
    shouldRouteToTerminalExecution(prompt) {
      const text = String(prompt || '').trim();
      if (!text) return false;
      // REA / reverse-engineering intent: force agent/terminal-tool mode, never web_search
      if (this.isReverseEngineeringIntent(text)) return true;
      const firstLine = text.split(/\r?\n/, 1)[0].trim();
      // Explicit terminal execution requests
      if (/^\s*(run|execute)\b[^\n]*\b(remote\s+)?terminal\b/i.test(firstLine)) return true;
      if (/^\s*execute\s+in\s+terminal\b/i.test(firstLine)) return true;
      if (/\b(run|execute)\b[^\n]*\b(in|on|via|using)\b[^\n]*\b(remote\s+)?(terminal|runner|shell|codespace)\b/i.test(text)) return true;

      // Command/tool invocations that must route to terminal/agent execution (never web search)
      if (/^\s*(npx|node|git)\b/i.test(firstLine)) return true;
      if (/^\s*rea(\s|$)/i.test(firstLine)) return true;
      if (/^\s*(npm|pnpm|yarn|deno|bun|python3?|pip3?|gh|docker|kubectl|cargo|go|java|javac|mvn|gradle|ruby|bundle|rails|php|composer|dotnet|swift|clang|gcc|g\+\+|make|cmake|bash|sh|zsh|curl|wget|ssh|scp|rsync|terraform|ansible|helm|az|aws|gcloud|firebase)\b/i.test(firstLine)) return true;
      if (/^\.\/[^\s]+/.test(firstLine)) return true;

      // Prompts starting with or mentioning these command/tool tokens/phrases in execution context
      if (/^\s*(please\s+)?(run|execute)\s+/i.test(text) && /(^|[\s"'`(])(npx|node|git|rea)(\s|$|["'`),;.:])/i.test(text)) return true;
      if (/(^|[\s"'`(])(npx)(\s|$|["'`),;.:])/i.test(text)) return true;
      if (/(^|[\s"'`(])rea(\s|$|["'`),;.:])/i.test(text)) return true;
      if (/(^|[\s"'`(])git(\s|$|["'`),;.:])/i.test(text) && /\b(run|execute|terminal|shell|runner|command|remote|status|diff|commit|push|pull|clone|checkout|branch|merge|log|rebase|stash|fetch|add|init)\b/i.test(text)) return true;
      if (/(^|[\s"'`(])node(\s|$|["'`),;.:])/i.test(text) && /\b(run|execute|terminal|shell|runner|command|script|\.js\b|\.mjs\b|\.cjs\b)\b/i.test(text)) return true;

      return false;
    },
    shouldSearch(prompt) {
      const raw = String(prompt || '').trim();
      if (!raw) return false;
      // REA / reverse-engineering intent: force agent/terminal-tool mode, never web_search
      if (typeof this.isReverseEngineeringIntent === 'function' && this.isReverseEngineeringIntent(raw)) return false;
      // Terminal/agent execution intent takes precedence and must never route to web_search
      if (this.shouldRouteToTerminalExecution(raw)) return false;
      if (/^\s*(run|execute)\b[^\n]*\b(remote\s+)?terminal\b/i.test(raw) || /\bexecute\s+in\s+terminal\b/i.test(raw)) return false;
      if (/(^|[\s"'`(])(npx|rea)(\s|$|["'`),;.:])/i.test(raw)) return false;
      if (/(^|[\s"'`(])(node|git)(\s|$|["'`),;.:])/i.test(raw)) return false;

      const lower = raw.toLowerCase();
      if (/(https?:\/\/)/.test(lower)) return false; // direct URL fetch not our search tool
      const explicitWeb = /\b(search|look up|lookup|google|find online|web search|search the web|internet|online docs|documentation online)\b/i.test(raw);
      if (explicitWeb) return true;
      const intent = /(docs|documentation|latest|current|today|news|release|version|changelog|price|weather|who is|what is|when did|how to .*(202\d|latest)|compare .* (vs|versus) .* (202\d|latest)|error .* fix .* (202\d|latest))/i;
      const live = /(202[4-9]|latest|newest|current|recent|today|now|breaking)/i;
      return intent.test(raw) || (live.test(raw) && /(what|who|when|which|news|release|version|docs|api)/i.test(raw));
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
          body: JSON.stringify({ method: 'web_search', action: 'web_search', tool: 'web_search', query, numResults: 5 })
        }, 1, 1000);
        if (!res.ok) {
          const t = await res.text().catch(() => '');
          return { error: this.formatFetchError(null, url, res, t), results: [] };
        }
        const data = await res.json().catch(() => ({}));
        return (data && typeof data === 'object') ? data : { results: [], raw: data };
      } catch (e) {
        return { error: this.formatFetchError(e, url, null, ''), results: [] };
      }
    },

    buildActionBadges(execSummary = [], toolNotes = [], applied = [], cmdResults = [], extras = []) {
      const badges = [];
      for (const item of (execSummary || [])) {
        if (!item) continue;
        if (typeof item === 'string' && item.indexOf('tool-exec-badge') !== -1) badges.push(item);
      }
      for (const a of (applied || [])) {
        if (!a || !a.path) continue;
        badges.push((a.created ? '✓ Created ' : '✓ Updated ') + a.path);
      }
      for (const r of (cmdResults || [])) {
        if (!r || !r.cmd) continue;
        if (badges.some(b => typeof b === 'string' && b.indexOf('Ran terminal command') !== -1)) continue;
        const short = String(r.cmd).length > 42 ? String(r.cmd).slice(0, 39) + '…' : String(r.cmd);
        if (r.mode === 'browser' && !r.remote) badges.push('✓ Ran in sandbox: ' + short);
        else if (r.remote) badges.push('✓ Ran remotely: ' + short);
        else badges.push('✓ Ran: ' + short);
      }
      for (const e of (extras || [])) { if (e) badges.push(e); }
      const seen = new Set();
      return badges.filter(b => { const k = typeof b === 'string' ? b : JSON.stringify(b); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 12);
    },

    async runPrompt(prompt, opts = {}) {
      const streamBubble = opts.streamBubble || this.createStreamingAssistantBubble('chat');
      const useRagEl = document.getElementById('agentUseRag');
      const autoApplyEl = document.getElementById('agentAutoApply');
      const useRag = opts.useRag ?? (useRagEl ? useRagEl.checked : true);
      const autoApply = autoApplyEl ? autoApplyEl.checked : ((AppState && AppState.settings && typeof AppState.settings.autoApplyEdits === 'boolean') ? AppState.settings.autoApplyEdits : true);
      const toolNotes = [];
      let extraContext = '';
      let ragMeta = '';
      const execSummary = [];
      const cmdResults = [];
      let nativeToolCallsAccum = [];

      // 1) Unified autonomous tool routing (pre-LLM): web search, binary context, n8n, MCP, RAG
      const wantsSearch = this.shouldSearch(prompt);
      if (wantsSearch) {
        const searchPreview = Agent.formatToolArgsPreview({ query: prompt }, 60);
        const pill = this.addStatusPill(`🔍 Searching web${searchPreview ? `: ${searchPreview}` : ''}...`, 'running');
        try {
          const data = await this.performWebSearch(prompt);
          const formatted = this.formatSearchResults(data);
          const results = Array.isArray(data && data.results) ? data.results : [];
          const ok = results.length > 0;
          const errMsg = (data && data.error) ? (typeof data.error === 'string' ? data.error : (this.formatToolResultForUi(data.error, 160) || 'search error')) : '';
          extraContext += `\n\n--- Web Search Results (/api/search) ---\n${formatted}`;
          toolNotes.push(ok
            ? `Web search${searchPreview ? ` (${searchPreview})` : ''}: ${results.length} result(s)`
            : (errMsg
              ? `Web search${searchPreview ? ` (${searchPreview})` : ''}: ${errMsg}`
              : `Web search${searchPreview ? ` (${searchPreview})` : ''}: no results`));
          this.updateStatusPill(
            pill,
            ok
              ? `🔍 Searched web${searchPreview ? `: ${searchPreview}` : ''} (${results.length} sources)`
              : `🔍 Web search${searchPreview ? `: ${searchPreview}` : ''}: ${errMsg || 'no results'}`,
            ok ? 'done' : 'warn'
          );
        } catch (e) {
          const emsg = (e && e.message) ? e.message : String(e);
          toolNotes.push(`Web search${searchPreview ? ` (${searchPreview})` : ''} failed: ${emsg}`);
          this.updateStatusPill(pill, `🔍 Web search failed: ${this.formatToolResultForUi(emsg, 120)}`, 'error');
        }
      }

      const attachments = Array.isArray(opts.attachments) ? opts.attachments : [];
      const attachCtx = !!(AppState && AppState.settings && AppState.settings.attachWorkspaceContext) || !!((typeof document !== 'undefined') && ((document.getElementById('attachWorkspaceContext') || document.getElementById('agentAttachWorkspaceContext') || {}).checked));
      let _runMode = this.getAgentMode();
      try { if (this.shouldForceAgentModeForIntent(prompt)) _runMode = 'agent'; } catch {}
      let contextBlock = this.collectWorkspaceSummary(prompt, {
        mode: _runMode,
        attachments,
        attachWorkspaceContext: attachCtx
      });
      if (attachments.length && window.Workspace && typeof Workspace.buildAgentAttachmentContext === 'function') {
        const attText = Workspace.buildAgentAttachmentContext(attachments);
        if (attText) contextBlock = contextBlock ? (contextBlock + `\n\n${attText}`) : attText;
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
      try {
        if (window.MCP && typeof MCP.connectAll === 'function' && MCP.connections && MCP.connections.size === 0 && Array.isArray(AppState.mcpServers) && AppState.mcpServers.length) {
          await Promise.race([
            (async () => { try { await MCP.connectAll(AppState.mcpServers); if (typeof MCP.discoverAll === 'function') await MCP.discoverAll(); } catch {} })(),
            new Promise(r => setTimeout(r, 1500))
          ]);
        }
      } catch {}
      const mcpTools = (window.MCP && MCP.getAllTools) ? MCP.getAllTools() : [];
      const llmTools = (typeof this.getLlmTools === 'function') ? this.getLlmTools() : [];
      if (mcpTools.length) {
        const compactCatalog = (typeof this.formatMcpToolCatalogCompact === 'function')
          ? this.formatMcpToolCatalogCompact(mcpTools)
          : mcpTools.map(t => `- mcp__${t.server}__${t.name || t.id}`).join('\n');
        contextBlock += `\n\n--- Available MCP Tools (${mcpTools.length}) ---\n` + compactCatalog;
      }
      if (llmTools.length) {
        const toolNames = llmTools.map(t => `- ${(t.function && t.function.name) || t.name || '(unnamed)'}`).join('\n');
        contextBlock += `\n\n--- Available Function Tools (${llmTools.length}) ---\n` + toolNames;
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
      const contextSection = String(contextBlock || '').trim();
      const userPayload = contextSection
        ? `${prompt}\n\n=== WORKSPACE & TOOL CONTEXT ===\n${contextSection}`
        : String(prompt || '');

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
              tools: llmTools,
              promptHint: prompt
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
              let toolResultText = '';
              let toolExec = null;
              try {
                toolExec = await this.executeToolCallByName(fname, fargs, { prompt });
                toolResultText = this.toolResultToText(toolExec && (toolExec.text != null ? toolExec.text : (toolExec.raw != null ? toolExec.raw : (toolExec.error || ''))));
                if (!toolResultText && toolExec && toolExec.error) toolResultText = 'Error: ' + toolExec.error;
                if (toolExec && toolExec.badge) execSummary.push(toolExec.badge);
                if (toolExec && toolExec.cmd) cmdResults.push({ cmd: toolExec.cmd, ...(toolExec.raw || {}), remote: !!(toolExec.raw && (toolExec.raw.mode === 'remote' || toolExec.raw.mode === 'remote-http')) });
                if (toolExec && toolExec.applied) applied.push(toolExec.applied);
              } catch (e) {
                toolResultText = 'Tool execution error: ' + (e.message || e);
              }
              messages.push({
                role: 'tool',
                tool_call_id: tc.id || ('call_' + Math.random().toString(36).slice(2)),
                content: this.truncateForModel(typeof toolResultText === 'string' ? toolResultText : JSON.stringify(toolResultText), 12000)
              });
            }
          }
        } else {
          const res = await this.callLLM(userPayload, {
            stream: true,
            onDelta: (delta) => { if (streamBubble) streamBubble.append(delta); },
            promptHint: prompt
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
            let fname = String(call.name || tool || '');
            if ((!server || !tool) && call.name) {
              const p = (typeof this.parseMcpPrefixedToolName === 'function') ? this.parseMcpPrefixedToolName(call.name) : null;
              if (p) { server = p.server; tool = p.tool; fname = call.name; }
            }
            if (server && tool) {
              const ex = await this.executeToolCallByName(fname || ('mcp__' + server + '__' + tool), args, { prompt, server, tool });
              const txt = String((ex && (ex.text || ex.error)) || '').trim();
              if (ex && ex.badge) execSummary.push(ex.badge);
              if (ex && ex.applied) applied.push(ex.applied);
              _results.push('[TOOL ' + server + ':' + tool + ' ' + ((ex && ex.ok) ? 'RESULT' : 'ERROR') + ']\n' + (txt || '(no output)'));
              continue;
            }
            if (!fname) continue;
            const ex = await this.executeToolCallByName(fname, args, { prompt });
            const txt = String((ex && (ex.text || ex.error)) || '').trim();
            if (ex && ex.badge) execSummary.push(ex.badge);
            if (ex && ex.applied) applied.push(ex.applied);
            _results.push('[TOOL ' + fname + ' ' + ((ex && ex.ok) ? 'RESULT' : 'ERROR') + ']\n' + (txt || '(no output)'));
          }
          if (!_results.length) break;
          const cont = prompt + '\n\n[Autonomous MCP tool execution results]\n' + _results.join('\n\n').slice(0, 12000) + '\n\nContinue with these results and provide the final plain-English response. Do not repeat the same tool call unless necessary.';
          const cres = await this.callLLM(cont, { stream: true, onDelta: (d) => { if (streamBubble) streamBubble.append(d); }, promptHint: prompt });
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

      // MCP/tool calls requested by agent in structured action blocks (fallback path)
      if (actions.mcp && actions.mcp.length) {
        for (const call of actions.mcp) {
          let server = call.server || call.serverName;
          let tool = call.tool || call.name || call.toolName;
          const rawArgs = call.arguments || call.args || call.input || {};
          const args = this.normalizeToolCallArgs(rawArgs);
          let fname = String(call.name || tool || '');
          if ((!server || !tool) && call.name) {
            const parsed = (typeof this.parseMcpPrefixedToolName === 'function') ? this.parseMcpPrefixedToolName(call.name) : null;
            if (parsed) { server = parsed.server; tool = parsed.tool; fname = call.name; }
          }
          if (!server && !tool && !fname) continue;
          const ex = await this.executeToolCallByName(fname || (server && tool ? ('mcp__' + server + '__' + tool) : ''), args, { prompt, server, tool });
          if (ex && ex.badge) execSummary.push(ex.badge);
          if (ex && ex.applied) applied.push(ex.applied);
          if (ex && ex.cmd) cmdResults.push({ cmd: ex.cmd, ...(ex.raw || {}) });
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
