/* =========================================================================
   Admin shell — shared across /admin pages.
   Uses a separate token key from the merchant dashboard to keep the two
   authentication scopes isolated.
   ========================================================================= */
(() => {
  'use strict';

  const TOKEN_KEY = 'ramper_admin_token';

  /* --- Auth ----------------------------------------------------------- */
  const AdminAuth = {
    get token() { return localStorage.getItem(TOKEN_KEY); },
    set token(v) { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); },
    require() {
      if (!this.token) {
        window.location.href = '/admin/login';
        return false;
      }
      return true;
    },
    logout() {
      this.token = null;
      window.location.href = '/admin/login';
    },
  };

  /* --- API ------------------------------------------------------------ */
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

  /* --- Shell (sidebar + breadcrumbs) --------------------------------- */
  const AdminShell = {
    render(opts = {}) {
      const crumbs = opts.crumbs || [];
      document.body.innerHTML = `
        <div class="admin-layout">
          <aside class="admin-sidebar">
            <div class="admin-mark">Admin · Operator</div>
            <a class="brand-logo" href="/admin/overview" aria-label="Infinity Ramper" style="display:block;width:160px;margin-bottom:24px">
              <img src="/assets/logo-dark.svg" alt="Infinity Ramper" class="brand-logo-dark" style="width:100%;height:auto;display:block;"/>
              <img src="/assets/logo-light.svg" alt="Infinity Ramper" class="brand-logo-light" style="width:100%;height:auto;display:block;"/>
            </a>
            <nav class="admin-nav">
              <a href="/admin/overview" ${opts.active === 'overview' ? 'class="active"' : ''}>Overview</a>
              <a href="/admin/merchants" ${opts.active === 'merchants' ? 'class="active"' : ''}>Merchants</a>
              <a href="/admin/activity" ${opts.active === 'activity' ? 'class="active"' : ''}>Activity</a>
            </nav>
            <div class="admin-footer">
              <div class="meta" id="admin-email">—</div>
              <button class="btn btn-ghost btn-sm" id="admin-signout">Sign out</button>
            </div>
          </aside>
          <main class="admin-main">
            <div class="admin-crumbs">
              ${crumbs.map((c, i) =>
                c.href
                  ? `<a href="${c.href}">${escapeHtml(c.label)}</a>`
                  : `<span>${escapeHtml(c.label)}</span>`
              ).join('<span class="sep"> / </span>')}
            </div>
            <div id="admin-content"></div>
          </main>
        </div>
      `;

      // Wire sign out
      document.getElementById('admin-signout').addEventListener('click', () => {
        if (confirm('Sign out of the admin dashboard?')) AdminAuth.logout();
      });

      // Fetch admin email for the footer
      AdminAPI('GET', '/me').then(r => {
        document.getElementById('admin-email').textContent = r.email;
      }).catch(() => { /* auth will redirect if invalid */ });

      return document.getElementById('admin-content');
    },
  };

  function escapeHtml(s) {
    return String(s ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  /* --- Formatting helpers ----------------------------------------------- */
  const Fmt = {
    escape: escapeHtml,
    date(s) {
      if (!s) return '—';
      const d = new Date(s);
      if (isNaN(d)) return '—';
      return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    },
    dateShort(s) {
      if (!s) return '—';
      const d = new Date(s);
      if (isNaN(d)) return '—';
      return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    },
    relative(s) {
      if (!s) return '—';
      const d = new Date(s);
      if (isNaN(d)) return '—';
      const diff = Date.now() - d.getTime();
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return 'just now';
      if (mins < 60) return `${mins}m ago`;
      const hours = Math.floor(mins / 60);
      if (hours < 24) return `${hours}h ago`;
      const days = Math.floor(hours / 24);
      if (days < 30) return `${days}d ago`;
      return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    },
    money(amount, currency = 'USD') {
      const SYMBOLS = { USD: '$', EUR: '€', GBP: '£', CAD: 'C$', AUD: 'A$', INR: '₹' };
      const n = Number(amount);
      if (!isFinite(n)) return '—';
      const symbol = SYMBOLS[currency] || (currency + ' ');
      return `${symbol}${n.toFixed(2)}`;
    },
    num(n) {
      if (n === null || n === undefined) return '—';
      const v = Number(n);
      if (!isFinite(v)) return '—';
      return v.toLocaleString();
    },
  };

  window.AdminAuth = AdminAuth;
  window.AdminAPI = AdminAPI;
  window.AdminShell = AdminShell;
  window.Toast = Toast;
  window.Fmt = Fmt;
})();
