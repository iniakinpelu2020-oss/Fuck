(function () {
  const BinaryInspector = {
    selectedFile: null,
    init() {
      const dz = document.getElementById('binaryDropZone');
      const input = document.getElementById('binaryFileInput');
      if (dz) dz.addEventListener('click', () => input && input.click());
      if (dz) dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('border-accent'); });
      if (dz) dz.addEventListener('dragleave', () => dz.classList.remove('border-accent'));
      if (dz) dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('border-accent'); if (e.dataTransfer.files && e.dataTransfer.files[0]) this.setFile(e.dataTransfer.files[0]); });
      if (input) input.addEventListener('change', () => { if (input.files && input.files[0]) this.setFile(input.files[0]); });
      const btnAnalyze = document.getElementById('btnAnalyzeBinary');
      if (btnAnalyze) btnAnalyze.addEventListener('click', () => this.analyze());
      const btnRea = document.getElementById('btnAnalyzeBinaryREA');
      if (btnRea) btnRea.addEventListener('click', async () => {
        if (window.App && typeof App.analyzeSelectedBinaryWithREA === 'function') {
          await App.analyzeSelectedBinaryWithREA();
        } else {
          Utils.toast('REA analyzer unavailable', 'error');
        }
      });
      const btnClear = document.getElementById('btnClearBinary');
      if (btnClear) btnClear.addEventListener('click', () => this.clear());
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
      let elfInfo = null;
      let parsedSections = [];
      let parsedOverlay = null;

      if (sig.type === 'ZIP/APK/JAR/IPA' || /\.apk$|\.zip$|\.ipa$|\.jar$/i.test(target.name)) {
        lines.push(await this.inspectZip(buf, target.name));
      } else if (sig.type === 'PE/EXE/DLL' || /\.exe$|\.dll$/i.test(target.name)) {
        peInfo = this.inspectPe(bytes);
        parsedSections = peInfo.sections || [];
        parsedOverlay = peInfo.overlay || null;
        if (peInfo.sectionFlags && peInfo.sectionFlags.length) {
          lines.push('\n--- PE Section Size Flags ---');
          for (const f of peInfo.sectionFlags) {
            lines.push(`⚠ ${f.name}: raw=${f.rawSize} bytes (${f.pct.toFixed(1)}% of file) — likely contains embedded archive, installer, or packed payload`);
          }
          lines.push('');
        }
        lines.push(peInfo.text);
      } else if (sig.type === 'ELF' || /\.elf$|\.so$/i.test(target.name)) {
        elfInfo = this.inspectElf(bytes);
        parsedSections = elfInfo.sections || [];
        parsedOverlay = elfInfo.overlay || null;
        lines.push(elfInfo.text);
      } else if (sig.type === 'DMG/UDIF' || /\.dmg$/i.test(target.name)) {
        lines.push(this.inspectDmg(bytes, buf));
      } else {
        lines.push('No container-specific parser matched; performing generic inspection.');
      }

      // Deep scan for Go and PE/ELF binaries: full ArrayBuffer, with emphasis on .symtab/.rdata/.data
      const isElf = sig.type === 'ELF' || /\.elf$|\.so$/i.test(target.name);
      const isPe = sig.type === 'PE/EXE/DLL' || /\.exe$|\.dll$/i.test(target.name);
      const deepEligible = isElf || isPe;
      // detect Go indicators from quick sample
      let isGo = false;
      try {
        const sampleStr = new TextDecoder('latin1').decode(bytes.slice(0, Math.min(bytes.length, 2 * 1024 * 1024)));
        if (/Go build ID|go\.buildid|runtime\.main|runtime\.goexit|main\.main/.test(sampleStr)) isGo = true;
      } catch {}
      // also consider .gopclntab / __go_buildinfo sections
      if (this.getSectionByName(parsedSections, ['.gopclntab', '__gopclntab', '.noptrdata', '.go.buildinfo', '__go_buildinfo', '.note.go.buildid'])) isGo = true;

      if (deepEligible || isGo) {
        lines.push('\n=== Deep Binary Scan (full ArrayBuffer: .symtab / .rdata / .data emphasized) ===');
        const highlightNames = ['.symtab', '.strtab', '.dynsym', '.dynstr', '.rdata', '.rodata', '.data', '.data.rel.ro', '__data', '__rodata'];
        const highlighted = (parsedSections || []).filter(sec => highlightNames.includes(String(sec.name || '').toLowerCase()));
        if (highlighted.length) {
          lines.push('Highlighted sections scanned:');
          for (const sec of highlighted) {
            lines.push(` - ${sec.name}: offset=0x${Number(sec.offset||0).toString(16)} size=${Number(sec.size||0)} bytes`);
          }
        } else if (parsedSections && parsedSections.length) {
          lines.push('Highlighted sections (.symtab/.rdata/.data) not present by name; full ArrayBuffer scanned.');
        } else {
          lines.push('Section table unavailable; full ArrayBuffer scanned.');
        }
        lines.push(`Full buffer scan coverage: 0x0 - 0x${bytes.length.toString(16)} (${bytes.length} bytes)`);
        lines.push(`Format: ${isElf ? 'ELF' : (isPe ? 'PE' : (sig.type || 'unknown'))}${isGo ? ' (Go indicators detected)' : ''}`);

        // 1) Go Project Symbol Extraction
        if (isGo || isElf || isPe) {
          const goSyms = this.extractGoProjectSymbols(bytes);
          if (isGo || goSyms.length) {
            lines.push('\n--- Go Project Symbol Extraction (main.* and custom non-stdlib Go package paths) ---');
            lines.push('Filters excluded: runtime., reflect., syscall., internal/, fmt., os., time., sync., strconv., unicode.');
            if (goSyms.length) {
              lines.push(`Top ${goSyms.length} unique project symbols:`);
              for (let i = 0; i < goSyms.length; i++) lines.push(` ${String(i+1).padStart(2,' ')}. ${goSyms[i]}`);
            } else {
              lines.push('Top 0 unique project symbols: (none found)');
            }
          }
        }

        // 2) Embedded Archive & Payload Carving Scan (.data + overlay)
        if (isElf || isPe) {
          lines.push('\n--- Embedded Archive & Payload Carving Scan (.data section and overlay) ---');
          const carving = await this.scanDataAndOverlayForMagics(bytes, buf, parsedSections, parsedOverlay);
          lines.push(carving.text);
          lines.push('\nFirst 25 printable strings immediately following the .data section start:');
          if (carving.firstStringsAfterDataStart && carving.firstStringsAfterDataStart.length) {
            for (const s of carving.firstStringsAfterDataStart) lines.push(' - ' + s);
          } else if (carving.dataSection) {
            lines.push(' - (none found)');
          } else {
            lines.push(' - (.data section not identified)');
          }
        }
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
      if (bytes.length >= 4 && bytes[0] === 0x7F && bytes[1] === 0x45 && bytes[2] === 0x4C && bytes[3] === 0x46) {
        const cls = bytes[4] === 2 ? 'ELF64' : (bytes[4] === 1 ? 'ELF32' : 'ELF');
        const endian = bytes[5] === 1 ? 'LE' : (bytes[5] === 2 ? 'BE' : '');
        return { type: 'ELF', detail: [cls, endian].filter(Boolean).join(' ') || 'ELF header' };
      }
      if (s4 === 'PK\x03\x04') return { type: 'ZIP/APK/JAR/IPA', detail: 'ZIP local file header' };
      if (s2 === 'MZ') return { type: 'PE/EXE/DLL', detail: 'DOS MZ header' };
      const tail = String.fromCharCode(...bytes.slice(Math.max(0, bytes.length - 512)));
      if (tail.includes('koly')) return { type: 'DMG/UDIF', detail: 'UDIF koly trailer found' };
      if (s4 === 'xar!') return { type: 'Package/Binary', detail: 'magic: xar!' };
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
      const sections = [];
      let overlay = null;
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (bytes.length < 64) return { text: 'File too small for PE headers.', sectionFlags, sections, overlay, format: 'PE' };
      const peOffset = dv.getUint32(60, true);
      lines.push(`DOS header e_lfanew (PE offset): ${peOffset}`);
      if (peOffset + 4 < bytes.length && String.fromCharCode(bytes[peOffset], bytes[peOffset+1]) === 'PE') {
        const machine = dv.getUint16(peOffset + 4, true);
        const numSections = dv.getUint16(peOffset + 6, true);
        const time = dv.getUint32(peOffset + 8, true);
        const optSize = peOffset + 20 < bytes.length ? dv.getUint16(peOffset + 20, true) : 0;
        const optMagic = peOffset + 24 < bytes.length ? dv.getUint16(peOffset + 24, true) : 0;
        lines.push(`PE signature: valid`);
        lines.push(`Machine: 0x${machine.toString(16)} ${machine===0x8664?'(x64)':machine===0x14c?'(x86)':machine===0xaa64?'(ARM64)':''}`);
        lines.push(`Sections: ${numSections}`);
        lines.push(`Timestamp: ${time ? new Date(time*1000).toISOString() : 'n/a'}`);
        lines.push(`Optional header: ${optMagic===0x10b?'PE32':optMagic===0x20b?'PE32+':'unknown'}`);
        const secTable = peOffset + 24 + optSize;
        let lastSectionEnd = 0;
        lines.push('\nSection headers:');
        for (let i=0; i<numSections; i++) {
          const off = secTable + i*40;
          if (off + 40 > bytes.length) break;
          let name = '';
          for (let j = 0; j < 8; j++) { const b = bytes[off + j]; if (!b) break; name += (b >= 32 && b < 127) ? String.fromCharCode(b) : '?'; }
          name = name || '(non-ascii)';
          const vsize = dv.getUint32(off+8, true);
          const rawSize = dv.getUint32(off+16, true);
          const rawPtr = dv.getUint32(off+20, true);
          const pct = bytes.length ? (rawSize / bytes.length) * 100 : 0;
          sections.push({ name, vsize, rawSize, rawPtr, index: i });
          const end = rawPtr + rawSize;
          if (end > lastSectionEnd) lastSectionEnd = end;
          lines.push(` - ${name} vsize=${vsize} raw=${rawSize} rawPtr=0x${rawPtr.toString(16)} (${pct.toFixed(1)}% of file)`);
          if ((/\.data|\.rsrc/i.test(name)) && pct > 50) {
            sectionFlags.push({ name, rawSize, pct });
          }
        }
        if (lastSectionEnd > 0 && lastSectionEnd < bytes.length) {
          overlay = { name: 'overlay', offset: lastSectionEnd, size: bytes.length - lastSectionEnd };
          lines.push(`\nOverlay: offset=0x${overlay.offset.toString(16)} size=${overlay.size} bytes`);
        }
        const importsHint = this.extractStrings(bytes, 7, 200).strings.filter(s => /(\.dll\b|kernel32|user32|advapi32|ws2_32|wininet|msvcrt|CreateFile|WinExec|VirtualAlloc|CreateRemoteThread|InternetOpen|ShellExecute|RegSetValue)/i.test(s)).slice(0, 40);
        if (importsHint.length) { lines.push('\nPossible imports/APIs/URLs (heuristic):'); lines.push(...importsHint.map(s=>' - '+s)); }
      } else {
        lines.push('PE signature not found at expected offset; may be packed or malformed.');
      }
      return { text: lines.join('\n'), sectionFlags, sections, overlay, format: 'PE' };
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
    inspectElf(bytes) {
      const lines = ['ELF inspection:'];
      const sections = [];
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (bytes.length < 52 || bytes[0] !== 0x7F || bytes[1] !== 0x45 || bytes[2] !== 0x4C || bytes[3] !== 0x46) {
        return { text: 'Not a valid ELF file.', sections, overlay: null, format: 'ELF' };
      }
      const cls = bytes[4]; // 1=32,2=64
      const dataEnc = bytes[5]; // 1=LE,2=BE
      const le = dataEnc !== 2;
      const u16 = (o) => (o + 2 <= bytes.length ? dv.getUint16(o, le) : 0);
      const u32 = (o) => (o + 4 <= bytes.length ? dv.getUint32(o, le) : 0);
      const u64 = (o) => {
        if (o + 8 > bytes.length) return 0;
        if (typeof dv.getBigUint64 === 'function') {
          const v = dv.getBigUint64(o, le);
          return v > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(v);
        }
        const lo = dv.getUint32(o, le), hi = dv.getUint32(o + 4, le);
        return le ? (hi * 0x100000000 + lo) : (lo * 0x100000000 + hi);
      };
      const is64 = cls === 2;
      const ehdrSize = is64 ? 64 : 52;
      if (bytes.length < ehdrSize) return { text: 'ELF header truncated.', sections, overlay: null, format: 'ELF' };
      const eType = u16(16);
      const eMachine = u16(18);
      const eShoff = is64 ? u64(40) : u32(32);
      const eShentsize = is64 ? u16(58) : u16(46);
      const eShnum = is64 ? u16(60) : u16(48);
      const eShstrndx = is64 ? u16(62) : u16(50);
      const typeMap = { 1: 'REL', 2: 'EXEC', 3: 'DYN', 4: 'CORE' };
      const machMap = { 3: 'x86', 40: 'ARM', 62: 'x86-64', 183: 'AArch64', 243: 'RISC-V' };
      lines.push(`Class: ${is64 ? 'ELF64' : 'ELF32'} ${le ? 'LE' : 'BE'}`);
      lines.push(`Type: ${typeMap[eType] || ('0x' + eType.toString(16))}`);
      lines.push(`Machine: ${machMap[eMachine] || ('0x' + eMachine.toString(16))}`);
      lines.push(`Section headers: ${eShnum} @ 0x${eShoff.toString(16)} (entsize=${eShentsize}, shstrndx=${eShstrndx})`);

      let shstr = null;
      if (eShoff && eShentsize && eShstrndx < eShnum) {
        const shOff = eShoff + eShstrndx * eShentsize;
        if (shOff + eShentsize <= bytes.length) {
          const strOff = is64 ? u64(shOff + 24) : u32(shOff + 16);
          const strSize = is64 ? u64(shOff + 32) : u32(shOff + 20);
          if (strOff + strSize <= bytes.length && strSize > 0) {
            shstr = bytes.slice(strOff, strOff + strSize);
          }
        }
      }
      const readName = (idx) => {
        if (!shstr || idx >= shstr.length) return '';
        let end = idx;
        while (end < shstr.length && shstr[end] !== 0) end++;
        let name = '';
        for (let i = idx; i < end; i++) { const b = shstr[i]; name += (b >= 32 && b < 127) ? String.fromCharCode(b) : ''; }
        return name;
      };

      let lastEnd = 0;
      if (eShoff && eShentsize) {
        lines.push('\nSection headers:');
        for (let i = 0; i < eShnum; i++) {
          const off = eShoff + i * eShentsize;
          if (off + eShentsize > bytes.length) break;
          const nameIdx = u32(off);
          const shType = u32(off + 4);
          const shOffset = is64 ? u64(off + 24) : u32(off + 16);
          const shSize = is64 ? u64(off + 32) : u32(off + 20);
          const name = readName(nameIdx) || `[idx:${nameIdx}]`;
          sections.push({ name, type: shType, offset: shOffset, size: shSize, index: i });
          const end = shOffset + shSize;
          if (shType !== 8 /* SHT_NOBITS */ && end > lastEnd && shOffset < bytes.length) lastEnd = end;
          const pct = bytes.length ? (shSize / bytes.length) * 100 : 0;
          lines.push(` - ${name} type=${shType} offset=0x${shOffset.toString(16)} size=${shSize} (${pct.toFixed(1)}% of file)`);
        }
      }
      let overlay = null;
      if (lastEnd > 0 && lastEnd < bytes.length) {
        overlay = { name: 'overlay', offset: lastEnd, size: bytes.length - lastEnd };
        lines.push(`\nOverlay: offset=0x${overlay.offset.toString(16)} size=${overlay.size} bytes`);
      }
      return { text: lines.join('\n'), sections, overlay, format: 'ELF' };
    },

    scanStringsInRange(bytes, start, end, minLen = 4, limit = Infinity) {
      const out = [];
      const s = Math.max(0, start | 0);
      const e = Math.min(bytes.length, end == null ? bytes.length : end | 0);
      let cur = [];
      let curStart = s;
      for (let i = s; i < e; i++) {
        const b = bytes[i];
        if (b >= 32 && b <= 126) {
          if (!cur.length) curStart = i;
          cur.push(String.fromCharCode(b));
        } else {
          if (cur.length >= minLen) {
            out.push({ text: cur.join(''), offset: curStart });
            if (out.length >= limit) return out;
          }
          cur = [];
        }
      }
      if (cur.length >= minLen && out.length < limit) out.push({ text: cur.join(''), offset: curStart });
      return out;
    },

    extractGoProjectSymbols(bytes) {
      const runs = this.scanStringsInRange(bytes, 0, bytes.length, 4, 200000);
      const excludePrefixes = ['runtime.', 'reflect.', 'syscall.', 'internal/', 'fmt.', 'os.', 'time.', 'sync.', 'strconv.', 'unicode.'];
      const excludeContains = ['go:buildid', 'go.buildid'];
      const seen = new Set();
      const out = [];
      const isExcluded = (sym) => {
        for (const p of excludePrefixes) { if (sym.startsWith(p)) return true; }
        for (const c of excludeContains) { if (sym.includes(c)) return true; }
        // also filter runtime/internal/... forms
        if (/^runtime\/internal\//.test(sym)) return true;
        if (/^vendor\//.test(sym)) return false; // vendor can be project-related; keep
        return false;
      };
      const isLikelySymbol = (s) => {
        if (!s || s.length < 4 || s.length > 300) return false;
        if (/\s/.test(s)) return false;
        // main.* functions
        if (/^main\.[A-Za-z0-9_]+/.test(s)) return true;
        // package path symbols like github.com/x/y.Func or pkg.Func with dot path
        if (!/[.\/]/.test(s)) return false;
        // must look like go symbol path: segments with dot method/func at end or (*T).M
        if (!/\.[A-Za-z0-9_()\*\[\],.-]+$/.test(s) && !/^main\./.test(s)) return false;
        // avoid obvious non-symbols
        if (/^https?:\/\//i.test(s)) return false;
        if (/^[A-Za-z]:\\/.test(s)) return false;
        return true;
      };
      for (const r of runs) {
        const s = r.text;
        // direct symbol candidates
        if (isLikelySymbol(s) && !isExcluded(s)) {
          if (!seen.has(s)) { seen.add(s); out.push(s); }
        }
        // sometimes symbols embedded; try to find main.xxx inside longer runs? keep conservative
        if (/main\.[A-Za-z0-9_]+/.test(s)) {
          const m = s.match(/main\.[A-Za-z0-9_.*()\[\],-]+/g);
          if (m) for (const x of m) { if (!isExcluded(x) && !seen.has(x)) { seen.add(x); out.push(x); } }
        }
      }
      // prefer main.* and shorter/cleaner symbols, keep stable-ish order
      out.sort((a, b) => {
        const am = a.startsWith('main.') ? 0 : 1;
        const bm = b.startsWith('main.') ? 0 : 1;
        if (am !== bm) return am - bm;
        return a.length - b.length || a.localeCompare(b);
      });
      return out.slice(0, 40);
    },

    getSectionByName(sections, names) {
      const list = Array.isArray(names) ? names : [names];
      const lower = list.map(n => String(n).toLowerCase());
      return (sections || []).find(sec => lower.includes(String(sec.name || '').toLowerCase())) || null;
    },

    async scanDataAndOverlayForMagics(bytes, buf, sections, overlay) {
      const lines = [];
      const dataSec = this.getSectionByName(sections, ['.data', '__data', 'DATA']);
      const ranges = [];
      if (dataSec && dataSec.offset < bytes.length && dataSec.size > 0) {
        ranges.push({ name: dataSec.name || '.data', start: Math.max(0, dataSec.offset), end: Math.min(bytes.length, dataSec.offset + dataSec.size) });
      }
      if (overlay && overlay.offset < bytes.length && overlay.size > 0) {
        ranges.push({ name: 'overlay', start: Math.max(0, overlay.offset), end: Math.min(bytes.length, overlay.offset + overlay.size) });
      }
      // if no .data/overlay found, we still can report that; but request says scan .data section (and overlay)
      if (!ranges.length) {
        lines.push('No .data section or overlay region identified; embedded payload magic scan over .data/overlay not performed.');
        lines.push('(Full-buffer scan was still performed for other analyses.)');
        return { text: lines.join('\n'), firstStringsAfterDataStart: [] };
      }

      const sigs = [
        { name: 'ZIP', bytes: [0x50, 0x4B, 0x03, 0x04] },
        { name: 'GZIP', bytes: [0x1F, 0x8B, 0x08] },
        { name: '7-Zip', bytes: [0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C] },
        { name: 'Zstandard', bytes: [0x28, 0xB5, 0x2F, 0xFD] },
        { name: 'Embedded PE', bytes: [0x4D, 0x5A] },
      ];
      const matches = [];
      const matchAt = (i, pat) => {
        if (i + pat.length > bytes.length) return false;
        for (let j = 0; j < pat.length; j++) if (bytes[i + j] !== pat[j]) return false;
        return true;
      };
      for (const r of ranges) {
        // byte-by-byte scan
        for (let i = r.start; i < r.end; i++) {
          for (const sig of sigs) {
            if (matchAt(i, sig.bytes)) {
              matches.push({ sig: sig.name, offset: i, region: r.name });
            }
          }
        }
      }

      // dedupe identical (sig,offset)
      const seenM = new Set();
      const uniqMatches = [];
      for (const m of matches) {
        const k = m.sig + '@' + m.offset;
        if (seenM.has(k)) continue;
        seenM.add(k);
        uniqMatches.push(m);
      }

      lines.push('Scanned regions (byte-by-byte) for embedded magic signatures:');
      for (const r of ranges) lines.push(` - ${r.name}: start=0x${r.start.toString(16)} (${r.start}) end=0x${r.end.toString(16)} (${r.end}) size=${r.end - r.start} bytes`);
      lines.push('');
      if (!uniqMatches.length) {
        lines.push('Embedded magic matches: (none found)');
      } else {
        lines.push(`Embedded magic matches (${uniqMatches.length}):`);
        for (const m of uniqMatches.slice(0, 200)) {
          lines.push(` - [${m.sig}] offset=0x${m.offset.toString(16)} (${m.offset}) region=${m.region}`);
          if (m.sig === 'ZIP') {
            // try to list internal filenames from embedded ZIP
            let zipInfo = 'JSZip not loaded or listing unavailable';
            if (window.JSZip) {
              try {
                const slice = (buf && typeof buf.slice === 'function') ? buf.slice(m.offset) : bytes.slice(m.offset).buffer;
                const zip = await JSZip.loadAsync(slice);
                const names = Object.values(zip.files).map(f => (f.dir ? '[dir] ' : '[file] ') + f.name).slice(0, 200);
                if (!names.length) zipInfo = 'ZIP parsed but contains no entries';
                else {
                  zipInfo = 'embedded ZIP entries (' + Object.keys(zip.files).length + '):\n' + names.map(n => '     * ' + n).join('\n');
                  if (Object.keys(zip.files).length > 200) zipInfo += '\n     * ... (' + (Object.keys(zip.files).length - 200) + ' more)';
                }
              } catch (e) {
                zipInfo = 'embedded ZIP parse/list failed: ' + (e && e.message ? e.message : e);
              }
            }
            lines.push(`   embedded ZIP listing: ${zipInfo.includes('\n') ? '\n' + zipInfo : zipInfo}`);
          }
        }
        if (uniqMatches.length > 200) lines.push(` - ... (${uniqMatches.length - 200} more matches omitted)`);
      }

      // first 25 printable strings immediately following the .data section start
      let firstStrings = [];
      if (dataSec && dataSec.offset < bytes.length) {
        const runs = this.scanStringsInRange(bytes, dataSec.offset, bytes.length, 4, 25);
        firstStrings = runs.map(r => `0x${r.offset.toString(16)}: ${r.text}`);
      }

      return { text: lines.join('\n'), firstStringsAfterDataStart: firstStrings, dataSection: dataSec || null, ranges };
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
