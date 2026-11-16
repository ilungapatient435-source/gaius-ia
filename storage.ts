import fs from 'node:fs';
import path from 'node:path';
import type { AccountRecord, AuthStateData, StoredUserWorkspace } from './types.js';

export const APP_VERSION = '1.5.0';
export const APP_UPDATED_DATE = '16 novembre 2026';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
export const ACCOUNTS_FILE = path.resolve(process.cwd(), 'data', 'accounts.json');
export const AUTH_STATE_FILE = path.join(DATA_DIR, 'auth_state.json');
export const CONVERSATIONS_DIR = path.join(DATA_DIR, 'conversations');

export const MAX_CONVERSATIONS_PER_USER = Math.max(
  1,
  Number(process.env.MAX_CONVERSATIONS_PER_USER) || 500,
);
export const DAILY_REQUEST_LIMIT = Math.max(
  0,
  Number(process.env.DAILY_REQUEST_LIMIT) || 120,
);

const locks = new Map<string, Promise<void>>();

export async function withFileLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = prev.then(() => next);
  locks.set(key, chained);

  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === chained) {
      locks.delete(key);
    }
  }
}

export function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function writeJsonAtomic(filePath: string, data: unknown): void {
  ensureParentDir(filePath);
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const serialized = JSON.stringify(data, null, 2);
  fs.writeFileSync(tmpPath, serialized, 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

export function readJsonSafe<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw) as T;
  } catch (err) {
    console.warn(`Failed to read JSON file ${filePath}:`, err);
    return fallback;
  }
}

export function sanitizeId(raw: string): string {
  const clean = raw.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!clean) {
    throw new Error('Identifiant invalide.');
  }
  return clean;
}

export function readAccounts(): AccountRecord[] {
  const data = readJsonSafe<{ accounts?: AccountRecord[] } | AccountRecord[]>(ACCOUNTS_FILE, []);
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.accounts)) return data.accounts;
  return [];
}

export function writeAccounts(accounts: AccountRecord[]): void {
  writeJsonAtomic(ACCOUNTS_FILE, { accounts });
}

export function readAuthState(): AuthStateData {
  const fallback: AuthStateData = {
    sessions: [],
    pendingCodes: [],
    loginAttempts: [],
    dailyUsage: {},
  };
  const parsed = readJsonSafe<Partial<AuthStateData>>(AUTH_STATE_FILE, fallback);
  return {
    sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
    pendingCodes: Array.isArray(parsed.pendingCodes) ? parsed.pendingCodes : [],
    loginAttempts: Array.isArray(parsed.loginAttempts) ? parsed.loginAttempts : [],
    dailyUsage: parsed.dailyUsage && typeof parsed.dailyUsage === 'object' ? parsed.dailyUsage : {},
  };
}

export function writeAuthState(state: AuthStateData): void {
  const now = Date.now();
  const pruned: AuthStateData = {
    sessions: state.sessions.filter((s) => s.expiresAt > now),
    pendingCodes: state.pendingCodes.filter((c) => c.expiresAt > now - 60 * 60 * 1000),
    loginAttempts: state.loginAttempts.filter((a) => a.lockedUntil > now || a.failedCount > 0),
    dailyUsage: state.dailyUsage,
  };
  writeJsonAtomic(AUTH_STATE_FILE, pruned);
}

export function getUserWorkspacePath(userId: string): string {
  const safe = sanitizeId(userId);
  return path.join(CONVERSATIONS_DIR, `${safe}.json`);
}

export function readUserWorkspace(userId: string): StoredUserWorkspace {
  const filePath = getUserWorkspacePath(userId);
  const fallback: StoredUserWorkspace = {
    userId,
    updatedAt: 0,
    conversations: [],
    memories: [],
    projects: [],
    deletedConversationIds: [],
  };
  const parsed = readJsonSafe<Partial<StoredUserWorkspace>>(filePath, fallback);
  return {
    userId,
    updatedAt: Number(parsed.updatedAt) || 0,
    conversations: Array.isArray(parsed.conversations) ? parsed.conversations : [],
    memories: Array.isArray(parsed.memories) ? parsed.memories : [],
    projects: Array.isArray(parsed.projects) ? parsed.projects : [],
    deletedConversationIds: Array.isArray(parsed.deletedConversationIds)
      ? parsed.deletedConversationIds
      : [],
  };
}

export function writeUserWorkspace(userId: string, workspace: StoredUserWorkspace): void {
  const filePath = getUserWorkspacePath(userId);
  writeJsonAtomic(filePath, {
    ...workspace,
    userId,
    updatedAt: Date.now(),
  });
}

export function deleteUserWorkspace(userId: string): void {
  try {
    const filePath = getUserWorkspacePath(userId);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    console.warn(`Failed to delete workspace for user ${userId}:`, err);
  }
}
