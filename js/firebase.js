(function () {
  const firebaseConfig = {
    apiKey: "AIzaSyB6Q5jvZR2PjjhGji8MS0NR5msu6_gYJmY",
    authDomain: "apex-ai-studio-coder.firebaseapp.com",
    projectId: "apex-ai-studio-coder",
    storageBucket: "apex-ai-studio-coder.firebasestorage.app",
    messagingSenderId: "166973140410",
    appId: "1:166973140410:web:84963836033a0bdfadc183",
    measurementId: "G-N3J68636Z5"
  };

  const FB = {
    app: null, auth: null, db: null, user: null, ready: false,
    googleClientId: '88418113812-2eatncg73fvuqa8nl7cirjre155kfprs.apps.googleusercontent.com',
    _unsubChats: null, _unsubConfig: null, _syncing: false, _syncingConfig: false, _gisInitialized: false, _gisRendered: false,

    init() {
      try {
        if (!window.firebase) { console.warn('[Firebase] SDK not loaded'); return; }
        if (!firebase.apps || !firebase.apps.length) this.app = firebase.initializeApp(firebaseConfig);
        else this.app = firebase.app();
        this.auth = firebase.auth();
        this.db = firebase.firestore();
        try { this.db.enablePersistence({ synchronizeTabs: true }).catch(() => {}); } catch {}
        this.ready = true;
        this.auth.onAuthStateChanged((user) => this.onAuthStateChanged(user));
        this.bindAuthUI();
        this.initGoogleIdentity();
      } catch (e) { console.error('[Firebase] init failed', e); }
    },

    onAuthStateChanged(user) {
      this.user = user || null;
      this.updateAuthUI();
      if (this._unsubChats) { try { this._unsubChats(); } catch {} this._unsubChats = null; }
      if (this._unsubConfig) { try { this._unsubConfig(); } catch {} this._unsubConfig = null; }
      if (user) {
        this.mergeLocalToCloud().then(() => { this.subscribeChats(); this.subscribeConfig(); })
          .catch(e => console.error('[Firebase] merge/sync error', e));
      }
    },

    async mergeLocalToCloud() {
      if (!this.user || !this.db) return;
      const uid = this.user.uid;
      try {
        const sessions = Array.isArray(AppState.chatSessions) ? AppState.chatSessions : [];
        if (sessions.length) {
          for (const s of sessions) {
            if (!s || !s.id) continue;
            const ref = this.db.collection('users').doc(uid).collection('chats').doc(s.id);
            const snap = await ref.get();
            if (!snap.exists) await ref.set(this.sanitizeChatForCloud(s), { merge: true });
            else {
              const remote = snap.data() || {};
              if (Number(s.updatedAt || 0) > this.tsNum(remote.updatedAt)) await ref.set(this.sanitizeChatForCloud(s), { merge: true });
            }
          }
        }
        const cref = this.db.collection('users').doc(uid).collection('config').doc('settings');
        const csnap = await cref.get();
        if (!csnap.exists) await cref.set({ ...this.buildLocalConfig(), updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
        else this.applyCloudConfig(csnap.data() || {});
      } catch (e) { console.error('[Firebase] mergeLocalToCloud', e); }
    },

    sanitizeChatForCloud(s) {
      const msgs = Array.isArray(s.messages) ? s.messages.map(m => ({
        role: m.role || 'user', content: String(m.content == null ? '' : m.content),
        meta: m.meta || '', badges: Array.isArray(m.badges) ? m.badges.slice(0, 20) : [], ts: m.ts || Date.now()
      })).slice(-200) : [];
      return { id: s.id, title: String(s.title || 'New chat'), messages: msgs, createdAt: s.createdAt || Date.now(), updatedAt: s.updatedAt || Date.now(), pinned: !!s.pinned };
    },

    subscribeChats() {
      if (!this.user || !this.db) return;
      const uid = this.user.uid;
      this._unsubChats = this.db.collection('users').doc(uid).collection('chats').orderBy('updatedAt', 'desc').limit(100)
        .onSnapshot((snap) => {
          if (this._syncing) return;
          try {
            const remote = [];
            snap.forEach(doc => remote.push({ id: doc.id, ...(doc.data() || {}) }));
            if (!Array.isArray(AppState.chatSessions)) AppState.chatSessions = [];
            const byId = new Map(AppState.chatSessions.map(s => [s.id, s]));
            let changed = false;
            for (const r of remote) {
              const local = byId.get(r.id);
              const ru = this.tsNum(r.updatedAt), lu = local ? Number(local.updatedAt || 0) : 0;
              if (!local || ru >= lu) { byId.set(r.id, { ...(local||{}), ...this.normalizeChatFromCloud(r) }); changed = true; }
            }
            if (changed) {
              AppState.chatSessions = Array.from(byId.values()).sort((a,b)=>Number(b.updatedAt||0)-Number(a.updatedAt||0));
              if (typeof AppState.saveChatSessions === 'function') AppState.saveChatSessions();
              if (window.App && typeof App.renderChatHistory === 'function') App.renderChatHistory();
              // if active chat updated, reload view
              if (window.App && typeof App.loadActiveChat === 'function' && AppState.activeChatId) { try { App.loadActiveChat(); } catch {} }
            }
            for (const s of AppState.chatSessions) {
              const r = remote.find(x => x.id === s.id);
              if (!r || Number(s.updatedAt||0) > this.tsNum(r.updatedAt)) this.pushChat(s);
            }
          } catch (e) { console.error('[Firebase] chats snapshot', e); }
        }, (err) => console.error('[Firebase] chats snapshot error', err));
    },

    normalizeChatFromCloud(r) {
      return { id: r.id, title: String(r.title || 'New chat'), messages: Array.isArray(r.messages) ? r.messages : [], createdAt: this.tsNum(r.createdAt) || Date.now(), updatedAt: this.tsNum(r.updatedAt) || Date.now(), pinned: !!r.pinned };
    },
    tsNum(v) { if (!v) return 0; if (typeof v === 'number') return v; if (v.seconds) return v.seconds * 1000; if (v.toMillis) try { return v.toMillis(); } catch { return 0; } return Number(v) || 0; },

    async pushChat(session) {
      if (!this.user || !this.db || !session || !session.id) return;
      try { this._syncing = true; await this.db.collection('users').doc(this.user.uid).collection('chats').doc(session.id).set(this.sanitizeChatForCloud(session), { merge: true }); }
      catch (e) { console.error('[Firebase] pushChat', e); }
      finally { setTimeout(() => { this._syncing = false; }, 150); }
    },
    async deleteChat(chatId) {
      if (!this.user || !this.db || !chatId) return;
      try { await this.db.collection('users').doc(this.user.uid).collection('chats').doc(chatId).delete(); } catch (e) { console.error('[Firebase] deleteChat', e); }
    },

    buildLocalConfig() {
      const s = (AppState && AppState.settings) ? { ...AppState.settings } : {};
      return { settings: s, mcpServers: Array.isArray(AppState.mcpServers) ? AppState.mcpServers : [], vault: Array.isArray(AppState.vault) ? AppState.vault : [], apiKeys: Array.isArray(AppState.apiKeys) ? AppState.apiKeys : [], webhookUrl: s.webhookUrl || s.n8nWebhookUrl || 'https://drippydee.app.n8n.cloud/webhook/apex-agent', n8nAuthHeaderName: s.authHeaderName || '', n8nAuthHeaderValue: s.authHeaderValue || '' };
    },
    applyCloudConfig(d) {
      if (!d || typeof d !== 'object') return;
      try {
        if (d.settings && typeof d.settings === 'object') { AppState.settings = { ...(AppState.settings || {}), ...d.settings }; if (typeof AppState.saveSettings === 'function') try { localStorage.setItem('aether.settings.v1', JSON.stringify(AppState.settings)); } catch {} }
        if (Array.isArray(d.mcpServers) && d.mcpServers.length) { AppState.mcpServers = d.mcpServers; if (typeof AppState.saveMcp === 'function') try { localStorage.setItem('aether.mcp.v1', JSON.stringify(AppState.mcpServers)); } catch {} }
        if (Array.isArray(d.vault)) { AppState.vault = d.vault; try { localStorage.setItem('aether.vault.v1', JSON.stringify(AppState.vault)); } catch {} }
        if (Array.isArray(d.apiKeys)) { AppState.apiKeys = d.apiKeys; try { localStorage.setItem('aether.apikeys.v1', JSON.stringify(d.apiKeys)); } catch {} }
        this.ensureDefaultMcpServers();
      } catch (e) { console.error('[Firebase] applyCloudConfig', e); }
    },
    ensureDefaultMcpServers() {
      if (!Array.isArray(AppState.mcpServers)) AppState.mcpServers = [];
      const has = (u) => AppState.mcpServers.some(s => s && String(s.url||'').replace(/\/$/,'') === u.replace(/\/$/,''));
      let changed = false;
      if (!has('https://fuck.iniakinpelu2020.workers.dev')) { AppState.mcpServers.unshift({ name: 'apex-mcp', url: 'https://fuck.iniakinpelu2020.workers.dev', transport: 'http' }); changed = true; }
      if (!has('https://fuck.iniakinpelu2020.workers.dev/n8n-mcp')) { AppState.mcpServers.push({ name: 'n8n-mcp', url: 'https://fuck.iniakinpelu2020.workers.dev/n8n-mcp', transport: 'http' }); changed = true; }
      if (changed) try { localStorage.setItem('aether.mcp.v1', JSON.stringify(AppState.mcpServers)); } catch {}
    },
    subscribeConfig() {
      if (!this.user || !this.db) return;
      this._unsubConfig = this.db.collection('users').doc(this.user.uid).collection('config').doc('settings')
        .onSnapshot((snap) => {
          if (!snap.exists || this._syncingConfig) return;
          this.applyCloudConfig(snap.data() || {});
          if (window.App && typeof App.restoreSettingsUI === 'function') try { App.restoreSettingsUI(); } catch {}
          if (window.MCP && typeof MCP.render === 'function') try { MCP.render(); } catch {}
        }, (err) => console.error('[Firebase] config snapshot error', err));
    },
    async pushConfig() {
      if (!this.user || !this.db) return;
      try { this._syncingConfig = true; await this.db.collection('users').doc(this.user.uid).collection('config').doc('settings').set({ ...this.buildLocalConfig(), updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true }); }
      catch (e) { console.error('[Firebase] pushConfig', e); }
      finally { setTimeout(() => { this._syncingConfig = false; }, 200); }
    },

    bindAuthUI() {
      const btn = document.getElementById('btnAuth');
      if (btn) btn.addEventListener('click', () => { if (this.user) this.openAccountModal(); else this.openSignInModal(); });
      const closeSignIn = document.getElementById('btnCloseSignIn'); if (closeSignIn) closeSignIn.addEventListener('click', () => this.closeSignInModal());
      const signInModal = document.getElementById('signInModal'); if (signInModal) signInModal.addEventListener('click', (e) => { if (e.target.id === 'signInModal') this.closeSignInModal(); });
      const emailForm = document.getElementById('emailAuthForm'); if (emailForm) emailForm.addEventListener('submit', (e) => { e.preventDefault(); this.signInWithEmail(); });
      const signUpBtn = document.getElementById('btnEmailSignUp'); if (signUpBtn) signUpBtn.addEventListener('click', () => this.signUpWithEmail());
    },
    openSignInModal() {
      const m = document.getElementById('signInModal');
      if (m) { m.classList.remove('hidden'); m.classList.add('flex'); }
      this.initGoogleIdentity();
      this.renderGoogleButton();
    },
    closeSignInModal() { const m = document.getElementById('signInModal'); if (m) { m.classList.add('hidden'); m.classList.remove('flex'); } },
    openAccountModal() { if (confirm('Sign out of ' + ((this.user && (this.user.email || this.user.displayName)) || 'account') + '?')) this.signOut(); },

    initGoogleIdentity() {
      const tryInit = () => {
        if (this._gisInitialized) return true;
        if (!(window.google && google.accounts && google.accounts.id)) return false;
        try {
          google.accounts.id.initialize({
            client_id: this.googleClientId,
            ux_mode: 'popup',
            callback: (response) => this.handleGoogleCredentialResponse(response),
            auto_select: false,
            cancel_on_tap_outside: true
          });
          this._gisInitialized = true;
          this.renderGoogleButton();
          return true;
        } catch (e) {
          console.error('[Firebase] GIS init failed', e);
          return false;
        }
      };
      if (tryInit()) return;
      let attempts = 0;
      const timer = setInterval(() => {
        attempts++;
        if (tryInit() || attempts > 100) clearInterval(timer);
      }, 100);
      window.addEventListener('load', () => { tryInit(); this.renderGoogleButton(); }, { once: true });
    },

    renderGoogleButton() {
      const container = document.getElementById('googleGisButtonContainer') || document.getElementById('signInModal');
      if (!container || !(window.google && google.accounts && google.accounts.id)) return;
      if (container.id === 'signInModal') {
        // do not render into whole modal by mistake
        const inner = document.getElementById('googleGisButtonContainer');
        if (!inner) return;
      }
      const target = document.getElementById('googleGisButtonContainer');
      if (!target) return;
      try {
        const width = Math.max(240, Math.min((target.clientWidth || target.parentElement?.clientWidth || 320), 360));
        target.innerHTML = '';
        google.accounts.id.renderButton(target, {
          type: 'standard',
          theme: 'outline',
          size: 'large',
          text: 'continue_with',
          shape: 'rectangular',
          width
        });
        this._gisRendered = true;
      } catch (e) {
        console.error('[Firebase] GIS render failed', e);
      }
    },

    async handleGoogleCredentialResponse(response) {
      try {
        if (!response || !response.credential) throw new Error('No Google credential received');
        if (!this.auth) throw new Error('Firebase Auth not ready');
        const credential = firebase.auth.GoogleAuthProvider.credential(response.credential);
        await this.auth.signInWithCredential(credential);
        this.closeSignInModal();
        if (window.Utils) Utils.toast('Signed in with Google', 'success');
      } catch (e) {
        console.error('[Firebase] GIS sign-in failed', e);
        if (window.Utils) Utils.toast('Google sign-in failed: ' + (e && e.message ? e.message : e), 'error');
      }
    },

    async signInWithGoogle() {
      // Google sign-in is provided by Google Identity Services button in the sign-in modal.
      this.initGoogleIdentity();
      this.renderGoogleButton();
      if (!(window.google && google.accounts && google.accounts.id)) {
        if (window.Utils) Utils.toast('Google Sign-In is loading. Please try again.', 'info');
      }
    },
    async signInWithEmail() {
      if (!this.auth) return; const email = ((document.getElementById('authEmail')||{}).value||'').trim(); const pass = (document.getElementById('authPassword')||{}).value||'';
      try { await this.auth.signInWithEmailAndPassword(email, pass); this.closeSignInModal(); if (window.Utils) Utils.toast('Signed in', 'success'); } catch(e){ if(window.Utils) Utils.toast('Sign-in failed: '+(e.message||e),'error'); }
    },
    async signUpWithEmail() {
      if (!this.auth) return; const email = ((document.getElementById('authEmail')||{}).value||'').trim(); const pass = (document.getElementById('authPassword')||{}).value||'';
      try { await this.auth.createUserWithEmailAndPassword(email, pass); this.closeSignInModal(); if (window.Utils) Utils.toast('Account created', 'success'); } catch(e){ if(window.Utils) Utils.toast('Sign-up failed: '+(e.message||e),'error'); }
    },
    async signOut() { if (!this.auth) return; try { await this.auth.signOut(); if (window.Utils) Utils.toast('Signed out', 'info'); } catch(e){ console.error(e); } },
    updateAuthUI() {
      const label = document.getElementById('authLabel'); const avatar = document.getElementById('authAvatar'); const btn = document.getElementById('btnAuth');
      if (!btn) return;
      if (this.user) {
        const name = this.user.displayName || this.user.email || 'Account';
        if (label) label.textContent = (name.split('@')[0] || 'Account').slice(0, 18);
        if (avatar) { if (this.user.photoURL) avatar.innerHTML = `<img src="${this.user.photoURL}" alt="" class="w-full h-full rounded-full object-cover">`; else avatar.textContent = (name[0]||'U').toUpperCase(); }
        btn.title = 'Signed in as ' + name;
      } else {
        if (label) label.textContent = 'Sign In';
        if (avatar) avatar.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="w-4 h-4"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
        btn.title = 'Sign in to sync across devices';
      }
    }
  };
  window.FirebaseSync = FB;
})();
