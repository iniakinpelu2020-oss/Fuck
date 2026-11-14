(function () {
  const N8N_CRED_NAME = 'n8n-local-instance';
  const DEFAULT_N8N_WEBHOOK_URL = (typeof window !== 'undefined' && window.APEX_DEFAULT_N8N_WEBHOOK_URL) || 'https://drippydee.app.n8n.cloud/webhook/apex-agent';

  const Integrations = {
    init() {
      document.getElementById('btnVaultSave').addEventListener('click', () => this.saveCredential());
      document.getElementById('btnVaultExport').addEventListener('click', () => this.exportVault());
      document.getElementById('btnVaultImport').addEventListener('click', () => this.importVault());
      this.bindN8nUI();
      this.render();
      this.installWebhookBridge();
      this.loadN8nConfigToUI();
      this.renderN8nStatus({ status: 'idle', httpStatus: null, body: 'No n8n trigger activity yet.' });
    },

    saveCredential() {
      const name = document.getElementById('vaultName').value.trim();
      const type = document.getElementById('vaultType').value.trim() || 'api_key';
      const url = document.getElementById('vaultUrl').value.trim();
      const secret = document.getElementById('vaultSecret').value.trim();
      if (!name || !secret) return Utils.toast('Integration name and secret/config required', 'error');
      const existingIdx = AppState.vault.findIndex(v => v.name.toLowerCase() === name.toLowerCase());
      const item = { id: existingIdx >= 0 ? AppState.vault[existingIdx].id : Utils.uid('cred'), name, type, url, secret, updatedAt: new Date().toISOString() };
      if (existingIdx >= 0) AppState.vault[existingIdx] = item; else AppState.vault.unshift(item);
      AppState.saveVault();
      document.getElementById('vaultName').value = '';
      document.getElementById('vaultType').value = '';
      document.getElementById('vaultUrl').value = '';
      document.getElementById('vaultSecret').value = '';
      this.render();
      if (name.toLowerCase() === N8N_CRED_NAME) this.loadN8nConfigToUI();
      Utils.toast('Credential saved locally', 'success');
    },
    deleteCredential(id) {
      AppState.vault = AppState.vault.filter(v => v.id !== id);
      AppState.saveVault();
      this.render();
      this.loadN8nConfigToUI();
    },
    getByName(name) {
      return AppState.vault.find(v => v.name.toLowerCase() === String(name||'').toLowerCase()) || null;
    },
    exportVault() {
      Utils.download('apex-vault.json', JSON.stringify(AppState.vault, null, 2));
      Utils.toast('Vault exported (contains secrets)', 'success');
    },
    async importVault() {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = '.json,application/json';
      inp.onchange = async () => {
        const file = inp.files[0]; if (!file) return;
        try {
          const txt = await file.text();
          const data = Utils.safeJsonParse(txt, null);
          if (!Array.isArray(data)) throw new Error('Invalid vault format');
          AppState.vault = data;
          AppState.saveVault();
          this.render();
          this.loadN8nConfigToUI();
          Utils.toast('Vault imported', 'success');
        } catch (e) { Utils.toast(`Import failed: ${e.message}`, 'error'); }
      };
      inp.click();
    },
    render() {
      const list = document.getElementById('vaultList');
      if (!list) return;
      list.innerHTML = '';
      if (!AppState.vault.length) {
        list.innerHTML = '<div class="text-gray-500">No credentials stored.</div>';
        return;
      }
      for (const v of AppState.vault) {
        const card = document.createElement('div');
        card.className = 'border border-border rounded p-2';
        card.innerHTML = `
          <div class="flex items-center justify-between gap-2">
            <div>
              <div class="font-medium text-gray-200">${Utils.escapeHtml(v.name)}</div>
              <div class="text-[11px] text-gray-400">${Utils.escapeHtml(v.type || 'api_key')} ${v.url ? '• ' + Utils.escapeHtml(v.url) : ''}</div>
            </div>
            <div class="flex gap-1">
              <button data-act="copy" class="px-2 py-0.5 rounded bg-gray-700 hover:bg-gray-600">Copy</button>
              <button data-act="delete" class="px-2 py-0.5 rounded bg-gray-800 hover:bg-gray-700 text-red-300">Delete</button>
            </div>
          </div>
          <div class="text-[11px] text-gray-500 mt-1">Updated ${Utils.escapeHtml(v.updatedAt || '')}</div>`;
        card.querySelector('[data-act="copy"]').addEventListener('click', async () => {
          try { await navigator.clipboard.writeText(v.secret || ''); Utils.toast('Secret copied', 'success'); }
          catch { Utils.toast('Clipboard unavailable', 'error'); }
        });
        card.querySelector('[data-act="delete"]').addEventListener('click', () => this.deleteCredential(v.id));
        list.appendChild(card);
      }
    },

    // --- n8n local instance integration ---
    bindN8nUI() {
      const on = (id, evt, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(evt, fn); };
      on('btnN8nSaveConfig', 'click', () => this.saveN8nConfigFromUI());
      on('btnN8nHealth', 'click', () => this.checkN8nHealth());
      on('btnN8nTrigger', 'click', () => this.triggerN8nFromUI());
    },

    getN8nCredential() {
      return this.getByName(N8N_CRED_NAME) || AppState.vault.find(v => (v.type || '').toLowerCase() === 'n8n') || null;
    },

    parseN8nSecret(secret) {
      if (!secret) return { token: '', headerName: '' };
      const obj = Utils.safeJsonParse(secret, null);
      if (obj && typeof obj === 'object') {
        return {
          token: obj.token || obj.authToken || obj.value || obj.apiKey || obj.key || '',
          headerName: obj.headerName || obj.authHeader || obj.header || ''
        };
      }
      return { token: String(secret), headerName: '' };
    },

    getN8nConfig() {
      const cred = this.getN8nCredential();
      const parsed = this.parseN8nSecret(cred?.secret);
      const url = (document.getElementById('n8nWebhookUrl')?.value || '').trim() || cred?.url || AppState.settings.webhookUrl || DEFAULT_N8N_WEBHOOK_URL;
      const headerName = (document.getElementById('n8nAuthHeader')?.value || '').trim() || parsed.headerName || '';
      const token = (document.getElementById('n8nAuthToken')?.value || '').trim() || parsed.token || '';
      return { url, headerName, token, credentialName: cred?.name || N8N_CRED_NAME };
    },

    saveN8nConfigFromUI() {
      const url = (document.getElementById('n8nWebhookUrl')?.value || '').trim();
      const headerName = (document.getElementById('n8nAuthHeader')?.value || '').trim();
      const token = (document.getElementById('n8nAuthToken')?.value || '').trim();
      if (!url) return Utils.toast('Enter an n8n webhook URL', 'error');
      const secret = JSON.stringify({ headerName, token, updatedBy: 'apex-ide' });
      const existing = this.getByName(N8N_CRED_NAME);
      const item = { id: existing?.id || Utils.uid('cred'), name: N8N_CRED_NAME, type: 'n8n', url, secret, updatedAt: new Date().toISOString() };
      const idx = AppState.vault.findIndex(v => v.name.toLowerCase() === N8N_CRED_NAME);
      if (idx >= 0) AppState.vault[idx] = item; else AppState.vault.unshift(item);
      AppState.saveVault();
      AppState.settings.webhookUrl = url;
      AppState.saveSettings();
      const sw = document.getElementById('settingWebhookUrl'); if (sw) sw.value = url;
      this.render();
      this.loadN8nConfigToUI();
      Utils.toast('n8n configuration saved to Credential Vault', 'success');
    },

    loadN8nConfigToUI() {
      const cred = this.getN8nCredential();
      const parsed = this.parseN8nSecret(cred?.secret);
      const urlEl = document.getElementById('n8nWebhookUrl');
      const hEl = document.getElementById('n8nAuthHeader');
      const tEl = document.getElementById('n8nAuthToken');
      const fallbackUrl = cred?.url || AppState.settings.webhookUrl || DEFAULT_N8N_WEBHOOK_URL;
      if (urlEl) {
        if (!urlEl.value) urlEl.value = fallbackUrl;
        if (!String(urlEl.value || '').trim()) urlEl.value = DEFAULT_N8N_WEBHOOK_URL;
      }
      if (hEl && !hEl.value) hEl.value = parsed.headerName || '';
      if (tEl && !tEl.value) tEl.value = parsed.token || '';
      // ensure settings reflect pre-configured default for fresh loads
      if (!String(AppState.settings.webhookUrl || '').trim()) {
        AppState.settings.webhookUrl = DEFAULT_N8N_WEBHOOK_URL;
        try { AppState.saveSettings(); } catch {}
      }
    },

    renderN8nStatus(state = {}) {
      const badge = document.getElementById('n8nStatusBadge');
      const http = document.getElementById('n8nHttpStatus');
      const out = document.getElementById('n8nExecutionOutput');
      const status = state.status || 'idle';
      const label = status === 'sending' ? 'Sending…' : status === 'success' ? 'Success' : status === 'error' ? 'Error' : 'Idle';
      if (badge) {
        badge.textContent = label;
        badge.className = 'badge ' + (status === 'success' ? 'badge-success' : status === 'error' ? 'badge-danger' : status === 'sending' ? 'badge-warn' : 'badge-muted');
      }
      if (http) {
        const code = state.httpStatus != null ? String(state.httpStatus) : '—';
        http.textContent = `HTTP ${code}`;
        const ok = typeof state.httpStatus === 'number' && state.httpStatus >= 200 && state.httpStatus < 300;
        http.className = 'badge ' + (state.httpStatus == null ? 'badge-muted' : ok ? 'badge-success' : 'badge-danger');
      }
      if (out) {
        let text = state.body;
        if (typeof text !== 'string') {
          try { text = JSON.stringify(text, null, 2); } catch { text = String(text); }
        }
        out.textContent = text || '(empty response)';
      }
    },

    getN8nBaseUrl(webhookUrl) {
      try {
        const u = new URL(webhookUrl);
        return `${u.protocol}//${u.host}`;
      } catch { return 'http://localhost:5678'; }
    },

    async checkN8nHealth() {
      const cfg = this.getN8nConfig();
      const base = this.getN8nBaseUrl(cfg.url);
      const healthUrl = base.replace(/\/$/, '') + '/healthz';
      this.renderN8nStatus({ status: 'sending', httpStatus: null, body: `Checking health: ${healthUrl}` });
      try {
        const res = await fetch(healthUrl, { method: 'GET' });
        const text = await res.text().catch(() => '');
        let body; try { body = text ? JSON.parse(text) : text; } catch { body = text || '(ok)'; }
        const ok = res.ok;
        this.renderN8nStatus({ status: ok ? 'success' : 'error', httpStatus: res.status, body: { endpoint: healthUrl, status: res.status, data: body } });
        Utils.toast(ok ? `n8n health OK (${res.status})` : `n8n health check failed (${res.status})`, ok ? 'success' : 'error');
        return { ok, status: res.status, body };
      } catch (e) {
        this.renderN8nStatus({ status: 'error', httpStatus: null, body: `Health check failed: ${e.message}\nURL: ${healthUrl}\n\nIf n8n is running locally, ensure CORS allows browser requests or use a proxy.` });
        Utils.toast(`n8n health check failed: ${e.message}`, 'error');
        return { ok: false, error: e.message };
      }
    },

    async triggerN8nFromUI() {
      const raw = (document.getElementById('n8nTestPayload')?.value || '').trim();
      let data;
      if (raw) {
        const parsed = Utils.safeJsonParse(raw, null);
        data = parsed && typeof parsed === 'object' ? parsed : { message: raw };
      } else {
        data = { message: 'Hello from Apex Studio' };
      }
      const bridge = window.ApexWorkflowBridge || window.AetherWorkflowBridge;
      try {
        const result = await bridge.trigger('manual', data, { source: 'vault-ui' });
        Utils.toast(`n8n workflow triggered (${result.httpStatus})`, 'success');
      } catch (e) {
        Utils.toast(`n8n trigger failed: ${e.message}`, 'error');
      }
    },

    installWebhookBridge() {
      const bridge = {
        last: { status: 'idle', httpStatus: null, body: null, url: '' },
        listeners: new Set(),
        getConfig() { return Integrations.getN8nConfig(); },
        saveConfig(cfg = {}) {
          const urlEl = document.getElementById('n8nWebhookUrl');
          const hEl = document.getElementById('n8nAuthHeader');
          const tEl = document.getElementById('n8nAuthToken');
          if (cfg.url != null && urlEl) urlEl.value = cfg.url;
          if (cfg.headerName != null && hEl) hEl.value = cfg.headerName;
          if (cfg.token != null && tEl) tEl.value = cfg.token;
          return Integrations.saveN8nConfigFromUI();
        },
        getWebhookUrl() {
          const cfg = this.getConfig();
          return (cfg && cfg.url) ? String(cfg.url).trim() : '';
        },
        subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
        notify(state) {
          this.last = { ...(this.last || {}), ...state };
          try { Integrations.renderN8nStatus(this.last); } catch {}
          try { AppState.emit('n8n:status', this.last); } catch {}
          for (const fn of this.listeners) { try { fn(this.last); } catch {} }
        },
        buildPayload(event, data = {}) {
          const active = AppState?.getActiveFile?.();
          const payload = {
            message: typeof data.message === 'string' ? data.message : (typeof data.prompt === 'string' ? data.prompt : ''),
            session_id: data.session_id || data.sessionId || `apex_${Date.now().toString(36)}`,
            user_id: data.user_id || data.userId || 'apex-user',
            event: event || 'manual',
            timestamp: new Date().toISOString(),
            source: data.source || 'apex-ide',
            workspace: AppState?.workspaceName || null,
            activeFile: AppState?.activeFilePath || null,
          };
          if (data && typeof data === 'object') {
            for (const [k, v] of Object.entries(data)) {
              if (!(k in payload)) payload[k] = v;
            }
            if (data.message && !payload.message) payload.message = data.message;
          }
          if (active && data.includeActiveFile !== false && !payload.activeFileContent) {
            payload.activeFileContent = String(active.content || '').slice(0, 12000);
          }
          return payload;
        },
        async trigger(event = 'manual', data = {}, options = {}) {
          const cfg = this.getConfig();
          const url = (options.url || cfg.url || DEFAULT_N8N_WEBHOOK_URL || '').trim();
          if (!url) {
            const err = new Error('No n8n webhook URL configured. Save an n8n config in the Vault/Integrations tab.');
            this.notify({ status: 'error', httpStatus: null, url: '', body: err.message, event, at: new Date().toISOString() });
            throw err;
          }
          const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
          const headerName = (options.authHeaderName != null ? options.authHeaderName : cfg.headerName || '').trim();
          const token = (options.authToken != null ? options.authToken : cfg.token || '').trim();
          if (headerName && token) headers[headerName] = token;
          else if (token && !headers.Authorization && /^bearer\s|^basic\s/i.test(token)) headers.Authorization = token;

          const payload = options.payload !== undefined ? options.payload : this.buildPayload(event, data);
          // Enforce requested n8n payload contract for the webhook POST body
          const reqObj = (payload && typeof payload === 'object' && !Array.isArray(payload)) ? { ...payload } : { payload };
          if (reqObj.event == null || reqObj.event === '') reqObj.event = event || 'manual';
          if (!Object.prototype.hasOwnProperty.call(reqObj, 'payload')) reqObj.payload = (data && typeof data === 'object') ? data : (data ?? null);
          if (!reqObj.source) reqObj.source = 'apex-ide';
          if (!reqObj.timestamp) reqObj.timestamp = new Date().toISOString();
          const reqBody = typeof options.payload === 'string' ? options.payload : JSON.stringify(reqObj);

          // 10s timeout so webhook triggers (incl. trigger_n8n_webhook tool) never hang
          const timeoutMs = Number(options.timeoutMs || 10000);
          const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
          let timedOut = false;
          const timer = controller ? setTimeout(() => { timedOut = true; try { controller.abort(); } catch {} }, timeoutMs) : null;
          const fetchOptions = { method: options.method || 'POST', headers, body: reqBody };
          if (controller) fetchOptions.signal = controller.signal;
          if (options.signal && controller) {
            // if caller provided a signal, abort our controller when it aborts
            try { options.signal.addEventListener('abort', () => { try { controller.abort(); } catch {} }, { once: true }); } catch {}
          } else if (options.signal && !controller) {
            fetchOptions.signal = options.signal;
          }

          this.notify({ status: 'sending', httpStatus: null, url, event: reqObj.event, request: { method: fetchOptions.method, headers: { ...headers, ...(headers[headerName] ? { [headerName]: '[redacted]' } : {}), ...(headers.Authorization ? { Authorization: '[redacted]' } : {}) }, payload: reqObj }, body: `Sending ${fetchOptions.method} ${url} ...`, at: new Date().toISOString() });

          try {
            const res = await fetch(url, fetchOptions);
            const text = await res.text().catch(() => '');
            let body;
            try { body = text ? JSON.parse(text) : (text || null); } catch { body = text; }
            const result = {
              ok: res.ok,
              status: 'completed',
              httpStatus: res.status,
              url,
              event: reqObj.event,
              body,
              raw: text,
              request: reqObj,
              at: new Date().toISOString()
            };
            this.notify({ status: res.ok ? 'success' : 'error', ...result });
            if (!res.ok) throw new Error(`n8n webhook responded with HTTP ${res.status}`);
            return result;
          } catch (e) {
            let errMsg = e && e.message ? e.message : String(e);
            if ((e && e.name === 'AbortError') || timedOut) {
              errMsg = `n8n webhook timed out after ${timeoutMs}ms`;
            }
            const errState = { status: 'error', httpStatus: e && e.httpStatus ? e.httpStatus : null, url, event: reqObj.event, body: `Trigger failed: ${errMsg}`, error: errMsg, at: new Date().toISOString(), timedOut: !!timedOut };
            this.notify(errState);
            const outErr = new Error(errMsg);
            outErr.httpStatus = errState.httpStatus;
            outErr.timedOut = !!timedOut;
            throw outErr;
          } finally {
            if (timer) clearTimeout(timer);
          }
        },
        async checkHealth() { return Integrations.checkN8nHealth(); }
      };
      window.ApexWorkflowBridge = bridge;
      window.ApexAutomationBridge = bridge;
      // compatibility aliases
      window.AetherWorkflowBridge = bridge;
      window.AetherAutomationBridge = bridge;
    }
  };

  window.Integrations = Integrations;
})();
