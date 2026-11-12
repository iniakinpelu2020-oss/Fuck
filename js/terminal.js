(function () {
  const TerminalPanel = {
    term: null,
    fit: null,
    socket: null,
    connected: false,
    init() {
      const container = document.getElementById('xtermContainer');
      if (window.Terminal) {
        this.term = new window.Terminal({
          convertEol: true,
          cursorBlink: true,
          fontSize: 13,
          theme: { background: '#000000', foreground: '#e5e7eb' }
        });
        if (window.FitAddon && window.FitAddon.FitAddon) {
          this.fit = new window.FitAddon.FitAddon();
          this.term.loadAddon(this.fit);
        }
        this.term.open(container);
        this.fit && this.fit.fit();
        this.term.writeln('\x1b[36mAether Terminal\x1b[0m');
        this.term.writeln('Connect to a backend shell bridge (WebSocket) to run npm/node/python commands.');
        this.term.writeln('Example bridge protocol: send {type:"input",data:"ls\\n"} / receive {type:"output",data:"..."} or raw text.');
        this.term.onData(data => this.send(data));
        window.addEventListener('resize', () => this.fit && this.fit.fit());
      } else {
        container.innerHTML = '<div class="p-2 text-xs text-red-300">xterm.js failed to load.</div>';
      }

      document.getElementById('btnTerminalConnect').addEventListener('click', () => this.connect());
      document.getElementById('btnTerminalClear').addEventListener('click', () => this.term && this.term.clear());
      document.getElementById('terminalWsUrl').value = AppState.settings.terminalWs || '';
      this.setStatus('disconnected');
    },

    setStatus(s) {
      this.connected = s === 'connected';
      const el = document.getElementById('terminalStatus');
      el.textContent = s;
      el.className = s === 'connected' ? 'text-green-400' : (s === 'connecting' ? 'text-yellow-400' : 'text-gray-400');
    },

    connect(url) {
      const wsUrl = url || document.getElementById('terminalWsUrl').value.trim() || AppState.settings.terminalWs;
      if (!wsUrl) return Utils.toast('Terminal bridge URL required', 'error');
      this.disconnect();
      try {
        this.setStatus('connecting');
        this.socket = new WebSocket(wsUrl);
        this.socket.onopen = () => {
          this.setStatus('connected');
          this.term && this.term.writeln(`\r\n\x1b[32mConnected to ${wsUrl}\x1b[0m`);
          Utils.toast('Terminal connected', 'success');
        };
        this.socket.onmessage = (ev) => {
          let data = ev.data;
          try {
            const msg = JSON.parse(ev.data);
            if (msg.type === 'output' || msg.type === 'data') data = msg.data || '';
            else if (msg.type === 'exit') data = `\r\n[process exited ${msg.code ?? ''}]\r\n`;
            else data = msg.data ?? ev.data;
          } catch {}
          this.term && this.term.write(typeof data === 'string' ? data : String(data));
        };
        this.socket.onerror = () => {
          this.term && this.term.writeln('\r\n\x1b[31mTerminal bridge error\x1b[0m');
        };
        this.socket.onclose = () => {
          this.setStatus('disconnected');
          this.term && this.term.writeln('\r\n\x1b[33mDisconnected\x1b[0m');
        };
      } catch (e) {
        this.setStatus('disconnected');
        Utils.toast(`Terminal connect failed: ${e.message}`, 'error');
      }
    },

    disconnect() {
      if (this.socket) { try { this.socket.close(); } catch {} this.socket = null; }
      this.setStatus('disconnected');
    },

    send(data) {
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        // support both raw and JSON bridge protocols
        try { this.socket.send(JSON.stringify({ type: 'input', data })); }
        catch { this.socket.send(data); }
      }
    },

    runCommand(command) {
      if (!command) return false;
      if (!(this.socket && this.socket.readyState === WebSocket.OPEN)) {
        Utils.toast('Terminal not connected; cannot run command', 'error');
        return false;
      }
      this.send(command.endsWith('\n') ? command : command + '\n');
      return true;
    },

    show(show = true) {
      document.getElementById('terminalPane').classList.toggle('hidden', !show);
      setTimeout(() => this.fit && this.fit.fit(), 50);
    },

    toggle() {
      const pane = document.getElementById('terminalPane');
      this.show(pane.classList.contains('hidden'));
    }
  };
  window.TerminalPanel = TerminalPanel;
})();
