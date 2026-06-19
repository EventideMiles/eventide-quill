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
    /** Dashboard chapter overrides: files to add to or remove from the auto-detected manuscript. */
    chapters?: { add?: string[]; remove?: string[] };
    /** Entity type overrides: entity ID → new type. Applied after extraction. */
    reclassifiedEntities?: Record<string, EntityType>;
}

/** Read quill context data from a file's frontmatter via the metadata cache. */
export function loadQuillContextData(app: App, file: TFile): QuillContextData {
    const cache = app.metadataCache.getFileCache(file);
    if (!cache?.frontmatter) return {};
    const raw: Record<string, unknown> = (cache.frontmatter['quill'] as Record<string, unknown> | undefined) ?? {};
    if (typeof raw !== 'object' || Array.isArray(raw)) return {};
    const plotMapRaw = raw['plotMap'];
    const plotMapTrimmed = typeof plotMapRaw === 'string' ? plotMapRaw.trim() : '';
    return {
        pinnedEntities: asStringArray(raw['pinnedEntities']),
        removedEntities: asStringArray(raw['removedEntities']),
        addedEntities: asStringArray(raw['addedEntities']),
        addedFiles: asStringArray(raw['addedFiles']),
        pinnedFiles: asStringArray(raw['pinnedFiles']),
        removedFiles: asStringArray(raw['removedFiles']),
        plotMap: plotMapTrimmed.length > 0 ? plotMapTrimmed : undefined,
        chapters: parseChapterOverrides(raw['chapters']),
        reclassifiedEntities: parseReclassifiedEntities(raw['reclassifiedEntities'])
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
    const normalized = plotMap?.trim() ?? '';
    await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
        const quill = getQuillObject(fm);
        if (normalized.length > 0) {
            quill['plotMap'] = normalized;
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

/** Parse a raw `chapters` value from frontmatter into a structured override. */
function parseChapterOverrides(val: unknown): { add?: string[]; remove?: string[] } | undefined {
    if (typeof val !== 'object' || val === null || Array.isArray(val)) return undefined;
    const obj = val as Record<string, unknown>;
    const add = asStringArray(obj['add']);
    const remove = asStringArray(obj['remove']);
    if (!add && !remove) return undefined;
    const result: { add?: string[]; remove?: string[] } = {};
    if (add) result.add = add;
    if (remove) result.remove = remove;
    return result;
}

const VALID_ENTITY_TYPES = new Set(['character', 'location', 'plot-thread', 'theme', 'item']);

/** Parse a raw `reclassifiedEntities` value from frontmatter into an ID → type map. */
function parseReclassifiedEntities(val: unknown): Record<string, EntityType> | undefined {
    if (typeof val !== 'object' || val === null || Array.isArray(val)) return undefined;
    const obj = val as Record<string, unknown>;
    const result: Record<string, EntityType> = {};
    let hasAny = false;
    for (const [id, typeVal] of Object.entries(obj)) {
        if (typeof typeVal === 'string' && VALID_ENTITY_TYPES.has(typeVal)) {
            result[id] = typeVal as EntityType;
            hasAny = true;
        }
    }
    return hasAny ? result : undefined;
}

/**
 * Set or clear a single entity's type classification in the active file's frontmatter.
 * Pass `null` as `newType` to remove the override (revert to extracted type).
 * Other quill keys are preserved.
 */
export async function setEntityReclassification(
    app: App,
    file: TFile,
    entityId: string,
    newType: EntityType | null
): Promise<void> {
    await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
        const quill = getQuillObject(fm);
        const existing = (quill['reclassifiedEntities'] as Record<string, unknown> | undefined) ?? {};
        const updated: Record<string, unknown> = { ...existing };

        if (newType === null) {
            delete updated[entityId];
        } else {
            updated[entityId] = newType;
        }

        if (Object.keys(updated).length > 0) {
            quill['reclassifiedEntities'] = updated;
        } else {
            delete quill['reclassifiedEntities'];
        }

        commitQuillObject(fm, quill);
    });
}

/** Set or clear chapter overrides in a file's frontmatter. Other quill keys are preserved. */
export async function setChapterOverrides(
    app: App,
    file: TFile,
    add: string[] | null,
    remove: string[] | null
): Promise<void> {
    await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
        const quill = getQuillObject(fm);
        const hasAdd = Array.isArray(add) && add.length > 0;
        const hasRemove = Array.isArray(remove) && remove.length > 0;
        if (!hasAdd && !hasRemove) {
            delete quill['chapters'];
        } else {
            const chapters: Record<string, unknown> = {};
            if (hasAdd) chapters['add'] = add;
            if (hasRemove) chapters['remove'] = remove;
            quill['chapters'] = chapters;
        }
        commitQuillObject(fm, quill);
    });
}
