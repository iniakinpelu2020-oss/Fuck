(function () {
  const TerminalPanel = {
    term: null,
    fit: null,
    socket: null,
    connected: false,
    remoteUrl: '',
    _execSeq: 0,
    _pendingExec: new Map(),
    _reconnectTimer: null,
    _reconnectDelay: 1000,
    _manualDisconnect: false,
    _maxReconnectDelay: 15000,

    init() {
      const container = document.getElementById('xtermContainer');
      if (window.Terminal && container) {
        this.term = new window.Terminal({
          convertEol: true,
          cursorBlink: true,
          fontSize: 13,
          theme: { background: '#05070b', foreground: '#e5e7eb', cursor: '#3b82f6', selectionBackground: 'rgba(59,130,246,0.35)' }
        });
        if (window.FitAddon && window.FitAddon.FitAddon) {
          this.fit = new window.FitAddon.FitAddon();
          this.term.loadAddon(this.fit);
        }
        this.term.open(container);
        this.fit && this.fit.fit();
        this.term.writeln('\x1b[38;2;59;130;246mApex Runner\x1b[0m — browser sandbox ready.');
        this.term.writeln('File commands and JS run locally. Configure a remote WebSocket bridge in Settings for a live shell.');
        this.term.onData(data => this.sendInteractive(data));
        window.addEventListener('resize', () => this.fit && this.fit.fit());
      } else if (container) {
        container.innerHTML = '<div class="p-2 text-xs text-red-300">xterm.js failed to load.</div>';
      }

      const btnConn = document.getElementById('btnTerminalConnect');
      const btnClear = document.getElementById('btnTerminalClear');
      if (btnConn) btnConn.addEventListener('click', () => this.connect());
      if (btnClear) btnClear.addEventListener('click', () => this.term && this.term.clear());
      const wsInput = document.getElementById('terminalWsUrl');
      const saved = (window.AppState && AppState.settings && AppState.settings.terminalWs) ? String(AppState.settings.terminalWs).trim() : '';
      if (wsInput && saved) wsInput.value = saved;

      // Default to browser sandbox until/unless remote connects
      this.setStatus('browser');

      // Auto-connect/apply runner config on page load if a remote URL is already saved
      if (saved) {
        if (this.isHttpRunnerUrl(saved)) this.applyRunnerConfig(saved, { silent: true, auto: true });
        else this.connect(saved, { silent: true, auto: true });
      }
    },

    setStatus(s) {
      this.connected = s === 'connected';
      const el = document.getElementById('terminalStatus');
      if (!el) return;
      let label = 'Browser Sandbox';
      let cls = 'badge text-cyan-300 ';
      if (s === 'connected') {
        label = 'Remote Shell Connected';
        cls = 'badge badge-success text-green-400 ';
      } else if (s === 'connecting') {
        label = 'Connecting Remote...';
        cls = 'badge badge-warn text-yellow-400 ';
      } else {
        label = 'Browser Sandbox';
        cls = 'badge badge-success text-cyan-300 ';
      }
      el.textContent = label;
      el.className = cls;
      el.title = s === 'connected' ? 'Connected to remote WebSocket shell bridge' : (s === 'connecting' ? 'Connecting to remote shell bridge' : 'In-browser execution engine active');
    },

    isHttpRunnerUrl(url) {
      return /^https?:\/\//i.test(String(url || '').trim());
    },

    isWsRunnerUrl(url) {
      return /^wss?:\/\//i.test(String(url || '').trim());
    },

    getConfiguredUrl() {
      const el = document.getElementById('terminalWsUrl');
      const v = (el && el.value ? String(el.value).trim() : '') || (window.AppState && AppState.settings && AppState.settings.terminalWs) || this.remoteUrl || '';
      return String(v || '').trim();
    },

    getHttpRunnerUrl() {
      const url = this.getConfiguredUrl();
      return this.isHttpRunnerUrl(url) ? url : '';
    },

    persistUrl(url) {
      const v = String(url || '').trim();
      if (window.AppState && AppState.settings) {
        AppState.settings.terminalWs = v;
        if (AppState.saveSettings) AppState.saveSettings();
      }
      const el = document.getElementById('terminalWsUrl');
      if (el) el.value = v;
      this.remoteUrl = v;
    },

    clearReconnect() {
      if (this._reconnectTimer) {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
      }
    },

    scheduleReconnect() {
      if (this._manualDisconnect) return;
      const url = this.getConfiguredUrl();
      if (!url) return;
      this.clearReconnect();
      const delay = this._reconnectDelay;
      this._reconnectTimer = setTimeout(() => {
        this._reconnectTimer = null;
        if (this._manualDisconnect) return;
        if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) return;
        this.connect(url, { silent: true, auto: true });
      }, delay);
      this._reconnectDelay = Math.min(this._maxReconnectDelay, Math.max(1000, Math.floor(delay * 1.7)));
    },

    applyRunnerConfig(url, opts = {}) {
      const configured = String(url != null ? url : this.getConfiguredUrl() || '').trim();
      this.persistUrl(configured);
      if (!configured) {
        this.disconnect(true);
        this.setStatus('browser');
        if (!opts.silent && window.Utils) Utils.toast('No Remote Runner URL set; using Browser Sandbox', 'info');
        return { mode: 'browser', url: '' };
      }
      if (this.isHttpRunnerUrl(configured)) {
        // HTTP(S) runner: commands are executed via POST per-command; no WebSocket session
        this.disconnect(true);
        this.remoteUrl = configured;
        const el = document.getElementById('terminalStatus');
        if (el) {
          el.textContent = 'Remote Runner (HTTP)';
          el.className = 'badge badge-success text-green-400 ';
          el.title = `Remote HTTP runner configured: ${configured}`;
        }
        this.connected = false;
        this.write(`\x1b[32mRemote Runner configured (HTTP): ${configured}\x1b[0m`);
        if (!opts.silent && window.Utils) Utils.toast('Remote HTTP Runner configured', 'success');
        return { mode: 'http', url: configured };
      }
      // WebSocket runner URL
      return this.connect(configured, opts);
    },

    connect(url, opts = {}) {
      const wsUrl = String(url || this.getConfiguredUrl() || '').trim();
      if (!wsUrl) {
        if (!opts.silent && window.Utils) Utils.toast('No remote terminal URL configured; using Browser Sandbox', 'info');
        this.setStatus('browser');
        return;
      }
      this.persistUrl(wsUrl);
      this._manualDisconnect = false;
      this.clearReconnect();

      // Close existing socket without triggering manual-disconnect semantics
      if (this.socket) {
        try { this.socket.onclose = null; this.socket.onerror = null; this.socket.onmessage = null; this.socket.close(); } catch {}
        this.socket = null;
      }

      try {
        this.setStatus('connecting');
        const socket = new WebSocket(wsUrl);
        this.socket = socket;

        socket.onopen = () => {
          if (this.socket !== socket) return;
          this.connected = true;
          this._reconnectDelay = 1000;
          this.setStatus('connected');
          this.write(`\x1b[32mRemote Shell Connected: ${wsUrl}\x1b[0m`);
          if (!opts.silent && window.Utils) Utils.toast('Remote Shell Connected', 'success');
        };

        socket.onmessage = (ev) => {
          if (this.socket !== socket) return;
          this.handleSocketMessage(ev.data);
        };

        socket.onerror = () => {
          if (this.socket !== socket) return;
          this.write('\x1b[31mRemote terminal bridge error\x1b[0m');
        };

        socket.onclose = () => {
          if (this.socket !== socket) return;
          const wasManual = this._manualDisconnect;
          this.socket = null;
          this.connected = false;
          this.failAllPending('Remote shell disconnected');
          this.setStatus('browser');
          this.write(wasManual
            ? '\x1b[33mRemote shell disconnected — Browser Sandbox active\x1b[0m'
            : '\x1b[33mRemote shell disconnected — Browser Sandbox active (reconnecting...)\x1b[0m');
          if (!wasManual) this.scheduleReconnect();
        };
      } catch (e) {
        this.socket = null;
        this.connected = false;
        this.setStatus('browser');
        if (!opts.silent && window.Utils) Utils.toast(`Remote terminal connect failed: ${e.message}`, 'error');
        this.scheduleReconnect();
      }
    },

    disconnect(manual = true) {
      this._manualDisconnect = !!manual;
      this.clearReconnect();
      if (this.socket) {
        try { this.socket.close(); } catch {}
        this.socket = null;
      }
      this.connected = false;
      this.failAllPending('Remote shell disconnected');
      this.setStatus('browser');
    },

    failAllPending(reason) {
      for (const [id, p] of this._pendingExec.entries()) {
        try { clearTimeout(p.timer); } catch {}
        this._pendingExec.delete(id);
        try { p.resolve({ ok: false, stdout: p.stdout || '', stderr: (p.stderr ? p.stderr + '\n' : '') + String(reason || 'Remote shell disconnected'), output: ((p.stdout||'') + (p.stderr?'\n'+p.stderr:'')).trim(), code: 1, mode: 'remote' }); } catch {}
      }
    },

    handleSocketMessage(raw) {
      let msg = raw;
      let parsed = null;
      if (typeof raw === 'string') {
        try { parsed = JSON.parse(raw); msg = parsed; } catch { parsed = null; msg = raw; }
      } else if (raw && typeof raw === 'object') {
        parsed = raw;
      }

      // Extract display/output text for xterm mirroring
      let display = '';
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.output === 'string') display += parsed.output;
        if (typeof parsed.stdout === 'string') display += (display && !display.endsWith('\n') ? '\n' : '') + parsed.stdout;
        if (typeof parsed.stderr === 'string') display += (display ? '\n' : '') + parsed.stderr;
        if (!display && typeof parsed.data === 'string') display = parsed.data;
        if (!display && parsed.type === 'exit') display = `\r\n[process exited ${parsed.code ?? ''}]\r\n`;
        if (!display && parsed.type === 'error' && parsed.message) display = String(parsed.message);
      } else {
        display = typeof raw === 'string' ? raw : String(raw ?? '');
      }

      if (display) this.writeRaw(display);

      if (!parsed || typeof parsed !== 'object') {
        // Raw string output: append to most recent pending exec if any
        const pending = this._lastPending();
        if (pending) {
          pending.stdout = (pending.stdout || '') + String(raw || '');
          pending.output = (pending.output || '') + String(raw || '');
        }
        return;
      }

      const id = parsed.id != null ? String(parsed.id) : null;
      const type = parsed.type ? String(parsed.type).toLowerCase() : '';
      const pending = id ? this._pendingExec.get(id) : (type ? this._lastPending() : null);

      if (pending) {
        if (typeof parsed.stdout === 'string') { pending.stdout = (pending.stdout || '') + parsed.stdout; }
        if (typeof parsed.stderr === 'string') { pending.stderr = (pending.stderr || '') + parsed.stderr; }
        if (typeof parsed.output === 'string') { pending.output = (pending.output || '') + parsed.output; }
        if (typeof parsed.data === 'string' && !parsed.stdout && !parsed.stderr && !parsed.output) { pending.stdout = (pending.stdout || '') + parsed.data; }
        if (parsed.code !== undefined) pending.code = parsed.code;
        if (parsed.exitCode !== undefined) pending.code = parsed.exitCode;
        if (parsed.status !== undefined && pending.code == null) pending.code = parsed.status;

        const isFinal = type === 'result' || type === 'exit' || type === 'done' || type === 'complete' || type === 'exec_result' || parsed.done === true || Object.prototype.hasOwnProperty.call(parsed, 'code') || Object.prototype.hasOwnProperty.call(parsed, 'exitCode');
        if (isFinal) {
          this.resolvePending(pending.id || id);
        }
        return;
      }

      // No pending correlation: still handled by xterm mirror above
    },

    _lastPending() {
      let last = null;
      for (const p of this._pendingExec.values()) last = p;
      return last;
    },

    resolvePending(id) {
      const key = id != null ? String(id) : null;
      if (!key || !this._pendingExec.has(key)) return;
      const p = this._pendingExec.get(key);
      this._pendingExec.delete(key);
      try { clearTimeout(p.timer); } catch {}
      const stdout = String(p.stdout || '');
      const stderr = String(p.stderr || '');
      const out = String(p.output || (stdout + (stderr ? '\n' + stderr : '')) || '');
      const code = (p.code == null ? 0 : Number(p.code));
      const ok = !Number.isNaN(code) ? code === 0 : true;
      try { p.resolve({ ok, stdout, stderr, output: out, code, mode: 'remote' }); } catch {}
    },

    // Interactive/raw terminal input (keystrokes) to remote bridge
    sendInteractive(data) {
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        try { this.socket.send(JSON.stringify({ type: 'input', data })); }
        catch { try { this.socket.send(data); } catch {} }
      }
      // browser mode: ignore interactive keystrokes (commands run via executeCommand)
    },

    // Back-compat
    send(data) { this.sendInteractive(data); },

    write(text) {
      if (!this.term) return;
      const s = String(text == null ? '' : text);
      if (!s) return;
      const normalized = s.replace(/\r?\n/g, '\r\n');
      this.term.write(normalized.endsWith('\r\n') ? normalized : normalized + '\r\n');
    },

    writeRaw(text) {
      if (!this.term) return;
      const s = String(text == null ? '' : text);
      if (!s) return;
      // Preserve carriage returns; normalize bare \n for xterm
      const normalized = s.replace(/\r?\n/g, (m) => m === '\r\n' ? '\r\n' : '\r\n');
      // avoid double-normalizing existing \r\n sequences badly
      this.term.write(String(text).replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'));
    },

    show(show = true) {
      const pane = document.getElementById('terminalPane');
      if (!pane) return;
      pane.classList.toggle('hidden', !show);
      if (show) setTimeout(() => this.fit && this.fit.fit(), 50);
    },

    toggle() {
      const pane = document.getElementById('terminalPane');
      this.show(pane ? pane.classList.contains('hidden') : true);
    },

    ensureShown() { this.show(true); },

    // --- In-browser execution engine (fallback) ---
    normalizePath(p) {
      if (!p) return '';
      let s = String(p).trim();
      if (s === '.' || s === './') return '';
      s = s.replace(/^\.?\//, '').replace(/\\/g, '/').replace(/\/+$/g, '');
      const parts = [];
      for (const part of s.split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') parts.pop(); else parts.push(part);
      }
      return parts.join('/');
    },

    resolvePath(arg, cwd) {
      if (!arg) return cwd || '';
      const a = String(arg).trim();
      if (a.startsWith('/')) return this.normalizePath(a.slice(1));
      return this.normalizePath((cwd ? cwd + '/' : '') + a);
    },

    listDir(dirPath) {
      const dir = this.normalizePath(dirPath);
      const entries = new Map();
      for (const d of (AppState.dirs || [])) {
        const p = this.normalizePath(d);
        if (!p) continue;
        const parent = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
        if (parent === dir) entries.set(p.split('/').pop() + '/', { name: p.split('/').pop() + '/', type: 'dir' });
      }
      for (const f of (AppState.files || new Map()).values()) {
        const p = this.normalizePath(f.path);
        const parent = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
        if (parent === dir) entries.set(p.split('/').pop(), { name: p.split('/').pop(), type: 'file' });
      }
      return Array.from(entries.values()).sort((a,b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    },

    parseSimpleCommand(cmd) {
      const tokens = [];
      const re = /"([^"]*)"|'([^']*)'|([^\s]+)/g;
      let m;
      while ((m = re.exec(cmd)) !== null) tokens.push(m[1] ?? m[2] ?? m[3]);
      return tokens;
    },

    async execInBrowser(command) {
      const raw = String(command || '').replace(/\r\n?/g, '\n').trim();
      if (!raw) return { ok: true, stdout: '', stderr: '', output: '', mode: 'browser' };
      const parts = raw.split(/\s*(?:&&|;)\s*/).filter(Boolean);
      let stdout = '', stderr = '', allOk = true, cwd = '';
      for (const part of parts) {
        const res = await this.execSingleBrowser(part, cwd);
        cwd = res.cwd || cwd;
        if (res.stdout) stdout += (stdout && !stdout.endsWith('\n') ? '\n' : '') + res.stdout;
        if (res.stderr) stderr += (stderr && !stderr.endsWith('\n') ? '\n' : '') + res.stderr;
        if (!res.ok) { allOk = false; break; }
      }
      return { ok: allOk, stdout, stderr, output: stdout + (stderr ? (stdout ? '\n' : '') + stderr : ''), mode: 'browser', cwd };
    },

    async execSingleBrowser(cmd, cwd = '') {
      const t = this.parseSimpleCommand(cmd);
      if (!t.length) return { ok: true, stdout: '', stderr: '', cwd };
      const c = t[0];

      if (c === 'node' || c === 'nodejs') {
        let code = '';
        if (t[1] === '-e' || t[1] === '--eval') code = t.slice(2).join(' ');
        else if (t[1]) {
          const p = this.resolvePath(t[1], cwd);
          const f = AppState.files.get(p);
          if (!f) return { ok: false, stdout: '', stderr: `node: cannot open '${t[1]}' (No such file in workspace)`, cwd };
          code = String(f.content || '');
        } else {
          code = '';
        }
        return await this.runJsSandbox(code, `node ${t.slice(1).join(' ')}`.trim() || 'node', cwd);
      }

      if (c === 'pwd') return { ok: true, stdout: '/' + (cwd || ''), stderr: '', cwd };
      if (c === 'ls') {
        const target = this.resolvePath(t[1] && !t[1].startsWith('-') ? t[1] : (t[2] || ''), cwd);
        const entries = this.listDir(target);
        const out = entries.map(e => e.name).join('\n');
        return { ok: true, stdout: out || '(empty)', stderr: '', cwd };
      }
      if (c === 'cat') {
        const target = this.resolvePath(t[1] || '', cwd);
        if (!target) return { ok: false, stdout: '', stderr: 'cat: missing file operand', cwd };
        const f = AppState.files.get(target);
        if (!f) return { ok: false, stdout: '', stderr: `cat: ${t[1]}: No such file in workspace`, cwd };
        return { ok: true, stdout: String(f.content || ''), stderr: '', cwd };
      }
      if (c === 'mkdir') {
        const target = this.resolvePath(t.filter(x => x !== '-p' && x !== 'mkdir')[0] || t[1] || '', cwd);
        if (!target) return { ok: false, stdout: '', stderr: 'mkdir: missing operand', cwd };
        AppState.ensureDir(target);
        AppState.emit('workspace:changed');
        return { ok: true, stdout: '', stderr: '', cwd };
      }
      if (c === 'touch') {
        const target = this.resolvePath(t[1] || '', cwd);
        if (!target) return { ok: false, stdout: '', stderr: 'touch: missing file operand', cwd };
        if (!AppState.files.has(target)) AppState.upsertFile(target, '', { dirty: true });
        return { ok: true, stdout: '', stderr: '', cwd };
      }
      if (c === 'rm') {
        const target = this.resolvePath(t.filter(x => !x.startsWith('-') && x !== 'rm')[0] || t[1] || '', cwd);
        if (!target) return { ok: false, stdout: '', stderr: 'rm: missing operand', cwd };
        AppState.deletePath(target);
        return { ok: true, stdout: '', stderr: '', cwd };
      }
      if (c === 'echo') {
        return { ok: true, stdout: t.slice(1).join(' '), stderr: '', cwd };
      }
      if (c === 'find') {
        const base = this.resolvePath(t[1] && !t[1].startsWith('-') ? t[1] : '', cwd);
        const nameIdx = t.indexOf('-name');
        const pat = nameIdx >= 0 ? (t[nameIdx + 1] || '*').replace(/[*]/g, '.*').replace(/[?]/g, '.') : '.*';
        const re = new RegExp('^' + pat + '$', 'i');
        const results = [];
        for (const p of AppState.files.keys()) {
          const np = this.normalizePath(p);
          if (base && np !== base && !np.startsWith(base + '/')) continue;
          const bn = np.split('/').pop();
          if (re.test(bn) || re.test(np)) results.push(np);
        }
        return { ok: true, stdout: results.join('\n') || '(no matches)', stderr: '', cwd };
      }
      if (c === 'grep') {
        let pattern = '', fileArg = '', flags = '';
        for (let i = 1; i < t.length; i++) {
          if (t[i].startsWith('-')) { flags += t[i]; continue; }
          if (!pattern) pattern = t[i]; else if (!fileArg) fileArg = t[i];
        }
        if (!pattern || !fileArg) return { ok: false, stdout: '', stderr: 'grep: usage: grep [pattern] [file]', cwd };
        const target = this.resolvePath(fileArg, cwd);
        const f = AppState.files.get(target);
        if (!f) return { ok: false, stdout: '', stderr: `grep: ${fileArg}: No such file in workspace`, cwd };
        let re;
        try { re = new RegExp(pattern, flags.includes('i') ? 'i' : ''); } catch (e) { return { ok: false, stdout: '', stderr: `grep: invalid pattern: ${e.message}`, cwd }; }
        const matches = String(f.content || '').split('\n').filter(line => re.test(line));
        return { ok: true, stdout: matches.join('\n') || '(no matches)', stderr: '', cwd };
      }

      if (['npm', 'npx', 'yarn', 'pnpm', 'pip', 'pip3', 'python', 'python3', 'bash', 'sh', 'curl', 'wget', 'git', 'make', 'cargo', 'go'].includes(c)) {
        const msg = [
          `[browser-runner] "${cmd}" cannot run because this is a browser-native workspace without a Linux shell or system package manager.`,
          'Guidance for agent: write and run the code directly in the virtual workspace instead of shell installs.',
          '- For JavaScript: create/update .js/.html files in the workspace and run JS with `node -e "..."` or `node path/to/file.js` (executed in a sandboxed in-browser runtime).',
          '- For web apps: create index.html (+ CSS/JS) and use the Live Preview.',
          '- For non-JS tooling, implement the logic in workspace files or connect a remote Runner URL in Settings.'
        ].join('\n');
        return { ok: true, stdout: msg, stderr: '', cwd, advisory: true };
      }

      return { ok: false, stdout: '', stderr: `[browser-runner] Command not available in browser sandbox: "${cmd}". Supported directly: ls, cat, pwd, mkdir, touch, rm, find, grep, echo, node. Connect a remote Terminal/Runner in Settings for full shell access.`, cwd };
    },

    async runJsSandbox(code, label = 'js', cwd = '') {
      const src = String(code || '');
      return await new Promise((resolve) => {
        const workerCode = `
          const logs = [], errs = [];
          const fmt = (a) => { try { return typeof a === 'string' ? a : JSON.stringify(a); } catch { try { return String(a); } catch { return '[unprintable]'; } } };
          console.log = (...a) => logs.push(a.map(fmt).join(' '));
          console.info = (...a) => logs.push(a.map(fmt).join(' '));
          console.warn = (...a) => logs.push('[warn] ' + a.map(fmt).join(' '));
          console.error = (...a) => errs.push(a.map(fmt).join(' '));
          try {
            const result = (function(){ ${src}\n })();
            if (result !== undefined) logs.push('=> ' + fmt(result));
            postMessage({ ok: true, logs, errs });
          } catch (e) {
            errs.push((e && e.stack) ? String(e.stack) : String(e));
            postMessage({ ok: false, logs, errs });
          }
        `;
        let blobUrl;
        let timer;
        try {
          const blob = new Blob([workerCode], { type: 'application/javascript' });
          blobUrl = URL.createObjectURL(blob);
          const worker = new Worker(blobUrl);
          timer = setTimeout(() => {
            try { worker.terminate(); } catch {}
            resolve({ ok: false, stdout: '', stderr: '[js-sandbox] Execution timed out (5s).', output: '[js-sandbox] Execution timed out (5s).', cwd, mode: 'browser' });
          }, 5000);
          worker.onmessage = (e) => {
            clearTimeout(timer);
            try { worker.terminate(); } catch {}
            const d = e.data || {};
            const stdout = (d.logs || []).join('\n');
            const stderr = (d.errs || []).join('\n');
            resolve({ ok: !!d.ok, stdout, stderr, output: stdout + (stderr ? (stdout ? '\n' : '') + stderr : ''), cwd, mode: 'browser' });
          };
          worker.onerror = (e) => {
            clearTimeout(timer);
            try { worker.terminate(); } catch {}
            const stderr = String(e.message || e);
            resolve({ ok: false, stdout: '', stderr, output: stderr, cwd, mode: 'browser' });
          };
        } catch (e) {
          clearTimeout(timer);
          const stderr = `[js-sandbox] Failed to start: ${e.message}`;
          resolve({ ok: false, stdout: '', stderr, output: stderr, cwd, mode: 'browser' });
        } finally {
          setTimeout(() => { if (blobUrl) try { URL.revokeObjectURL(blobUrl); } catch {} }, 6000);
        }
      });
    },

    // --- Remote WebSocket exec bridge ---
    async execRemote(command, opts = {}) {
      if (!(this.socket && this.socket.readyState === WebSocket.OPEN)) {
        return { ok: false, stdout: '', stderr: 'Remote shell not connected', output: 'Remote shell not connected', mode: 'remote', code: 1 };
      }
      const id = `exec_${Date.now().toString(36)}_${(++this._execSeq).toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const timeoutMs = Number(opts.timeoutMs || 120000);

      return await new Promise((resolve) => {
        const entry = { id, resolve, stdout: '', stderr: '', output: '', code: null, timer: null };
        entry.timer = setTimeout(() => {
          if (!this._pendingExec.has(id)) return;
          this._pendingExec.delete(id);
          const stdout = entry.stdout || '';
          const stderr = (entry.stderr ? entry.stderr + '\n' : '') + `[remote] Command timed out after ${Math.round(timeoutMs/1000)}s`;
          resolve({ ok: false, stdout, stderr, output: stdout + (stderr ? '\n' + stderr : ''), code: 124, mode: 'remote', timedOut: true });
        }, timeoutMs);
        this._pendingExec.set(id, entry);

        try {
          // Standard bridge handshake: { type: 'exec', id, command }
          this.socket.send(JSON.stringify({ type: 'exec', id, command }));
        } catch (e) {
          clearTimeout(entry.timer);
          this._pendingExec.delete(id);
          resolve({ ok: false, stdout: '', stderr: `Remote send failed: ${e.message}`, output: `Remote send failed: ${e.message}`, code: 1, mode: 'remote' });
        }
      });
    },

    async execRemoteHttp(command, opts = {}) {
      const url = this.getHttpRunnerUrl();
      if (!url) {
        return { ok: false, stdout: '', stderr: 'Remote runner URL not configured', output: 'Remote runner URL not configured', mode: 'remote-http', code: 1 };
      }
      const timeoutMs = Number(opts.timeoutMs || 120000);
      const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      const timer = controller ? setTimeout(() => { try { controller.abort(); } catch {} }, timeoutMs) : null;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: String(command || '') }),
          signal: controller ? controller.signal : undefined
        });
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        let data = null;
        let text = '';
        if (ct.includes('application/json')) {
          data = await res.json().catch(() => null);
        } else {
          text = await res.text().catch(() => '');
          try { data = JSON.parse(text); } catch { data = null; }
        }
        let output = '';
        if (data && typeof data === 'object') {
          if (typeof data.output === 'string') output = data.output;
          else if (typeof data.stdout === 'string' || typeof data.stderr === 'string') {
            const so = String(data.stdout || '');
            const se = String(data.stderr || '');
            output = so + (se ? (so ? '\n' : '') + se : '');
          } else if (typeof data.result === 'string') output = data.result;
          else output = JSON.stringify(data, null, 2);
        } else if (text) {
          output = text;
        }
        if (output == null) output = '';
        if (!res.ok) {
          const errMsg = (data && (data.error || data.message)) ? String(data.error || data.message) : `HTTP ${res.status}`;
          const combined = String(output || errMsg);
          return { ok: false, stdout: output, stderr: errMsg, output: combined, mode: 'remote-http', code: res.status, status: res.status, data };
        }
        return { ok: true, stdout: output, stderr: '', output: String(output), mode: 'remote-http', code: 0, status: res.status, data };
      } catch (e) {
        const msg = (e && e.name === 'AbortError') ? `Remote runner request timed out after ${Math.round(timeoutMs/1000)}s` : (e && e.message ? e.message : String(e));
        return { ok: false, stdout: '', stderr: msg, output: msg, mode: 'remote-http', code: 1, error: msg };
      } finally {
        if (timer) clearTimeout(timer);
      }
    },

    parseMcpTerminalCommand(command) {
      // Intercept "<serverName>:<toolName> {jsonArgs}" or "<serverName>:<toolName> key=value ..." and route via MCP.callTool
      const s = String(command || '').trim();
      if (!s) return null;
      const m = s.match(/^([A-Za-z0-9_.-]+):([A-Za-z0-9_.-]+)(?:\s+([\s\S]*))?$/);
      if (!m) return null;
      const server = m[1];
      const tool = m[2];
      if (server === 'http' || server === 'https' || server === 'ws' || server === 'wss') return null; // avoid URL-like false positives
      const rest = (m[3] || '').trim();
      let args = {};
      if (rest) {
        const parsed = (window.Utils && Utils.safeJsonParse) ? Utils.safeJsonParse(rest, null) : null;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed;
        else if (parsed != null) args = { value: parsed };
        else args = { input: rest };
      }
      return { server, tool, args };
    },

    async executeMcpCommand(server, tool, args) {
      if (!(window.MCP && typeof MCP.callTool === 'function')) {
        const msg = 'MCP client not available';
        return { ok: false, stdout: '', stderr: msg, output: msg, mode: 'mcp', code: 1 };
      }
      try {
        const res = await MCP.callTool(server, tool, args || {});
        const out = typeof res === 'string' ? res : JSON.stringify(res, null, 2);
        return { ok: true, stdout: out, stderr: '', output: out, mode: 'mcp', code: 0, data: res, server, tool };
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        return { ok: false, stdout: '', stderr: msg, output: msg, mode: 'mcp', code: 1, error: msg, server, tool };
      }
    },

    async executeCommand(command) {
      const cmd = String(command || '').trim();
      if (!cmd) return { ok: true, stdout: '', stderr: '', output: '', mode: 'noop' };
      this.ensureShown();
      this.write(`$ ${cmd}`);

      // Route "<serverName>:<toolName> ..." to MCP.callTool (do not use browser/remote shell runner)
      const mcpCall = (typeof this.parseMcpTerminalCommand === 'function') ? this.parseMcpTerminalCommand(cmd) : null;
      if (mcpCall && window.MCP && typeof MCP.callTool === 'function') {
        const result = await this.executeMcpCommand(mcpCall.server, mcpCall.tool, mcpCall.args);
        // Mirror captured output to xterm for MCP calls
        if (result && result.stdout) this.writeRaw(result.stdout.endsWith('\n') ? result.stdout : result.stdout + '\n');
        if (result && result.stderr) this.writeRaw('\x1b[31m' + result.stderr + (result.stderr.endsWith('\n') ? '' : '\n') + '\x1b[0m');
        if (result && result.ok && !result.stdout && !result.stderr) this.write('(no output)\n');
        this._last = result;
        return result;
      }

      let result;
      const httpRunner = this.getHttpRunnerUrl();
      if (httpRunner) {
        result = await this.execRemoteHttp(cmd);
      } else if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        result = await this.execRemote(cmd);
      } else {
        // Only use browser runner when no Remote Runner URL is set
        if (this.getConfiguredUrl()) {
          const msg = 'Remote runner configured but not connected/available';
          result = { ok: false, stdout: '', stderr: msg, output: msg, mode: 'remote', code: 1 };
        } else {
          result = await this.execInBrowser(cmd);
        }
      }
      // Mirror captured output to xterm for browser runs and HTTP remote runs
      const mirrorMode = result && (result.mode === 'browser' || result.mode === 'remote-http');
      if (mirrorMode) {
        if (result.stdout) this.writeRaw(result.stdout.endsWith('\n') ? result.stdout : result.stdout + '\n');
        if (result.stderr) this.writeRaw('\x1b[31m' + result.stderr + (result.stderr.endsWith('\n') ? '' : '\n') + '\x1b[0m');
      }
      return result;
    },

    runCommand(command) {
      // Back-compat sync API: schedule execution, never show "Terminal not connected" error.
      this.executeCommand(command).catch(() => {});
      return true;
    }
  };

  window.TerminalPanel = TerminalPanel;
})();
