import { describe, it, expect, vi } from 'vitest';
import {
    resolveQueueDir,
    mintJobId,
    listFeedbackJobs,
    saveFeedbackJob,
    loadFeedbackJob,
    deleteFeedbackJob
} from '../../src/ai/feedback-queue';
import type { FeedbackJob } from '../../src/ai/feedback-queue';
import { makeMemoryVault } from '../helpers/memory-vault';

function makeJob(overrides: Partial<FeedbackJob> = {}): FeedbackJob {
    return {
        id: mintJobId(),
        title: 'Test job',
        engine: 'editorial',
        manuscriptPath: 'manuscript/chapter1.md',
        scope: 'document',
        contextSnapshot: {
            kind: 'editorial',
            contentMessages: [],
            vaultContext: '',
            narrativePreset: { id: 'default', label: 'Default', description: '' } as unknown
        } as FeedbackJob['contextSnapshot'],
        status: 'queued',
        createdAt: Date.now(),
        ...overrides
    };
}

describe('resolveQueueDir', () => {
    it('resolves the queue folder under the plugin data dir', () => {
        expect(resolveQueueDir('.obsidian/plugins/eventide-quill')).toContain('feedback-queue');
    });
});

describe('mintJobId', () => {
    it('produces an fq_ prefixed id', () => {
        expect(mintJobId()).toMatch(/^fq_/);
    });

    it('produces unique ids', () => {
        // The full id is `fq_<base36-ts>_<base36-rand>`. All 20 calls land in
        // the same millisecond, so the timestamp prefix is identical and
        // uniqueness rests entirely on the random suffix (a 46656-value space).
        // The real RNG can collide there (birthday paradox), which made a naive
        // `size === 20` assertion flaky in CI. Stub Math.random to a strictly-
        // increasing sequence so the suffixes are guaranteed distinct — this
        // still verifies the suffix actually varies with the RNG (a constant or
        // broken random would collapse to one id).
        let i = 0;
        const spy = vi.spyOn(Math, 'random').mockImplementation(() => i++ / 20);
        const ids = new Set<string>();
        for (let j = 0; j < 20; j++) ids.add(mintJobId());
        spy.mockRestore();
        expect(ids.size).toBe(20);
    });
});

describe('saveFeedbackJob + loadFeedbackJob round-trip', () => {
    it('saves and loads a job', async () => {
        const vault = makeMemoryVault();
        const job = makeJob();
        const result = await saveFeedbackJob(vault, 'queue', job);
        expect(result.entry.id).toBe(job.id);

        const loaded = await loadFeedbackJob(vault, 'queue', job.id);
        expect(loaded).not.toBeNull();
        expect(loaded!.title).toBe('Test job');
        expect(loaded!.engine).toBe('editorial');
    });

    it('strips reportMarkdown at persist time', async () => {
        const vault = makeMemoryVault();
        const job = makeJob({ reportMarkdown: '# Secret report content' });
        await saveFeedbackJob(vault, 'queue', job);

        const loaded = await loadFeedbackJob(vault, 'queue', job.id);
        expect(loaded!.reportMarkdown).toBeUndefined();
    });

    it('preserves reportNotePath (the vault pointer)', async () => {
        const vault = makeMemoryVault();
        const job = makeJob({ reportNotePath: 'reports/quill-report-test.md' });
        await saveFeedbackJob(vault, 'queue', job);
        const loaded = await loadFeedbackJob(vault, 'queue', job.id);
        expect(loaded!.reportNotePath).toBe('reports/quill-report-test.md');
    });
});

describe('loadFeedbackJob running→queued restore', () => {
    it('restores a running job as queued on load', async () => {
        const vault = makeMemoryVault();
        const job = makeJob({ status: 'running' });
        await saveFeedbackJob(vault, 'queue', job);
        const loaded = await loadFeedbackJob(vault, 'queue', job.id);
        expect(loaded!.status).toBe('queued');
    });

    it('does not change succeeded status on load', async () => {
        const vault = makeMemoryVault();
        const job = makeJob({ status: 'succeeded', completedAt: Date.now() });
        await saveFeedbackJob(vault, 'queue', job);
        const loaded = await loadFeedbackJob(vault, 'queue', job.id);
        expect(loaded!.status).toBe('succeeded');
    });
});

describe('listFeedbackJobs', () => {
    it('returns empty array when no jobs exist', async () => {
        const vault = makeMemoryVault();
        expect(await listFeedbackJobs(vault, 'queue')).toEqual([]);
    });

    it('returns jobs sorted newest-first by createdAt', async () => {
        const vault = makeMemoryVault();
        const j1 = makeJob({ createdAt: 1000 });
        const j2 = makeJob({ createdAt: 2000 });
        await saveFeedbackJob(vault, 'queue', j1);
        await saveFeedbackJob(vault, 'queue', j2);

        const list = await listFeedbackJobs(vault, 'queue');
        expect(list).toHaveLength(2);
        expect(list[0]!.id).toBe(j2.id);
        expect(list[1]!.id).toBe(j1.id);
    });
});

describe('deleteFeedbackJob', () => {
    it('removes the job sidecar and index row', async () => {
        const vault = makeMemoryVault();
        const job = makeJob();
        await saveFeedbackJob(vault, 'queue', job);
        await deleteFeedbackJob(vault, 'queue', job.id);
        expect(await loadFeedbackJob(vault, 'queue', job.id)).toBeNull();
        const list = await listFeedbackJobs(vault, 'queue');
        expect(list.find((e) => e.id === job.id)).toBeUndefined();
    });

    it('is a no-op for a non-existent id', async () => {
        const vault = makeMemoryVault();
        await expect(deleteFeedbackJob(vault, 'queue', 'fq_missing')).resolves.not.toThrow();
    });
});

describe('saveFeedbackJob LRU eviction', () => {
    it('evicts oldest completed jobs beyond the limit', async () => {
        const vault = makeMemoryVault();
        const dir = 'queue';
        const j1 = makeJob({ status: 'succeeded', completedAt: 1000 });
        const j2 = makeJob({ status: 'succeeded', completedAt: 2000 });
        const j3 = makeJob({ status: 'succeeded', completedAt: 3000 });

        await saveFeedbackJob(vault, dir, j1, 2);
        await saveFeedbackJob(vault, dir, j2, 2);
        const result = await saveFeedbackJob(vault, dir, j3, 2);

        expect(result.evictedIds).toContain(j1.id);
        expect(await loadFeedbackJob(vault, dir, j1.id)).toBeNull();
    });

    it('never evicts active (queued/running) jobs', async () => {
        const vault = makeMemoryVault();
        const dir = 'queue';
        // Three active jobs, limit 1 — none should be evicted.
        const j1 = makeJob({ status: 'queued' });
        const j2 = makeJob({ status: 'queued' });
        await saveFeedbackJob(vault, dir, j1, 1);
        const result = await saveFeedbackJob(vault, dir, j2, 1);
        expect(result.evictedIds).toEqual([]);
    });
});

describe('loadFeedbackJob validation', () => {
    it('returns null for a non-existent job', async () => {
        const vault = makeMemoryVault();
        expect(await loadFeedbackJob(vault, 'queue', 'fq_missing')).toBeNull();
    });

    it('returns null for a malformed id', async () => {
        const vault = makeMemoryVault();
        expect(await loadFeedbackJob(vault, 'queue', '../../../etc/passwd')).toBeNull();
    });
});
