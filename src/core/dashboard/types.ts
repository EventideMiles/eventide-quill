import type { EntityType } from '../context-engine/types';

/** A section (scene) within a chapter. */
export interface SectionRange {
    /** Heading text when the boundary was a heading, otherwise null. */
    title: string | null;
    /** 1-based line number where the section begins in the source file. */
    lineStart: number;
    /** 1-based line number where the section ends in the source file (inclusive). */
    lineEnd: number;
    /** Section text (joined lines, no leading/trailing blank-line padding). */
    text: string;
    /** What kind of boundary created this section. */
    kind: 'heading' | 'scene-break' | 'leading';
}

/** A chapter: either a whole file or a heading-split region of a file. */
export interface ChapterRange {
    /** File basename, or heading text when split-by-heading produced this chapter. */
    title: string;
    /** Source file path in the vault. */
    filePath: string;
    /** Source file basename (without extension). */
    fileBasename: string;
    /** 1-based line where the chapter begins; 1 when file = chapter. */
    lineStart: number;
    /** 1-based line where the chapter ends (inclusive). */
    lineEnd: number;
    /** Chapter text (joined lines). */
    text: string;
    /** Sections within this chapter. */
    sections: SectionRange[];
}

/** A pacing flag on a uniformly short/long passage. */
export interface PacingFlag {
    /** Source file path for navigation. */
    filePath: string;
    /** 1-based line where the flagged passage begins (relative to the source text). */
    lineStart: number;
    /** 1-based line where the flagged passage ends (inclusive). */
    lineEnd: number;
    /** Whether the passage is uniformly short or uniformly long. */
    kind: 'uniform-short' | 'uniform-long';
    /** Average sentence length in words across the passage. */
    avgSentenceLength: number;
}

/** Which readability formula to display (plugin-level setting). */
export type ReadabilityFormula = 'dale-chall' | 'flesch-kincaid' | 'ari' | 'reweighted-flesch' | 'custom-composite';

/** Per-section metrics used for pacing analysis and expandable rows. */
export interface SectionMetrics {
    /** Heading text or null for scene-break/leading sections. */
    title: string | null;
    /** 1-based line where the section begins. */
    lineStart: number;
    /** 1-based line where the section ends (inclusive). */
    lineEnd: number;
    /** Number of words in the section. */
    wordCount: number;
    /** Number of sentences in the section. */
    sentenceCount: number;
    /** Average sentence length in words. */
    avgSentenceLength: number;
    /** Ratio of dialogue to total text (0-1). */
    dialogueRatio: number;
    /** Flesch Reading Ease score (0-100, higher = easier). */
    fleschReadingEase: number;
    /** Dale-Chall raw score (0-100, higher = easier). */
    daleChallRawScore: number;
    /** Dale-Chall grade level (4-16, lower = easier). */
    daleChallGradeLevel: number;
    /** Reweighted Flesch Reading Ease for fiction (0-100, higher = easier). */
    reweightedFleschReadingEase: number;
    /** Reweighted Flesch grade level (0+, lower = easier). */
    reweightedFleschGradeLevel: number;
    /** Custom composite score for fiction readability (0-100). */
    customCompositeScore: number;
    /** ARI grade level (0+, lower = easier). */
    ariScore: number;
    /** Pacing flags raised within this section. */
    pacingFlags: PacingFlag[];
}

/** Per-chapter computed metrics. */
export interface ChapterMetrics {
    /** Source file path in the vault. */
    filePath: string;
    /** Source file basename (without extension). */
    fileBasename: string;
    /** Chapter title (file basename or heading text). */
    title: string;
    /** 1-based line where the chapter begins. */
    lineStart: number;
    /** 1-based line where the chapter ends (inclusive). */
    lineEnd: number;
    /** Number of words in the chapter. */
    wordCount: number;
    /** Number of sentences in the chapter. */
    sentenceCount: number;
    /** Average sentence length in words. */
    avgSentenceLength: number;
    /** Standard deviation of sentence length across the chapter. */
    sentenceLengthStddev: number;
    /** Ratio of dialogue to total text (0-1). */
    dialogueRatio: number;
    /** Ratio of narration to total text (0-1); 1 - dialogueRatio. */
    narrationRatio: number;
    /** Flesch Reading Ease score (0-100, higher = easier). */
    fleschReadingEase: number;
    /** Flesch-Kincaid grade level. */
    fleschKincaidGrade: number;
    /** Dale-Chall raw score (0-100, higher = easier). */
    daleChallRawScore: number;
    /** Dale-Chall grade level (4-16, lower = easier). */
    daleChallGradeLevel: number;
    /** Reweighted Flesch Reading Ease for fiction (0-100, higher = easier). */
    reweightedFleschReadingEase: number;
    /** Reweighted Flesch grade level (0+, lower = easier). */
    reweightedFleschGradeLevel: number;
    /** Custom composite score for fiction readability (0-100). */
    customCompositeScore: number;
    /** ARI grade level (0+, lower = easier). */
    ariScore: number;
    /** Pacing flags aggregated from sections. */
    pacingFlags: PacingFlag[];
    /** Per-scene breakdown for expandable rows. */
    sections: SectionMetrics[];
}

/** Per-character appearance summary across a manuscript. */
export interface CharacterAppearance {
    /** Entity ID (`type:normalized-name`) — used for reclassification. */
    entityId: string;
    /** Display name of the character. */
    name: string;
    /** Total occurrences across the manuscript. */
    occurrences: number;
    /** 0-based chapter indices where the character appears. */
    chapterIndices: number[];
    /** Index of the last chapter where the character appears, or -1 if absent. */
    lastSeenChapter: number;
    /** Chapters since last appearance: -1 if absent from all chapters, 0 if in the latest chapter. */
    chaptersSinceLastSeen: number;
}

/** An entity whose type was reclassified by the user. */
export interface ReclassifiedEntity {
    /** Entity ID (`type:normalized-name` from extraction). */
    entityId: string;
    /** Display name. */
    name: string;
    /** The type the extractor originally assigned. */
    originalType: EntityType;
    /** The user-assigned type. */
    currentType: EntityType;
    /** Total occurrences across the manuscript. */
    occurrences: number;
}

/** An entity the user dismissed entirely (false positive, not any type). */
export interface DismissedEntity {
    /** Entity ID (`type:normalized-name` from extraction). */
    entityId: string;
    /** Display name. */
    name: string;
    /** The type the extractor originally assigned. */
    originalType: EntityType;
    /** Total occurrences across the manuscript. */
    occurrences: number;
}

/** Aggregated metrics for an entire manuscript. */
export interface ManuscriptMetrics {
    /** Epoch milliseconds when the metrics were computed. */
    generatedAt: number;
    /** Number of chapters in the manuscript. */
    chapterCount: number;
    /** Total number of sections across all chapters. */
    sectionCount: number;
    /** Total word count across all chapters. */
    totalWords: number;
    /** Total sentence count across all chapters. */
    totalSentences: number;
    /** Manuscript-wide average sentence length in words. */
    avgSentenceLength: number;
    /** Manuscript-wide standard deviation of sentence length. */
    sentenceLengthStddev: number;
    /** Manuscript-wide dialogue ratio (0-1). */
    dialogueRatio: number;
    /** Manuscript-wide narration ratio (0-1). */
    narrationRatio: number;
    /** Manuscript-wide Flesch Reading Ease score. */
    fleschReadingEase: number;
    /** Manuscript-wide Flesch-Kincaid grade level. */
    fleschKincaidGrade: number;
    /** Manuscript-wide Dale-Chall raw score (0-100, higher = easier). */
    daleChallRawScore: number;
    /** Manuscript-wide Dale-Chall grade level (4-16, lower = easier). */
    daleChallGradeLevel: number;
    /** Manuscript-wide reweighted Flesch Reading Ease for fiction (0-100, higher = easier). */
    reweightedFleschReadingEase: number;
    /** Manuscript-wide reweighted Flesch grade level (0+, lower = easier). */
    reweightedFleschGradeLevel: number;
    /** Manuscript-wide custom composite score for fiction readability (0-100). */
    customCompositeScore: number;
    /** Manuscript-wide ARI grade level (0+, lower = easier). */
    ariScore: number;
    /** Per-chapter metrics, in manuscript order. */
    chapters: ChapterMetrics[];
    /** Per-character appearance summaries, sorted by occurrences descending. */
    characters: CharacterAppearance[];
    /** Entities the user reclassified away from their extracted type. */
    reclassified: ReclassifiedEntity[];
    /** Entities the user dismissed entirely (false positives). */
    dismissed: DismissedEntity[];
    /** Pacing flags aggregated across the manuscript. */
    pacingFlags: PacingFlag[];
}

/** One persisted historical snapshot. */
export interface ManuscriptSnapshot {
    /** Epoch milliseconds when the snapshot was taken. */
    takenAt: number;
    /** Total word count at snapshot time. */
    totalWords: number;
    /** Chapter count at snapshot time. */
    chapterCount: number;
    /** Per-chapter word counts at snapshot time. */
    perChapterWords: { filePath: string; title: string; wordCount: number }[];
}
