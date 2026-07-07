import { describe, it, expect } from 'vitest';
import type { Vault } from 'obsidian';
import {
    resolveSessionsDir,
    listSessions,
    saveSession,
    loadSession,
    deleteSession
} from '../../src/ai/conversation-store';
import type { SerializedCoWriterState } from '../../src/ai/co-writer';

/** Build an in-memory Vault with a Map-backed adapter for sidecar persistence tests. */
function makeMemoryVault(): Vault {
    const files = new Map<string, string>();
    const adapter = {
        async exists(p: string): Promise<boolean> {
            return files.has(p);
        },
        async mkdir(): Promise<void> {},
        async read(p: string): Promise<string> {
            return files.get(p) ?? '';
        },
        async write(p: string, data: string): Promise<void> {
            files.set(p, data);
        },
        async remove(p: string): Promise<void> {
            files.delete(p);
        }
    };
    return { adapter } as unknown as Vault;
}

/** Minimal valid state that passes the isValidState() shape check. */
function makeState(title?: string): SerializedCoWriterState {
    return {
        mode: 'discuss',
        chatHistory: title ? [{ id: 'm1', role: 'user', content: title }] : [],
        discussCurrentMessages: [],
        loreCoachMessages: [],
        manuscriptPath: null,
        voiceProfile: null,
        contextFilePaths: [],
        recentImages: [],
        fulfillChanges: { edits: [], nextId: 0 },
        directChanges: { edits: [], nextId: 0 },
        loreEdits: [],
        proposedLoreImages: [],
        subagents: [],
        activeSubagentId: null,
        coachSession: null,
        coachActive: false,
        loreCoachSession: null,
        loreCoachActive: false,
        currentLoreDraft: null,
        currentOptions: []
    } as unknown as SerializedCoWriterState;
}

describe('resolveSessionsDir', () => {
    it('resolves the sessions folder under the plugin data dir', () => {
        const dir = resolveSessionsDir('.obsidian/plugins/eventide-quill');
        expect(dir).toContain('co-writer-sessions');
    });
});

describe('saveSession + loadSession round-trip', () => {
    const dir = 'sessions';

    it('saves a new session and loads it back', async () => {
        const vault = makeMemoryVault();
        const entry = await saveSession(vault, dir, makeState('Hello world'));
        expect(entry.id).toMatch(/^cw_/);
        expect(entry.title).toBe('Hello world');

        const loaded = await loadSession(vault, dir, entry.id);
        expect(loaded).not.toBeNull();
        expect(loaded!.mode).toBe('discuss');
    });

    it('preserves createdAt on overwrite', async () => {
        const vault = makeMemoryVault();
        const first = await saveSession(vault, dir, makeState('Original'));
        const originalCreatedAt = first.createdAt;

        // Wait a bit so updatedAt differs.
        await new Promise((r) => setTimeout(r, 10));

        const updated = await saveSession(vault, dir, makeState('Updated'), { id: first.id });
        expect(updated.createdAt).toBe(originalCreatedAt);
        expect(updated.updatedAt).toBeGreaterThanOrEqual(originalCreatedAt);
        expect(updated.title).toBe('Updated');
    });

    it('derives title from first user message', async () => {
        const vault = makeMemoryVault();
        const entry = await saveSession(vault, dir, makeState('A very long title that should be truncated'));
        expect(entry.title).toContain('A very long title');
    });

    it('uses "Untitled" when no user messages exist', async () => {
        const vault = makeMemoryVault();
        const entry = await saveSession(vault, dir, makeState());
        expect(entry.title).toBe('Untitled');
    });
});

describe('listSessions', () => {
    it('returns empty array when no sessions exist', async () => {
        const vault = makeMemoryVault();
        expect(await listSessions(vault, 'sessions')).toEqual([]);
    });

    it('returns sessions sorted newest-first by updatedAt', async () => {
        const vault = makeMemoryVault();
        const e1 = await saveSession(vault, 'sessions', makeState('First'));
        await new Promise((r) => setTimeout(r, 15));
        const e2 = await saveSession(vault, 'sessions', makeState('Second'));

        const list = await listSessions(vault, 'sessions');
        expect(list).toHaveLength(2);
        expect(list[0]!.id).toBe(e2.id);
        expect(list[1]!.id).toBe(e1.id);
    });
});

describe('saveSession LRU eviction', () => {
    it('evicts oldest sessions beyond the limit', async () => {
        const vault = makeMemoryVault();
        const dir = 'sessions';
        const e1 = await saveSession(vault, dir, makeState('First'), { limit: 2 });
        await new Promise((r) => setTimeout(r, 15));
        await saveSession(vault, dir, makeState('Second'), { limit: 2 });
        await new Promise((r) => setTimeout(r, 15));
        await saveSession(vault, dir, makeState('Third'), { limit: 2 });

        const list = await listSessions(vault, dir);
        expect(list).toHaveLength(2);
        // The oldest (e1) should have been evicted.
        expect(list.find((e) => e.id === e1.id)).toBeUndefined();
    });

    it('deletes the sidecar file on eviction', async () => {
        const vault = makeMemoryVault();
        const dir = 'sessions';
        const e1 = await saveSession(vault, dir, makeState('First'), { limit: 1 });
        await new Promise((r) => setTimeout(r, 15));
        await saveSession(vault, dir, makeState('Second'), { limit: 1 });

        // e1 should be evicted; loading it should return null.
        expect(await loadSession(vault, dir, e1.id)).toBeNull();
    });
});

describe('deleteSession', () => {
    it('removes the session sidecar and index row', async () => {
        const vault = makeMemoryVault();
        const dir = 'sessions';
        const entry = await saveSession(vault, dir, makeState('ToDelete'));
        await deleteSession(vault, dir, entry.id);
        expect(await loadSession(vault, dir, entry.id)).toBeNull();
        const list = await listSessions(vault, dir);
        expect(list.find((e) => e.id === entry.id)).toBeUndefined();
    });

    it('is a no-op for a non-existent id', async () => {
        const vault = makeMemoryVault();
        await expect(deleteSession(vault, 'sessions', 'cw_nonexistent')).resolves.not.toThrow();
    });
});

describe('loadSession validation', () => {
    it('returns null for a non-existent session', async () => {
        const vault = makeMemoryVault();
        expect(await loadSession(vault, 'sessions', 'cw_missing')).toBeNull();
    });

    it('returns null for a malformed id', async () => {
        const vault = makeMemoryVault();
        expect(await loadSession(vault, 'sessions', '../../../etc/passwd')).toBeNull();
    });
});
