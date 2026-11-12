(function () {
  const Integrations = {
    init() {
      document.getElementById('btnVaultSave').addEventListener('click', () => this.saveCredential());
      document.getElementById('btnVaultExport').addEventListener('click', () => this.exportVault());
      document.getElementById('btnVaultImport').addEventListener('click', () => this.importVault());
      this.render();
    },
    saveCredential() {
      const name = document.getElementById('vaultName').value.trim();
      const type = document.getElementById('vaultType').value.trim() || 'api_key';
      const url = document.getElementById('vaultUrl').value.trim();
      const secret = document.getElementById('vaultSecret').value.trim();
      if (!name || !secret) return Utils.toast('Integration name and secret/config required', 'error');
      const existingIdx = AppState.vault.findIndex(v => v.name.toLowerCase() === name.toLowerCase());
      const item = { id: existingIdx >= 0 ? AppState.vault[existingIdx].id : Utils.uid('cred'), name, type, url, secret, updatedAt: new Date().toISOString() };
      if (existingIdx >= 0) AppState.vault[existingIdx] = item; else AppState.vault.unshift(item);
      AppState.saveVault();
      document.getElementById('vaultName').value = '';
      document.getElementById('vaultType').value = '';
      document.getElementById('vaultUrl').value = '';
      document.getElementById('vaultSecret').value = '';
      this.render();
      Utils.toast('Credential saved locally', 'success');
    },
    deleteCredential(id) {
      AppState.vault = AppState.vault.filter(v => v.id !== id);
      AppState.saveVault();
      this.render();
    },
    getByName(name) {
      return AppState.vault.find(v => v.name.toLowerCase() === String(name||'').toLowerCase()) || null;
    },
    exportVault() {
      Utils.download('aether-vault.json', JSON.stringify(AppState.vault, null, 2));
      Utils.toast('Vault exported (contains secrets)', 'success');
    },
    async importVault() {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = '.json,application/json';
      inp.onchange = async () => {
        const file = inp.files[0]; if (!file) return;
        try {
          const txt = await file.text();
          const data = Utils.safeJsonParse(txt, null);
          if (!Array.isArray(data)) throw new Error('Invalid vault format');
          AppState.vault = data;
          AppState.saveVault();
          this.render();
          Utils.toast('Vault imported', 'success');
        } catch (e) { Utils.toast(`Import failed: ${e.message}`, 'error'); }
      };
      inp.click();
    },
    render() {
      const list = document.getElementById('vaultList');
      list.innerHTML = '';
      if (!AppState.vault.length) {
        list.innerHTML = '<div class="text-gray-500">No credentials stored.</div>';
        return;
      }
      for (const v of AppState.vault) {
        const card = document.createElement('div');
        card.className = 'border border-border rounded p-2';
        card.innerHTML = `
          <div class="flex items-center justify-between gap-2">
            <div>
              <div class="font-medium text-gray-200">${Utils.escapeHtml(v.name)}</div>
              <div class="text-[11px] text-gray-400">${Utils.escapeHtml(v.type || 'api_key')} ${v.url ? '• ' + Utils.escapeHtml(v.url) : ''}</div>
            </div>
            <div class="flex gap-1">
              <button data-act="copy" class="px-2 py-0.5 rounded bg-gray-700 hover:bg-gray-600">Copy</button>
              <button data-act="delete" class="px-2 py-0.5 rounded bg-gray-800 hover:bg-gray-700 text-red-300">Delete</button>
            </div>
          </div>
          <div class="text-[11px] text-gray-500 mt-1">Updated ${Utils.escapeHtml(v.updatedAt || '')}</div>`;
        card.querySelector('[data-act="copy"]').addEventListener('click', async () => {
          try { await navigator.clipboard.writeText(v.secret || ''); Utils.toast('Secret copied', 'success'); }
          catch { Utils.toast('Clipboard unavailable', 'error'); }
        });
        card.querySelector('[data-act="delete"]').addEventListener('click', () => this.deleteCredential(v.id));
        list.appendChild(card);
      }
    }
  };
  window.Integrations = Integrations;
})();
