import type { Express, Response } from 'express';
import { type AuthenticatedRequest, requireAuth } from './auth.js';
import {
  MAX_CONVERSATIONS_PER_USER,
  readUserWorkspace,
  withFileLock,
  writeUserWorkspace,
} from './storage.js';
import type { StoredUserWorkspace } from './types.js';

function sanitizeConversation(raw: unknown): (Record<string, unknown> & { id: string; updatedAt: number }) | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === 'string' ? obj.id.trim() : '';
  if (!id) return null;
  const updatedAt = Number(obj.updatedAt) || Date.now();
  return {
    ...obj,
    id,
    updatedAt,
  };
}

export function registerConversationRoutes(app: Express): void {
  app.get('/api/conversations', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.authUser!.id;
    const workspace = await withFileLock(`workspace:${userId}`, () => readUserWorkspace(userId));
    const sorted = [...workspace.conversations].sort((a, b) => b.updatedAt - a.updatedAt);
    res.json({
      conversations: sorted,
      memories: workspace.memories,
      projects: workspace.projects,
      deletedConversationIds: workspace.deletedConversationIds ?? [],
      maxConversations: MAX_CONVERSATIONS_PER_USER,
    });
  });

  app.put('/api/conversations/:id', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.authUser!.id;
    const convId = String(req.params.id ?? '').trim();
    const incoming = sanitizeConversation(req.body?.conversation ?? req.body);
    if (!convId || !incoming || incoming.id !== convId) {
      res.status(400).json({ error: 'Conversation invalide.' });
      return;
    }

    const result = await withFileLock(`workspace:${userId}`, () => {
      const workspace = readUserWorkspace(userId);
      const idx = workspace.conversations.findIndex((c) => c.id === convId);
      if (idx === -1) {
        if (workspace.conversations.length >= MAX_CONVERSATIONS_PER_USER) {
          return {
            ok: false as const,
            error: `Limite maximale de ${MAX_CONVERSATIONS_PER_USER} conversations atteinte. Supprimez d'anciennes conversations pour en enregistrer de nouvelles.`,
          };
        }
        workspace.conversations.push(incoming);
      } else {
        const existing = workspace.conversations[idx];
        // Conflict resolution: server keeps the most recent version
        if (incoming.updatedAt >= existing.updatedAt) {
          workspace.conversations[idx] = incoming;
        }
      }
      workspace.deletedConversationIds = (workspace.deletedConversationIds ?? []).filter(
        (id) => id !== convId,
      );
      workspace.conversations.sort((a, b) => b.updatedAt - a.updatedAt);
      writeUserWorkspace(userId, workspace);
      const saved = workspace.conversations.find((c) => c.id === convId)!;
      return { ok: true as const, conversation: saved };
    });

    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ ok: true, conversation: result.conversation });
  });

  app.post('/api/conversations/sync', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.authUser!.id;
    const clientConvsRaw = Array.isArray(req.body?.conversations) ? req.body.conversations : [];
    const clientDeletedIds = Array.isArray(req.body?.deletedIds)
      ? req.body.deletedIds.filter((x: unknown): x is string => typeof x === 'string')
      : [];
    const clientMemories = Array.isArray(req.body?.memories) ? req.body.memories : null;
    const clientProjects = Array.isArray(req.body?.projects) ? req.body.projects : null;

    const synced = await withFileLock(`workspace:${userId}`, () => {
      const workspace: StoredUserWorkspace = readUserWorkspace(userId);
      const deletedSet = new Set<string>(workspace.deletedConversationIds ?? []);
      for (const delId of clientDeletedIds) {
        deletedSet.add(delId);
      }

      const byId = new Map<string, Record<string, unknown> & { id: string; updatedAt: number }>();
      for (const c of workspace.conversations) {
        if (!deletedSet.has(c.id)) {
          byId.set(c.id, c);
        }
      }

      let limitReached = false;
      for (const raw of clientConvsRaw) {
        const c = sanitizeConversation(raw);
        if (!c) continue;
        if (deletedSet.has(c.id)) continue;
        const existing = byId.get(c.id);
        if (existing) {
          if (c.updatedAt > existing.updatedAt) {
            byId.set(c.id, c);
          }
        } else {
          if (byId.size >= MAX_CONVERSATIONS_PER_USER) {
            limitReached = true;
            continue;
          }
          byId.set(c.id, c);
        }
      }

      if (clientMemories) {
        const memMap = new Map<string, Record<string, unknown> & { id: string }>();
        for (const m of workspace.memories) memMap.set(m.id, m);
        for (const m of clientMemories) {
          if (m && typeof m === 'object' && typeof (m as { id?: unknown }).id === 'string') {
            memMap.set((m as { id: string }).id, m as Record<string, unknown> & { id: string });
          }
        }
        workspace.memories = Array.from(memMap.values());
      }

      if (clientProjects) {
        const projMap = new Map<string, Record<string, unknown> & { id: string }>();
        for (const p of workspace.projects) projMap.set(p.id, p);
        for (const p of clientProjects) {
          if (p && typeof p === 'object' && typeof (p as { id?: unknown }).id === 'string') {
            projMap.set((p as { id: string }).id, p as Record<string, unknown> & { id: string });
          }
        }
        workspace.projects = Array.from(projMap.values());
      }

      workspace.conversations = Array.from(byId.values()).sort((a, b) => b.updatedAt - a.updatedAt);
      workspace.deletedConversationIds = Array.from(deletedSet).slice(-500);
      writeUserWorkspace(userId, workspace);

      return {
        conversations: workspace.conversations,
        memories: workspace.memories,
        projects: workspace.projects,
        deletedConversationIds: workspace.deletedConversationIds,
        limitReached,
        maxConversations: MAX_CONVERSATIONS_PER_USER,
      };
    });

    res.json(synced);
  });

  app.delete('/api/conversations/:id', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.authUser!.id;
    const convId = String(req.params.id ?? '').trim();
    if (!convId) {
      res.status(400).json({ error: 'Identifiant manquant.' });
      return;
    }

    await withFileLock(`workspace:${userId}`, () => {
      const workspace = readUserWorkspace(userId);
      workspace.conversations = workspace.conversations.filter((c) => c.id !== convId);
      const delSet = new Set(workspace.deletedConversationIds ?? []);
      delSet.add(convId);
      workspace.deletedConversationIds = Array.from(delSet).slice(-500);
      writeUserWorkspace(userId, workspace);
    });

    res.json({ ok: true });
  });

  app.put('/api/user-data/memories', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.authUser!.id;
    const memories = Array.isArray(req.body?.memories) ? req.body.memories : [];
    await withFileLock(`workspace:${userId}`, () => {
      const workspace = readUserWorkspace(userId);
      workspace.memories = memories.filter(
        (m: unknown): m is Record<string, unknown> & { id: string } =>
          Boolean(m && typeof m === 'object' && typeof (m as { id?: unknown }).id === 'string'),
      );
      writeUserWorkspace(userId, workspace);
    });
    res.json({ ok: true });
  });

  app.put('/api/user-data/projects', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.authUser!.id;
    const projects = Array.isArray(req.body?.projects) ? req.body.projects : [];
    await withFileLock(`workspace:${userId}`, () => {
      const workspace = readUserWorkspace(userId);
      workspace.projects = projects.filter(
        (p: unknown): p is Record<string, unknown> & { id: string } =>
          Boolean(p && typeof p === 'object' && typeof (p as { id?: unknown }).id === 'string'),
      );
      writeUserWorkspace(userId, workspace);
    });
    res.json({ ok: true });
  });

  app.get('/api/conversations/export', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.authUser!.id;
    const workspace = await withFileLock(`workspace:${userId}`, () => readUserWorkspace(userId));
    const exportPayload = {
      app: 'Gaius IA',
      exportedAt: new Date().toISOString(),
      accountEmail: req.authUser!.email,
      totalConversations: workspace.conversations.length,
      conversations: workspace.conversations,
      memories: workspace.memories,
      projects: workspace.projects,
    };
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="gaius-ia-conversations.json"');
    res.send(JSON.stringify(exportPayload, null, 2));
  });
}
