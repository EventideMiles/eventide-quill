import type { Vault } from 'obsidian';

/** Options for {@link makeMemoryVault}. */
export interface MemoryVaultOptions {
    /**
     * Binary files pre-seeded into the adapter (path → bytes), readable via
     * `adapter.readBinary` and replaceable via `adapter.writeBinary`. Lets the
     * attachment-hygiene tests stage image bytes without real files.
     */
    binaries?: Record<string, Uint8Array>;
}

/**
 * Build an in-memory Vault with a Map-backed adapter for sidecar persistence
 * tests. Shared by conversation-store, feedback-queue, and attachment-hygiene
 * test suites so the stub behaviour stays in sync.
 *
 * Binary surface (`readBinary` / `writeBinary` / `createBinary`) is backed by
 * a second in-memory Map exposed as `__binaries` for assertions. The plain
 * no-argument shape is unchanged from when the helper only served text
 * sidecars.
 */
export function makeMemoryVault(options: MemoryVaultOptions = {}): Vault {
    const files = new Map<string, string>();
    const binaries = new Map<string, ArrayBuffer>();
    for (const [path, bytes] of Object.entries(options.binaries ?? {})) {
        binaries.set(path, bytes.slice().buffer as ArrayBuffer);
    }
    const adapter = {
        async exists(p: string): Promise<boolean> {
            return files.has(p) || binaries.has(p);
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
            binaries.delete(p);
        },
        async readBinary(p: string): Promise<ArrayBuffer> {
            const buf = binaries.get(p);
            if (!buf) throw new Error(`file not found: ${p}`);
            return buf.slice(0);
        },
        async writeBinary(p: string, data: ArrayBuffer): Promise<void> {
            binaries.set(p, data.slice(0));
        }
    };
    const vault = {
        adapter,
        async createBinary(p: string, data: ArrayBuffer): Promise<unknown> {
            binaries.set(p, data.slice(0));
            return { path: p, stat: { size: data.byteLength } };
        }
    } as unknown as Vault;
    // Test-visible handle for binary assertions (non-standard, cast on).
    (vault as unknown as { __binaries: Map<string, ArrayBuffer> }).__binaries = binaries;
    return vault;
}
