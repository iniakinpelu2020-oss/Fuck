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

  function uniqueStrings(arr, limit = Infinity) {
    const seen = new Set();
    const out = [];
    for (const v of (arr || [])) {
      const s = String(v == null ? '' : v).trim();
      if (!s || seen.has(s)) continue;
      seen.add(s);
      out.push(s);
      if (out.length >= limit) break;
    }
    return out;
  }

  // ---- Binary IOC extraction & embedded payload carving ----
  function scanAsciiRuns(bytes, minLen = 4, maxScan = 4 * 1024 * 1024, limit = 50000) {
    const runs = [];
    let cur = [];
    let start = 0;
    const scanLen = Math.min(bytes.length, maxScan);
    const flush = (i) => {
      if (cur.length >= minLen) runs.push({ text: cur.join(''), offset: start, length: cur.length });
      cur = [];
    };
    for (let i = 0; i < scanLen; i++) {
      const b = bytes[i];
      if (b >= 32 && b <= 126) { if (!cur.length) start = i; cur.push(String.fromCharCode(b)); if (runs.length >= limit) { cur = []; break; } }
      else flush(i);
    }
    flush(scanLen);
    return runs;
  }

  function extractBinaryIOCs(buffer, opts = {}) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer || []);
    const maxScan = opts.maxScan || 4 * 1024 * 1024;
    const runs = scanAsciiRuns(bytes, 4, maxScan, 40000);
    const urls = [];
    const ipv4 = [];
    const regPaths = [];
    const filePaths = [];
    for (const r of runs) {
      const s = r.text;
      if (s.length < 6) continue;
      // URLs
      let m;
      const urlRe = /\b(?:https?|ftp|ws|wss):\/\/[^\s"'<>\\\x00-\x1F]+/gi;
      while ((m = urlRe.exec(s)) !== null) urls.push(m[0].replace(/[),.;:]+$/,''));
      // IPv4 addresses (dotted quads)
      const ipRe = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
      while ((m = ipRe.exec(s)) !== null) ipv4.push(m[0]);
      // Windows registry paths
      const regRe = /\b(?:HKEY_LOCAL_MACHINE|HKEY_CURRENT_USER|HKEY_CLASSES_ROOT|HKEY_USERS|HKEY_CURRENT_CONFIG|HKLM|HKCU|HKCR|HKU|HKCC)\\[A-Za-z0-9_\-.\\ ]{2,}/gi;
      while ((m = regRe.exec(s)) !== null) regPaths.push(m[0]);
      // Windows file paths
      const winPathRe = /\b[A-Za-z]:\\(?:[^\\\/:*?"<>|\r\n]{1,120}\\)*[^\\\/:*?"<>|\r\n]{0,120}/g;
      while ((m = winPathRe.exec(s)) !== null) {
        const p = m[0].replace(/[),.;:]+$/,'');
        if (p.length >= 6) filePaths.push(p);
      }
      // Unix-like file paths of interest
      if (s.startsWith('/') || s.includes('/etc/') || s.includes('/usr/') || s.includes('/var/') || s.includes('/bin/') || s.includes('/tmp/')) {
        const uxRe = /(?:^|[\s"'=:])(\/(?:[A-Za-z0-9._@+\-]{1,64}\/){1,12}[A-Za-z0-9._@+\-]{1,96})/g;
        while ((m = uxRe.exec(s)) !== null) {
          const p = m[1].replace(/[),.;:]+$/,'');
          if (p.length >= 6 && p.length <= 260) filePaths.push(p);
        }
      }
    }
    // Filter out some obvious false-positive IPs/paths
    const filteredIps = ipv4.filter(ip => !/^0\.0\.0\.0$|^255\.255\.255\.255$/.test(ip));

    // Magic byte signatures / embedded payloads
    const magicDefs = [
      { id: 'zip', label: 'ZIP archive (PK\\x03\\x04)', ext: '.zip', mime: 'application/zip', sig: [0x50,0x4B,0x03,0x04] },
      { id: 'mz', label: 'PE executable (MZ)', ext: '.exe', mime: 'application/x-msdownload', sig: [0x4D,0x5A] },
      { id: '7z', label: '7z archive (7z\\xBC\\xAF)', ext: '.7z', mime: 'application/x-7z-compressed', sig: [0x37,0x7A,0xBC,0xAF,0x27,0x1C] },
      { id: 'rar', label: 'RAR archive (Rar!)', ext: '.rar', mime: 'application/vnd.rar', sig: [0x52,0x61,0x72,0x21] }
    ];
    const matches = (needle, startIdx) => {
      if (startIdx + needle.length > bytes.length) return false;
      for (let i = 0; i < needle.length; i++) if (bytes[startIdx + i] !== needle[i]) return false;
      return true;
    };
    const embedded = [];
    for (let off = 0; off < bytes.length; off++) {
      for (const def of magicDefs) {
        if (!matches(def.sig, off)) continue;
        // avoid duplicating the primary MZ header at offset 0 as "embedded" noise? keep it but mark
        embedded.push({ offset: off, type: def.id, label: def.label, ext: def.ext, mime: def.mime, signatureHex: def.sig.map(b=>b.toString(16).padStart(2,'0')).join(' ') });
        if (embedded.length >= 200) break;
      }
      if (embedded.length >= 200) break;
    }
    // compute carve ranges (from this offset to next embedded magic or EOF)
    const embeddedWithRanges = embedded.map((e, i) => {
      const next = embedded[i + 1];
      const end = next ? next.offset : bytes.length;
      return { ...e, endOffset: end, size: Math.max(0, end - e.offset) };
    });

    const result = {
      urls: uniqueStrings(urls, 300),
      ipv4: uniqueStrings(filteredIps, 300),
      registryPaths: uniqueStrings(regPaths, 300),
      filePaths: uniqueStrings(filePaths, 300),
      embedded: embeddedWithRanges,
      scannedBytes: Math.min(bytes.length, maxScan),
      totalBytes: bytes.length
    };
    return result;
  }

  function extForEmbedded(e) { return (e && e.ext) || '.bin'; }
  function mimeForEmbedded(e) { return (e && e.mime) || 'application/octet-stream'; }

  function carveEmbeddedPayloads(buffer, embeddedList, opts = {}) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer || []);
    const list = Array.isArray(embeddedList) ? embeddedList : [];
    const maxCarve = opts.maxCarve || 10;
    const maxSize = opts.maxSize || 25 * 1024 * 1024; // 25MB per carve safety cap
    const results = [];
    for (const e of list.slice(0, maxCarve)) {
      if (!e || typeof e.offset !== 'number') continue;
      const off = Math.max(0, Math.min(bytes.length, e.offset));
      let end = (typeof e.endOffset === 'number') ? Math.max(off, Math.min(bytes.length, e.endOffset)) : bytes.length;
      if (end - off > maxSize) end = off + maxSize;
      if (end <= off) continue;
      const slice = bytes.slice(off, end);
      results.push({ ...e, offset: off, endOffset: end, size: slice.byteLength, bytes: slice });
    }
    return results;
  }

  function makeDownloadableFileRecord(name, bytes, mime) {
    const safeName = sanitizePath(String(name || 'carved.bin').split('/').pop() || 'carved.bin');
    const size = bytes ? bytes.byteLength || bytes.length || 0 : 0;
    let downloadUrl = null;
    try {
      if (typeof Blob !== 'undefined' && typeof URL !== 'undefined' && URL.createObjectURL) {
        const blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
        downloadUrl = URL.createObjectURL(blob);
      }
    } catch {}
    return { name: safeName, path: safeName, size, mime: mime || 'application/octet-stream', downloadUrl };
  }

  function extractPrintableStrings(buffer, maxCount = 200, maxLen = 4000, opts = {}) {
    try {
      const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
      const minLen = opts.minLen || 4;
      const perStringMax = opts.perStringMax || 200;
      const out = [];
      let cur = [];
      const flush = () => {
        if (cur.length >= minLen) {
          let str = cur.join('');
          if (str.length > perStringMax) str = str.slice(0, perStringMax) + '…';
          out.push(str);
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
      const seen = new Set();
      const uniq = [];
      for (const str of out) { const k = String(str).trim(); if (!k || seen.has(k)) continue; seen.add(k); uniq.push(k); }
      let joined = uniq.join('\n');
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

  function readAscii(bytes, offset, len) {
    let out = '';
    const end = Math.min(bytes.length, offset + len);
    for (let i = Math.max(0, offset); i < end; i++) {
      const b = bytes[i];
      if (b === 0) break;
      out += (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.';
    }
    return out;
  }
  function u16(bytes, off) { return (off + 1 < bytes.length) ? (bytes[off] | (bytes[off + 1] << 8)) : 0; }
  function u32(bytes, off) { return (off + 3 < bytes.length) ? ((bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0) : 0; }

  function summarizeBinaryBuffer(buffer, meta = {}) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer || []);
    const name = meta.name || 'file';
    const mime = meta.mime || 'application/octet-stream';
    const size = (meta.size != null ? meta.size : bytes.length) || 0;
    const hash = meta.hash || null;
    const header = meta.headerHex || headerHex(bytes, 64);
    const lines = [];
    lines.push(`[Binary file: ${name}]`);
    lines.push(`MIME: ${mime}`);
    lines.push(`Size: ${size} bytes (${fmtBytes(size)})`);
    lines.push(`SHA-256: ${hash || '(unavailable)'}`);
    if (header) lines.push(`Header bytes (hex): ${header}`);

    // PE / EXE summary (best-effort, bounded)
    if (bytes.length >= 64 && bytes[0] === 0x4D && bytes[1] === 0x5A) {
      const peOff = u32(bytes, 60);
      lines.push('');
      lines.push('PE Header (summary):');
      lines.push('- DOS signature: MZ');
      lines.push(`- PE header offset: 0x${peOff.toString(16)}`);
      if (peOff > 0 && peOff + 24 < bytes.length && bytes[peOff] === 0x50 && bytes[peOff+1] === 0x45 && bytes[peOff+2] === 0 && bytes[peOff+3] === 0) {
        const coff = peOff + 4;
        const machine = u16(bytes, coff);
        const numSections = u16(bytes, coff + 2);
        const timeDate = u32(bytes, coff + 4);
        const optSize = u16(bytes, coff + 16);
        const characteristics = u16(bytes, coff + 18);
        const machineMap = { 0x014c: 'x86 (I386)', 0x8664: 'x64 (AMD64)', 0x01c0: 'ARM', 0xaa64: 'ARM64', 0x0200: 'IA64' };
        lines.push('- Signature: PE\0\0');
        lines.push(`- Machine: ${machineMap[machine] || ('0x' + machine.toString(16))}`);
        lines.push(`- Sections: ${numSections}`);
        lines.push(`- Timestamp: ${timeDate ? new Date(timeDate * 1000).toISOString() : '0'}`);
        lines.push(`- Characteristics: 0x${characteristics.toString(16)}`);
        const optOff = coff + 20;
        if (optOff + 2 <= bytes.length) {
          const magic = u16(bytes, optOff);
          const isPE32Plus = magic === 0x20b;
          const isPE32 = magic === 0x10b;
          if (isPE32 || isPE32Plus) {
            lines.push(`- Optional header: ${isPE32Plus ? 'PE32+ (64-bit)' : 'PE32 (32-bit)'}`);
            const ddCountOff = optOff + (isPE32Plus ? 108 : 92);
            const ddOff = optOff + (isPE32Plus ? 112 : 96);
            const ddCount = (ddCountOff + 4 <= bytes.length) ? u32(bytes, ddCountOff) : 0;
            const secOff = optOff + optSize;
            const rvaToOff = (rva) => {
              if (!rva) return 0;
              for (let i = 0; i < Math.min(numSections, 96); i++) {
                const so = secOff + i * 40;
                if (so + 40 > bytes.length) break;
                const va = u32(bytes, so + 12);
                const rawSize = u32(bytes, so + 16);
                const rawPtr = u32(bytes, so + 20);
                const vsize = u32(bytes, so + 8) || rawSize;
                if (rva >= va && rva < va + vsize) return rawPtr + (rva - va);
              }
              return rva;
            };
            // Sections
            lines.push('');
            lines.push('Sections:');
            const maxSecs = Math.min(numSections, 16);
            for (let i = 0; i < maxSecs; i++) {
              const so = secOff + i * 40;
              if (so + 40 > bytes.length) break;
              let secName = '';
              for (let j = 0; j < 8; j++) { const b = bytes[so + j]; if (!b) break; secName += (b >= 32 && b <= 126) ? String.fromCharCode(b) : ''; }
              const vsize = u32(bytes, so + 8);
              const va = u32(bytes, so + 12);
              const rawSize = u32(bytes, so + 16);
              const rawPtr = u32(bytes, so + 20);
              const ch = u32(bytes, so + 36);
              lines.push(`- ${secName || '(noname)'} | vsize=0x${vsize.toString(16)} va=0x${va.toString(16)} raw=0x${rawSize.toString(16)} ptr=0x${rawPtr.toString(16)} flags=0x${ch.toString(16)}`);
            }
            if (numSections > maxSecs) lines.push(`- … (${numSections - maxSecs} more sections)`);

            // Imports (DLL names)
            if (ddCount >= 2 && ddOff + 16 <= bytes.length) {
              const impRva = u32(bytes, ddOff + 8);
              const impSize = u32(bytes, ddOff + 12);
              if (impRva && impSize) {
                const imports = [];
                let idOff = rvaToOff(impRva);
                for (let n = 0; n < 64 && idOff + 20 <= bytes.length; n++, idOff += 20) {
                  const nameRva = u32(bytes, idOff + 12);
                  const origFirstThunk = u32(bytes, idOff);
                  const firstThunk = u32(bytes, idOff + 16);
                  if (!nameRva && !origFirstThunk && !firstThunk) break;
                  const nameOff = rvaToOff(nameRva);
                  if (!nameOff || nameOff <= 0 || nameOff >= bytes.length) continue;
                  let dll = '';
                  for (let j = 0; j < 128 && nameOff + j < bytes.length; j++) {
                    const b = bytes[nameOff + j];
                    if (!b) break;
                    if (b >= 32 && b <= 126) dll += String.fromCharCode(b); else { dll = ''; break; }
                  }
                  if (dll) imports.push(dll);
                }
                if (imports.length) {
                  lines.push('');
                  lines.push('Imports (DLLs):');
                  const uniqImports = Array.from(new Set(imports));
                  const show = uniqImports.slice(0, 60);
                  for (const dll of show) lines.push(`- ${dll}`);
                  if (uniqImports.length > show.length) lines.push(`- … (${uniqImports.length - show.length} more)`);
                }
              }
            }
          } else {
            lines.push(`- Optional header magic: 0x${magic.toString(16)} (unknown)`);
          }
        }
      } else {
        lines.push('- PE signature not found at offset (truncated or non-PE)');
      }
    }

    // Printable strings sample (top 150 unique), capped contribution
    lines.push('');
    lines.push('Printable strings (top 150 unique, sampled):');
    const strings = extractPrintableStrings(bytes, 300, 3500, { minLen: 4, perStringMax: 120 });
    if (strings) {
      const strLines = strings.split('\n').filter(Boolean).slice(0, 150);
      for (const str of strLines) lines.push(`- ${str}`);
    } else {
      lines.push('- (none)');
    }

    let out = lines.join('\n');
    // hard cap: never dump raw megabytes into prompt
    const MAX = 8000;
    if (out.length > MAX) out = out.slice(0, MAX) + '\n…(binary context truncated to 8000 chars)';
    return out;
  }

  function capBinaryContext(text, max = 8000) {
    const s = String(text || '');
    if (s.length <= max) return s;
    return s.slice(0, max) + '\n…(binary context truncated to 8000 chars)';
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

  const CHAT_TEXT_EXTS = new Set(['js','mjs','cjs','ts','tsx','jsx','html','htm','css','scss','sass','less','json','jsonc','py','md','markdown','txt','sh','bash','zsh','yml','yaml','xml','svg']);

  const Workspace = {
    pendingAttachments: [],
    lastBinaryIocReport: null,

    init() {
      this.pendingAttachments = [];
      this.bindChatComposer();
      this.renderChips();
    },

    bindChatComposer() {
      const attachBtn = document.getElementById('btnChatAttach');
      const fileInput = document.getElementById('chatFileInput');
      if (attachBtn && fileInput && !attachBtn.dataset.boundAttach) {
        attachBtn.dataset.boundAttach = '1';
        attachBtn.addEventListener('click', (e) => {
          e.preventDefault();
          fileInput.click();
        });
      }
      if (fileInput && !fileInput.dataset.boundAttach) {
        fileInput.dataset.boundAttach = '1';
        fileInput.addEventListener('change', async () => {
          try {
            if (fileInput.files && fileInput.files.length) {
              await this.handleFiles(fileInput.files, { attachToChat: true, source: 'chat-attach' });
            }
          } finally {
            fileInput.value = '';
          }
        });
      }

      const dropTargets = [
        document.getElementById('chatDropZone'),
        document.getElementById('chatMessages'),
        document.getElementById('agentComposerWrap')
      ].filter(Boolean);
      dropTargets.forEach((zone) => {
        if (zone.dataset.dropBoundChat) return;
        zone.dataset.dropBoundChat = '1';
        let dragDepth = 0;
        const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
        const activate = () => zone.classList.add('ring-1', 'ring-accent2/60', 'bg-accent2/5');
        const deactivate = () => zone.classList.remove('ring-1', 'ring-accent2/60', 'bg-accent2/5');
        zone.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; activate(); });
        zone.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; activate(); });
        zone.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) deactivate(); });
        zone.addEventListener('drop', async (e) => {
          if (!hasFiles(e) || !e.dataTransfer.files || !e.dataTransfer.files.length) { dragDepth = 0; deactivate(); return; }
          e.preventDefault(); e.stopPropagation(); dragDepth = 0; deactivate();
          await this.handleFiles(e.dataTransfer.files, { attachToChat: true, source: 'chat-drop' });
        });
      });
    },

    isChatTextFile(file) {
      const name = String((file && file.name) || '').toLowerCase();
      const ext = getExt(name);
      if (CHAT_TEXT_EXTS.has(ext)) return true;
      const mime = String((file && file.type) || '').toLowerCase();
      if (mime.startsWith('text/')) return true;
      if (mime === 'application/json' || mime === 'application/javascript' || mime === 'application/xml' || mime === 'image/svg+xml') return true;
      return false;
    },

    getHttpRunnerUrl() {
      try { return (window.TerminalPanel && typeof TerminalPanel.getHttpRunnerUrl === 'function') ? (TerminalPanel.getHttpRunnerUrl() || '') : ''; }
      catch { return ''; }
    },

    async uploadFileToRunner(file, runnerUrl) {
      const token = (window.AppState && AppState.settings && (AppState.settings.runnerToken || AppState.settings.codespaceToken || AppState.settings.terminalToken)) || '';
      const fd = new FormData();
      fd.append('file', file, file.name || 'upload.bin');
      fd.append('runnerUrl', runnerUrl);
      fd.append('token', String(token || ''));
      fd.append('filename', file.name || 'upload.bin');
      const res = await fetch('/api/upload', { method: 'POST', body: fd });
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      let data = null;
      if (ct.includes('application/json')) data = await res.json().catch(() => null);
      else {
        const text = await res.text().catch(() => '');
        try { data = JSON.parse(text); } catch { data = { ok: res.ok, stdout: text, stderr: res.ok ? '' : text }; }
      }
      if (!data || typeof data !== 'object') data = { ok: res.ok };
      if (res.ok && data.ok !== false) return { ok: true, ...data };
      return { ok: false, ...data, stderr: (data && (data.stderr || data.error || data.message)) || `HTTP ${res.status}` };
    },

    async processChatBinaryFile(file, ctx) {
      // Binary/large chat attachment: upload to configured remote HTTP runner if available, else metadata-only chip
      const httpRunner = this.getHttpRunnerUrl();
      let uploaded = null;
      let uploadError = '';
      if (httpRunner) {
        try {
          uploaded = await this.uploadFileToRunner(file, httpRunner);
          if (!uploaded || uploaded.ok === false) {
            uploadError = (uploaded && (uploaded.stderr || uploaded.error || uploaded.message)) || 'Upload failed';
            uploaded = null;
          }
        } catch (e) {
          uploadError = e && e.message ? e.message : String(e);
          uploaded = null;
        }
      }
      const attachment = {
        id: uid('att'),
        kind: 'binary-upload',
        name: ctx.name,
        size: ctx.size,
        mime: ctx.mime || 'application/octet-stream',
        uploaded: !!uploaded,
        runnerUrl: httpRunner || '',
        remotePath: uploaded ? (uploaded.path || uploaded.filePath || uploaded.remotePath || uploaded.filename || '') : '',
        uploadResult: uploaded || null,
        uploadError: uploadError || (!httpRunner ? 'No remote HTTP runner configured' : '')
      };
      return { path: null, attachment };
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
      if (att.kind === 'binary-upload') return att.uploaded ? '⬆️' : '📦';
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
      let sub = `${size} · ${type}`;
      if (att.kind === 'zip' && Array.isArray(att.extractedPaths)) sub = `${size} · zip · ${att.extractedPaths.length} files`;
      else if (att.kind === 'binary-upload') sub = att.uploaded ? `${size} · uploaded to remote runner` : `${size} · not uploaded${att.uploadError && /No remote HTTP runner/i.test(att.uploadError) ? ' (no runner)' : ''}`;
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

      if (attachToChat) {
        if (this.isChatTextFile(file)) {
          return await this.processText(file, { attachToChat, basePath, name, size, mime });
        }
        // Binary/large chat attachments (.exe, .zip, .bin, etc.): upload to configured remote HTTP runner if available, else metadata-only chip
        return await this.processChatBinaryFile(file, { attachToChat, basePath, name, size, mime });
      }

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
            const header = headerHex(u8, 64);
            const summary = capBinaryContext(summarizeBinaryBuffer(ab, { name: entryPath, mime: '', size: ab.byteLength, hash, headerHex: header }), 8000);
            const stringsPreview = extractPrintableStrings(u8, 150, 1500, { minLen: 4, perStringMax: 120 });
            const saved = addFileToWorkspace(entryPath, summary, { dirty: false, binary: true, meta: { size: ab.byteLength, mime: '', fromZip: ctx.name, arrayBuffer: ab, hash, stringsPreview, headerHex: header, summary } });
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
      const header = headerHex(u8, 64);
      // Capped summary (<= 8000 chars): PE header/sections/imports + top 150 unique printable strings; never dump raw bytes
      const summary = capBinaryContext(summarizeBinaryBuffer(buf, { name: ctx.name, mime: ctx.mime || 'application/octet-stream', size: ctx.size, hash, headerHex: header }), 8000);
      const stringsPreview = extractPrintableStrings(u8, 150, 1500, { minLen: 4, perStringMax: 120 });
      const path = addFileToWorkspace(ctx.basePath, summary, {
        dirty: false,
        binary: true,
        meta: { size: ctx.size, mime: ctx.mime, arrayBuffer: buf, hash, stringsPreview, headerHex: header, summary }
      });
      // Make available to Binary analyzer tab (File wrapper; ArrayBuffer stored in workspace)
      try {
        if (window.BinaryInspector && typeof BinaryInspector.setFile === 'function') {
          const f = new File([buf], ctx.name, { type: ctx.mime || 'application/octet-stream' });
          BinaryInspector.setFile(f);
        }
      } catch {}
      const attachment = ctx.attachToChat ? {
        id: uid('att'), kind: 'binary', name: ctx.name, path, size: ctx.size, mime: ctx.mime || 'application/octet-stream',
        hash, headerHex: header, summary
      } : null;
      return { path, attachment };
    },

    async getLoadedBinaryBuffer() {
      // Prefer currently selected/analyzed binary in BinaryInspector, else most recent binary in workspace
      try {
        if (window.BinaryInspector && BinaryInspector.selectedFile) {
          const buf = await BinaryInspector.selectedFile.arrayBuffer();
          return { name: BinaryInspector.selectedFile.name || 'binary', mime: BinaryInspector.selectedFile.type || 'application/octet-stream', size: BinaryInspector.selectedFile.size || buf.byteLength || 0, buffer: buf };
        }
      } catch {}
      try {
        if (window.AppState && AppState.files) {
          const candidates = [];
          for (const f of AppState.files.values()) {
            if (f && f.binary && f.meta && f.meta.arrayBuffer) candidates.push(f);
          }
          if (candidates.length) {
            const f = candidates[candidates.length - 1];
            const ab = f.meta.arrayBuffer;
            return { name: f.path || f.name || 'binary', mime: (f.meta && f.meta.mime) || 'application/octet-stream', size: (f.meta && f.meta.size) || (ab && ab.byteLength) || 0, buffer: ab, file: f };
          }
        }
      } catch {}
      return null;
    },

    async extractBinaryIocs(args = {}) {
      const opts = (args && typeof args === 'object') ? args : {};
      const loaded = await this.getLoadedBinaryBuffer();
      if (!loaded || !loaded.buffer) {
        return { ok: false, error: 'No binary loaded. Load or select a binary in the Binary analyzer first.' };
      }
      const bytes = loaded.buffer instanceof Uint8Array ? loaded.buffer : new Uint8Array(loaded.buffer);
      const report = extractBinaryIOCs(bytes, { maxScan: opts.maxScan || 4 * 1024 * 1024 });
      report.source = { name: loaded.name, mime: loaded.mime, size: loaded.size || bytes.length };

      // Optionally carve embedded payloads and add as downloadable files into Workspace
      const wantCarve = !!(opts.carve || opts.carveEmbedded || opts.extractEmbedded || opts.saveCarved || (Array.isArray(opts.offsets) && opts.offsets.length));
      const carvedFiles = [];
      if (wantCarve) {
        let targets = Array.isArray(report.embedded) ? report.embedded.slice() : [];
        if (Array.isArray(opts.offsets) && opts.offsets.length) {
          const wanted = new Set(opts.offsets.map(n => Number(n)).filter(n => Number.isFinite(n) && n >= 0));
          targets = targets.filter(e => wanted.has(Number(e.offset)));
        }
        // if specific magic types requested
        if (opts.types && (Array.isArray(opts.types) || typeof opts.types === 'string')) {
          const types = new Set((Array.isArray(opts.types) ? opts.types : String(opts.types).split(',')).map(s => String(s).trim().toLowerCase()).filter(Boolean));
          if (types.size) targets = targets.filter(e => types.has(String(e.type || '').toLowerCase()) || types.has(String(e.ext || '').replace(/^\./,'').toLowerCase()));
        }
        const maxCarve = Math.max(0, Math.min(Number(opts.maxCarve || 10) || 10, 25));
        const carved = carveEmbeddedPayloads(bytes, targets, { maxCarve, maxSize: Number(opts.maxSize || 25 * 1024 * 1024) });
        for (let i = 0; i < carved.length; i++) {
          const c = carved[i];
          const baseName = `carved_${c.type || 'bin'}_${c.offset}${extForEmbedded(c)}`;
          const rec = makeDownloadableFileRecord(baseName, c.bytes, mimeForEmbedded(c));
          // Add carved bytes into Workspace as binary file (available for download via blob URL; stored in memory)
          try {
            const path = addFileToWorkspace(rec.name, `[Carved embedded payload]\nSource: ${report.source.name}\nType: ${c.label || c.type}\nOffset: ${c.offset} (0x${Number(c.offset).toString(16)})\nSize: ${c.size} bytes\n\n(Downloadable binary payload stored in workspace memory.)`, {
              dirty: false,
              binary: true,
              meta: { size: c.size, mime: rec.mime, arrayBuffer: c.bytes.buffer.slice(c.bytes.byteOffset, c.bytes.byteOffset + c.bytes.byteLength), carvedFrom: report.source.name, carvedOffset: c.offset, carvedType: c.type, downloadUrl: rec.downloadUrl }
            });
            rec.workspacePath = path || rec.name;
          } catch {}
          carvedFiles.push({ name: rec.name, workspacePath: rec.workspacePath || rec.name, type: c.type, label: c.label, offset: c.offset, endOffset: c.endOffset, size: c.size, mime: rec.mime, downloadUrl: rec.downloadUrl || null });
        }
        if (carvedFiles.length && window.AppState && AppState.emit) AppState.emit('workspace:changed');
      }

      const summary = {
        ok: true,
        source: report.source,
        scannedBytes: report.scannedBytes,
        totalBytes: report.totalBytes,
        counts: {
          urls: report.urls.length,
          ipv4: report.ipv4.length,
          registryPaths: report.registryPaths.length,
          filePaths: report.filePaths.length,
          embedded: report.embedded.length,
          carved: carvedFiles.length
        },
        urls: report.urls.slice(0, 200),
        ipv4: report.ipv4.slice(0, 200),
        registryPaths: report.registryPaths.slice(0, 200),
        filePaths: report.filePaths.slice(0, 200),
        embedded: report.embedded.slice(0, 200).map(e => ({ offset: e.offset, endOffset: e.endOffset, size: e.size, type: e.type, label: e.label, signatureHex: e.signatureHex })),
        carvedFiles
      };
      this.lastBinaryIocReport = summary;
      return summary;
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
          // Capped to 8000 chars total per binary to avoid oversized LLM payloads (e.g. 30MB+ exe)
          const summary = capBinaryContext(a.summary || a.text || '', 8000);
          if (summary) {
            parts.push('\n' + summary);
          } else {
            parts.push(`\n[Binary/Document file: ${a.name}${a.path ? ' (' + a.path + ')' : ''}]`);
            parts.push(`MIME: ${a.mime || 'unknown'}`);
            parts.push(`Size: ${a.size || 0} bytes (${fmtBytes(a.size || 0)})`);
            parts.push(`SHA-256: ${a.hash || '(unavailable)'}`);
            if (a.headerHex) parts.push(`Header bytes (hex): ${a.headerHex}`);
            if (a.stringsPreview) parts.push(capBinaryContext('Printable strings (sample):\n' + String(a.stringsPreview), 2000));
          }
        } else if (a.kind === 'image') {
          parts.push(`\n[Image attachment: ${a.name} | ${fmtBytes(a.size||0)} | ${a.mime||'image/*'}] (image provided as vision input)`);
        } else if (a.kind === 'binary-upload') {
          parts.push(`\n[Attached file: ${a.name} | ${fmtBytes(a.size||0)} | ${a.mime||'application/octet-stream'}]`);
          parts.push(`Filename: ${a.name}`);
          parts.push(`Size: ${fmtBytes(a.size||0)} (${a.size||0} bytes)`);
          if (a.uploaded) {
            parts.push(`Status: uploaded to remote runner${a.remotePath ? ` (path: ${a.remotePath})` : ''}.`);
            if (a.runnerUrl) parts.push(`Runner: ${a.runnerUrl}`);
            if (a.uploadResult && (a.uploadResult.stdout || a.uploadResult.path || a.uploadResult.message || a.uploadResult.savedAs)) {
              const detail = String(a.uploadResult.stdout || a.uploadResult.path || a.uploadResult.savedAs || a.uploadResult.message).slice(0, 800);
              parts.push(`Upload result: ${detail}`);
            }
          } else {
            parts.push(`Status: not uploaded to remote runner.`);
            parts.push(`Reason: ${a.uploadError || 'No remote HTTP runner configured/connected'}`);
          }
        } else {
          parts.push(`\n[Attachment: ${a.name || 'file'} | ${a.kind || 'file'} | ${fmtBytes(a.size||0)}]`);
        }
      }
      return parts.join('\n');
    }
  };

  // helpers exposed for other modules
  Workspace.summarizeBinaryBuffer = summarizeBinaryBuffer;
  Workspace.capBinaryContext = capBinaryContext;
  Workspace.extractPrintableStrings = extractPrintableStrings;
  Workspace.extractBinaryIOCs = extractBinaryIOCs;
  Workspace.carveEmbeddedPayloads = carveEmbeddedPayloads;
  window.Workspace = Workspace;
})();
