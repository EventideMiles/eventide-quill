import { describe, it, expect } from 'vitest';
import { TFile } from 'obsidian';
import { createProposeEntryTool } from '../../../src/ai/tools/propose-entry';
import type { ToolContext } from '../../../src/ai/tools/tool';

interface StubOptions {
    /** Resolved existing file for the proposed name, or null if none. */
    existing: TFile | null;
    /** Body text returned by vault.cachedRead for the existing file. */
    body?: string;
    /** Setting value. Default true. */
    preferEdit?: boolean;
}

function makeCtx(opts: StubOptions): ToolContext {
    const fileByPath = new Map<string, TFile>();
    const linkByName = new Map<string, TFile>();
    if (opts.existing) {
        linkByName.set(opts.existing.basename, opts.existing);
        fileByPath.set(opts.existing.path, opts.existing);
    }
    const bodyFor = new Map<TFile, string>();
    if (opts.existing) bodyFor.set(opts.existing, opts.body ?? '');

    const plugin = {
        settings: { lorePreferEditOverCreate: opts.preferEdit ?? true },
        app: {
            vault: {
                getAbstractFileByPath(path: string): TFile | null {
                    return fileByPath.get(path) ?? null;
                },
                async cachedRead(file: TFile): Promise<string> {
                    return bodyFor.get(file) ?? '';
                }
            },
            metadataCache: {
                getFirstLinkpathDest(link: string): TFile | null {
                    return linkByName.get(link) ?? null;
                }
            }
        },
        coWriterSession: {
            currentLoreDraft: null as unknown,
            resolveRecentImage(): string | null {
                return null;
            }
        }
    };
    return { plugin } as unknown as ToolContext;
}

function makeFile(path: string, basename: string): TFile {
    const f = new TFile();
    f.path = path;
    f.basename = basename;
    return f;
}

describe('propose_entry — existence redirect (lorePreferEditOverCreate)', () => {
    it('stashes a draft when no note with that name exists', async () => {
        const ctx = makeCtx({ existing: null });
        const tool = createProposeEntryTool(false);
        const result = await tool.execute({ name: 'Sarah Connor', content: '# Sarah\n...\n', entry_type: 'character' }, ctx);
        expect(result).toContain('Draft received: "Sarah Connor" (character)');
        const draft = ctx.plugin.coWriterSession.currentLoreDraft;
        expect(draft).not.toBeNull();
        expect(draft?.name).toBe('Sarah Connor');
    });

    it('refuses and routes to insert_note when an empty note exists', async () => {
        const existing = makeFile('Lore/Characters/Sarah Connor.md', 'Sarah Connor');
        const ctx = makeCtx({ existing, body: '   \n  ' });
        const tool = createProposeEntryTool(false);
        const result = await tool.execute({ name: 'Sarah Connor', content: '# Sarah\n...' }, ctx);
        expect(result).toContain('already exists');
        expect(result).toContain(existing.path);
        expect(result).toContain('currently empty');
        expect(result).toContain('insert_note');
        // Draft must NOT be stashed on refusal.
        expect(ctx.plugin.coWriterSession.currentLoreDraft).toBeNull();
    });

    it('refuses and routes to edit_note when a populated note exists', async () => {
        const existing = makeFile('Lore/Characters/Sarah Connor.md', 'Sarah Connor');
        const ctx = makeCtx({ existing, body: 'A'.repeat(420) });
        const tool = createProposeEntryTool(false);
        const result = await tool.execute({ name: 'Sarah Connor', content: '# Sarah\n...' }, ctx);
        expect(result).toContain('already exists');
        expect(result).toContain('420 characters');
        expect(result).toContain('edit_note');
        expect(ctx.plugin.coWriterSession.currentLoreDraft).toBeNull();
    });

    it('bypasses the check when lorePreferEditOverCreate is off', async () => {
        const existing = makeFile('Lore/Characters/Sarah Connor.md', 'Sarah Connor');
        const ctx = makeCtx({ existing, body: 'x'.repeat(500), preferEdit: false });
        const tool = createProposeEntryTool(false);
        const result = await tool.execute({ name: 'Sarah Connor', content: '# Sarah\n...' }, ctx);
        expect(result).toContain('Draft received: "Sarah Connor"');
        expect(ctx.plugin.coWriterSession.currentLoreDraft).not.toBeNull();
    });

    it('still validates required fields before the existence check', async () => {
        const ctx = makeCtx({ existing: null });
        const tool = createProposeEntryTool(false);
        await expect(tool.execute({ name: '', content: 'x' }, ctx)).resolves.toContain('"name" is required');
        await expect(tool.execute({ name: 'X', content: '' }, ctx)).resolves.toContain('"content" is required');
    });
});
