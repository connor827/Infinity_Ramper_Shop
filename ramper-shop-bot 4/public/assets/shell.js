/* =========================================================================
   Dashboard shell — shared across every /dashboard page.
   Exposes globals: API, Shell, Toast, Fmt, Auth.
   ========================================================================= */
(() => {
  'use strict';

  const TOKEN_KEY = 'ramper_token';
  const THEME_KEY = 'ramper_theme';

  /* --- Theme handling ------------------------------------------------- */
  const savedTheme = localStorage.getItem(THEME_KEY) || 'dark';
  document.documentElement.dataset.theme = savedTheme;

  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
    const btn = document.getElementById('theme-toggle');
    if (btn) btn.textContent = theme === 'dark' ? '☾' : '☀';
  }

  /* --- Auth ----------------------------------------------------------- */
  const Auth = {
    get token() { return localStorage.getItem(TOKEN_KEY); },
    set token(v) { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); },
    require() {
      if (!this.token) {
        window.location.href = '/';
        return false;
      }
      return true;
    },
    logout() {
      this.token = null;
      window.location.href = '/';
    },
  };

  /* --- API ------------------------------------------------------------ */
  const API = async (method, path, body) => {
    const headers = { 'content-type': 'application/json' };
    if (Auth.token) headers.authorization = 'Bearer ' + Auth.token;
    const res = await fetch('/api' + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) { Auth.logout(); throw new Error('Session expired'); }
    const text = await res.text();
    const data = text ? safeJson(text) : null;
    if (!res.ok) {
      const msg = data && typeof data.error === 'string'
        ? data.error
        : `${method} ${path} — ${res.status}`;
      throw new Error(msg);
    }
    return data;
  };

  function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

  /* --- Toast ---------------------------------------------------------- */
  const Toast = {
    show(msg, kind = 'ok', ms = 3200) {
      let root = document.getElementById('toast-root');
      if (!root) {
        root = document.createElement('div');
        root.id = 'toast-root';
        document.body.appendChild(root);
      }
      const t = document.createElement('div');
      t.className = 'toast ' + (kind === 'err' ? 'err' : 'ok');
      t.textContent = msg;
      root.appendChild(t);
      setTimeout(() => { t.style.transition = 'opacity 200ms ease'; t.style.opacity = '0'; }, ms - 200);
      setTimeout(() => t.remove(), ms);
    },
    ok(msg) { this.show(msg, 'ok'); },
    err(msg) { this.show(msg, 'err'); },
  };

  /* --- Formatting helpers --------------------------------------------- */
  const Fmt = {
    money(amount, currency) {
      const n = Number(amount);
      if (!isFinite(n)) return '—';
      return `${currency || 'USD'} ${n.toFixed(2)}`;
    },
    moneySplit(amount, currency) {
      const n = Number(amount);
      if (!isFinite(n)) return { ccy: '—', val: '' };
      return { ccy: currency || 'USD', val: n.toFixed(2) };
    },
    date(d) {
      if (!d) return '—';
      const dt = new Date(d);
      if (isNaN(dt.getTime())) return '—';
      return dt.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    },
    dateTime(d) {
      if (!d) return '—';
      const dt = new Date(d);
      if (isNaN(dt.getTime())) return '—';
      return dt.toLocaleString(undefined, {
        day: 'numeric', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
    },
    relative(d) {
      if (!d) return '—';
      const dt = new Date(d);
      const diffMs = Date.now() - dt.getTime();
      const mins = Math.floor(diffMs / 60000);
      if (mins < 1) return 'just now';
      if (mins < 60) return `${mins}m ago`;
      const hrs = Math.floor(mins / 60);
      if (hrs < 24) return `${hrs}h ago`;
      const days = Math.floor(hrs / 24);
      if (days < 14) return `${days}d ago`;
      return this.date(d);
    },
    escape(s) {
      return String(s).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
      );
    },
  };

  /* --- Shell renderer -------------------------------------------------- */
  const NAV = [
    { href: '/dashboard',            label: 'Overview',  match: /^\/dashboard\/?$/ },
    { href: '/dashboard/orders',     label: 'Orders',    match: /^\/dashboard\/orders/ },
    { href: '/dashboard/products',   label: 'Products',  match: /^\/dashboard\/products/ },
    { href: '/dashboard/customers',  label: 'Customers', match: /^\/dashboard\/customers/ },
    { href: '/dashboard/bot',        label: 'Bot',       match: /^\/dashboard\/bot/ },
    { href: '/dashboard/settings',   label: 'Settings',  match: /^\/dashboard\/settings/ },
  ];

  const Shell = {
    render({ crumbs = [], actions = '' } = {}) {
      const path = window.location.pathname;
      const navHtml = NAV.map(item => {
        const active = item.match.test(path);
        return `<a class="nav-item ${active ? 'active' : ''}" href="${item.href}">
          <span class="dot"></span>${item.label}
        </a>`;
      }).join('');

      const crumbHtml = crumbs.length === 0
        ? ''
        : crumbs.map((c, i) => {
            const last = i === crumbs.length - 1;
            const sep = i > 0 ? '<span class="sep">/</span>' : '';
            return sep + (last
              ? `<span class="current">${Fmt.escape(c.label)}</span>`
              : c.href
                ? `<a href="${c.href}">${Fmt.escape(c.label)}</a>`
                : `<span>${Fmt.escape(c.label)}</span>`);
          }).join('');

      const shell = document.createElement('div');
      shell.className = 'shell';
      shell.innerHTML = `
        <aside class="sidebar">
          <div class="brand-wrap">
            <a href="/dashboard" class="brand-logo" aria-label="Infinity Ramper">
              <img src="/assets/logo-dark.svg" alt="Infinity Ramper" class="brand-logo-dark"/>
              <img src="/assets/logo-light.svg" alt="Infinity Ramper" class="brand-logo-light"/>
            </a>
          </div>
          <nav>${navHtml}</nav>
          <div class="footer">
            <div id="shell-store-name">—</div>
            <div id="shell-store-slug" class="faint">loading</div>
          </div>
        </aside>
        <header class="topbar">
          <div class="crumbs">${crumbHtml}</div>
          <div class="actions">
            ${actions}
            <button class="btn-ghost" id="theme-toggle" title="Toggle theme" style="padding:6px 10px;border-radius:100px;border:1px solid var(--border);font-size:14px;cursor:pointer;background:transparent;color:var(--ink-light)">☾</button>
            <button class="btn-ghost" id="logout-btn">Log out</button>
          </div>
        </header>
        <main class="main" id="main-content"></main>`;

      const pageRoot = document.getElementById('page') || document.body;
      pageRoot.innerHTML = '';
      pageRoot.appendChild(shell);

      document.getElementById('theme-toggle').onclick = () => {
        const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        setTheme(next);
      };
      document.getElementById('logout-btn').onclick = () => Auth.logout();

      // Populate store name from /me
      API('GET', '/me').then(me => {
        document.getElementById('shell-store-name').textContent = me.store_name || '—';
        document.getElementById('shell-store-slug').textContent = me.store_slug ? '@' + me.store_slug : '';
      }).catch(() => {});

      setTheme(document.documentElement.dataset.theme);
      return document.getElementById('main-content');
    },
  };

  // Expose
  window.API = API;
  window.Auth = Auth;
  window.Shell = Shell;
  window.Toast = Toast;
  window.Fmt = Fmt;
})();
