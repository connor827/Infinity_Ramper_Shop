/* =========================================================================
   Admin shell — shared across every /admin page.
   Isolated from merchant shell: different token key, different API base.
   Exposes globals: AdminAPI, AdminAuth, AdminShell, AdminToast, Fmt.
   ========================================================================= */
(() => {
  'use strict';

  const TOKEN_KEY = 'ramper_admin_token';
  const THEME_KEY = 'ramper_admin_theme';

  // --- Theme ----------------------------------------------------------
  const savedTheme = localStorage.getItem(THEME_KEY) || 'dark';
  document.documentElement.dataset.theme = savedTheme;
  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
    const btn = document.getElementById('admin-theme-toggle');
    if (btn) btn.textContent = theme === 'dark' ? '☾' : '☀';
  }

  // --- Auth -----------------------------------------------------------
  const AdminAuth = {
    get token() { return localStorage.getItem(TOKEN_KEY); },
    set token(v) { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); },
    require() {
      if (!this.token) {
        window.location.href = '/admin';
        return false;
      }
      return true;
    },
    logout() {
      this.token = null;
      window.location.href = '/admin';
    },
  };

  // --- API ------------------------------------------------------------
  const AdminAPI = async (method, path, body) => {
    const headers = { 'content-type': 'application/json' };
    if (AdminAuth.token) headers.authorization = 'Bearer ' + AdminAuth.token;
    const res = await fetch('/api/admin' + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) { AdminAuth.logout(); throw new Error('Session expired'); }
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

  // --- Toast ----------------------------------------------------------
  const AdminToast = {
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

  // --- Formatting -----------------------------------------------------
  const Fmt = {
    escape(s) {
      return String(s ?? '')
        .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
    },
    money(amount, currency = 'USD') {
      const num = Number(amount);
      if (!isFinite(num)) return '—';
      const symbols = { USD: '$', EUR: '€', GBP: '£', CAD: 'C$', AUD: 'A$', INR: '₹' };
      const sym = symbols[currency] || (currency + ' ');
      return `${sym}${num.toFixed(2)}`;
    },
    moneySplit(amount, currency = 'USD') {
      const num = Number(amount);
      const symbols = { USD: '$', EUR: '€', GBP: '£', CAD: 'C$', AUD: 'A$', INR: '₹' };
      const sym = symbols[currency] || (currency + ' ');
      return { ccy: sym, val: isFinite(num) ? num.toFixed(2) : '—' };
    },
    date(iso) {
      if (!iso) return '—';
      const d = new Date(iso);
      if (isNaN(d)) return '—';
      return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    },
    relative(iso) {
      if (!iso) return '—';
      const d = new Date(iso);
      if (isNaN(d)) return '—';
      const ms = Date.now() - d.getTime();
      if (ms < 60_000) return 'just now';
      if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
      if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
      if (ms < 7 * 86_400_000) return `${Math.floor(ms / 86_400_000)}d ago`;
      return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    },
  };

  // --- Shell (header + nav) -------------------------------------------
  const AdminShell = {
    render({ crumbs = [] } = {}) {
      const page = document.getElementById('page');
      if (!page) throw new Error('No #page element');

      const crumbHtml = crumbs
        .map((c, i) => {
          const last = i === crumbs.length - 1;
          if (c.href && !last) {
            return `<a href="${c.href}">${Fmt.escape(c.label)}</a>`;
          }
          return `<span${last ? ' class="current"' : ''}>${Fmt.escape(c.label)}</span>`;
        })
        .join('<span class="crumb-sep">/</span>');

      page.innerHTML = `
        <div class="dash-frame">
          <header class="dash-head">
            <div class="dash-brand">
              <a href="/admin/overview" style="display:flex;align-items:center;gap:10px;text-decoration:none;color:inherit">
                <span class="admin-mark">IR</span>
                <span class="admin-wordmark">
                  <span style="color:var(--ink)">Infinity Ramper</span>
                  <span style="color:var(--accent);font-style:italic;font-weight:300">admin</span>
                </span>
              </a>
            </div>
            <nav class="dash-nav">
              <a href="/admin/overview" class="${isActive('/admin/overview') ? 'active' : ''}">Overview</a>
              <a href="/admin/merchants" class="${isActive('/admin/merchants') ? 'active' : ''}">Merchants</a>
              <a href="/admin/activity" class="${isActive('/admin/activity') ? 'active' : ''}">Activity</a>
            </nav>
            <div class="dash-actions">
              <button id="admin-theme-toggle" class="btn btn-icon" title="Toggle theme">${savedTheme === 'dark' ? '☾' : '☀'}</button>
              <button id="admin-logout" class="btn btn-ghost btn-sm">Sign out</button>
            </div>
          </header>
          <nav class="crumbs">${crumbHtml}</nav>
          <main id="main"></main>
        </div>
      `;

      document.getElementById('admin-theme-toggle').addEventListener('click', () => {
        setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
      });
      document.getElementById('admin-logout').addEventListener('click', () => {
        AdminAuth.logout();
      });

      return document.getElementById('main');
    },
  };

  function isActive(href) {
    return window.location.pathname.startsWith(href);
  }

  // Expose globally
  window.AdminAPI = AdminAPI;
  window.AdminAuth = AdminAuth;
  window.AdminShell = AdminShell;
  window.AdminToast = AdminToast;
  window.Fmt = Fmt;
})();
