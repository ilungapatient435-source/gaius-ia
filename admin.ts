import crypto from 'node:crypto';
import type { Express, NextFunction, Request, Response } from 'express';
import { parseCookies, safeEqualString } from './auth.js';
import {
  deleteUserWorkspace,
  readAccounts,
  readAuthState,
  withFileLock,
  writeAccounts,
  writeAuthState,
} from './storage.js';
import type { AccountRecord } from './types.js';

const ADMIN_COOKIE_NAME = 'gaius_admin_session';
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

let ephemeralAdminSecret: string | null = null;
function getAdminSecret(): string {
  const configured = (process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD || '').trim();
  if (configured) return configured;
  if (!ephemeralAdminSecret) {
    ephemeralAdminSecret = crypto.randomBytes(32).toString('hex');
  }
  return ephemeralAdminSecret;
}

export function getAdminPath(): string {
  const raw = (process.env.ADMIN_PATH || '/gaius-gestion').trim();
  if (!raw) return '/gaius-gestion';
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`;
  return withSlash.replace(/\/+$/, '') || '/gaius-gestion';
}

function signAdminSession(email: string): string {
  const payload = Buffer.from(
    JSON.stringify({ email, exp: Date.now() + ADMIN_SESSION_TTL_MS }),
    'utf-8',
  ).toString('base64url');
  const sig = crypto
    .createHmac('sha256', getAdminSecret())
    .update(payload)
    .digest('base64url');
  return `${payload}.${sig}`;
}

function verifyAdminSession(token: string | undefined): { email: string } | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expected = crypto
    .createHmac('sha256', getAdminSecret())
    .update(payload)
    .digest('base64url');
  if (!safeEqualString(sig, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as {
      email?: string;
      exp?: number;
    };
    if (!parsed.email || !parsed.exp || parsed.exp <= Date.now()) return null;
    const configuredEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    if (!configuredEmail || parsed.email.toLowerCase() !== configuredEmail) return null;
    return { email: parsed.email };
  } catch {
    return null;
  }
}

function requireAdminAuth(req: Request, res: Response, next: NextFunction): void {
  const cookies = parseCookies(req.headers.cookie);
  const session = verifyAdminSession(cookies[ADMIN_COOKIE_NAME]);
  if (!session) {
    res.status(401).json({ error: 'Authentification administrateur requise.' });
    return;
  }
  next();
}

function noIndexHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('Cache-Control', 'no-store');
  next();
}

function sanitizeAccountForAdmin(a: AccountRecord) {
  // Note: Strictly NO conversations, NO messages, NO passwordHash.
  return {
    id: a.id,
    name: a.name,
    email: a.email,
    authProvider: a.authProvider,
    emailVerified: a.emailVerified,
    disabled: a.disabled,
    createdAt: a.createdAt,
    lastActiveAt: a.lastActiveAt,
    questionnaireCompleted: a.questionnaireCompleted,
    questionnaire: a.questionnaire ?? {},
  };
}

function csvCell(val: unknown): string {
  const str = String(val ?? '').replace(/\r?\n/g, ' ');
  return `"${str.replace(/"/g, '""')}"`;
}

export function registerAdminRoutes(app: Express): void {
  const adminPath = getAdminPath();

  app.use(adminPath, noIndexHeaders);

  app.post(`${adminPath}/api/login`, (req, res) => {
    const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    const adminPassword = (process.env.ADMIN_PASSWORD || '').trim();
    if (!adminEmail || !adminPassword) {
      res.status(503).json({
        error: 'Les identifiants ADMIN_EMAIL et ADMIN_PASSWORD ne sont pas configurés dans les Secrets.',
      });
      return;
    }

    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '');
    if (!safeEqualString(email, adminEmail) || !safeEqualString(password, adminPassword)) {
      res.status(401).json({ error: 'Identifiants de gestion invalides.' });
      return;
    }

    const token = signAdminSession(adminEmail);
    const isProd = process.env.NODE_ENV === 'production';
    res.cookie(ADMIN_COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: isProd,
      maxAge: ADMIN_SESSION_TTL_MS,
      path: adminPath,
    });
    res.json({ ok: true });
  });

  app.post(`${adminPath}/api/logout`, (_req, res) => {
    res.clearCookie(ADMIN_COOKIE_NAME, { path: adminPath });
    res.json({ ok: true });
  });

  app.get(`${adminPath}/api/users`, requireAdminAuth, (req, res) => {
    const query = String(req.query.q ?? '').trim().toLowerCase();
    const accounts = readAccounts();
    const now = Date.now();
    const startOfToday = new Date();
    startOfToday.setUTCHours(0, 0, 0, 0);
    const todayTs = startOfToday.getTime();
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
    const oneDayAgo = now - 24 * 60 * 60 * 1000;

    const stats = {
      total: accounts.length,
      newToday: accounts.filter((a) => a.createdAt >= todayTs).length,
      new7Days: accounts.filter((a) => a.createdAt >= sevenDaysAgo).length,
      active24h: accounts.filter((a) => !a.disabled && a.lastActiveAt >= oneDayAgo).length,
    };

    const filtered = query
      ? accounts.filter(
          (a) =>
            a.name.toLowerCase().includes(query) ||
            a.email.toLowerCase().includes(query),
        )
      : accounts;

    const sorted = [...filtered].sort((a, b) => b.createdAt - a.createdAt);
    res.json({
      stats,
      users: sorted.map(sanitizeAccountForAdmin),
    });
  });

  app.post(`${adminPath}/api/users/:id/toggle-status`, requireAdminAuth, async (req, res) => {
    const userId = String(req.params.id ?? '');
    const updated = await withFileLock('accounts', () => {
      const accounts = readAccounts();
      const target = accounts.find((a) => a.id === userId);
      if (!target) return null;
      target.disabled = !target.disabled;
      writeAccounts(accounts);
      return sanitizeAccountForAdmin(target);
    });
    if (!updated) {
      res.status(404).json({ error: 'Utilisateur introuvable.' });
      return;
    }
    if (updated.disabled) {
      await withFileLock('auth_state', () => {
        const state = readAuthState();
        state.sessions = state.sessions.filter((s) => s.userId !== userId);
        writeAuthState(state);
      });
    }
    res.json({ ok: true, user: updated });
  });

  app.delete(`${adminPath}/api/users/:id`, requireAdminAuth, async (req, res) => {
    const userId = String(req.params.id ?? '');
    const existed = await withFileLock('accounts', () => {
      const accounts = readAccounts();
      const filtered = accounts.filter((a) => a.id !== userId);
      if (filtered.length === accounts.length) return false;
      writeAccounts(filtered);
      return true;
    });
    if (!existed) {
      res.status(404).json({ error: 'Utilisateur introuvable.' });
      return;
    }
    await withFileLock('auth_state', () => {
      const state = readAuthState();
      state.sessions = state.sessions.filter((s) => s.userId !== userId);
      writeAuthState(state);
    });
    await withFileLock(`workspace:${userId}`, () => {
      deleteUserWorkspace(userId);
    });
    res.json({ ok: true });
  });

  app.get(`${adminPath}/api/export.csv`, requireAdminAuth, (_req, res) => {
    const accounts = readAccounts().sort((a, b) => b.createdAt - a.createdAt);
    const headers = [
      'ID',
      'Nom',
      'Email',
      'Inscription',
      'Derniere activite',
      'Mode',
      'Statut',
      'Profil',
      'Domaine',
      'Attente',
      'Langue souhaitee',
      'Remarques',
    ];
    const lines = [headers.map(csvCell).join(',')];
    for (const a of accounts) {
      const q = a.questionnaire ?? {};
      const status = a.disabled ? 'Désactivé' : a.emailVerified ? 'Actif' : 'Non vérifié';
      lines.push(
        [
          a.id,
          a.name,
          a.email,
          new Date(a.createdAt).toISOString(),
          new Date(a.lastActiveAt).toISOString(),
          a.authProvider === 'google' ? 'Google' : 'E-mail',
          status,
          q.role === 'Autre' && q.roleOther ? `Autre: ${q.roleOther}` : q.role || '',
          q.domain === 'Autre' && q.domainOther ? `Autre: ${q.domainOther}` : q.domain || '',
          q.expectation === 'Autre' && q.expectationOther
            ? `Autre: ${q.expectationOther}`
            : q.expectation || '',
          q.preferredLanguage === 'Autre' && q.preferredLanguageOther
            ? `Autre: ${q.preferredLanguageOther}`
            : q.preferredLanguage || '',
          q.notes || '',
        ]
          .map(csvCell)
          .join(','),
      );
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="gaius-ia-utilisateurs.csv"');
    res.send('\uFEFF' + lines.join('\r\n'));
  });

  app.get(adminPath, (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    const isAuthenticated = Boolean(verifyAdminSession(cookies[ADMIN_COOKIE_NAME]));
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderAdminHtml(adminPath, isAuthenticated));
  });
}

function renderAdminHtml(adminPath: string, isAuthenticated: boolean): string {
  return `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="noindex, nofollow, noarchive" />
    <title>Gaius IA — Espace de gestion</title>
    <style>
      :root { color-scheme: dark light; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        background: #0b0f17;
        color: #e2e8f0;
        min-height: 100vh;
      }
      .wrap { max-width: 1120px; margin: 0 auto; padding: 28px 20px; }
      .card {
        background: #131b2b;
        border: 1px solid #1e293b;
        border-radius: 16px;
        padding: 20px;
      }
      .login-wrap {
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
      }
      .login-card { width: 100%; max-width: 390px; }
      h1 { margin: 0 0 6px; font-size: 22px; color: #fff; }
      .muted { color: #94a3b8; font-size: 13px; }
      label { display: block; font-size: 13px; color: #cbd5e1; margin: 14px 0 6px; }
      input[type="email"], input[type="password"], input[type="search"] {
        width: 100%;
        background: #0b1120;
        border: 1px solid #334155;
        border-radius: 10px;
        padding: 10px 12px;
        color: #f8fafc;
        font-size: 14px;
      }
      button, .btn {
        cursor: pointer;
        border: 0;
        border-radius: 10px;
        padding: 10px 14px;
        font-size: 13px;
        font-weight: 600;
        background: #2563eb;
        color: #fff;
        text-decoration: none;
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      button.secondary, .btn.secondary { background: #1e293b; color: #e2e8f0; border: 1px solid #334155; }
      button.danger { background: #be123c; color: #fff; }
      button.warn { background: #b45309; color: #fff; }
      .topbar { display: flex; flex-wrap: wrap; gap: 12px; justify-content: space-between; align-items: center; margin-bottom: 20px; }
      .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 20px; }
      .stat-val { font-size: 28px; font-weight: 700; color: #fff; margin-top: 6px; }
      .toolbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: space-between; margin-bottom: 14px; }
      .table-wrap { overflow-x: auto; }
      table { width: 100%; border-collapse: collapse; font-size: 13px; }
      th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #1e293b; vertical-align: top; }
      th { color: #94a3b8; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
      .badge {
        display: inline-block; padding: 3px 8px; border-radius: 999px; font-size: 11px; font-weight: 600;
      }
      .badge.ok { background: rgba(16, 185, 129, 0.16); color: #34d399; }
      .badge.off { background: rgba(244, 63, 94, 0.16); color: #fb7185; }
      .badge.provider { background: rgba(59, 130, 246, 0.16); color: #60a5fa; }
      .err { color: #fda4af; font-size: 13px; margin-top: 10px; }
      .actions { display: flex; gap: 6px; flex-wrap: wrap; }
    </style>
  </head>
  <body>
    ${
      !isAuthenticated
        ? `<div class="login-wrap">
            <form id="loginForm" class="card login-card">
              <h1>Espace de gestion</h1>
              <p class="muted">Accès réservé au propriétaire de Gaius IA. Les conversations des utilisateurs ne sont jamais accessibles ici.</p>
              <label for="email">E-mail administrateur</label>
              <input id="email" type="email" required autocomplete="username" />
              <label for="password">Mot de passe</label>
              <input id="password" type="password" required autocomplete="current-password" />
              <div id="loginError" class="err"></div>
              <div style="margin-top:16px;">
                <button type="submit" style="width:100%;justify-content:center;">Se connecter</button>
              </div>
            </form>
          </div>
          <script>
            document.getElementById('loginForm').addEventListener('submit', async (e) => {
              e.preventDefault();
              const errEl = document.getElementById('loginError');
              errEl.textContent = '';
              const res = await fetch(${JSON.stringify(adminPath + '/api/login')}, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  email: document.getElementById('email').value,
                  password: document.getElementById('password').value,
                }),
              });
              const data = await res.json();
              if (!res.ok) {
                errEl.textContent = data.error || 'Connexion refusée.';
                return;
              }
              window.location.reload();
            });
          </script>`
        : `<div class="wrap">
            <div class="topbar">
              <div>
                <h1>Espace de gestion · Gaius IA</h1>
                <div class="muted">Gestion des comptes uniquement (confidentialité stricte : aucune conversation n'est accessible).</div>
              </div>
              <div style="display:flex;gap:8px;flex-wrap:wrap;">
                <a class="btn secondary" href="${adminPath}/api/export.csv">Exporter CSV</a>
                <button id="logoutBtn" class="secondary" type="button">Déconnexion</button>
              </div>
            </div>
            <div class="stats">
              <div class="card"><div class="muted">Total utilisateurs</div><div class="stat-val" id="stTotal">-</div></div>
              <div class="card"><div class="muted">Nouveaux aujourd'hui</div><div class="stat-val" id="stToday">-</div></div>
              <div class="card"><div class="muted">Nouveaux (7 jours)</div><div class="stat-val" id="st7d">-</div></div>
              <div class="card"><div class="muted">Actifs (24h)</div><div class="stat-val" id="stActive">-</div></div>
            </div>
            <div class="card">
              <div class="toolbar">
                <input id="searchInput" type="search" placeholder="Rechercher par nom ou e-mail…" style="max-width:340px;" />
                <button id="refreshBtn" class="secondary" type="button">Actualiser</button>
              </div>
              <div class="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Utilisateur</th>
                      <th>Inscription / Activité</th>
                      <th>Mode & Statut</th>
                      <th>Questionnaire</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody id="usersBody"></tbody>
                </table>
              </div>
            </div>
          </div>
          <script>
            const BASE = ${JSON.stringify(adminPath)};
            const fmtDate = (ts) => ts ? new Date(ts).toLocaleString('fr-FR') : '-';
            const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
            async function loadUsers() {
              const q = document.getElementById('searchInput').value.trim();
              const res = await fetch(BASE + '/api/users?q=' + encodeURIComponent(q));
              if (res.status === 401) { window.location.reload(); return; }
              const data = await res.json();
              document.getElementById('stTotal').textContent = data.stats.total;
              document.getElementById('stToday').textContent = data.stats.newToday;
              document.getElementById('st7d').textContent = data.stats.new7Days;
              document.getElementById('stActive').textContent = data.stats.active24h;
              const tbody = document.getElementById('usersBody');
              if (!data.users.length) {
                tbody.innerHTML = '<tr><td colspan="5" class="muted">Aucun utilisateur trouvé.</td></tr>';
                return;
              }
              tbody.innerHTML = data.users.map((u) => {
                const q = u.questionnaire || {};
                const qParts = [
                  q.role ? 'Profil: ' + esc(q.role === 'Autre' && q.roleOther ? q.roleOther : q.role) : '',
                  q.domain ? 'Domaine: ' + esc(q.domain === 'Autre' && q.domainOther ? q.domainOther : q.domain) : '',
                  q.expectation ? 'Attente: ' + esc(q.expectation === 'Autre' && q.expectationOther ? q.expectationOther : q.expectation) : '',
                  q.preferredLanguage ? 'Langue: ' + esc(q.preferredLanguage === 'Autre' && q.preferredLanguageOther ? q.preferredLanguageOther : q.preferredLanguage) : '',
                  q.notes ? 'Note: ' + esc(q.notes) : '',
                ].filter(Boolean);
                return '<tr>' +
                  '<td><strong>' + esc(u.name) + '</strong><br><span class="muted">' + esc(u.email) + '</span></td>' +
                  '<td><span class="muted">Inscrit :</span> ' + fmtDate(u.createdAt) + '<br><span class="muted">Actif :</span> ' + fmtDate(u.lastActiveAt) + '</td>' +
                  '<td><span class="badge provider">' + (u.authProvider === 'google' ? 'Google' : 'E-mail') + '</span> ' +
                    (u.disabled ? '<span class="badge off">Désactivé</span>' : '<span class="badge ok">Actif</span>') + '</td>' +
                  '<td>' + (qParts.length ? qParts.join('<br>') : '<span class="muted">Non renseigné</span>') + '</td>' +
                  '<td><div class="actions">' +
                    '<button type="button" class="' + (u.disabled ? 'secondary' : 'warn') + '" onclick="toggleUser(\\'' + esc(u.id) + '\\')">' + (u.disabled ? 'Réactiver' : 'Désactiver') + '</button>' +
                    '<button type="button" class="danger" onclick="deleteUser(\\'' + esc(u.id) + '\\', \\'' + esc(u.email) + '\\')">Supprimer</button>' +
                  '</div></td>' +
                '</tr>';
              }).join('');
            }
            window.toggleUser = async (id) => {
              await fetch(BASE + '/api/users/' + encodeURIComponent(id) + '/toggle-status', { method: 'POST' });
              loadUsers();
            };
            window.deleteUser = async (id, email) => {
              if (!confirm('Supprimer définitivement le compte ' + email + ' et ses données ?')) return;
              await fetch(BASE + '/api/users/' + encodeURIComponent(id), { method: 'DELETE' });
              loadUsers();
            };
            document.getElementById('searchInput').addEventListener('input', () => loadUsers());
            document.getElementById('refreshBtn').addEventListener('click', () => loadUsers());
            document.getElementById('logoutBtn').addEventListener('click', async () => {
              await fetch(BASE + '/api/logout', { method: 'POST' });
              window.location.reload();
            });
            loadUsers();
          </script>`
    }
  </body>
</html>`;
}
