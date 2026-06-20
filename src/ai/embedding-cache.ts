import { normalizePath, Vault } from 'obsidian';
import type { AiProvider } from './provider';

/** Filename for the per-folder embedding cache. */
const EMBEDDINGS_FILENAME = 'quill-embeddings.json';

/** A single cached embedding entry. */
export interface EmbeddingEntry {
    /** Content hash of the chunk text (FNV-1a). Used for incremental updates. */
    hash: string;
    /** The embedding vector. */
    embedding: number[];
    /** Source file path (vault-relative). */
    filePath: string;
    /** Chunk index within the source file. */
    chunkIndex: number;
    /** The chunk text (stored for retrieval without re-reading files). */
    chunkText: string;
}

/** On-disk format for the embedding cache. */
export interface EmbeddingCacheData {
    /** Schema version for forward compatibility. */
    schemaVersion: number;
    /** The model ID used to generate these embeddings. If the model changes, the cache is invalidated. */
    modelId: string;
    /** Epoch milliseconds when the cache was last updated. */
    generatedAt: number;
    /** Cached embedding entries. */
    entries: EmbeddingEntry[];
}

const SCHEMA_VERSION = 1;

/**
 * FNV-1a string hash. Fast, good distribution for prose text.
 * Returns a hex string. Not cryptographic — just for cache invalidation.
 */
export function hashString(text: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Resolve the vault-relative path to the embedding cache file for a folder. */
export function embeddingDataPath(folder: string): string {
    const clean = normalizePath(folder);
    return clean.length > 0 ? normalizePath(`${clean}/${EMBEDDINGS_FILENAME}`) : EMBEDDINGS_FILENAME;
}

/** Whether a folder is the vault root (never embedded). */
export function isRootFolder(folder: string): boolean {
    const clean = normalizePath(folder);
    return clean.length === 0;
}

/**
 * Per-folder embedding cache. Stores pre-computed embeddings keyed by
 * content hash so only changed chunks need re-embedding.
 *
 * Lives at `{folder}/quill-embeddings.json`, parallel to `quill-data.json`.
 * Root folder (`''`) is never cached — it would embed the entire vault.
 */
export class EmbeddingCache {
    private folder: string;
    private modelId: string;
    private entries: Map<string, EmbeddingEntry>;
    private dirty = false;

    private constructor(folder: string, modelId: string, entries: EmbeddingEntry[]) {
        this.folder = folder;
        this.modelId = modelId;
        this.entries = new Map(entries.map((e) => [e.hash, e]));
    }

    /** Create an empty cache for a folder + model. */
    static empty(folder: string, modelId: string): EmbeddingCache {
        return new EmbeddingCache(folder, modelId, []);
    }

    /**
     * Load the embedding cache for a folder. If the file doesn't exist or
     * the model ID doesn't match, returns an empty cache.
     */
    static async load(vault: Vault, folder: string, modelId: string): Promise<EmbeddingCache> {
        if (isRootFolder(folder)) return EmbeddingCache.empty(folder, modelId);

        const path = embeddingDataPath(folder);
        try {
            const exists = await vault.adapter.exists(path);
            if (!exists) return EmbeddingCache.empty(folder, modelId);

            const raw = await vault.adapter.read(path);
            const parsed = JSON.parse(raw) as EmbeddingCacheData;

            // Model mismatch → stale dimensionality. Start fresh.
            if (parsed.modelId !== modelId) {
                return EmbeddingCache.empty(folder, modelId);
            }

            const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
            return new EmbeddingCache(folder, modelId, entries);
        } catch {
            return EmbeddingCache.empty(folder, modelId);
        }
    }

    /** Save the cache to disk if it has changed. */
    async save(vault: Vault): Promise<void> {
        if (!this.dirty) return;
        if (isRootFolder(this.folder)) return;

        const path = embeddingDataPath(this.folder);
        try {
            const dir = normalizePath(this.folder);
            if (dir.length > 0 && !(await vault.adapter.exists(dir))) {
                await vault.adapter.mkdir(dir);
            }

            const data: EmbeddingCacheData = {
                schemaVersion: SCHEMA_VERSION,
                modelId: this.modelId,
                generatedAt: Date.now(),
                entries: Array.from(this.entries.values())
            };
            await vault.adapter.write(path, JSON.stringify(data));
            this.dirty = false;
        } catch {
            // Best-effort — embedding cache is not critical.
        }
    }

    /** Look up a cached embedding by content hash. */
    get(hash: string): EmbeddingEntry | undefined {
        return this.entries.get(hash);
    }

    /** Add or update an entry. Marks the cache as dirty. */
    set(entry: EmbeddingEntry): void {
        this.entries.set(entry.hash, entry);
        this.dirty = true;
    }

    /** Number of cached entries. */
    get size(): number {
        return this.entries.size;
    }

    /** Whether the cache has unsaved changes. */
    get isDirty(): boolean {
        return this.dirty;
    }

    /** Get all cached entries (for retrieval without re-reading files). */
    getAll(): EmbeddingEntry[] {
        return Array.from(this.entries.values());
    }

    /**
     * Ensure all chunks have embeddings. Uses cached embeddings where the
     * content hash matches; embeds only uncached chunks via the provider.
     * Returns the chunks with their `embedding` field populated.
     */
    async ensureEmbeddings(
        provider: AiProvider,
        chunks: Array<{ text: string; hash?: string; embedding?: number[]; filePath?: string; chunkIndex?: number }>,
        modelId?: string
    ): Promise<void> {
        const toEmbed: { text: string; index: number }[] = [];

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i]!;
            const hash = chunk.hash ?? hashString(chunk.text);
            chunk.hash = hash;

            const cached = this.get(hash);
            if (cached && cached.embedding.length > 0) {
                chunk.embedding = cached.embedding;
            } else {
                toEmbed.push({ text: chunk.text, index: i });
            }
        }

        if (toEmbed.length === 0) return;

        // Batch embed all uncached chunks.
        const texts = toEmbed.map((c) => c.text);
        const result = await provider.embed({ input: texts, model: modelId });

        for (let i = 0; i < toEmbed.length; i++) {
            const { text, index } = toEmbed[i]!;
            const embedding = result.embeddings[i];
            if (!embedding) continue;

            const chunk = chunks[index]!;
            chunk.embedding = embedding;

            // Cache the new embedding.
            this.set({
                hash: chunk.hash!,
                embedding,
                filePath: chunk.filePath ?? '',
                chunkIndex: chunk.chunkIndex ?? index,
                chunkText: text
            });
        }
    }
}

/**
 * Cosine similarity between two vectors.
 * Exported for use by ranking functions.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
        const av = a[i]!;
        const bv = b[i]!;
        dot += av * bv;
        na += av * av;
        nb += bv * bv;
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom === 0 ? 0 : dot / denom;
}

/**
 * Rank chunks by cosine similarity to a query embedding.
 * Chunks must already have their `embedding` field populated.
 * Returns the top-K chunks sorted by descending similarity.
 */
export function rankBySimilarity<T extends { embedding?: number[] }>(
    chunks: T[],
    queryEmbedding: number[],
    topK: number = 10
): T[] {
    const scored = chunks.map((chunk) => ({
        chunk,
        score: chunk.embedding ? cosineSimilarity(chunk.embedding, queryEmbedding) : 0
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).map((s) => s.chunk);
}

/**
 * Find all non-root folders in the vault that directly contain markdown files.
 * Returns a set of folder paths (vault-relative, no trailing slash).
 */
export function findEmbeddableFolders(allMarkdownPaths: string[]): Set<string> {
    const folders = new Set<string>();
    for (const path of allMarkdownPaths) {
        const lastSlash = path.lastIndexOf('/');
        if (lastSlash <= 0) continue; // root file (no folder or root folder)
        const folder = path.substring(0, lastSlash);
        folders.add(folder);
    }
    return folders;
}
