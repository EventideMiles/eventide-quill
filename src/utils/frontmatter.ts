import { App, TFile } from 'obsidian';
import type { ExtractedEntity, EntityType } from '../core/context-engine/types';

export interface QuillContextData {
    pinnedEntities?: string[];
    removedEntities?: string[];
    addedEntities?: string[];
    addedFiles?: string[];
    pinnedFiles?: string[];
    removedFiles?: string[];
}

/** Read quill context data from a file's frontmatter via the metadata cache. */
export function loadQuillContextData(app: App, file: TFile): QuillContextData {
    const cache = app.metadataCache.getFileCache(file);
    if (!cache?.frontmatter) return {};
    const raw: Record<string, unknown> = (cache.frontmatter['quill'] as Record<string, unknown> | undefined) ?? {};
    if (typeof raw !== 'object' || Array.isArray(raw)) return {};
    return {
        pinnedEntities: asStringArray(raw['pinnedEntities']),
        removedEntities: asStringArray(raw['removedEntities']),
        addedEntities: asStringArray(raw['addedEntities']),
        addedFiles: asStringArray(raw['addedFiles']),
        pinnedFiles: asStringArray(raw['pinnedFiles']),
        removedFiles: asStringArray(raw['removedFiles'])
    };
}

/** Write quill context data to a file's frontmatter using Obsidian's processFrontMatter API.
 *  Removes the quill key entirely if all fields are empty. */
export async function writeQuillContextData(app: App, file: TFile, data: QuillContextData): Promise<void> {
    const hasContent = Object.keys(data).some((k) => {
        const val = data[k as keyof QuillContextData];
        return Array.isArray(val) && val.length > 0;
    });

    await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
        if (hasContent) {
            const quill: Record<string, string[]> = {};
            if (data.pinnedEntities && data.pinnedEntities.length > 0) quill.pinnedEntities = data.pinnedEntities;
            if (data.removedEntities && data.removedEntities.length > 0) quill.removedEntities = data.removedEntities;
            if (data.addedEntities && data.addedEntities.length > 0) quill.addedEntities = data.addedEntities;
            if (data.addedFiles && data.addedFiles.length > 0) quill.addedFiles = data.addedFiles;
            if (data.pinnedFiles && data.pinnedFiles.length > 0) quill.pinnedFiles = data.pinnedFiles;
            if (data.removedFiles && data.removedFiles.length > 0) quill.removedFiles = data.removedFiles;
            fm['quill'] = quill;
        } else {
            delete fm['quill'];
        }
    });
}

/** Build quill context data from current in-memory tracking structures.
 *  Only includes keys with non-empty values. */
export function buildQuillContextData(opts: {
    entityMods: Map<string, { pinned: boolean; removed: boolean; manual: boolean; entity: ExtractedEntity }>;
    pinnedContextPaths: Set<string>;
    removedContextPaths: Set<string>;
    manualContextItems: { filePath: string }[];
}): QuillContextData {
    const pinnedEntities: string[] = [];
    const removedEntities: string[] = [];
    const addedEntities: string[] = [];
    for (const [id, mod] of opts.entityMods) {
        if (mod.removed) {
            removedEntities.push(id);
        } else if (mod.manual) {
            addedEntities.push(id);
        } else if (mod.pinned) {
            pinnedEntities.push(id);
        }
    }

    const result: QuillContextData = {};
    if (pinnedEntities.length > 0) result.pinnedEntities = pinnedEntities;
    if (removedEntities.length > 0) result.removedEntities = removedEntities;
    if (addedEntities.length > 0) result.addedEntities = addedEntities;
    if (opts.manualContextItems.length > 0) result.addedFiles = opts.manualContextItems.map((i) => i.filePath);
    if (opts.pinnedContextPaths.size > 0) result.pinnedFiles = [...opts.pinnedContextPaths];
    if (opts.removedContextPaths.size > 0) result.removedFiles = [...opts.removedContextPaths];
    return result;
}

/** Reconstruct a minimal ExtractedEntity from an entity ID in type:name format. */
export function entityFromId(id: string): ExtractedEntity {
    const colonIdx = id.indexOf(':');
    const type = (colonIdx > 0 ? id.slice(0, colonIdx) : 'character') as EntityType;
    const name = colonIdx > 0 ? id.slice(colonIdx + 1).replace(/-/g, ' ') : id;
    return {
        id,
        type,
        name,
        occurrences: 0,
        lines: [],
        aliases: [],
        pinned: false,
        removed: false,
        manual: false
    };
}

function asStringArray(val: unknown): string[] | undefined {
    if (!Array.isArray(val)) return undefined;
    const result = val.filter((v): v is string => typeof v === 'string');
    return result.length > 0 ? result : undefined;
}
