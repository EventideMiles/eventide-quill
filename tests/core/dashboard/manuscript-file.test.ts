import { describe, it, expect } from 'vitest';
import { manuscriptDataPath } from '../../../src/core/dashboard/manuscript-file';

describe('manuscriptDataPath', () => {
    it('resolves to the manuscript data filename under the folder', () => {
        const path = manuscriptDataPath('manuscript');
        expect(path).toContain('quill-data.json');
        expect(path).toContain('manuscript');
    });

    it('normalizes the folder path', () => {
        const path = manuscriptDataPath('manuscript//chapters/');
        expect(path).not.toContain('//');
        expect(path).not.toMatch(/\/$/);
    });

    it('produces different paths for different folders', () => {
        expect(manuscriptDataPath('folder-a')).not.toBe(manuscriptDataPath('folder-b'));
    });
});
