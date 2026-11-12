(function () {
  const Utils = {
    uid(prefix = 'id') {
      return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
    },
    escapeHtml(str = '') {
      return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    },
    debounce(fn, wait = 300) {
      let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
    },
    pathJoin(...parts) {
      return parts.filter(Boolean).join('/').replace(/\/+/g, '/').replace(/^\.\//, '');
    },
    dirname(path) {
      const i = path.lastIndexOf('/'); return i === -1 ? '' : path.slice(0, i);
    },
    basename(path) { return path.split('/').pop() || path; },
    ext(path) { const b = Utils.basename(path); const i = b.lastIndexOf('.'); return i === -1 ? '' : b.slice(i + 1).toLowerCase(); },
    detectLang(path) {
      const e = Utils.ext(path);
      return ({ js:'javascript', mjs:'javascript', cjs:'javascript', ts:'typescript', tsx:'typescript', jsx:'javascript', py:'python', html:'html', htm:'html', css:'css', json:'json', md:'markdown', sh:'bash', bash:'bash', yml:'yaml', yaml:'yaml', rs:'rust', go:'go', c:'c', cpp:'cpp', h:'c', java:'java', txt:'plaintext' })[e] || 'plaintext';
    },
    isTextLike(name) {
      const e = Utils.ext(name);
      return ['js','mjs','cjs','ts','tsx','jsx','py','html','htm','css','json','md','txt','sh','bash','yml','yaml','xml','svg','rs','go','c','cpp','h','hpp','java','kt','swift','rb','php','sql','toml','ini','env','gitignore'].includes(e) || !e;
    },
    toast(msg, type = 'info', timeout = 3200) {
      const c = document.getElementById('toastContainer');
      if (!c) return;
      const d = document.createElement('div');
      d.className = `toast ${type}`;
      d.textContent = msg;
      c.appendChild(d);
      setTimeout(() => { d.remove(); }, timeout);
    },
    async readFileAsArrayBuffer(file) { return await file.arrayBuffer(); },
    async readFileAsText(file) { return await file.text(); },
    download(filename, content, type = 'application/json') {
      const blob = new Blob([content], { type });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = filename; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    },
    clamp(n, min, max) { return Math.max(min, Math.min(max, n)); },
    safeJsonParse(str, fallback = null) { try { return JSON.parse(str); } catch { return fallback; } },
    formatBytes(bytes) {
      if (!Number.isFinite(bytes)) return 'n/a';
      const units = ['B','KB','MB','GB']; let i=0, n=bytes;
      while (n>=1024 && i<units.length-1) { n/=1024; i++; }
      return `${n.toFixed(i?2:0)} ${units[i]}`;
    },
    hashString(str) {
      let h = 2166136261; for (let i=0;i<str.length;i++) { h ^= str.charCodeAt(i); h += (h<<1)+(h<<4)+(h<<7)+(h<<8)+(h<<24); }
      return (h>>>0).toString(16);
    },
    sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
  };
  window.Utils = Utils;
})();
