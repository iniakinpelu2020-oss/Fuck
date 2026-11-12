(function () {
  const BinaryInspector = {
    selectedFile: null,
    init() {
      const dz = document.getElementById('binaryDropZone');
      const input = document.getElementById('binaryFileInput');
      dz.addEventListener('click', () => input.click());
      dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('border-accent'); });
      dz.addEventListener('dragleave', () => dz.classList.remove('border-accent'));
      dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('border-accent'); if (e.dataTransfer.files[0]) this.setFile(e.dataTransfer.files[0]); });
      input.addEventListener('change', () => { if (input.files[0]) this.setFile(input.files[0]); });
      document.getElementById('btnAnalyzeBinary').addEventListener('click', () => this.analyze());
      document.getElementById('btnClearBinary').addEventListener('click', () => this.clear());
    },
    setFile(file) {
      this.selectedFile = file;
      document.getElementById('binaryOutput').textContent = `Selected: ${file.name} (${Utils.formatBytes(file.size)}, ${file.type || 'unknown type'})\nClick Analyze to inspect.`;
    },
    clear() {
      this.selectedFile = null;
      document.getElementById('binaryFileInput').value = '';
      document.getElementById('binaryOutput').textContent = '';
    },
    async analyze() {
      const out = document.getElementById('binaryOutput');
      if (!this.selectedFile) { Utils.toast('Select a binary/package first', 'error'); return; }
      const file = this.selectedFile;
      out.textContent = `Analyzing ${file.name}...\n`;
      try {
        const buf = await file.arrayBuffer();
        const bytes = new Uint8Array(buf);
        const lines = [];
        lines.push(`Name: ${file.name}`);
        lines.push(`Size: ${Utils.formatBytes(file.size)} (${file.size} bytes)`);
        lines.push(`MIME: ${file.type || 'unknown'}`);
        lines.push(`SHA-like fingerprint: ${Utils.hashString([...bytes.slice(0, 4096)].join(','))}-${file.size}`);
        const sig = this.detectSignature(bytes);
        lines.push(`Detected signature: ${sig.type}${sig.detail ? ' - ' + sig.detail : ''}`);
        lines.push('');

        if (sig.type === 'ZIP/APK/JAR/IPA' || /\.apk$|\.zip$|\.ipa$/i.test(file.name)) {
          lines.push(await this.inspectZip(buf, file.name));
        } else if (sig.type === 'PE/EXE/DLL' || /\.exe$/i.test(file.name)) {
          lines.push(this.inspectPe(bytes));
        } else if (sig.type === 'DMG/UDIF' || /\.dmg$/i.test(file.name)) {
          lines.push(this.inspectDmg(bytes, buf));
        } else {
          lines.push('No container-specific parser matched; performing generic inspection.');
        }

        lines.push('\n--- Extracted Strings (sample) ---');
        lines.push(this.extractStrings(bytes, 4, 300).join('\n') || '(none found)');
        lines.push('\n--- Hex Preview (first 256 bytes) ---');
        lines.push(this.hexPreview(bytes, 256));
        out.textContent = lines.join('\n');
        Utils.toast('Binary analysis complete', 'success');
      } catch (e) {
        out.textContent += `\nAnalysis failed: ${e.message}\n${e.stack || ''}`;
        Utils.toast(`Binary analysis failed: ${e.message}`, 'error');
      }
    },
    detectSignature(bytes) {
      const s4 = String.fromCharCode(...bytes.slice(0, 4));
      const s2 = String.fromCharCode(...bytes.slice(0, 2));
      if (s4 === 'PK\x03\x04') return { type: 'ZIP/APK/JAR/IPA', detail: 'ZIP local file header' };
      if (s2 === 'MZ') return { type: 'PE/EXE/DLL', detail: 'DOS MZ header' };
      // DMG often has 'koly' trailer at end (512 bytes block) or plist/xml; not fixed header
      const tail = String.fromCharCode(...bytes.slice(Math.max(0, bytes.length - 512)));
      if (tail.includes('koly')) return { type: 'DMG/UDIF', detail: 'UDIF koly trailer found' };
      if (s4 === 'xar!' || s4 === 'cafebabe'.slice(0,4)) return { type: 'Package/Binary', detail: `magic: ${s4}` };
      return { type: 'Unknown/Binary', detail: `head bytes: ${[...bytes.slice(0,8)].map(b=>b.toString(16).padStart(2,'0')).join(' ')}` };
    },
    async inspectZip(buf, name) {
      if (!window.JSZip) return 'JSZip not available; cannot inspect archive contents.';
      const zip = await JSZip.loadAsync(buf);
      const entries = Object.values(zip.files);
      const lines = [`Archive entries: ${entries.length}`];
      const interesting = ['AndroidManifest.xml', 'resources.arsc', 'classes.dex', 'META-INF/MANIFEST.MF', 'Info.plist', 'PackageInfo', 'app.asar', 'Contents/Info.plist'];
      let manifestText = null;
      for (const e of entries.slice(0, 200)) {
        lines.push(` - ${e.dir ? '[dir]' : '[file]'} ${e.name} ${e._data ? '' : ''}`);
      }
      if (entries.length > 200) lines.push(` ... (${entries.length - 200} more entries omitted)`);
      // try to read manifests
      const manifestNames = ['AndroidManifest.xml', 'META-INF/MANIFEST.MF', 'Info.plist', 'Contents/Info.plist', 'package.json', 'manifest.json'];
      for (const m of manifestNames) {
        const f = zip.file(m) || zip.file(m.toLowerCase()) || entries.find(e => e.name.endsWith('/'+m) || e.name === m);
        if (f && !f.dir) {
          try {
            if (m.endsWith('.xml') || m.endsWith('.MF') || m.endsWith('.plist') || m.endsWith('.json')) {
              const txt = await f.async('string');
              lines.push(`\n--- ${f.name} (preview) ---`);
              lines.push(txt.slice(0, 4000));
            } else {
              const u8 = await f.async('uint8array');
              lines.push(`\n--- ${f.name} binary preview ---`);
              lines.push(this.hexPreview(u8, 256));
            }
          } catch (e) { lines.push(`\n--- ${f.name} read error: ${e.message}`); }
        }
      }
      if (/\.apk$/i.test(name)) {
        const dexCount = entries.filter(e => /classes(\d+)?\.dex$/i.test(e.name)).length;
        const hasRes = entries.some(e => e.name === 'resources.arsc');
        lines.push(`\nAPK hints: dex files=${dexCount}, resources.arsc=${hasRes}, manifest=${entries.some(e=>/AndroidManifest\.xml$/.test(e.name))}`);
        lines.push('Note: AndroidManifest.xml/resources.arsc are often binary-encoded in release APKs; decompilation requires specialized tooling.');
      }
      return lines.join('\n');
    },
    inspectPe(bytes) {
      const lines = ['PE/EXE inspection:'];
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (bytes.length < 64) return 'File too small for PE headers.';
      const peOffset = dv.getUint32(60, true);
      lines.push(`DOS header e_lfanew (PE offset): ${peOffset}`);
      if (peOffset + 4 < bytes.length && String.fromCharCode(bytes[peOffset], bytes[peOffset+1]) === 'PE') {
        const machine = dv.getUint16(peOffset + 4, true);
        const sections = dv.getUint16(peOffset + 6, true);
        const time = dv.getUint32(peOffset + 8, true);
        const optMagic = peOffset + 24 < bytes.length ? dv.getUint16(peOffset + 24, true) : 0;
        lines.push(`PE signature: valid`);
        lines.push(`Machine: 0x${machine.toString(16)} ${machine===0x8664?'(x64)':machine===0x14c?'(x86)':machine===0xaa64?'(ARM64)':''}`);
        lines.push(`Sections: ${sections}`);
        lines.push(`Timestamp: ${time ? new Date(time*1000).toISOString() : 'n/a'}`);
        lines.push(`Optional header: ${optMagic===0x10b?'PE32':optMagic===0x20b?'PE32+':'unknown'}`);
        const secTable = peOffset + 24 + (peOffset + 20 < bytes.length ? dv.getUint16(peOffset + 20, true) : 0);
        lines.push('\nSection headers (sample):');
        for (let i=0; i<Math.min(sections, 16); i++) {
          const off = secTable + i*40;
          if (off + 40 > bytes.length) break;
          const name = [...bytes.slice(off, off+8)].map(b=>b>=32&&b<127?String.fromCharCode(b):'').join('');
          const vsize = dv.getUint32(off+8, true);
          const rawSize = dv.getUint32(off+16, true);
          lines.push(` - ${name || '(non-ascii)'} vsize=${vsize} raw=${rawSize}`);
        }
        const importsHint = this.extractStrings(bytes, 4, 120).filter(s => /(\.dll|kernel32|user32|libc|msvcrt|CreateFile|WinExec|http|https)/i.test(s)).slice(0, 40);
        if (importsHint.length) { lines.push('\nPossible imports/APIs/URLs (heuristic):'); lines.push(...importsHint.map(s=>' - '+s)); }
      } else {
        lines.push('PE signature not found at expected offset; may be packed or malformed.');
      }
      return lines.join('\n');
    },
    inspectDmg(bytes, buf) {
      const lines = ['DMG/UDIF inspection:'];
      lines.push('Apple disk images may contain UDIF metadata, APFS/HFS structures, or compressed blocks.');
      // UDIF koly trailer is 512 bytes at end
      if (bytes.length >= 512) {
        const off = bytes.length - 512;
        const sig = String.fromCharCode(...bytes.slice(off, off+4));
        lines.push(`Trailer signature: ${sig}`);
        if (sig === 'koly') {
          const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          const dataForkOffset = Number(dv.getBigUint64(off + 24, false));
          const dataForkLength = Number(dv.getBigUint64(off + 32, false));
          const xmlOffset = Number(dv.getBigUint64(off + 216, false));
          const xmlLength = Number(dv.getBigUint64(off + 224, false));
          lines.push(`Data fork offset/length: ${dataForkOffset} / ${dataForkLength}`);
          lines.push(`XML plist offset/length: ${xmlOffset} / ${xmlLength}`);
          if (xmlOffset + xmlLength <= bytes.length && xmlLength > 0 && xmlLength < 5*1024*1024) {
            try {
              const xml = new TextDecoder().decode(bytes.slice(xmlOffset, xmlOffset + xmlLength));
              lines.push('\n--- Embedded XML Plist (preview) ---');
              lines.push(xml.slice(0, 6000));
            } catch (e) { lines.push(`XML decode failed: ${e.message}`); }
          }
        }
      }
      const strings = this.extractStrings(bytes, 5, 80).filter(s => /Contents\/|Info\.plist|Library|Applications|Apple|APFS|HFS|\.app|pkg/i.test(s));
      if (strings.length) { lines.push('\nHeuristic resource strings:'); lines.push(...strings.slice(0,50).map(s=>' - '+s)); }
      lines.push('\nDeep filesystem extraction from DMG requires native tooling; this view provides signatures, metadata, and decompiled strings.');
      return lines.join('\n');
    },
    extractStrings(bytes, minLen = 4, limit = 200) {
      const out = [];
      let cur = [];
      for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        if (b >= 32 && b <= 126) cur.push(String.fromCharCode(b));
        else {
          if (cur.length >= minLen) { out.push(cur.join('')); if (out.length >= limit) return out; }
          cur = [];
        }
      }
      if (cur.length >= minLen && out.length < limit) out.push(cur.join(''));
      return out;
    },
    hexPreview(bytes, n = 256) {
      const slice = bytes.slice(0, Math.min(n, bytes.length));
      const rows = [];
      for (let i = 0; i < slice.length; i += 16) {
        const chunk = slice.slice(i, i + 16);
        const hex = [...chunk].map(b => b.toString(16).padStart(2, '0')).join(' ');
        const ascii = [...chunk].map(b => (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.').join('');
        rows.push(`${i.toString(16).padStart(8,'0')}  ${hex.padEnd(47,' ')}  ${ascii}`);
      }
      return rows.join('\n');
    }
  };
  window.BinaryInspector = BinaryInspector;
})();
