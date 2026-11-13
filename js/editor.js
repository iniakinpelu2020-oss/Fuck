(function () {
  const Editor = {
    els: {},
    init() {
      this.els.editor = document.getElementById('codeEditor');
      this.els.lines = document.getElementById('lineNumbers');
      this.els.highlight = document.getElementById('highlightLayer');
      this.els.activeName = document.getElementById('activeFileName');
      this.els.dirty = document.getElementById('dirtyIndicator');
      this.els.lang = document.getElementById('languageSelect');
      this.els.langBadge = document.getElementById('languageBadge');

      this.els.editor.addEventListener('input', () => this.onInput());
      this.els.editor.addEventListener('scroll', () => this.syncScroll());
      this.els.editor.addEventListener('keydown', (e) => this.onKeydown(e));
      this.els.lang.addEventListener('change', () => {
        if (this.els.langBadge) this.els.langBadge.textContent = this.els.lang.value || 'plaintext';
        this.renderHighlight();
      });

      AppState.subscribe((evt, payload) => {
        if (evt === 'file:active') this.loadActive();
        if (evt === 'file:changed' && payload?.path === AppState.activeFilePath) this.loadActive(true);
        if (evt === 'workspace:reset') this.loadActive();
      });
      this.loadActive();
    },

    loadActive(preserveScroll = false) {
      const file = AppState.getActiveFile();
      const scrollTop = this.els.editor.scrollTop;
      if (!file) {
        this.els.activeName.textContent = 'untitled.txt';
        this.els.editor.value = '';
        this.els.dirty.classList.add('hidden');
        if (this.els.langBadge) this.els.langBadge.textContent = 'plaintext';
        this.renderLines(''); this.renderHighlight('');
        return;
      }
      this.els.activeName.textContent = file.path;
      this.els.editor.value = file.content ?? '';
      this.els.dirty.classList.toggle('hidden', !file.dirty);
      const lang = Utils.detectLang(file.path);
      this.els.lang.value = lang;
      if (this.els.langBadge) this.els.langBadge.textContent = lang;
      this.renderLines(this.els.editor.value);
      this.renderHighlight(this.els.editor.value);
      if (preserveScroll) this.els.editor.scrollTop = scrollTop;
      this.syncScroll();
    },

    onInput() {
      const file = AppState.getActiveFile();
      if (!file) return;
      file.content = this.els.editor.value;
      file.dirty = true;
      this.els.dirty.classList.remove('hidden');
      this.renderLines(file.content);
      this.renderHighlight(file.content);
      AppState.emit('file:changed', { path: file.path });
      AppState.exportMemoryWorkspace();
    },

    renderLines(text) {
      const count = Math.max(1, String(text || '').split('\n').length);
      let out = '';
      for (let i = 1; i <= count; i++) out += i + '\n';
      this.els.lines.textContent = out;
    },

    renderHighlight(text = this.els.editor.value) {
      const lang = this.els.lang.value || 'plaintext';
      const code = String(text || '');
      let html;
      try {
        if (window.hljs && lang !== 'plaintext') {
          const res = window.hljs.highlight(code, { language: lang, ignoreIllegals: true });
          html = res.value;
        } else {
          html = Utils.escapeHtml(code);
        }
      } catch {
        html = Utils.escapeHtml(code);
      }
      if (code.endsWith('\n')) html += '\n';
      this.els.highlight.innerHTML = `<code class="hljs language-${Utils.escapeHtml(lang)}">${html}</code>`;
      this.syncScroll();
    },

    syncScroll() {
      this.els.highlight.scrollTop = this.els.editor.scrollTop;
      this.els.highlight.scrollLeft = this.els.editor.scrollLeft;
      this.els.lines.scrollTop = this.els.editor.scrollTop;
    },

    onKeydown(e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        window.FileTree && FileTree.saveActiveFile();
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const start = this.els.editor.selectionStart;
        const end = this.els.editor.selectionEnd;
        const v = this.els.editor.value;
        this.els.editor.value = v.slice(0, start) + '  ' + v.slice(end);
        this.els.editor.selectionStart = this.els.editor.selectionEnd = start + 2;
        this.onInput();
      }
    },

    openOrCreate(path, content = '') {
      if (!AppState.files.has(path)) AppState.upsertFile(path, content, { dirty: true });
      AppState.setActiveFile(path);
      AppState.emit('workspace:changed');
    },

    applyEdits(edits = []) {
      const applied = [];
      for (const edit of edits) {
        if (!edit || !edit.path || typeof edit.content !== 'string') continue;
        const existed = AppState.files.has(edit.path);
        AppState.upsertFile(edit.path, edit.content, { dirty: true, binary: false });
        applied.push({ path: edit.path, created: !existed });
      }
      if (applied.length) {
        AppState.setActiveFile(applied[applied.length - 1].path);
        AppState.emit('workspace:changed');
      }
      return applied;
    }
  };

  window.Editor = Editor;
})();
