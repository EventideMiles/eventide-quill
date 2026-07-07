import type { Vault } from 'obsidian';

/**
 * Build an in-memory Vault with a Map-backed adapter for sidecar persistence
 * tests. Shared by conversation-store and feedback-queue test suites so the
 * stub behaviour stays in sync.
 */
export function makeMemoryVault(): Vault {
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
