import { ExtractedEntity, VoiceMarker } from './types';

interface CachedContext {
    entities: ExtractedEntity[];
    voice: VoiceMarker;
    timestamp: number;
}

export class ContextCache {
    private cache = new Map<string, CachedContext>();

    /** Get cached context for a file, or null if not cached. */
    get(filePath: string): CachedContext | null {
        return this.cache.get(filePath) ?? null;
    }

    /** Store context for a file. */
    set(filePath: string, data: { entities: ExtractedEntity[]; voice: VoiceMarker }): void {
        this.cache.set(filePath, { ...data, timestamp: Date.now() });
    }

    /** Invalidate cached context for a specific file. */
    invalidate(filePath: string): void {
        this.cache.delete(filePath);
    }

    /** Invalidate all cached context. */
    invalidateAll(): void {
        this.cache.clear();
    }

    /** Check if a file has cached context. */
    has(filePath: string): boolean {
        return this.cache.has(filePath);
    }
}
