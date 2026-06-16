import { TFile, Vault } from 'obsidian';
import { ExtractedEntity, VoiceMarker, ContextItem, ContextAssembly, ContextAssemblyOptions } from './types';

const DEFAULT_OPTIONS: ContextAssemblyOptions = {
    tokenBudget: 8192,
    compactAtPercent: 80,
    includeVaultContext: true,
    maxVaultFiles: 20,
    maxCharsPerFile: 2000
};

/** Estimate token count from character count (roughly 4 chars per token). */
function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

/** Assemble context from the current document and related vault files. */
export async function assembleContext(
    vault: Vault,
    documentText: string,
    entities: ExtractedEntity[],
    voice: VoiceMarker,
    options: Partial<ContextAssemblyOptions> = {}
): Promise<ContextAssembly> {
    const opts: ContextAssemblyOptions = { ...DEFAULT_OPTIONS, ...options };

    // Build entity summary tokens.
    const entitySummary = buildEntitySummary(entities);
    const voiceSummary = buildVoiceSummary(voice);
    const baseTokens = estimateTokens(entitySummary) + estimateTokens(voiceSummary);

    let totalTokens = baseTokens;
    const contextItems: ContextItem[] = [];
    let budgetExceeded = false;
    let compacted = false;

    if (opts.includeVaultContext) {
        const vaultItems = await gatherVaultContextItems(vault, documentText, entities, opts);
        for (const item of vaultItems) {
            totalTokens += item.tokenEstimate;
            contextItems.push(item);
        }
    }

    // Sort by relevance (pinned first, then by score).
    contextItems.sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return b.relevanceScore - a.relevanceScore;
    });

    // Check compaction threshold.
    const compactThreshold = (opts.compactAtPercent / 100) * opts.tokenBudget;
    if (totalTokens > compactThreshold) {
        const result = compactContext(contextItems, totalTokens, opts.tokenBudget, opts.compactAtPercent);
        contextItems.length = 0;
        contextItems.push(...result.items);
        totalTokens = baseTokens + result.tokens;
        compacted = result.compacted;
    }

    // Final check: truncate if still over budget.
    if (totalTokens > opts.tokenBudget) {
        budgetExceeded = true;
        let remaining = opts.tokenBudget - baseTokens;
        const kept: ContextItem[] = [];
        for (const item of contextItems) {
            if (item.pinned || item.tokenEstimate <= remaining) {
                kept.push(item);
                remaining -= item.tokenEstimate;
            }
        }
        contextItems.length = 0;
        contextItems.push(...kept);
        totalTokens = baseTokens + contextItems.reduce((sum, it) => sum + it.tokenEstimate, 0);
    }

    return {
        entities,
        voice,
        contextItems,
        totalTokens,
        tokenBudget: opts.tokenBudget,
        budgetExceeded,
        compacted
    };
}

/** Build a human-readable entity summary. */
function buildEntitySummary(entities: ExtractedEntity[]): string {
    const byType: Record<string, string[]> = {};
    for (const e of entities) {
        if (e.removed) continue;
        const list = byType[e.type] ?? [];
        list.push(e.name);
        byType[e.type] = list;
    }

    const parts: string[] = [];
    if (byType['character']?.length) {
        parts.push(`Characters: ${byType['character'].join(', ')}`);
    }
    if (byType['location']?.length) {
        parts.push(`Locations: ${byType['location'].join(', ')}`);
    }
    if (byType['plot-thread']?.length) {
        parts.push(`Plot threads: ${byType['plot-thread'].join(', ')}`);
    }

    return parts.join('\n');
}

/** Build a human-readable voice summary. */
function buildVoiceSummary(voice: VoiceMarker): string {
    return `Narrative voice: ${voice.pov}, ${voice.tense} tense. Avg sentence: ${voice.avgSentenceLength} words. Dialogue: ${Math.round(voice.dialogueRatio * 100)}%.`;
}

/** Gather context items from the vault matching entity names. */
async function gatherVaultContextItems(
    vault: Vault,
    documentText: string,
    entities: ExtractedEntity[],
    options: ContextAssemblyOptions
): Promise<ContextItem[]> {
    const names = entities.filter((e) => !e.removed).map((e) => e.name);
    if (names.length === 0) return [];

    const allFiles = vault.getMarkdownFiles();
    const scored: { file: TFile; score: number }[] = [];

    // First pass: match by filename.
    for (const file of allFiles) {
        const path = file.path.toLowerCase();
        let score = 0;
        for (const name of names) {
            if (path.includes(name.toLowerCase())) {
                score += 2;
            }
        }
        if (score > 0) {
            scored.push({ file, score });
        }
    }

    // Sort by score and limit.
    scored.sort((a, b) => b.score - a.score);
    const topFiles = scored.slice(0, options.maxVaultFiles);

    const items: ContextItem[] = [];

    // Second pass: read contents and extract matching lines.
    for (const { file, score } of topFiles) {
        try {
            const content = await vault.cachedRead(file);
            const head = content.slice(0, options.maxCharsPerFile);
            const foundNames = names.filter((n) => head.toLowerCase().includes(n.toLowerCase()));

            if (foundNames.length < 2 && score < 2) continue;

            const lines = head.split('\n').slice(0, 30);
            const matchingLines = lines.filter((line) =>
                foundNames.some((n) => line.toLowerCase().includes(n.toLowerCase()))
            );

            const excerpt = matchingLines.slice(0, 5).join('\n');

            items.push({
                filePath: file.path,
                excerpt,
                matchedEntities: foundNames,
                tokenEstimate: estimateTokens(excerpt),
                pinned: false,
                relevanceScore: foundNames.length * 2 + (score > 0 ? 1 : 0) + matchingLines.length / 5,
                manual: false
            });
        } catch {
            // Skip files that fail to read.
        }
    }

    return items;
}

/** Compact context by removing low-relevance items. */
export function compactContext(
    items: ContextItem[],
    currentTokens: number,
    budget: number,
    compactAtPercent: number
): { items: ContextItem[]; tokens: number; compacted: boolean } {
    const threshold = (compactAtPercent / 100) * budget;
    if (currentTokens <= threshold) {
        return { items, tokens: currentTokens, compacted: false };
    }

    const target = Math.floor(0.7 * budget);

    // Sort non-pinned items by relevance ascending (lowest first).
    const pinned = items.filter((it) => it.pinned);
    const nonPinned = items.filter((it) => !it.pinned).sort((a, b) => a.relevanceScore - b.relevanceScore);

    let tokens = pinned.reduce((sum, it) => sum + it.tokenEstimate, 0);
    const kept: ContextItem[] = [...pinned];

    for (const item of nonPinned) {
        if (tokens + item.tokenEstimate <= target) {
            kept.push(item);
            tokens += item.tokenEstimate;
        }
    }

    return { items: kept, tokens, compacted: true };
}

/** Backward-compatible wrapper for transform.ts. */
export async function gatherVaultContext(
    vault: Vault,
    documentText: string,
    cachedAssembly?: ContextAssembly | null
): Promise<string> {
    let assembly: ContextAssembly;

    if (cachedAssembly) {
        // Use cached assembly directly to preserve user pins, removals, and manual adjustments.
        assembly = cachedAssembly;
    } else {
        // Import entity extraction here to avoid circular dependency.
        const { extractAllEntities } = await import('./entity-extractor');
        const { analyzeVoice } = await import('./voice-analyzer');
        const entities = extractAllEntities(documentText);
        const voice = analyzeVoice(documentText);

        assembly = await assembleContext(vault, documentText, entities, voice);
    }

    const names = assembly.entities.filter((e) => !e.removed).map((e) => e.name);

    if (names.length === 0) return '';

    const lines: string[] = [`Characters and references found in vault:`];
    lines.push(names.join(', '));
    lines.push('');
    lines.push('Related notes:');

    for (const item of assembly.contextItems) {
        lines.push(`[${item.filePath}]`);
        if (item.excerpt) {
            lines.push(`  ${item.excerpt.split('\n').join('\n  ')}`);
        }
    }

    return lines.join('\n');
}
