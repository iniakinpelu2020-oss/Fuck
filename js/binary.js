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
      this.lastAnalysis = null;
      const out = document.getElementById('binaryOutput');
      if (out) out.textContent = `Selected: ${file.name} (${Utils.formatBytes(file.size)}, ${file.type || 'unknown type'})\nAnalyzing automatically...`;
      // Auto-parse loaded binary so agent has live context
      this.analyze().catch(() => {});
    },
    clear() {
      this.selectedFile = null;
      this.lastAnalysis = null;
      const inp = document.getElementById('binaryFileInput'); if (inp) inp.value = '';
      const out = document.getElementById('binaryOutput'); if (out) out.textContent = '';
    },
    async analyze() {
      const out = document.getElementById('binaryOutput');
      if (!this.selectedFile) { Utils.toast('Select a binary/package first', 'error'); return null; }
      const file = this.selectedFile;
      if (out) out.textContent = `Analyzing ${file.name}...\n`;
      try {
        const text = await this.analyzeToText(file);
        if (out) out.textContent = text;
        Utils.toast('Binary analysis complete', 'success');
        return text;
      } catch (e) {
        const msg = `Analysis failed: ${e.message}\n${e.stack || ''}`;
        if (out) out.textContent += `\n${msg}`;
        Utils.toast(`Binary analysis failed: ${e.message}`, 'error');
        throw e;
      }
    },

    async analyzeToText(file) {
      const target = file || this.selectedFile;
      if (!target) throw new Error('No binary file selected');
      const buf = await target.arrayBuffer();
      const bytes = new Uint8Array(buf);
      const lines = [];
      lines.push(`Name: ${target.name}`);
      lines.push(`Size: ${Utils.formatBytes(target.size)} (${target.size} bytes)`);
      lines.push(`MIME: ${target.type || 'unknown'}`);
      lines.push(`SHA-like fingerprint: ${Utils.hashString([...bytes.slice(0, 4096)].join(','))}-${target.size}`);
      const sig = this.detectSignature(bytes);
      lines.push(`Detected signature: ${sig.type}${sig.detail ? ' - ' + sig.detail : ''}`);
      lines.push('');

      let peInfo = null;
      if (sig.type === 'ZIP/APK/JAR/IPA' || /\.apk$|\.zip$|\.ipa$/i.test(target.name)) {
        lines.push(await this.inspectZip(buf, target.name));
      } else if (sig.type === 'PE/EXE/DLL' || /\.exe$/i.test(target.name)) {
        peInfo = this.inspectPe(bytes);
        if (peInfo.sectionFlags && peInfo.sectionFlags.length) {
          lines.push('\n--- PE Section Size Flags ---');
          for (const f of peInfo.sectionFlags) {
            lines.push(`⚠ ${f.name}: raw=${f.rawSize} bytes (${f.pct.toFixed(1)}% of file) — likely contains embedded archive, installer, or packed payload`);
          }
          lines.push('');
        }
        lines.push(peInfo.text);
      } else if (sig.type === 'DMG/UDIF' || /\.dmg$/i.test(target.name)) {
        lines.push(this.inspectDmg(bytes, buf));
      } else {
        lines.push('No container-specific parser matched; performing generic inspection.');
      }

      const extracted = this.extractStrings(bytes, 7, 1200);
      const findings = this.categorizeFindings(extracted.strings);
      lines.push('\n=== Interesting Findings ===');
      lines.push(this.renderFindings(findings));
      if (extracted.filteredNoise) {
        lines.push(`(Filtered ${extracted.filteredNoise} noisy/repetitive strings such as repeated-byte patterns and short register-like fragments.)`);
      }

      lines.push('\n--- Extracted Strings (sample, >= 7 chars, noise filtered) ---');
      lines.push(extracted.strings.slice(0, 300).join('\n') || '(none found)');
      lines.push('\n--- Hex Preview (first 256 bytes) ---');
      lines.push(this.hexPreview(bytes, 256));
      const text = lines.join('\n');
      this.lastAnalysis = { name: target.name, text, at: Date.now() };
      return text;
    },
    detectSignature(bytes) {
      const s4 = String.fromCharCode(...bytes.slice(0, 4));
      const s2 = String.fromCharCode(...bytes.slice(0, 2));
      if (s4 === 'PK\x03\x04') return { type: 'ZIP/APK/JAR/IPA', detail: 'ZIP local file header' };
      if (s2 === 'MZ') return { type: 'PE/EXE/DLL', detail: 'DOS MZ header' };
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
      for (const e of entries.slice(0, 200)) {
        lines.push(` - ${e.dir ? '[dir]' : '[file]'} ${e.name}`);
      }
      if (entries.length > 200) lines.push(` ... (${entries.length - 200} more entries omitted)`);
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
      const sectionFlags = [];
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (bytes.length < 64) return { text: 'File too small for PE headers.', sectionFlags };
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
          const name = [...bytes.slice(off, off+8)].map(b=>b>=32&&b<127?String.fromCharCode(b):'').join('').replace(/\0/g,'') || '(non-ascii)';
          const vsize = dv.getUint32(off+8, true);
          const rawSize = dv.getUint32(off+16, true);
          const pct = bytes.length ? (rawSize / bytes.length) * 100 : 0;
          lines.push(` - ${name} vsize=${vsize} raw=${rawSize} (${pct.toFixed(1)}% of file)`);
          if ((/\.data|\.rsrc/i.test(name)) && pct > 50) {
            sectionFlags.push({ name, rawSize, pct });
          }
        }
        const importsHint = this.extractStrings(bytes, 7, 200).strings.filter(s => /(\.dll\b|kernel32|user32|advapi32|ws2_32|wininet|msvcrt|CreateFile|WinExec|VirtualAlloc|CreateRemoteThread|InternetOpen|ShellExecute|RegSetValue)/i.test(s)).slice(0, 40);
        if (importsHint.length) { lines.push('\nPossible imports/APIs/URLs (heuristic):'); lines.push(...importsHint.map(s=>' - '+s)); }
      } else {
        lines.push('PE signature not found at expected offset; may be packed or malformed.');
      }
      return { text: lines.join('\n'), sectionFlags };
    },
    inspectDmg(bytes, buf) {
      const lines = ['DMG/UDIF inspection:'];
      lines.push('Apple disk images may contain UDIF metadata, APFS/HFS structures, or compressed blocks.');
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
      const strings = this.extractStrings(bytes, 7, 120).strings.filter(s => /Contents\/|Info\.plist|Library|Applications|Apple|APFS|HFS|\.app|pkg/i.test(s));
      if (strings.length) { lines.push('\nHeuristic resource strings:'); lines.push(...strings.slice(0,50).map(s=>' - '+s)); }
      lines.push('\nDeep filesystem extraction from DMG requires native tooling; this view provides signatures, metadata, and decompiled strings.');
      return lines.join('\n');
    },
    isNoisyString(s) {
      if (!s || s.length < 7) return true;
      // repetitive single char or two-char patterns: UUUUUUUU, 33333333, ABABABAB
      if (/^(.)\1{6,}$/.test(s)) return true;
      if (/^(..)\1{3,}$/.test(s)) return true;
      // very low character diversity for long strings
      const uniq = new Set(s).size;
      if (s.length >= 8 && uniq <= 2) return true;
      // mostly punctuation/symbols or base64-like padding runs
      if (/^[A-Za-z0-9+/=]{8,}$/.test(s) && /=/.test(s) && uniq <= 8) return true;
      // common short register/noise fragments (x86-ish) if mostly non-word
      if (/^[A-Za-z0-9$@%]{7,8}$/.test(s) && !/[aeiou]{2,}/i.test(s) && !/[A-Z][a-z]{3,}/.test(s) && /[$@%]/.test(s)) return true;
      return false;
    },
    extractStrings(bytes, minLen = 7, limit = 300) {
      const out = [];
      let cur = [];
      let filteredNoise = 0;
      for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        if (b >= 32 && b <= 126) cur.push(String.fromCharCode(b));
        else {
          if (cur.length >= minLen) {
            const s = cur.join('');
            if (this.isNoisyString(s)) filteredNoise++; else { out.push(s); if (out.length >= limit) return { strings: out, filteredNoise }; }
          }
          cur = [];
        }
      }
      if (cur.length >= minLen && out.length < limit) {
        const s = cur.join('');
        if (this.isNoisyString(s)) filteredNoise++; else out.push(s);
      }
      return { strings: out, filteredNoise };
    },
    categorizeFindings(strings) {
      const cats = {
        urls: new Set(),
        paths: new Set(),
        compiler: new Set(),
        sensitiveApis: new Set()
      };
      for (const s of strings) {
        if (/(https?:\/\/|wss?:\/\/)[^\s"'<>]+/i.test(s)) {
          const m = s.match(/(https?:\/\/|wss?:\/\/)[^\s"'<>]+/ig);
          if (m) m.forEach(x => cats.urls.add(x));
        }
        // file paths & registry keys
        if (/[A-Za-z]:\\[^\s"'<>|*?]{3,}/.test(s) || /\\Software\\[^\s"'<>]+/i.test(s) || /\\Users\\|\\Program Files\\|\\Windows\\/i.test(s) || /\.(dll|exe|sys|json|plist|apk|dmg|pkg|so|dylib)\b/i.test(s)) {
          const m = s.match(/[A-Za-z]:\\[^\s"'<>|*?]+|\\Software\\[^\s"'<>]+|\/[^\s"'<>]{4,}\.(dll|exe|sys|json|plist|apk|dmg|pkg|so|dylib)|[^\s"'<>]+\\[^\s"'<>]+/ig);
          if (m) m.forEach(x => { if (x.length >= 7) cats.paths.add(x); });
          else if (s.length < 160) cats.paths.add(s);
        }
        // compiler/runtime signatures
        if (/Go build ID|Go buildinf|GCC:\s*|clang version|rustc\s|\.NET|MSVC|UPX!|UPX0|UPX1|PyInstaller|Electron|Node\.js|java\/lang|dalvik/i.test(s)) {
          cats.compiler.add(s.length > 180 ? s.slice(0, 180) + '…' : s);
        }
        // sensitive/network/process Windows APIs and related
        if (/\b(VirtualAlloc|VirtualAllocEx|VirtualProtect|CreateRemoteThread|WriteProcessMemory|NtCreateThreadEx|InternetOpen|InternetConnect|HttpSendRequest|WinHttpOpen|URLDownloadToFile|ShellExecute|WinExec|CreateProcess|RegSetValue|RegCreateKey|RegOpenKey|LoadLibrary|GetProcAddress|WSAStartup|connect|socket)\b/i.test(s)) {
          cats.sensitiveApis.add(s.length > 180 ? s.slice(0, 180) + '…' : s);
        }
      }
      return cats;
    },
    renderFindings(cats) {
      const section = (title, set) => {
        const arr = [...set].slice(0, 40);
        if (!arr.length) return `${title}\n  - (none found)`;
        const more = set.size > arr.length ? `\n  - ... (+${set.size - arr.length} more)` : '';
        return `${title}\n${arr.map(x => `  - ${x}`).join('\n')}${more}`;
      };
      return [
        section('URLs & Endpoints (http://, https://, ws://, wss://)', cats.urls),
        '',
        section('File Paths & Registry Keys (C:\\, \\Software\\, .dll/.exe/.json, etc.)', cats.paths),
        '',
        section('Compiler / Runtime Signatures (Go build ID, GCC, rustc, UPX, PyInstaller, Electron)', cats.compiler),
        '',
        section('Sensitive / Network / Process Windows APIs (VirtualAlloc, CreateRemoteThread, InternetOpen, ShellExecute, RegSetValue, etc.)', cats.sensitiveApis),
      ].join('\n');
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
