import { describe, it, expect } from 'vitest';
import { hashString, embeddingDataPath } from '../../src/ai/embedding-cache';

describe('hashString', () => {
    it('returns an 8-char hex string', () => {
        const hash = hashString('hello world');
        expect(hash).toMatch(/^[0-9a-f]{8}$/);
    });

    it('is deterministic for the same input', () => {
        expect(hashString('test content')).toBe(hashString('test content'));
    });

    it('produces different hashes for different inputs', () => {
        expect(hashString('input one')).not.toBe(hashString('input two'));
    });

    it('returns a known hash for a known input (FNV-1a)', () => {
        // FNV-1a of empty string with the standard offset basis is 0x811c9dc5.
        // Our implementation starts with that basis and processes zero chars.
        expect(hashString('')).toBe('811c9dc5');
    });

    it('handles unicode text', () => {
        const hash = hashString('héllo wörld 日本語');
        expect(hash).toMatch(/^[0-9a-f]{8}$/);
    });
});

describe('embeddingDataPath', () => {
    it('resolves to the embeddings filename under the folder', () => {
        const path = embeddingDataPath('Lore/Characters');
        expect(path).toContain('quill-embeddings.json');
        expect(path).toContain('Lore');
    });

    it('normalizes the folder path', () => {
        const path = embeddingDataPath('Lore//Characters/');
        expect(path).not.toContain('//');
        expect(path).not.toMatch(/\/$/);
    });
});
