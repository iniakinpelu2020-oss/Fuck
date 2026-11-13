(function () {
  const FileTree = {
    init() {
      document.getElementById('btnOpenFolder').addEventListener('click', () => this.openFolder());
      document.getElementById('btnNewFile').addEventListener('click', () => this.newFilePrompt());
      document.getElementById('btnDeleteFile').addEventListener('click', () => this.deleteActive());
      document.getElementById('btnSaveFile').addEventListener('click', () => this.saveActiveFile());
      AppState.subscribe((evt) => {
        if (['workspace:changed','workspace:reset','file:changed','file:active'].includes(evt)) this.render();
      });
      this.render();
    },

    render() {
      const root = document.getElementById('fileTree');
      root.innerHTML = '';
      const tree = this.buildTree();
      const frag = document.createDocumentFragment();
      const title = document.createElement('div');
      title.className = 'tree-title';
      const dot = document.createElement('span');
      dot.style.cssText = 'width:7px;height:7px;border-radius:999px;background:#6366f1;box-shadow:0 0 0 3px rgba(99,102,241,0.15);display:inline-block;';
      const label = document.createElement('span');
      label.textContent = AppState.rootHandle ? `Local: ${AppState.workspaceName}` : `Workspace: ${AppState.workspaceName}`;
      title.appendChild(dot); title.appendChild(label);
      frag.appendChild(title);
      if (!tree.children.length && AppState.files.size === 0) {
        const empty = document.createElement('div');
        empty.className = 'text-xs text-gray-500 px-2 py-3 text-center';
        empty.textContent = 'No files yet. Open a folder or create a file.';
        frag.appendChild(empty);
      } else {
        this.renderNode(tree, frag, 0);
      }
      root.appendChild(frag);
      const ws = document.getElementById('workspaceLabel');
      if (ws) ws.textContent = AppState.workspaceName || 'Workspace';
      const mirror = document.getElementById('workspaceLabelMirror');
      if (mirror) mirror.textContent = AppState.workspaceName || 'Workspace';
    },

    buildTree() {
      const root = { name: '', path: '', type: 'dir', children: [] };
      const dirMap = new Map([[ '', root ]]);
      const ensureDir = (path) => {
        if (dirMap.has(path)) return dirMap.get(path);
        const parentPath = Utils.dirname(path);
        const parent = ensureDir(parentPath);
        const node = { name: Utils.basename(path), path, type: 'dir', children: [] };
        parent.children.push(node); dirMap.set(path, node); return node;
      };
      for (const d of AppState.dirs) { if (d) ensureDir(d); }
      for (const f of AppState.files.values()) {
        const parent = ensureDir(Utils.dirname(f.path));
        parent.children.push({ name: Utils.basename(f.path), path: f.path, type: 'file' });
      }
      const sortRec = (n) => {
        n.children.sort((a,b) => (a.type===b.type ? a.name.localeCompare(b.name) : a.type==='dir'?-1:1));
        n.children.forEach(sortRec);
      };
      sortRec(root);
      return root;
    },

    iconFor(name, type) {
      if (type === 'dir') return '▸';
      const ext = Utils.ext(name);
      const map = { js:'JS', mjs:'JS', cjs:'JS', ts:'TS', tsx:'TS', jsx:'JS', py:'PY', html:'HT', css:'CS', json:'{}', md:'MD', sh:'SH', yml:'YM', yaml:'YM', go:'GO', rs:'RS', txt:'TX' };
      return map[ext] || '•';
    },

    renderNode(node, container, depth) {
      for (const child of node.children) {
        const row = document.createElement('div');
        row.className = `file-node ${child.type} ${AppState.activeFilePath===child.path?'active':''}`;
        row.style.paddingLeft = `${6 + depth * 12}px`;
        row.title = child.path || child.name;

        const icon = document.createElement('span');
        icon.className = 'file-icon';
        icon.style.cssText = 'font-size:10px;opacity:0.85;min-width:1.15rem;display:inline-flex;align-items:center;justify-content:center;color:#818cf8;';
        icon.textContent = this.iconFor(child.name, child.type);

        const name = document.createElement('span');
        name.className = 'file-label';
        name.textContent = child.name;

        row.appendChild(icon);
        row.appendChild(name);

        if (child.type === 'file') {
          const ext = Utils.ext(child.name) || 'file';
          const badge = document.createElement('span');
          badge.className = 'file-badge';
          badge.textContent = ext.length > 4 ? ext.slice(0,4) : ext;
          row.appendChild(badge);
          row.addEventListener('click', () => AppState.setActiveFile(child.path));
        } else {
          row.addEventListener('click', () => {
            row.classList.toggle('collapsed');
            const wrap = row.nextElementSibling;
            if (wrap && wrap.classList.contains('file-indent')) wrap.classList.toggle('hidden');
          });
        }
        container.appendChild(row);
        if (child.type === 'dir') {
          const wrap = document.createElement('div');
          wrap.className = 'file-indent';
          this.renderNode(child, wrap, depth + 1);
          container.appendChild(wrap);
        }
      }
    },

    async openFolder() {
      if (!window.showDirectoryPicker) {
        Utils.toast('Directory Picker API not supported. Using in-memory workspace.', 'error');
        return;
      }
      try {
        const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
        AppState.resetWorkspaceMemory();
        AppState.rootHandle = handle;
        AppState.workspaceName = handle.name || 'Local Folder';
        await this.readDirectoryRecursive(handle, '');
        const first = AppState.files.keys().next().value;
        if (first) AppState.setActiveFile(first);
        AppState.emit('workspace:changed');
        Utils.toast(`Opened folder: ${AppState.workspaceName}`, 'success');
      } catch (e) {
        if (e.name !== 'AbortError') Utils.toast(`Failed to open folder: ${e.message}`, 'error');
      }
    },

    async readDirectoryRecursive(dirHandle, basePath) {
      AppState.ensureDir(basePath);
      for await (const [name, handle] of dirHandle.entries()) {
        if (name === '.git' || name === 'node_modules') continue;
        const path = basePath ? `${basePath}/${name}` : name;
        if (handle.kind === 'directory') {
          AppState.ensureDir(path);
          await this.readDirectoryRecursive(handle, path);
        } else if (handle.kind === 'file') {
          try {
            const file = await handle.getFile();
            if (Utils.isTextLike(name) && file.size < 1024 * 1024) {
              const content = await file.text();
              AppState.upsertFile(path, content, { handle, dirty: false, binary: false });
            } else {
              AppState.upsertFile(path, `[Binary or large file: ${Utils.formatBytes(file.size)}]`, { handle, dirty: false, binary: true, meta: { size: file.size, type: file.type } });
            }
          } catch (e) {
            AppState.upsertFile(path, `/* Failed to read file: ${e.message} */`, { handle, dirty: false, binary: false });
          }
        }
      }
    },

    async newFilePrompt() {
      const path = prompt('Enter new file path (relative):', 'src/new-file.js');
      if (!path) return;
      const clean = path.replace(/^\/+/, '').trim();
      if (!clean) return;
      if (AppState.files.has(clean) && !confirm('File exists. Overwrite?')) return;
      AppState.upsertFile(clean, '', { dirty: true, binary: false });
      AppState.setActiveFile(clean);
      AppState.emit('workspace:changed');
      if (AppState.rootHandle) await this.saveActiveFile(true);
      Utils.toast(`Created ${clean}`, 'success');
    },

    async deleteActive() {
      const path = AppState.activeFilePath;
      if (!path) return Utils.toast('No active file selected', 'error');
      if (!confirm(`Delete ${path}?`)) return;
      AppState.deletePath(path);
      AppState.emit('workspace:changed');
      Utils.toast(`Removed ${path} from workspace (local disk item not deleted)`, 'info');
    },

    async saveActiveFile(silent = false) {
      const file = AppState.getActiveFile();
      if (!file) { if (!silent) Utils.toast('No active file', 'error'); return; }
      try {
        if (file.handle && file.handle.createWritable) {
          const writable = await file.handle.createWritable();
          await writable.write(file.content ?? '');
          await writable.close();
          file.dirty = false;
          AppState.emit('file:changed', { path: file.path });
          if (!silent) Utils.toast(`Saved ${file.path}`, 'success');
          return true;
        }
        if (AppState.rootHandle) {
          const handle = await this.ensureFileHandle(file.path);
          if (handle) {
            const writable = await handle.createWritable();
            await writable.write(file.content ?? '');
            await writable.close();
            file.handle = handle; file.dirty = false;
            AppState.emit('file:changed', { path: file.path });
            if (!silent) Utils.toast(`Saved ${file.path}`, 'success');
            return true;
          }
        }
        file.dirty = false;
        AppState.exportMemoryWorkspace();
        AppState.emit('file:changed', { path: file.path });
        if (!silent) Utils.toast('Saved in browser memory workspace', 'success');
        return true;
      } catch (e) {
        if (!silent) Utils.toast(`Save failed: ${e.message}`, 'error');
        return false;
      }
    },

    async ensureFileHandle(path) {
      if (!AppState.rootHandle) return null;
      const parts = path.split('/').filter(Boolean);
      let dir = AppState.rootHandle;
      for (let i = 0; i < parts.length - 1; i++) {
        dir = await dir.getDirectoryHandle(parts[i], { create: true });
      }
      return await dir.getFileHandle(parts[parts.length - 1], { create: true });
    }
  };

  window.FileTree = FileTree;
})();
