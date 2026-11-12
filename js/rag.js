(function () {
  const DB_NAME = 'aether-rag-db';
  const STORE = 'chunks';
  const DB_VER = 1;

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('path', 'path', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function withStore(mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      let result;
      Promise.resolve(fn(store)).then(r => { result = r; }).catch(reject);
      tx.oncomplete = () => { db.close(); resolve(result); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  }

  function tokenize(text) {
    return (text || '').toLowerCase().replace(/[^a-z0-9_\s]/g, ' ').split(/\s+/).filter(t => t.length > 1 && t.length < 40);
  }

  function vectorize(text) {
    const tokens = tokenize(text);
    const vec = Object.create(null);
    for (const t of tokens) vec[t] = (vec[t] || 0) + 1;
    // l2 norm
    let norm = 0; for (const k in vec) norm += vec[k] * vec[k]; norm = Math.sqrt(norm) || 1;
    return { vec, norm, count: tokens.length };
  }

  function cosine(a, b) {
    let dot = 0;
    const small = Object.keys(a.vec).length < Object.keys(b.vec).length ? a.vec : b.vec;
    const large = small === a.vec ? b.vec : a.vec;
    for (const k in small) if (large[k]) dot += small[k] * large[k];
    return dot / (a.norm * b.norm);
  }

  function chunkText(path, content, chunkSize = 1200, overlap = 200) {
    const text = String(content || '');
    const chunks = [];
    if (!text.trim()) return chunks;
    let i = 0, idx = 0;
    while (i < text.length) {
      const end = Math.min(text.length, i + chunkSize);
      const slice = text.slice(i, end);
      chunks.push({ id: `${path}::${idx}`, path, idx, content: slice, hash: Utils.hashString(slice) });
      if (end >= text.length) break;
      i = Math.max(0, end - overlap);
      idx++;
    }
    return chunks;
  }

  const RAG = {
    stats: { chunks: 0, files: 0, lastIndexed: null },
    init() {
      document.getElementById('btnRagReindex').addEventListener('click', () => this.indexWorkspace());
      document.getElementById('btnRagClear').addEventListener('click', () => this.clearIndex());
      document.getElementById('btnRagSearch').addEventListener('click', () => this.searchUI());
      this.refreshStats();
    },
    async clearIndex() {
      await withStore('readwrite', (store) => store.clear());
      this.stats = { chunks: 0, files: 0, lastIndexed: null };
      this.renderStats();
      document.getElementById('ragResults').textContent = '';
      Utils.toast('RAG index cleared', 'success');
    },
    async indexWorkspace() {
      const files = [...AppState.files.values()].filter(f => !f.binary && Utils.isTextLike(f.path));
      await this.clearIndex();
      let chunkCount = 0;
      await withStore('readwrite', (store) => {
        for (const file of files) {
          const chunks = chunkText(file.path, file.content || '');
          for (const c of chunks) {
            const v = vectorize(`${file.path}\n${c.content}`);
            store.put({ ...c, vec: v.vec, norm: v.norm });
            chunkCount++;
          }
        }
      });
      this.stats = { chunks: chunkCount, files: files.length, lastIndexed: new Date().toISOString() };
      this.renderStats();
      Utils.toast(`Indexed ${files.length} files / ${chunkCount} chunks`, 'success');
      return this.stats;
    },
    async refreshStats() {
      try {
        const all = await withStore('readonly', (store) => new Promise((resolve, reject) => {
          const req = store.getAll(); req.onsuccess = () => resolve(req.result || []); req.onerror = () => reject(req.error);
        }));
        const files = new Set(all.map(c => c.path));
        this.stats = { chunks: all.length, files: files.size, lastIndexed: this.stats.lastIndexed };
        this.renderStats();
      } catch { this.renderStats(); }
    },
    renderStats() {
      document.getElementById('ragStats').textContent = `Chunks: ${this.stats.chunks} | Files: ${this.stats.files}${this.stats.lastIndexed ? ' | Last: ' + this.stats.lastIndexed : ''}`;
    },
    async search(query, k = 6) {
      const q = vectorize(query || '');
      if (!q.count) return [];
      const all = await withStore('readonly', (store) => new Promise((resolve, reject) => {
        const req = store.getAll(); req.onsuccess = () => resolve(req.result || []); req.onerror = () => reject(req.error);
      }));
      const scored = all.map(c => {
        const score = cosine(q, { vec: c.vec || {}, norm: c.norm || 1 });
        // small keyword boost for path matches
        const boost = query && c.path.toLowerCase().includes(query.toLowerCase().split(/\s+/)[0] || '') ? 0.05 : 0;
        return { path: c.path, idx: c.idx, content: c.content, score: score + boost };
      }).filter(s => s.score > 0).sort((a,b) => b.score - a.score).slice(0, k);
      return scored;
    },
    async searchUI() {
      const q = document.getElementById('ragQueryInput').value.trim();
      if (!q) return;
      const res = await this.search(q, 10);
      const out = document.getElementById('ragResults');
      if (!res.length) { out.textContent = 'No relevant snippets found.'; return; }
      out.textContent = res.map((r,i) => `#${i+1} score=${r.score.toFixed(4)} ${r.path} [chunk ${r.idx}]\n${r.content}\n`).join('\n---\n\n');
    },
    async buildContext(query, k) {
      const limit = Number(k || AppState.settings.ragK || 6);
      const results = await this.search(query, limit);
      if (!results.length) return { text: '', results: [] };
      const text = results.map((r,i) => `[Context ${i+1}] ${r.path} (chunk ${r.idx}, score ${r.score.toFixed(3)})\n${r.content}`).join('\n\n');
      return { text, results };
    }
  };

  window.RAG = RAG;
})();
