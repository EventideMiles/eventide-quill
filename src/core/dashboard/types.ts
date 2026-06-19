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
    /** 1-based line where the flagged passage begins. */
    lineStart: number;
    /** 1-based line where the flagged passage ends (inclusive). */
    lineEnd: number;
    /** Whether the passage is uniformly short or uniformly long. */
    kind: 'uniform-short' | 'uniform-long';
    /** Average sentence length in words across the passage. */
    avgSentenceLength: number;
}

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
    /** Chapters since last appearance: -1 if in the latest chapter, 0 if in none. */
    chaptersSinceLastSeen: number;
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
    /** Per-chapter metrics, in manuscript order. */
    chapters: ChapterMetrics[];
    /** Per-character appearance summaries, sorted by occurrences descending. */
    characters: CharacterAppearance[];
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

/** Shape of the JSON file at pluginDataDir/dashboards/<id>.json. */
export interface ManuscriptSnapshotFile {
    /** Slugified folder path identifying this manuscript. */
    manuscriptId: string;
    /** Folder path the manuscript was resolved from. */
    folder: string;
    /** Chronological snapshots, oldest first, capped at dashboardMaxSnapshots. */
    snapshots: ManuscriptSnapshot[];
}
