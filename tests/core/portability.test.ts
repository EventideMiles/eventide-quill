import { describe, it, expect } from 'vitest';
import { normalizePath } from 'obsidian';
import type { DataAdapter } from 'obsidian';
import {
    exportPluginData,
    importPluginData,
    parsePluginDataBundle,
    sanitizeRelPath,
    PLUGIN_DATA_ROOTS,
    PLUGIN_DATA_BUNDLE_SCHEMA_VERSION
} from '../../src/core/portability';

interface Stat {
    type: 'file' | 'folder';
}

/** Minimal in-memory DataAdapter stub backing only the methods the portability module uses. */
function makeAdapter(initial: Record<string, string> = {}) {
    const files = new Map<string, string>();
    for (const [k, v] of Object.entries(initial)) files.set(normalizePath(k), v);

    return {
        async exists(p: string): Promise<boolean> {
            const k = normalizePath(p);
            if (files.has(k)) return true;
            const prefix = k.endsWith('/') ? k : `${k}/`;
            return [...files.keys()].some((key) => key.startsWith(prefix));
        },
        async stat(p: string): Promise<Stat | null> {
            const k = normalizePath(p);
            if (files.has(k)) return { type: 'file' };
            const prefix = k.endsWith('/') ? k : `${k}/`;
            return [...files.keys()].some((key) => key.startsWith(prefix)) ? { type: 'folder' } : null;
        },
        async read(p: string): Promise<string> {
            const v = files.get(normalizePath(p));
            if (v === undefined) throw new Error(`not found: ${p}`);
            return v;
        },
        async write(p: string, content: string): Promise<void> {
            files.set(normalizePath(p), content);
        },
        async mkdir(): Promise<void> {
            // No-op: file writes establish paths; existence is inferred from children.
        },
        async list(dir: string): Promise<{ files: string[]; folders: string[] }> {
            const norm = normalizePath(dir);
            const prefix = norm.endsWith('/') ? norm : `${norm}/`;
            const fileList: string[] = [];
            const folderSet = new Set<string>();
            for (const key of files.keys()) {
                if (key === norm || !key.startsWith(prefix)) continue;
                const rest = key.slice(prefix.length);
                const slash = rest.indexOf('/');
                if (slash === -1) {
                    fileList.push(key);
                } else {
                    folderSet.add(normalizePath(prefix + rest.slice(0, slash)));
                }
            }
            return { files: fileList, folders: [...folderSet] };
        },
        snapshot(): Record<string, string> {
            const out: Record<string, string> = {};
            for (const [k, v] of files) out[k] = v;
            return out;
        }
    };
}

const DATA_DIR = '.obsidian/plugins/eventide-quill';

describe('portability — allowlist', () => {
    it('covers the known sidecar roots', () => {
        expect(PLUGIN_DATA_BUNDLE_SCHEMA_VERSION).toBe(1);
        for (const root of ['data.json', 'co-writer-sessions', 'feedback-queue', 'dashboards', 'fandom-cache', 'writing-goals.json']) {
            expect(PLUGIN_DATA_ROOTS).toContain(root);
        }
    });
});

describe('exportPluginData', () => {
    it('bundles the allowlisted roots and excludes plugin code files', async () => {
        const src = makeAdapter({
            [`${DATA_DIR}/data.json`]: '{"linterMode":"all"}',
            [`${DATA_DIR}/main.js`]: 'BUNDLED CODE',
            [`${DATA_DIR}/manifest.json`]: '{"id":"eventide-quill"}',
            [`${DATA_DIR}/styles.css`]: 'body{}',
            [`${DATA_DIR}/co-writer-sessions/index.json`]: '{}',
            [`${DATA_DIR}/co-writer-sessions/sess-1.json`]: '{"id":"sess-1"}',
            [`${DATA_DIR}/writing-goals.json`]: '{"streak":3}'
        });
        const bundle = await exportPluginData(src as unknown as DataAdapter, DATA_DIR, 'eventide-quill');

        expect(bundle.schemaVersion).toBe(1);
        expect(bundle.pluginId).toBe('eventide-quill');
        expect(Object.keys(bundle.files).sort()).toEqual(
            ['co-writer-sessions/index.json', 'co-writer-sessions/sess-1.json', 'data.json', 'writing-goals.json']
        );
        // Plugin code must NOT ship in the backup.
        expect(bundle.files['main.js']).toBeUndefined();
    });

    it('produces an empty bundle when nothing exists yet', async () => {
        const src = makeAdapter({});
        const bundle = await exportPluginData(src as unknown as DataAdapter, DATA_DIR, 'eventide-quill');
        expect(bundle.files).toEqual({});
    });
});

describe('importPluginData — round trip', () => {
    it('restores files into a fresh data directory', async () => {
        const src = makeAdapter({
            [`${DATA_DIR}/data.json`]: '{"linterMode":"all"}',
            [`${DATA_DIR}/co-writer-sessions/sess-1.json`]: '{"id":"sess-1"}',
            [`${DATA_DIR}/feedback-queue/fq-1.json`]: '{}'
        });
        const bundle = await exportPluginData(src as unknown as DataAdapter, DATA_DIR, 'eventide-quill');

        const dst = makeAdapter();
        const written = await importPluginData(dst as unknown as DataAdapter, DATA_DIR, bundle);
        expect(written).toBe(3);
        expect(await dst.read(`${DATA_DIR}/co-writer-sessions/sess-1.json`)).toBe('{"id":"sess-1"}');
        expect(await dst.read(`${DATA_DIR}/data.json`)).toBe('{"linterMode":"all"}');
    });
});

describe('importPluginData — security', () => {
    it('refuses paths that escape the data directory', async () => {
        const dst = makeAdapter();
        const bundle = {
            schemaVersion: 1,
            exportedAt: '',
            pluginId: 'eventide-quill',
            files: {
                '../escape.json': 'evil',
                '/absolute.json': 'evil',
                'co-writer-sessions/../../escape2.json': 'evil',
                'legit.json': 'good'
            }
        };
        const written = await importPluginData(dst as unknown as DataAdapter, DATA_DIR, bundle);
        expect(written).toBe(1);
        expect(await dst.exists(`${DATA_DIR}/legit.json`)).toBe(true);
        const snap = dst.snapshot();
        expect(Object.keys(snap).some((k) => k.includes('escape'))).toBe(false);
    });

    it('rejects a bundle missing schemaVersion or files', async () => {
        const dst = makeAdapter();
        await expect(importPluginData(dst as unknown as DataAdapter, DATA_DIR, { files: {} } as never)).rejects.toThrow();
        await expect(
            importPluginData(dst as unknown as DataAdapter, DATA_DIR, { schemaVersion: 1 } as never)
        ).rejects.toThrow();
    });
});

describe('parsePluginDataBundle', () => {
    it('parses a valid bundle and fills optional fields', () => {
        const bundle = parsePluginDataBundle(JSON.stringify({ schemaVersion: 1, files: { 'a.json': 'x' } }));
        expect(bundle.schemaVersion).toBe(1);
        expect(bundle.files['a.json']).toBe('x');
        expect(bundle.exportedAt).toBe('');
    });

    it('rejects non-backup JSON', () => {
        expect(() => parsePluginDataBundle('not json')).toThrow();
        expect(() => parsePluginDataBundle(JSON.stringify({ foo: 1 }))).toThrow();
        expect(() => parsePluginDataBundle(JSON.stringify({ schemaVersion: 1 }))).toThrow();
    });
});

describe('sanitizeRelPath', () => {
    it.each([
        ['ok.json', 'ok.json'],
        ['co-writer-sessions/sess-1.json', 'co-writer-sessions/sess-1.json'],
        ['../escape.json', null],
        ['a/../../escape.json', null],
        ['/absolute.json', null],
        ['', null]
    ])('sanitizeRelPath(%j) -> %j', (input, expected) => {
        expect(sanitizeRelPath(input)).toBe(expected);
    });
});
