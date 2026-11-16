import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import {
  sendNewUserAdminNotification,
  sendPasswordResetEmail,
  sendVerificationCodeEmail,
} from './email.js';
import {
  APP_VERSION,
  DAILY_REQUEST_LIMIT,
  MAX_CONVERSATIONS_PER_USER,
  deleteUserWorkspace,
  readAccounts,
  readAuthState,
  withFileLock,
  writeAccounts,
  writeAuthState,
} from './storage.js';
import type {
  AccountRecord,
  PublicUser,
  QuestionnaireData,
  UserPreferences,
} from './types.js';

const SESSION_COOKIE_NAME = 'gaius_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours
const CODE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const RESEND_COOLDOWN_MS = 45 * 1000; // 45 secondes
const MAX_CODE_ATTEMPTS = 5;
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000; // 15 minutes

let ephemeralSecret: string | null = null;
function getSigningSecret(): string {
  const envSecret = (process.env.SESSION_SECRET || '').trim();
  if (envSecret) return envSecret;
  if (!ephemeralSecret) {
    ephemeralSecret = crypto.randomBytes(32).toString('hex');
  }
  return ephemeralSecret;
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash?: string): boolean {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, hex] = storedHash.split(':');
  if (!salt || !hex) return false;
  try {
    const derived = crypto.scryptSync(password, salt, 64);
    const expected = Buffer.from(hex, 'hex');
    if (derived.length !== expected.length) return false;
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

export function safeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf-8');
  const bufB = Buffer.from(b, 'utf-8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function toPublicUser(account: AccountRecord): PublicUser {
  return {
    id: account.id,
    name: account.name,
    email: account.email,
    authProvider: account.authProvider,
    emailVerified: account.emailVerified,
    disabled: account.disabled,
    createdAt: account.createdAt,
    lastActiveAt: account.lastActiveAt,
    questionnaireCompleted: account.questionnaireCompleted,
    questionnaireStep: account.questionnaireStep,
    questionnaire: account.questionnaire ?? {},
    preferences: account.preferences ?? {},
  };
}

export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  }
  return out;
}

export function extractSessionToken(req: {
  headers: Record<string, string | string[] | undefined>;
  url?: string;
}): string | null {
  const authHeader = req.headers.authorization;
  const authStr = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (authStr && authStr.toLowerCase().startsWith('bearer ')) {
    const token = authStr.slice(7).trim();
    if (token) return token;
  }
  const cookieHeader = req.headers.cookie;
  const cookieStr = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
  const cookies = parseCookies(cookieStr);
  if (cookies[SESSION_COOKIE_NAME]) {
    return cookies[SESSION_COOKIE_NAME];
  }
  if (req.url) {
    try {
      const urlObj = new URL(req.url, 'http://localhost');
      const queryToken = urlObj.searchParams.get('token');
      if (queryToken) return queryToken.trim();
    } catch {
      // Ignore invalid URL
    }
  }
  return null;
}

function setSessionCookie(res: Response, token: string): void {
  const isProd = process.env.NODE_ENV === 'production';
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: isProd ? 'none' : 'lax',
    secure: isProd,
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
}

function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
}

export function isGoogleOAuthConfigured(): boolean {
  return Boolean(
    (process.env.GOOGLE_CLIENT_ID || '').trim() &&
      (process.env.GOOGLE_CLIENT_SECRET || '').trim(),
  );
}

function generateSixDigitCode(): string {
  return String(crypto.randomInt(100000, 1000000));
}

function normalizeEmail(raw: unknown): string {
  return String(raw ?? '').trim().toLowerCase();
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 180;
}

async function createUserSession(
  userId: string,
  client: 'web' | 'apk' = 'web',
): Promise<string> {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = sha256(rawToken);
  const now = Date.now();
  await withFileLock('auth_state', () => {
    const state = readAuthState();
    state.sessions.push({
      id: `sess_${now}_${crypto.randomBytes(4).toString('hex')}`,
      tokenHash,
      userId,
      client,
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
    });
    writeAuthState(state);
  });
  return rawToken;
}

export async function authenticateToken(
  token: string | null,
): Promise<{ user: AccountRecord; tokenHash: string } | null> {
  if (!token) return null;
  const tokenHash = sha256(token);
  const now = Date.now();
  const state = readAuthState();
  const session = state.sessions.find((s) => s.tokenHash === tokenHash && s.expiresAt > now);
  if (!session) return null;

  const accounts = readAccounts();
  const user = accounts.find((a) => a.id === session.userId);
  if (!user || user.disabled || !user.emailVerified) {
    return null;
  }

  // Update lastActiveAt periodically (at most once per 60s to avoid excess disk writes)
  if (now - user.lastActiveAt > 60_000) {
    void withFileLock('accounts', () => {
      const latest = readAccounts();
      const target = latest.find((a) => a.id === user.id);
      if (target) {
        target.lastActiveAt = now;
        writeAccounts(latest);
      }
    });
  }

  return { user, tokenHash };
}

export interface AuthenticatedRequest extends Request {
  authUser?: AccountRecord;
  authTokenHash?: string;
}

export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = extractSessionToken(req);
  const auth = await authenticateToken(token);
  if (!auth) {
    res.status(401).json({
      code: 'SESSION_EXPIRED',
      error: 'Votre session a expiré. Reconnectez-vous pour continuer.',
    });
    return;
  }
  req.authUser = auth.user;
  req.authTokenHash = auth.tokenHash;
  next();
}

export async function checkAndConsumeDailyLimit(userId: string): Promise<{
  allowed: boolean;
  limit: number;
  used: number;
}> {
  if (DAILY_REQUEST_LIMIT <= 0) {
    return { allowed: true, limit: 0, used: 0 };
  }
  const today = new Date().toISOString().slice(0, 10);
  const key = `${userId}_${today}`;
  return withFileLock('auth_state', () => {
    const state = readAuthState();
    // Prune previous days
    for (const existingKey of Object.keys(state.dailyUsage)) {
      if (!existingKey.endsWith(`_${today}`)) {
        delete state.dailyUsage[existingKey];
      }
    }
    const current = state.dailyUsage[key] ?? 0;
    if (current >= DAILY_REQUEST_LIMIT) {
      return { allowed: false, limit: DAILY_REQUEST_LIMIT, used: current };
    }
    state.dailyUsage[key] = current + 1;
    writeAuthState(state);
    return { allowed: true, limit: DAILY_REQUEST_LIMIT, used: current + 1 };
  });
}

function getBaseOrigin(req: Request): string {
  const configured = (process.env.APP_URL || process.env.APP_SERVER_URL || '').trim();
  if (configured) {
    return configured.replace(/\/+$/, '');
  }
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() || req.protocol || 'http';
  const host = (req.headers['x-forwarded-host'] as string | undefined)?.split(',')[0]?.trim() || req.get('host') || 'localhost:3000';
  return `${proto}://${host}`;
}

function signOAuthState(payload: { client: 'web' | 'apk'; ts: number }): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', getSigningSecret())
    .update(encoded)
    .digest('base64url');
  return `${encoded}.${sig}`;
}

function verifyOAuthState(raw: string): { client: 'web' | 'apk'; ts: number } | null {
  const parts = raw.split('.');
  if (parts.length !== 2) return null;
  const [encoded, sig] = parts;
  const expected = crypto
    .createHmac('sha256', getSigningSecret())
    .update(encoded)
    .digest('base64url');
  if (!safeEqualString(sig, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf-8')) as {
      client?: string;
      ts?: number;
    };
    if (!parsed.ts || Date.now() - parsed.ts > 15 * 60 * 1000) return null;
    return {
      client: parsed.client === 'apk' ? 'apk' : 'web',
      ts: parsed.ts,
    };
  } catch {
    return null;
  }
}

export function registerAuthRoutes(app: import('express').Express): void {
  app.get('/api/auth/config', (_req, res) => {
    res.json({
      googleEnabled: isGoogleOAuthConfigured(),
      maxConversations: MAX_CONVERSATIONS_PER_USER,
      dailyRequestLimit: DAILY_REQUEST_LIMIT,
      appVersion: APP_VERSION,
    });
  });

  app.get('/api/auth/me', async (req, res) => {
    const token = extractSessionToken(req);
    const auth = await authenticateToken(token);
    if (!auth) {
      res.status(401).json({
        code: 'SESSION_EXPIRED',
        error: 'Votre session a expiré. Reconnectez-vous pour continuer.',
      });
      return;
    }
    res.json({ user: toPublicUser(auth.user) });
  });

  app.post('/api/auth/register', async (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password ?? '');

    if (name.length < 2 || name.length > 80) {
      res.status(400).json({ error: 'Veuillez saisir un nom complet (au moins 2 caractères).' });
      return;
    }
    if (!isValidEmail(email)) {
      res.status(400).json({ error: 'Veuillez saisir une adresse e-mail valide.' });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({
        error: 'Le mot de passe doit contenir au moins 8 caractères.',
      });
      return;
    }

    const existing = readAccounts().find((a) => a.email === email);
    if (existing) {
      res.status(409).json({
        error:
          existing.authProvider === 'google'
            ? 'Un compte Google existe déjà avec cette adresse e-mail. Utilisez « Continuer avec Google ».'
            : 'Un compte existe déjà avec cette adresse e-mail. Connectez-vous ou réinitialisez votre mot de passe.',
      });
      return;
    }

    const now = Date.now();
    const code = generateSixDigitCode();
    const codeHash = sha256(code);
    const pwdHash = hashPassword(password);
    const key = `register:${email}`;

    const rateCheck = await withFileLock('auth_state', () => {
      const state = readAuthState();
      const prev = state.pendingCodes.find((p) => p.key === key);
      if (prev && now - prev.lastSentAt < RESEND_COOLDOWN_MS) {
        const waitSec = Math.ceil((RESEND_COOLDOWN_MS - (now - prev.lastSentAt)) / 1000);
        return { ok: false as const, waitSec };
      }
      state.pendingCodes = state.pendingCodes.filter((p) => p.key !== key);
      state.pendingCodes.push({
        key,
        type: 'register',
        email,
        name,
        passwordHash: pwdHash,
        codeHash,
        createdAt: now,
        expiresAt: now + CODE_TTL_MS,
        attempts: 0,
        resendCount: prev ? prev.resendCount + 1 : 0,
        lastSentAt: now,
      });
      writeAuthState(state);
      return { ok: true as const };
    });

    if (!rateCheck.ok) {
      res.status(429).json({
        error: `Veuillez patienter ${rateCheck.waitSec} secondes avant de demander un nouveau code.`,
      });
      return;
    }

    const emailResult = await sendVerificationCodeEmail(email, name, code);
    if (emailResult.error) {
      res.status(503).json({ error: emailResult.error });
      return;
    }

    res.json({
      ok: true,
      email,
      message: emailResult.sent
        ? 'Un code de vérification à 6 chiffres vient d’être envoyé à votre adresse e-mail (valable 15 minutes).'
        : 'Mode développement : utilisez le code affiché pour finaliser votre inscription.',
      ...(emailResult.devCode ? { devCode: emailResult.devCode } : {}),
    });
  });

  app.post('/api/auth/resend-code', async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const type = req.body?.type === 'reset' ? 'reset' : 'register';
    if (!isValidEmail(email)) {
      res.status(400).json({ error: 'Adresse e-mail invalide.' });
      return;
    }

    const key = `${type}:${email}`;
    const now = Date.now();
    const newCode = generateSixDigitCode();

    const result = await withFileLock('auth_state', () => {
      const state = readAuthState();
      const entry = state.pendingCodes.find((p) => p.key === key);
      if (!entry) {
        return { status: 'missing' as const };
      }
      if (now - entry.lastSentAt < RESEND_COOLDOWN_MS) {
        const waitSec = Math.ceil((RESEND_COOLDOWN_MS - (now - entry.lastSentAt)) / 1000);
        return { status: 'cooldown' as const, waitSec };
      }
      if (entry.resendCount >= 5) {
        return { status: 'limit' as const };
      }
      entry.codeHash = sha256(newCode);
      entry.expiresAt = now + CODE_TTL_MS;
      entry.attempts = 0;
      entry.resendCount += 1;
      entry.lastSentAt = now;
      writeAuthState(state);
      return { status: 'ok' as const, name: entry.name || 'utilisateur' };
    });

    if (result.status === 'missing') {
      res.status(404).json({
        error: 'Aucune demande en attente trouvée pour cette adresse e-mail. Recommencez l’étape précédente.',
      });
      return;
    }
    if (result.status === 'cooldown') {
      res.status(429).json({
        error: `Veuillez patienter ${result.waitSec} secondes avant de renvoyer un code.`,
      });
      return;
    }
    if (result.status === 'limit') {
      res.status(429).json({
        error: 'Trop de renvois demandés. Veuillez patienter quelques minutes avant de recommencer.',
      });
      return;
    }

    const mailRes =
      type === 'reset'
        ? await sendPasswordResetEmail(email, result.name, newCode)
        : await sendVerificationCodeEmail(email, result.name, newCode);

    if (mailRes.error) {
      res.status(503).json({ error: mailRes.error });
      return;
    }

    res.json({
      ok: true,
      message: mailRes.sent
        ? 'Un nouveau code à 6 chiffres a été envoyé par e-mail.'
        : 'Mode développement : nouveau code généré.',
      ...(mailRes.devCode ? { devCode: mailRes.devCode } : {}),
    });
  });

  app.post('/api/auth/verify-email', async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const code = String(req.body?.code ?? '').trim();
    const client = req.body?.client === 'apk' ? 'apk' : 'web';

    if (!isValidEmail(email) || !/^\d{6}$/.test(code)) {
      res.status(400).json({ error: 'Saisissez un code de vérification valide à 6 chiffres.' });
      return;
    }

    const key = `register:${email}`;
    const now = Date.now();

    const verification = await withFileLock('auth_state', () => {
      const state = readAuthState();
      const idx = state.pendingCodes.findIndex((p) => p.key === key);
      if (idx === -1) {
        return { ok: false as const, error: 'Aucun code en attente. Veuillez vous inscrire à nouveau.' };
      }
      const entry = state.pendingCodes[idx];
      if (entry.expiresAt <= now) {
        state.pendingCodes.splice(idx, 1);
        writeAuthState(state);
        return {
          ok: false as const,
          error: 'Ce code a expiré (validité 15 minutes). Demandez un nouveau code.',
        };
      }
      if (entry.attempts >= MAX_CODE_ATTEMPTS) {
        return {
          ok: false as const,
          error: 'Trop de tentatives erronées. Veuillez renvoyer un nouveau code.',
        };
      }
      if (!safeEqualString(sha256(code), entry.codeHash)) {
        entry.attempts += 1;
        writeAuthState(state);
        const remaining = MAX_CODE_ATTEMPTS - entry.attempts;
        return {
          ok: false as const,
          error:
            remaining > 0
              ? `Code incorrect. Il vous reste ${remaining} tentative${remaining > 1 ? 's' : ''}.`
              : 'Trop de tentatives erronées. Veuillez renvoyer un nouveau code.',
        };
      }
      state.pendingCodes.splice(idx, 1);
      writeAuthState(state);
      return {
        ok: true as const,
        name: entry.name || 'Utilisateur',
        passwordHash: entry.passwordHash || '',
      };
    });

    if (!verification.ok) {
      res.status(400).json({ error: verification.error });
      return;
    }

    const created = await withFileLock('accounts', () => {
      const accounts = readAccounts();
      const exists = accounts.find((a) => a.email === email);
      if (exists) {
        return { error: 'Un compte existe déjà avec cette adresse e-mail.' };
      }
      const newAccount: AccountRecord = {
        id: `usr_${now}_${crypto.randomBytes(5).toString('hex')}`,
        name: verification.name,
        email,
        passwordHash: verification.passwordHash,
        authProvider: 'email',
        emailVerified: true,
        disabled: false,
        createdAt: now,
        lastActiveAt: now,
        questionnaireCompleted: false,
        questionnaireStep: 0,
        questionnaire: {},
        preferences: {
          theme: 'light',
          bubbleColor: 'slate',
          textSize: 'normal',
          responseLanguage: 'Français',
          webSearchDefault: false,
          voiceMode: true,
          voiceName: 'Zephyr',
          memoryEnabled: true,
          autoScroll: true,
          enterToSend: true,
        },
      };
      accounts.push(newAccount);
      writeAccounts(accounts);
      return { account: newAccount };
    });

    if ('error' in created) {
      res.status(409).json({ error: created.error });
      return;
    }

    const token = await createUserSession(created.account.id, client);
    setSessionCookie(res, token);
    void sendNewUserAdminNotification(created.account);

    res.json({
      ok: true,
      token,
      user: toPublicUser(created.account),
    });
  });

  app.post('/api/auth/login', async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password ?? '');
    const client = req.body?.client === 'apk' ? 'apk' : 'web';

    if (!isValidEmail(email) || !password) {
      res.status(400).json({ error: 'Veuillez renseigner votre adresse e-mail et votre mot de passe.' });
      return;
    }

    const now = Date.now();
    const lockCheck = await withFileLock('auth_state', () => {
      const state = readAuthState();
      const attempt = state.loginAttempts.find((a) => a.email === email);
      if (attempt && attempt.lockedUntil > now) {
        const mins = Math.ceil((attempt.lockedUntil - now) / 60000);
        return { locked: true, mins };
      }
      return { locked: false, mins: 0 };
    });

    if (lockCheck.locked) {
      res.status(429).json({
        error: `Trop de tentatives de connexion échouées. Réessayez dans ${lockCheck.mins} minute${lockCheck.mins > 1 ? 's' : ''}.`,
      });
      return;
    }

    const account = readAccounts().find((a) => a.email === email);
    if (!account) {
      await recordFailedLogin(email);
      res.status(401).json({ error: 'Adresse e-mail ou mot de passe incorrect.' });
      return;
    }

    if (account.disabled) {
      res.status(403).json({
        error: 'Ce compte a été désactivé par l’administrateur. Contactez ndalagaius3@gmail.com.',
      });
      return;
    }

    if (account.authProvider === 'google' && !account.passwordHash) {
      res.status(400).json({
        error: 'Ce compte utilise la connexion Google. Cliquez sur « Continuer avec Google ».',
      });
      return;
    }

    if (!verifyPassword(password, account.passwordHash)) {
      const info = await recordFailedLogin(email);
      res.status(401).json({
        error:
          info.locked
            ? 'Trop de tentatives incorrectes. Compte temporairement bloqué pendant 15 minutes.'
            : `Adresse e-mail ou mot de passe incorrect (${MAX_LOGIN_ATTEMPTS - info.failedCount} tentative${MAX_LOGIN_ATTEMPTS - info.failedCount > 1 ? 's' : ''} restante${MAX_LOGIN_ATTEMPTS - info.failedCount > 1 ? 's' : ''}).`,
      });
      return;
    }

    await clearFailedLogin(email);

    await withFileLock('accounts', () => {
      const list = readAccounts();
      const target = list.find((a) => a.id === account.id);
      if (target) {
        target.lastActiveAt = now;
        writeAccounts(list);
      }
    });

    const token = await createUserSession(account.id, client);
    setSessionCookie(res, token);

    res.json({
      ok: true,
      token,
      user: toPublicUser({ ...account, lastActiveAt: now }),
    });
  });

  app.post('/api/auth/forgot-password', async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    if (!isValidEmail(email)) {
      res.status(400).json({ error: 'Veuillez saisir une adresse e-mail valide.' });
      return;
    }

    const account = readAccounts().find((a) => a.email === email);
    if (!account) {
      res.status(404).json({
        error: 'Aucun compte n’est associé à cette adresse e-mail.',
      });
      return;
    }
    if (account.disabled) {
      res.status(403).json({ error: 'Ce compte est désactivé.' });
      return;
    }

    const now = Date.now();
    const code = generateSixDigitCode();
    const key = `reset:${email}`;

    const rateCheck = await withFileLock('auth_state', () => {
      const state = readAuthState();
      const prev = state.pendingCodes.find((p) => p.key === key);
      if (prev && now - prev.lastSentAt < RESEND_COOLDOWN_MS) {
        const waitSec = Math.ceil((RESEND_COOLDOWN_MS - (now - prev.lastSentAt)) / 1000);
        return { ok: false as const, waitSec };
      }
      state.pendingCodes = state.pendingCodes.filter((p) => p.key !== key);
      state.pendingCodes.push({
        key,
        type: 'reset',
        email,
        name: account.name,
        codeHash: sha256(code),
        createdAt: now,
        expiresAt: now + CODE_TTL_MS,
        attempts: 0,
        resendCount: prev ? prev.resendCount + 1 : 0,
        lastSentAt: now,
      });
      writeAuthState(state);
      return { ok: true as const };
    });

    if (!rateCheck.ok) {
      res.status(429).json({
        error: `Veuillez patienter ${rateCheck.waitSec} secondes avant de demander un nouveau code.`,
      });
      return;
    }

    const mailRes = await sendPasswordResetEmail(email, account.name, code);
    if (mailRes.error) {
      res.status(503).json({ error: mailRes.error });
      return;
    }

    res.json({
      ok: true,
      message: mailRes.sent
        ? 'Un code de réinitialisation à 6 chiffres vient d’être envoyé par e-mail (valable 15 minutes).'
        : 'Mode développement : utilisez le code affiché pour réinitialiser votre mot de passe.',
      ...(mailRes.devCode ? { devCode: mailRes.devCode } : {}),
    });
  });

  app.post('/api/auth/reset-password', async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const code = String(req.body?.code ?? '').trim();
    const newPassword = String(req.body?.newPassword ?? '');

    if (!isValidEmail(email) || !/^\d{6}$/.test(code)) {
      res.status(400).json({ error: 'Saisissez un code valide à 6 chiffres.' });
      return;
    }
    if (newPassword.length < 8) {
      res.status(400).json({
        error: 'Le nouveau mot de passe doit contenir au moins 8 caractères.',
      });
      return;
    }

    const now = Date.now();
    const key = `reset:${email}`;
    const check = await withFileLock('auth_state', () => {
      const state = readAuthState();
      const idx = state.pendingCodes.findIndex((p) => p.key === key);
      if (idx === -1) {
        return { ok: false as const, error: 'Aucune demande de réinitialisation active pour cet e-mail.' };
      }
      const entry = state.pendingCodes[idx];
      if (entry.expiresAt <= now) {
        state.pendingCodes.splice(idx, 1);
        writeAuthState(state);
        return {
          ok: false as const,
          error: 'Ce code a expiré. Demandez un nouveau code de réinitialisation.',
        };
      }
      if (entry.attempts >= MAX_CODE_ATTEMPTS) {
        return {
          ok: false as const,
          error: 'Trop de tentatives erronées. Veuillez renvoyer un nouveau code.',
        };
      }
      if (!safeEqualString(sha256(code), entry.codeHash)) {
        entry.attempts += 1;
        writeAuthState(state);
        const remaining = MAX_CODE_ATTEMPTS - entry.attempts;
        return {
          ok: false as const,
          error:
            remaining > 0
              ? `Code incorrect. ${remaining} tentative${remaining > 1 ? 's' : ''} restante${remaining > 1 ? 's' : ''}.`
              : 'Trop de tentatives erronées. Demandez un nouveau code.',
        };
      }
      state.pendingCodes.splice(idx, 1);
      writeAuthState(state);
      return { ok: true as const };
    });

    if (!check.ok) {
      res.status(400).json({ error: check.error });
      return;
    }

    const pwdHash = hashPassword(newPassword);
    let targetUserId = '';
    await withFileLock('accounts', () => {
      const accounts = readAccounts();
      const user = accounts.find((a) => a.email === email);
      if (user) {
        user.passwordHash = pwdHash;
        user.emailVerified = true;
        targetUserId = user.id;
        writeAccounts(accounts);
      }
    });

    if (!targetUserId) {
      res.status(404).json({ error: 'Compte introuvable.' });
      return;
    }

    // Revoke previous sessions & clear lockouts
    await withFileLock('auth_state', () => {
      const state = readAuthState();
      state.sessions = state.sessions.filter((s) => s.userId !== targetUserId);
      state.loginAttempts = state.loginAttempts.filter((a) => a.email !== email);
      writeAuthState(state);
    });

    res.json({
      ok: true,
      message: 'Votre mot de passe a été réinitialisé. Vous pouvez maintenant vous connecter.',
    });
  });

  app.post('/api/auth/logout', async (req, res) => {
    const token = extractSessionToken(req);
    if (token) {
      const tokenHash = sha256(token);
      await withFileLock('auth_state', () => {
        const state = readAuthState();
        state.sessions = state.sessions.filter((s) => s.tokenHash !== tokenHash);
        writeAuthState(state);
      });
    }
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  // Google OAuth Start
  app.get('/api/auth/google/start', (req, res) => {
    if (!isGoogleOAuthConfigured()) {
      res.status(503).send('Connexion Google non configurée sur le serveur.');
      return;
    }
    const client = req.query.client === 'apk' ? 'apk' : 'web';
    const state = signOAuthState({ client, ts: Date.now() });
    const redirectUri = `${getBaseOrigin(req)}/api/auth/google/callback`;
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!.trim(),
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      access_type: 'online',
      prompt: 'select_account',
      state,
    });
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
  });

  // Google OAuth Callback
  app.get('/api/auth/google/callback', async (req, res) => {
    if (!isGoogleOAuthConfigured()) {
      res.status(503).send('Connexion Google non configurée.');
      return;
    }
    const code = String(req.query.code ?? '');
    const stateStr = String(req.query.state ?? '');
    const parsedState = verifyOAuthState(stateStr);
    if (!code || !parsedState) {
      res.status(400).send('Paramètres de connexion Google invalides ou expirés.');
      return;
    }

    try {
      const redirectUri = `${getBaseOrigin(req)}/api/auth/google/callback`;
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: process.env.GOOGLE_CLIENT_ID!.trim(),
          client_secret: process.env.GOOGLE_CLIENT_SECRET!.trim(),
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      });
      if (!tokenRes.ok) {
        throw new Error('Échec de l’échange du code Google.');
      }
      const tokenJson = (await tokenRes.json()) as { access_token?: string };
      if (!tokenJson.access_token) {
        throw new Error('Jeton Google manquant.');
      }

      const profileRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${tokenJson.access_token}` },
      });
      if (!profileRes.ok) {
        throw new Error('Impossible de récupérer le profil Google.');
      }
      const profile = (await profileRes.json()) as {
        sub?: string;
        email?: string;
        name?: string;
        email_verified?: boolean;
      };
      const email = normalizeEmail(profile.email);
      if (!email || !profile.sub) {
        throw new Error('Adresse e-mail Google manquante.');
      }

      const now = Date.now();
      let isNew = false;
      const result = await withFileLock('accounts', () => {
        const accounts = readAccounts();
        let account = accounts.find((a) => a.email === email);
        if (account) {
          if (account.disabled) {
            return { disabled: true as const };
          }
          account.googleSub = profile.sub;
          account.emailVerified = true;
          account.lastActiveAt = now;
          if (!account.name && profile.name) {
            account.name = profile.name.trim();
          }
          writeAccounts(accounts);
          return { disabled: false as const, account };
        }

        isNew = true;
        const newAccount: AccountRecord = {
          id: `usr_${now}_${crypto.randomBytes(5).toString('hex')}`,
          name: (profile.name || email.split('@')[0] || 'Utilisateur').trim(),
          email,
          authProvider: 'google',
          googleSub: profile.sub,
          emailVerified: true,
          disabled: false,
          createdAt: now,
          lastActiveAt: now,
          questionnaireCompleted: false,
          questionnaireStep: 0,
          questionnaire: {},
          preferences: {
            theme: 'light',
            bubbleColor: 'slate',
            textSize: 'normal',
            responseLanguage: 'Français',
            webSearchDefault: false,
            voiceMode: true,
            voiceName: 'Zephyr',
            memoryEnabled: true,
            autoScroll: true,
            enterToSend: true,
          },
        };
        accounts.push(newAccount);
        writeAccounts(accounts);
        return { disabled: false as const, account: newAccount };
      });

      if (result.disabled) {
        res
          .status(403)
          .send('Ce compte a été désactivé. Contactez ndalagaius3@gmail.com.');
        return;
      }

      if (isNew) {
        void sendNewUserAdminNotification(result.account);
      }

      const sessionToken = await createUserSession(result.account.id, parsedState.client);
      if (parsedState.client === 'apk') {
        const deepLink = `gaiusia://auth/callback?token=${encodeURIComponent(sessionToken)}`;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(`<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Connexion réussie — Gaius IA</title>
  </head>
  <body style="font-family:system-ui,-apple-system,sans-serif;background:#0f172a;color:#f8fafc;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;text-align:center;">
    <div style="max-width:360px;">
      <h1 style="font-size:20px;margin:0 0 10px;">Connexion réussie</h1>
      <p style="font-size:14px;color:#cbd5e1;margin:0 0 20px;">Retour automatique vers l'application Gaius IA…</p>
      <a href="${deepLink}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:12px;font-size:14px;">Ouvrir Gaius IA</a>
    </div>
    <script>
      window.location.href = ${JSON.stringify(deepLink)};
    </script>
  </body>
</html>`);
        return;
      }

      setSessionCookie(res, sessionToken);
      res.redirect('/');
    } catch (err) {
      console.error('Google OAuth callback error:', err);
      res.status(500).send('Erreur lors de la connexion avec Google. Veuillez réessayer.');
    }
  });

  // Account Profile, Password, Questionnaire, Preferences, Delete
  app.patch('/api/account/profile', requireAuth, async (req: AuthenticatedRequest, res) => {
    const userId = req.authUser!.id;
    const name = String(req.body?.name ?? '').trim();
    if (name.length < 2 || name.length > 80) {
      res.status(400).json({ error: 'Le nom doit contenir entre 2 et 80 caractères.' });
      return;
    }
    const updated = await withFileLock('accounts', () => {
      const accounts = readAccounts();
      const target = accounts.find((a) => a.id === userId);
      if (!target) return null;
      target.name = name;
      target.lastActiveAt = Date.now();
      writeAccounts(accounts);
      return toPublicUser(target);
    });
    if (!updated) {
      res.status(404).json({ error: 'Compte introuvable.' });
      return;
    }
    res.json({ ok: true, user: updated });
  });

  app.post('/api/account/password', requireAuth, async (req: AuthenticatedRequest, res) => {
    const userId = req.authUser!.id;
    const currentPassword = String(req.body?.currentPassword ?? '');
    const newPassword = String(req.body?.newPassword ?? '');

    if (newPassword.length < 8) {
      res.status(400).json({ error: 'Le nouveau mot de passe doit contenir au moins 8 caractères.' });
      return;
    }

    const result = await withFileLock('accounts', () => {
      const accounts = readAccounts();
      const target = accounts.find((a) => a.id === userId);
      if (!target) return { error: 'Compte introuvable.' };
      if (target.passwordHash && !verifyPassword(currentPassword, target.passwordHash)) {
        return { error: 'Le mot de passe actuel est incorrect.' };
      }
      target.passwordHash = hashPassword(newPassword);
      target.lastActiveAt = Date.now();
      writeAccounts(accounts);
      return { ok: true };
    });

    if ('error' in result) {
      res.status(400).json({ error: result.error });
      return;
    }

    res.json({ ok: true, message: 'Mot de passe mis à jour avec succès.' });
  });

  app.patch('/api/account/questionnaire', requireAuth, async (req: AuthenticatedRequest, res) => {
    const userId = req.authUser!.id;
    const completed = Boolean(req.body?.completed);
    const step = Number(req.body?.step);
    const questionnaire = (req.body?.questionnaire ?? {}) as QuestionnaireData;

    const updated = await withFileLock('accounts', () => {
      const accounts = readAccounts();
      const target = accounts.find((a) => a.id === userId);
      if (!target) return null;
      target.questionnaire = {
        ...target.questionnaire,
        ...sanitizeQuestionnaire(questionnaire),
      };
      if (Number.isFinite(step) && step >= 0 && step <= 10) {
        target.questionnaireStep = Math.floor(step);
      }
      if (completed) {
        target.questionnaireCompleted = true;
      }
      target.lastActiveAt = Date.now();
      writeAccounts(accounts);
      return toPublicUser(target);
    });

    if (!updated) {
      res.status(404).json({ error: 'Compte introuvable.' });
      return;
    }
    res.json({ ok: true, user: updated });
  });

  app.patch('/api/account/preferences', requireAuth, async (req: AuthenticatedRequest, res) => {
    const userId = req.authUser!.id;
    const incoming = (req.body?.preferences ?? {}) as Partial<UserPreferences>;
    const updated = await withFileLock('accounts', () => {
      const accounts = readAccounts();
      const target = accounts.find((a) => a.id === userId);
      if (!target) return null;
      target.preferences = {
        ...target.preferences,
        ...sanitizePreferences(incoming),
      };
      target.lastActiveAt = Date.now();
      writeAccounts(accounts);
      return toPublicUser(target);
    });
    if (!updated) {
      res.status(404).json({ error: 'Compte introuvable.' });
      return;
    }
    res.json({ ok: true, user: updated });
  });

  app.delete('/api/account', requireAuth, async (req: AuthenticatedRequest, res) => {
    const user = req.authUser!;
    const password = String(req.body?.password ?? '');
    const confirmText = String(req.body?.confirmText ?? '').trim();

    if (user.passwordHash) {
      if (!password && confirmText !== 'SUPPRIMER') {
        res.status(400).json({
          error: 'Veuillez confirmer avec votre mot de passe ou saisir SUPPRIMER.',
        });
        return;
      }
      if (password && !verifyPassword(password, user.passwordHash)) {
        res.status(400).json({ error: 'Mot de passe incorrect.' });
        return;
      }
    } else if (confirmText !== 'SUPPRIMER') {
      res.status(400).json({
        error: 'Veuillez saisir SUPPRIMER pour confirmer la suppression définitive.',
      });
      return;
    }

    await withFileLock('accounts', () => {
      const accounts = readAccounts();
      writeAccounts(accounts.filter((a) => a.id !== user.id));
    });
    await withFileLock('auth_state', () => {
      const state = readAuthState();
      state.sessions = state.sessions.filter((s) => s.userId !== user.id);
      writeAuthState(state);
    });
    await withFileLock(`workspace:${user.id}`, () => {
      deleteUserWorkspace(user.id);
    });

    clearSessionCookie(res);
    res.json({ ok: true, message: 'Votre compte et toutes vos données ont été supprimés.' });
  });
}

async function recordFailedLogin(email: string): Promise<{ failedCount: number; locked: boolean }> {
  const now = Date.now();
  return withFileLock('auth_state', () => {
    const state = readAuthState();
    let entry = state.loginAttempts.find((a) => a.email === email);
    if (!entry) {
      entry = { email, failedCount: 0, lockedUntil: 0 };
      state.loginAttempts.push(entry);
    }
    if (entry.lockedUntil > 0 && entry.lockedUntil <= now) {
      entry.failedCount = 0;
      entry.lockedUntil = 0;
    }
    entry.failedCount += 1;
    let locked = false;
    if (entry.failedCount >= MAX_LOGIN_ATTEMPTS) {
      entry.lockedUntil = now + LOGIN_LOCK_MS;
      locked = true;
    }
    writeAuthState(state);
    return { failedCount: entry.failedCount, locked };
  });
}

async function clearFailedLogin(email: string): Promise<void> {
  await withFileLock('auth_state', () => {
    const state = readAuthState();
    const before = state.loginAttempts.length;
    state.loginAttempts = state.loginAttempts.filter((a) => a.email !== email);
    if (state.loginAttempts.length !== before) {
      writeAuthState(state);
    }
  });
}

function sanitizeQuestionnaire(q: QuestionnaireData): QuestionnaireData {
  const clean = (v: unknown, max = 300) =>
    typeof v === 'string' ? v.trim().slice(0, max) : undefined;
  return {
    ...(clean(q.role, 80) !== undefined ? { role: clean(q.role, 80) } : {}),
    ...(clean(q.roleOther, 200) !== undefined ? { roleOther: clean(q.roleOther, 200) } : {}),
    ...(clean(q.domain, 100) !== undefined ? { domain: clean(q.domain, 100) } : {}),
    ...(clean(q.domainOther, 200) !== undefined ? { domainOther: clean(q.domainOther, 200) } : {}),
    ...(clean(q.expectation, 120) !== undefined ? { expectation: clean(q.expectation, 120) } : {}),
    ...(clean(q.expectationOther, 240) !== undefined
      ? { expectationOther: clean(q.expectationOther, 240) }
      : {}),
    ...(clean(q.preferredLanguage, 60) !== undefined
      ? { preferredLanguage: clean(q.preferredLanguage, 60) }
      : {}),
    ...(clean(q.preferredLanguageOther, 100) !== undefined
      ? { preferredLanguageOther: clean(q.preferredLanguageOther, 100) }
      : {}),
    ...(clean(q.notes, 800) !== undefined ? { notes: clean(q.notes, 800) } : {}),
  };
}

function sanitizePreferences(p: Partial<UserPreferences>): Partial<UserPreferences> {
  const out: Partial<UserPreferences> = {};
  if (p.theme === 'light' || p.theme === 'dark') out.theme = p.theme;
  if (
    p.bubbleColor === 'slate' ||
    p.bubbleColor === 'cobalt' ||
    p.bubbleColor === 'emerald' ||
    p.bubbleColor === 'indigo' ||
    p.bubbleColor === 'amber'
  ) {
    out.bubbleColor = p.bubbleColor;
  }
  if (p.textSize === 'small' || p.textSize === 'normal' || p.textSize === 'large') {
    out.textSize = p.textSize;
  }
  if (typeof p.responseLanguage === 'string' && p.responseLanguage.trim()) {
    out.responseLanguage = p.responseLanguage.trim().slice(0, 60);
  }
  if (typeof p.webSearchDefault === 'boolean') out.webSearchDefault = p.webSearchDefault;
  if (typeof p.voiceMode === 'boolean') out.voiceMode = p.voiceMode;
  if (
    p.voiceName === 'Zephyr' ||
    p.voiceName === 'Kore' ||
    p.voiceName === 'Puck' ||
    p.voiceName === 'Charon' ||
    p.voiceName === 'Fenrir'
  ) {
    out.voiceName = p.voiceName;
  }
  if (typeof p.memoryEnabled === 'boolean') out.memoryEnabled = p.memoryEnabled;
  if (typeof p.autoScroll === 'boolean') out.autoScroll = p.autoScroll;
  if (typeof p.enterToSend === 'boolean') out.enterToSend = p.enterToSend;
  return out;
}
