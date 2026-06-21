/** The kind of entity extracted from the manuscript. */
export type EntityType = 'character' | 'location' | 'plot-thread' | 'theme' | 'item';

/** An entity extracted from the manuscript text. */
export interface ExtractedEntity {
    /** Unique identifier within the document context: "{type}:{normalized-name}" */
    id: string;
    /** The kind of entity. */
    type: EntityType;
    /** The display name (e.g. "Sarah Connor"). */
    name: string;
    /** Number of times this entity appears in the document. */
    occurrences: number;
    /** Line numbers where this entity appears (1-based, capped at 50). */
    lines: number[];
    /** Aliases or alternate references found in the text. */
    aliases: string[];
    /** Whether the user has manually pinned this entity (protects from compaction). */
    pinned: boolean;
    /** Whether the user has manually removed this entity from context. */
    removed: boolean;
    /** Whether the user manually added this entity (not extracted). */
    manual: boolean;
}

/** A narrative voice marker detected in the text. */
export interface VoiceMarker {
    /** The detected POV: "first-person", "third-person", "second-person", or "unknown". */
    pov: string;
    /** The detected tense: "past", "present", or "mixed". */
    tense: string;
    /** Average sentence length in words. */
    avgSentenceLength: number;
    /** Ratio of dialogue to total text (0-1). */
    dialogueRatio: number;
    /** Ratio of description to total text (0-1). */
    descriptionRatio: number;
}

/** A context item assembled from the vault for AI consumption. */
export interface ContextItem {
    /** The source file path in the vault. For folder items, prefixed with "embed:" or "embed-full:". */
    filePath: string;
    /** The relevant text excerpt from the file. */
    excerpt: string;
    /** Which entity names caused this item to be included. */
    matchedEntities: string[];
    /** Estimated token count for this item (chars / 4). */
    tokenEstimate: number;
    /** Whether the user manually pinned this item (protects from compaction). */
    pinned: boolean;
    /** Relevance score: (matchedEntities * 2) + (filenameMatch ? 1 : 0) + (contentMatches / 5). */
    relevanceScore: number;
    /** Whether the user manually added this file to context (not auto-discovered). */
    manual: boolean;
    /** If set, this item represents a folder with embedded chunks rather than a single file. */
    folderPath?: string;
    /** Embedding mode: 'top-k' retrieves the most relevant chunks; 'full' retrieves all. */
    embedMode?: 'top-k' | 'full';
    /** Resolved chunk texts from the folder cache. Populated lazily before AI calls. */
    resolvedChunks?: string[];
}

/** The full context assembly result. */
export interface ContextAssembly {
    /** Entities extracted from the current document. */
    entities: ExtractedEntity[];
    /** Voice markers detected in the current document. */
    voice: VoiceMarker;
    /** Assembled context items from related vault files. */
    contextItems: ContextItem[];
    /** Total estimated tokens across all context items. */
    totalTokens: number;
    /** The token budget that was used. */
    tokenBudget: number;
    /** Whether the budget was exceeded (items were trimmed). */
    budgetExceeded: boolean;
    /** Whether compaction was applied. */
    compacted: boolean;
}

/** Options for context assembly. */
export interface ContextAssemblyOptions {
    /** Maximum tokens for the assembled context. Default: 8192. */
    tokenBudget: number;
    /** Percentage of token budget at which compaction triggers. Default: 80. */
    compactAtPercent: number;
    /** Whether to include vault-wide context search. Default: true. */
    includeVaultContext: boolean;
    /** Maximum vault files to examine. Default: 20. */
    maxVaultFiles: number;
    /** Maximum characters to read per vault file. Default: 2000. */
    maxCharsPerFile: number;
}
