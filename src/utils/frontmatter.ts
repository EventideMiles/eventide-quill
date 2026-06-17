import { App, TFile } from 'obsidian';
import type { ExtractedEntity, EntityType } from '../core/context-engine/types';

export interface QuillContextData {
    pinnedEntities?: string[];
    removedEntities?: string[];
    addedEntities?: string[];
    addedFiles?: string[];
    pinnedFiles?: string[];
    removedFiles?: string[];
    /** Path of the manuscript's primary plot map note. Single slot; empty/missing = none. */
    plotMap?: string;
}

/** Read quill context data from a file's frontmatter via the metadata cache. */
export function loadQuillContextData(app: App, file: TFile): QuillContextData {
    const cache = app.metadataCache.getFileCache(file);
    if (!cache?.frontmatter) return {};
    const raw: Record<string, unknown> = (cache.frontmatter['quill'] as Record<string, unknown> | undefined) ?? {};
    if (typeof raw !== 'object' || Array.isArray(raw)) return {};
    const plotMapRaw = raw['plotMap'];
    return {
        pinnedEntities: asStringArray(raw['pinnedEntities']),
        removedEntities: asStringArray(raw['removedEntities']),
        addedEntities: asStringArray(raw['addedEntities']),
        addedFiles: asStringArray(raw['addedFiles']),
        pinnedFiles: asStringArray(raw['pinnedFiles']),
        removedFiles: asStringArray(raw['removedFiles']),
        plotMap: typeof plotMapRaw === 'string' && plotMapRaw.length > 0 ? plotMapRaw : undefined
    };
}

/** Write quill context data to a file's frontmatter using Obsidian's processFrontMatter API.
 *  Non-destructive: updates only the context-engine keys this function owns and
 *  preserves any other quill keys (e.g. plotMap). Removes the quill key entirely
 *  only when no quill keys remain. */
export async function writeQuillContextData(app: App, file: TFile, data: QuillContextData): Promise<void> {
    await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
        const quill = getQuillObject(fm);
        setArrayKey(quill, 'pinnedEntities', data.pinnedEntities);
        setArrayKey(quill, 'removedEntities', data.removedEntities);
        setArrayKey(quill, 'addedEntities', data.addedEntities);
        setArrayKey(quill, 'addedFiles', data.addedFiles);
        setArrayKey(quill, 'pinnedFiles', data.pinnedFiles);
        setArrayKey(quill, 'removedFiles', data.removedFiles);
        commitQuillObject(fm, quill);
    });
}

/** Set or clear the plot map link in a file's frontmatter. Other quill keys are preserved.
 *  Pass null to unlink the plot map. */
export async function setPlotMap(app: App, file: TFile, plotMap: string | null): Promise<void> {
    await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
        const quill = getQuillObject(fm);
        if (plotMap) {
            quill['plotMap'] = plotMap;
        } else {
            delete quill['plotMap'];
        }
        commitQuillObject(fm, quill);
    });
}

/** Read the quill object from frontmatter, or return a fresh empty object. Preserves existing keys. */
function getQuillObject(fm: Record<string, unknown>): Record<string, unknown> {
    const existing = fm['quill'];
    if (typeof existing === 'object' && existing !== null && !Array.isArray(existing)) {
        return existing as Record<string, unknown>;
    }
    return {};
}

/** Set or clear an array-valued key on the quill object. */
function setArrayKey(quill: Record<string, unknown>, key: string, val: string[] | undefined): void {
    if (Array.isArray(val) && val.length > 0) {
        quill[key] = val;
    } else {
        delete quill[key];
    }
}

/** Write the quill object back, pruning it entirely when no keys remain. */
function commitQuillObject(fm: Record<string, unknown>, quill: Record<string, unknown>): void {
    if (Object.keys(quill).length > 0) {
        fm['quill'] = quill;
    } else {
        delete fm['quill'];
    }
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
