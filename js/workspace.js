(function () {
  const TEXT_EXTS = new Set(['txt','md','markdown','js','mjs','cjs','ts','tsx','jsx','json','jsonc','html','htm','css','scss','sass','less','xml','svg','yml','yaml','toml','ini','cfg','conf','env','sh','bash','zsh','fish','ps1','bat','cmd','py','rb','php','java','c','h','cpp','hpp','cc','cxx','cs','go','rs','swift','kt','kts','scala','sql','graphql','gql','vue','svelte','astro','prisma','proto','dockerfile','makefile','gitignore','gitattributes','editorconfig','lock','csv','tsv','log']);
  const TEXT_MIME_PREFIXES = ['text/', 'application/json', 'application/javascript', 'application/typescript', 'application/xml', 'application/x-yaml', 'application/yaml', 'application/toml', 'application/x-sh', 'application/sql', 'application/graphql', 'application/xhtml', 'image/svg+xml'];

  function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function fmtBytes(n) { return (window.Utils && Utils.formatBytes) ? Utils.formatBytes(n) : (n + ' B'); }
  function uid(p) { return (window.Utils && Utils.uid) ? Utils.uid(p || 'att') : ((p||'att') + '_' + Date.now() + '_' + Math.random().toString(36).slice(2,7)); }

  function getExt(name) {
    const n = String(name || '');
    const base = n.split('/').pop() || n;
    if (/^dockerfile$/i.test(base)) return 'dockerfile';
    if (/^makefile$/i.test(base)) return 'makefile';
    const i = base.lastIndexOf('.');
    return i >= 0 ? base.slice(i + 1).toLowerCase() : '';
  }

  function isTextFile(file) {
    const name = file.name || '';
    const type = String(file.type || '').toLowerCase();
    const ext = getExt(name);
    if (TEXT_EXTS.has(ext)) return true;
    if (type && TEXT_MIME_PREFIXES.some(p => type === p || type.startsWith(p))) return true;
    if (!type && ext) return true; // many code files have empty mime
    // heuristic: common code filenames without extension-like patterns handled above
    return false;
  }

  function isImageFile(file) {
    const type = String(file.type || '').toLowerCase();
    if (type.startsWith('image/')) return true;
    const ext = getExt(file.name || '');
    return ['png','jpg','jpeg','gif','webp','bmp','ico','avif'].includes(ext);
  }

  function isZipFile(file) {
    const name = String(file.name || '').toLowerCase();
    const type = String(file.type || '').toLowerCase();
    if (name.endsWith('.zip')) return true;
    return type === 'application/zip' || type === 'application/x-zip-compressed' || type === 'multipart/x-zip';
  }

  function readAsText(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result == null ? '' : r.result));
      r.onerror = () => reject(r.error || new Error('Failed to read text file'));
      r.readAsText(file);
    });
  }
  function readAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || ''));
      r.onerror = () => reject(r.error || new Error('Failed to read data URL'));
      r.readAsDataURL(file);
    });
  }
  function readAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error || new Error('Failed to read binary file'));
      r.readAsArrayBuffer(file);
    });
  }

  async function sha256Hex(buffer) {
    try {
      if (!buffer) return null;
      const ab = buffer instanceof ArrayBuffer ? buffer : (buffer.buffer ? buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) : null);
      if (!ab || !(window.crypto && crypto.subtle)) return null;
      const hash = await crypto.subtle.digest('SHA-256', ab);
      return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch { return null; }
  }

  function extractPrintableStrings(buffer, maxCount = 120, maxLen = 2000) {
    try {
      const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
      const out = [];
      let cur = [];
      const flush = () => {
        if (cur.length >= 4) {
          let s = cur.join('');
          if (s.length > 200) s = s.slice(0, 200) + '…';
          out.push(s);
        }
        cur = [];
      };
      const limit = Math.min(bytes.length, 1024 * 1024); // scan first 1MB
      for (let i = 0; i < limit && out.length < maxCount; i++) {
        const b = bytes[i];
        if (b >= 32 && b <= 126) cur.push(String.fromCharCode(b));
        else if (b === 9 || b === 10 || b === 13) { if (cur.length) cur.push(' '); }
        else flush();
      }
      flush();
      let joined = out.join('\n');
      if (joined.length > maxLen) joined = joined.slice(0, maxLen) + '\n…';
      return joined;
    } catch { return ''; }
  }

  function headerHex(buffer, n = 64) {
    try {
      const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
      const slice = bytes.slice(0, Math.min(n, bytes.length));
      return Array.from(slice).map(b => b.toString(16).padStart(2, '0')).join(' ');
    } catch { return ''; }
  }

  function sanitizePath(p) {
    return String(p || '').replace(/\\/g, '/').replace(/^\/+/, '').split('/').filter(x => x && x !== '.' && x !== '..').join('/');
  }

  function uniqueWorkspacePath(basePath) {
    let p = sanitizePath(basePath) || ('file_' + Date.now());
    if (!window.AppState || !AppState.files || !AppState.files.has(p)) return p;
    const extIdx = p.lastIndexOf('.');
    const stem = extIdx > 0 ? p.slice(0, extIdx) : p;
    const ext = extIdx > 0 ? p.slice(extIdx) : '';
    let i = 1;
    while (AppState.files.has(`${stem} (${i})${ext}`)) i++;
    return `${stem} (${i})${ext}`;
  }

  function addFileToWorkspace(path, content, extra = {}) {
    if (!window.AppState) return null;
    const p = uniqueWorkspacePath(path);
    if (AppState.upsertFile) AppState.upsertFile(p, content, extra);
    else {
      AppState.ensureDir && AppState.ensureDir((window.Utils && Utils.dirname) ? Utils.dirname(p) : '');
      AppState.files.set(p, { path: p, content, type: 'file', ...extra });
      AppState.emit && AppState.emit('file:changed', { path: p });
    }
    return p;
  }

  function notifyWorkspaceChanged() {
    if (window.AppState && AppState.emit) AppState.emit('workspace:changed');
  }

  const Workspace = {
    pendingAttachments: [],

    init() {
      this.pendingAttachments = [];
      this.renderChips();
    },

    getPending() { return Array.isArray(this.pendingAttachments) ? [...this.pendingAttachments] : []; },

    clearPending() {
      this.pendingAttachments = [];
      this.renderChips();
    },

    removePending(id) {
      this.pendingAttachments = (this.pendingAttachments || []).filter(a => a.id !== id);
      this.renderChips();
    },

    addPending(att) {
      if (!att) return;
      if (!att.id) att.id = uid('att');
      this.pendingAttachments = this.pendingAttachments || [];
      this.pendingAttachments.push(att);
      this.renderChips();
    },

    renderChips() {
      const el = document.getElementById('chatAttachmentChips');
      if (!el) return;
      const list = this.pendingAttachments || [];
      if (!list.length) {
        el.innerHTML = '';
        el.classList.add('hidden');
        return;
      }
      el.classList.remove('hidden');
      el.innerHTML = list.map(att => this.renderChip(att)).join('');
      el.querySelectorAll('[data-remove-att]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.preventDefault(); e.stopPropagation();
          const id = btn.getAttribute('data-remove-att');
          if (id) this.removePending(id);
        });
      });
    },

    iconFor(att) {
      if (!att) return '📎';
      if (att.kind === 'image') return '🖼️';
      if (att.kind === 'zip') return '🗜️';
      if (att.kind === 'text') return '📄';
      if (att.kind === 'binary') return '📦';
      return '📎';
    },

    renderChip(att) {
      const name = esc(att.name || 'file');
      const size = esc(fmtBytes(att.size || 0));
      const type = esc(att.mime || att.kind || 'file');
      const icon = this.iconFor(att);
      const thumb = (att.kind === 'image' && att.dataUrl)
        ? `<img src="${att.dataUrl}" alt="" class="w-8 h-8 object-cover rounded border border-border shrink-0" />`
        : `<div class="w-8 h-8 rounded border border-border bg-white/5 flex items-center justify-center text-sm shrink-0">${icon}</div>`;
      const sub = att.kind === 'zip' && Array.isArray(att.extractedPaths)
        ? `${size} · zip · ${att.extractedPaths.length} files`
        : `${size} · ${type}`;
      return `<div class="inline-flex items-center gap-2 max-w-full rounded-lg border border-border bg-panel/80 px-2 py-1.5 text-xs text-slate-200">
        ${thumb}
        <div class="min-w-0">
          <div class="truncate max-w-[12rem] font-medium" title="${name}">${name}</div>
          <div class="text-[10px] text-slate-400 truncate max-w-[12rem]" title="${esc(sub)}">${esc(sub)}</div>
        </div>
        <button type="button" data-remove-att="${esc(att.id)}" class="ml-1 text-slate-400 hover:text-white shrink-0" title="Remove attachment" aria-label="Remove attachment">✕</button>
      </div>`;
    },

    async handleFiles(fileList, opts = {}) {
      const files = Array.from(fileList || []);
      if (!files.length) return { processed: 0, attachments: [] };
      const attachToChat = !!opts.attachToChat;
      const source = opts.source || 'upload';
      let processed = 0;
      const createdAttachments = [];
      for (const file of files) {
        try {
          const res = await this.processFile(file, { attachToChat, source });
          if (res && res.attachment) { this.addPending(res.attachment); createdAttachments.push(res.attachment); }
          processed++;
        } catch (e) {
          console.error('Failed to process file', file && file.name, e);
          if (window.Utils && Utils.toast) Utils.toast(`Failed: ${file && file.name ? file.name : 'file'} — ${e.message || e}`, 'error');
        }
      }
      if (processed && window.AppState && AppState.emit) AppState.emit('workspace:changed');
      if (processed && window.Utils && Utils.toast) {
        const msg = attachToChat ? `Attached ${processed} file${processed === 1 ? '' : 's'}` : `Uploaded ${processed} file${processed === 1 ? '' : 's'} to workspace`;
        Utils.toast(msg, 'success');
      }
      return { processed, attachments: createdAttachments };
    },

    async processFile(file, opts = {}) {
      const attachToChat = !!opts.attachToChat;
      const name = file.name || 'file';
      const size = file.size || 0;
      const mime = file.type || '';
      const basePath = sanitizePath(file.webkitRelativePath || name) || name;

      if (isZipFile(file)) {
        return await this.processZip(file, { attachToChat, basePath, name, size, mime });
      }
      if (isImageFile(file)) {
        return await this.processImage(file, { attachToChat, basePath, name, size, mime });
      }
      if (isTextFile(file)) {
        return await this.processText(file, { attachToChat, basePath, name, size, mime });
      }
      return await this.processBinary(file, { attachToChat, basePath, name, size, mime });
    },

    async processText(file, ctx) {
      const content = await readAsText(file);
      const path = addFileToWorkspace(ctx.basePath, content, { dirty: false, binary: false, meta: { size: ctx.size, mime: ctx.mime } });
      if (path && window.AppState) {
        // focus uploaded file in editor/explorer
        try { AppState.setActiveFile(path); } catch {}
      }
      const attachment = ctx.attachToChat ? {
        id: uid('att'), kind: 'text', name: ctx.name, path, size: ctx.size, mime: ctx.mime || 'text/plain',
        content: content.length > 20000 ? content.slice(0, 20000) + '\n…(truncated for context)' : content,
        truncated: content.length > 20000
      } : null;
      return { path, attachment };
    },

    async processImage(file, ctx) {
      const dataUrl = await readAsDataURL(file);
      // Images are chat attachments (vision) - keep as pending attachment; do not clutter text file tree
      const attachment = ctx.attachToChat ? {
        id: uid('att'), kind: 'image', name: ctx.name, path: ctx.basePath, size: ctx.size, mime: ctx.mime || 'image/*', dataUrl
      } : null;
      // If uploaded via workspace (not chat), still make it available as a note? store metadata entry
      if (!ctx.attachToChat) {
        const path = addFileToWorkspace(ctx.basePath, `[Image file: ${ctx.name}]\nMIME: ${ctx.mime || 'unknown'}\nSize: ${ctx.size} bytes\n(Attached image; preview available when sent to chat.)`, { dirty: false, binary: true, meta: { size: ctx.size, mime: ctx.mime, kind: 'image' } });
        return { path, attachment: null };
      }
      return { path: null, attachment };
    },

    async processZip(file, ctx) {
      if (!window.JSZip) throw new Error('JSZip not available to unpack archive');
      const buf = await readAsArrayBuffer(file);
      const zip = await JSZip.loadAsync(buf);
      const extractedPaths = [];
      const entries = Object.values(zip.files || {});
      for (const entry of entries) {
        if (!entry || entry.dir) continue;
        const entryPath = sanitizePath(entry.name);
        if (!entryPath) continue;
        // decide text vs binary for extracted file
        const fake = { name: entryPath, type: '' };
        const lower = entryPath.toLowerCase();
        const treatAsText = isTextFile(fake) || /\.(md|txt|json|js|ts|jsx|tsx|css|html|xml|yml|yaml|svg|csv)$/i.test(lower);
        try {
          if (treatAsText) {
            const content = await entry.async('string');
            const saved = addFileToWorkspace(entryPath, content, { dirty: false, binary: false, meta: { fromZip: ctx.name } });
            if (saved) extractedPaths.push(saved);
          } else {
            const ab = await entry.async('arraybuffer');
            const u8 = new Uint8Array(ab);
            const hash = await sha256Hex(ab);
            const strings = extractPrintableStrings(u8, 60, 800);
            const header = headerHex(u8, 64);
            const label = `[Binary file extracted from ${ctx.name}]\nPath: ${entryPath}\nMIME: (unknown)\nSize: ${ab.byteLength} bytes\nSHA-256: ${hash || '(unavailable)'}\nHeader bytes: ${header}\n\n--- Printable strings (sample) ---\n${strings || '(none)'}`;
            const saved = addFileToWorkspace(entryPath, label, { dirty: false, binary: true, meta: { size: ab.byteLength, mime: '', fromZip: ctx.name, arrayBuffer: ab, hash, stringsPreview: strings, headerHex: header } });
            if (saved) extractedPaths.push(saved);
          }
        } catch (e) {
          console.warn('Failed to extract zip entry', entryPath, e);
        }
      }
      const attachment = ctx.attachToChat ? {
        id: uid('att'), kind: 'zip', name: ctx.name, size: ctx.size, mime: ctx.mime || 'application/zip', extractedPaths
      } : null;
      return { path: null, attachment, extractedPaths };
    },

    async processBinary(file, ctx) {
      const buf = await readAsArrayBuffer(file);
      const u8 = new Uint8Array(buf);
      const hash = await sha256Hex(buf);
      const strings = extractPrintableStrings(u8, 120, 1500);
      const header = headerHex(u8, 64);
      const path = addFileToWorkspace(ctx.basePath, `[Binary file: ${ctx.name}]\nMIME: ${ctx.mime || 'unknown'}\nSize: ${ctx.size} bytes\nSHA-256: ${hash || '(unavailable)'}\nHeader bytes: ${header}\n\n--- Printable strings / header sample ---\n${strings || '(none)'}`, {
        dirty: false,
        binary: true,
        meta: { size: ctx.size, mime: ctx.mime, arrayBuffer: buf, hash, stringsPreview: strings, headerHex: header }
      });
      // Make available to Binary analyzer tab
      try {
        if (window.BinaryInspector && typeof BinaryInspector.setFile === 'function') {
          const f = new File([buf], ctx.name, { type: ctx.mime || 'application/octet-stream' });
          BinaryInspector.setFile(f);
        }
      } catch {}
      const attachment = ctx.attachToChat ? {
        id: uid('att'), kind: 'binary', name: ctx.name, path, size: ctx.size, mime: ctx.mime || 'application/octet-stream',
        hash, stringsPreview: strings, headerHex: header
      } : null;
      return { path, attachment };
    },

    buildAgentAttachmentContext(attachments) {
      const list = Array.isArray(attachments) ? attachments : [];
      if (!list.length) return '';
      const parts = [];
      parts.push('--- Attached Files (user upload) ---');
      for (const a of list) {
        if (!a) continue;
        if (a.kind === 'text') {
          const body = String(a.content || '');
          parts.push(`\n[Text file: ${a.name}${a.path ? ' (' + a.path + ')' : ''} | ${fmtBytes(a.size||0)} | ${a.mime||'text/plain'}]`);
          parts.push(body);
        } else if (a.kind === 'zip') {
          const paths = Array.isArray(a.extractedPaths) ? a.extractedPaths : [];
          parts.push(`\n[Zip archive: ${a.name} | ${fmtBytes(a.size||0)} | extracted ${paths.length} file(s) into workspace]`);
          if (paths.length) parts.push(paths.slice(0, 300).map(p => `- ${p}`).join('\n'));
        } else if (a.kind === 'binary') {
          parts.push(`\n[Binary/Document file: ${a.name}${a.path ? ' (' + a.path + ')' : ''}]`);
          parts.push(`MIME: ${a.mime || 'unknown'}`);
          parts.push(`Size: ${a.size || 0} bytes (${fmtBytes(a.size || 0)})`);
          parts.push(`SHA-256: ${a.hash || '(unavailable)'}`);
          if (a.headerHex) parts.push(`Header bytes (hex): ${a.headerHex}`);
          if (a.stringsPreview) parts.push(`Printable strings (sample):\n${a.stringsPreview}`);
        } else if (a.kind === 'image') {
          parts.push(`\n[Image attachment: ${a.name} | ${fmtBytes(a.size||0)} | ${a.mime||'image/*'}] (image provided as vision input)`);
        } else {
          parts.push(`\n[Attachment: ${a.name || 'file'} | ${a.kind || 'file'} | ${fmtBytes(a.size||0)}]`);
        }
      }
      return parts.join('\n');
    }
  };

  window.Workspace = Workspace;
})();
