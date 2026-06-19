import { ExtractedEntity, EntityType } from '../context-engine/types';
import { computeDialogueRatio } from '../context-engine/voice-analyzer';
import { countSyllables, splitSentences, listSections, SectionRange } from '../../utils/text-analysis';
import {
    ChapterMetrics,
    ChapterRange,
    CharacterAppearance,
    DismissedEntity,
    ManuscriptMetrics,
    PacingFlag,
    ReclassifiedEntity,
    SectionMetrics
} from './types';

const ABBREVIATIONS_PATTERN = new RegExp('\\b(Mr|Mrs|Ms|Dr|Sr|Jr|St|Rev|Prof|Gen|Capt|Maj)\\.$', 'i');

/** Pacing window size: number of consecutive sentences examined for uniform length. */
const PACING_WINDOW = 4;
/** Stddev threshold below which a window is considered uniform. */
const PACING_STDDEV_THRESHOLD = 3;
/** Average sentence length (words) at or below which a uniform window is flagged "short". */
const PACING_SHORT_AVG = 8;
/** Average sentence length (words) at or above which a uniform window is flagged "long". */
const PACING_LONG_AVG = 25;

/** Minimum occurrences for a character to appear in the dashboard list. */
const CHARACTER_MIN_OCCURRENCES = 2;
/** Maximum character rows shown in the dashboard. */
const CHARACTER_MAX_ROWS = 20;

const TOP_LEVEL_HEADING = /^#{1,2}\s+\S/;
const HEADING_TITLE = /^#{1,6}\s+(.+?)\s*$/;

/** Count words in `text` using the same convention as the chat panel (trim + split on whitespace). */
export function countWords(text: string): number {
    const trimmed = text.trim();
    if (!trimmed) return 0;
    return trimmed.split(/\s+/).filter(Boolean).length;
}

/** Count sentences in `text` using the shared sentence splitter. */
export function countSentences(text: string): number {
    if (!text.trim()) return 0;
    return splitSentences(text, ABBREVIATIONS_PATTERN).length;
}

/** Compute mean and population standard deviation of an array of numbers. Returns zeroes for empty input. */
function stats(values: number[]): { mean: number; stddev: number } {
    if (values.length === 0) return { mean: 0, stddev: 0 };
    let sum = 0;
    for (const v of values) sum += v;
    const mean = sum / values.length;
    let variance = 0;
    for (const v of values) variance += (v - mean) * (v - mean);
    variance /= values.length;
    return { mean, stddev: Math.sqrt(variance) };
}

/** Build an array of line-start offsets for O(log n) offset-to-line lookups. */
function buildLineOffsetTable(text: string): number[] {
    const offsets: number[] = [0];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\n') offsets.push(i + 1);
    }
    return offsets;
}

/** Resolve a 0-based character offset to a 1-based line number via binary search over a line-offset table. */
function lineFromOffset(table: number[], offset: number): number {
    let lo = 0;
    let hi = table.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const lineStart = table[mid];
        if (lineStart === undefined) break;
        if (lineStart <= offset) lo = mid + 1;
        else hi = mid - 1;
    }
    return hi >= 0 ? hi + 1 : 1;
}

/**
 * Compute the Flesch Reading Ease and Flesch-Kincaid Grade Level for `text`.
 *
 * Reading Ease: 206.835 - 1.015 * (words/sentences) - 84.6 * (syllables/words).
 * Grade Level:  0.39 * (words/sentences) + 11.8 * (syllables/words) - 15.59.
 *
 * Returns `{ 0, 0 }` for empty or sentence-less input. Uses the shared
 * `splitSentences` and `countSyllables` helpers so abbreviation handling
 * stays consistent with the rest of the codebase.
 */
export function fleschKincaid(text: string): { readingEase: number; gradeLevel: number } {
    if (!text.trim()) return { readingEase: 0, gradeLevel: 0 };

    const sentences = splitSentences(text, ABBREVIATIONS_PATTERN);
    if (sentences.length === 0) return { readingEase: 0, gradeLevel: 0 };

    let totalWords = 0;
    let totalSyllables = 0;
    for (const s of sentences) {
        const words = s.text.split(/\s+/).filter(Boolean);
        totalWords += words.length;
        for (const w of words) totalSyllables += countSyllables(w);
    }

    if (totalWords === 0) return { readingEase: 0, gradeLevel: 0 };

    const wordsPerSentence = totalWords / sentences.length;
    const syllablesPerWord = totalSyllables / totalWords;

    const readingEase = 206.835 - 1.015 * wordsPerSentence - 84.6 * syllablesPerWord;
    const gradeLevel = 0.39 * wordsPerSentence + 11.8 * syllablesPerWord - 15.59;

    return {
        readingEase: Math.round(readingEase * 10) / 10,
        gradeLevel: Math.max(0, Math.round(gradeLevel * 10) / 10)
    };
}

/**
 * Flag runs of uniformly short or long sentences.
 *
 * Scans sentences in document order using a sliding window. When a window's
 * stddev is below `PACING_STDDEV_THRESHOLD` and its average length crosses
 * the short/long thresholds, the window is flagged. Adjacent flags of the
 * same kind are merged into a single `PacingFlag` spanning the full range.
 *
 * @param text      Source text to analyze.
 * @param lineTable Line-offset table for the same text (built by `buildLineOffsetTable`).
 * @param filePath  Source file path (attached to flags for click-to-navigate).
 * @returns Pacing flags in document order.
 */
export function pacingAnalysis(text: string, lineTable: number[], filePath: string): PacingFlag[] {
    if (!text.trim()) return [];

    const sentences = splitSentences(text, ABBREVIATIONS_PATTERN);
    if (sentences.length < PACING_WINDOW) return [];

    const wordCounts = sentences.map((s) => s.text.split(/\s+/).filter(Boolean).length);

    type FlagRun = { kind: PacingFlag['kind']; startIdx: number; endIdx: number; avg: number };
    const runs: FlagRun[] = [];

    for (let i = 0; i + PACING_WINDOW <= wordCounts.length; i++) {
        const window = wordCounts.slice(i, i + PACING_WINDOW);
        const { mean, stddev } = stats(window);
        if (stddev > PACING_STDDEV_THRESHOLD) continue;

        if (mean <= PACING_SHORT_AVG) {
            runs.push({ kind: 'uniform-short', startIdx: i, endIdx: i + PACING_WINDOW - 1, avg: mean });
        } else if (mean >= PACING_LONG_AVG) {
            runs.push({ kind: 'uniform-long', startIdx: i, endIdx: i + PACING_WINDOW - 1, avg: mean });
        }
    }

    if (runs.length === 0) return [];

    // Merge adjacent runs of the same kind.
    const merged: FlagRun[] = [runs[0]!];
    for (let r = 1; r < runs.length; r++) {
        const cur = runs[r]!;
        const last = merged[merged.length - 1]!;
        if (cur.kind === last.kind && cur.startIdx <= last.endIdx + 1) {
            last.endIdx = Math.max(last.endIdx, cur.endIdx);
            last.avg = Math.round(((last.avg + cur.avg) / 2) * 10) / 10;
        } else {
            merged.push(cur);
        }
    }

    return merged.map((run) => {
        const firstSentence = sentences[run.startIdx]!;
        const lastSentence = sentences[run.endIdx]!;
        return {
            filePath,
            lineStart: lineFromOffset(lineTable, firstSentence.start),
            lineEnd: lineFromOffset(lineTable, lastSentence.end),
            kind: run.kind,
            avgSentenceLength: Math.round(run.avg)
        };
    });
}

/** Compute metrics for a single section. */
function computeSectionMetrics(section: SectionRange, filePath: string): SectionMetrics {
    const lineTable = buildLineOffsetTable(section.text);
    const words = countWords(section.text);
    const sentences = splitSentences(section.text, ABBREVIATIONS_PATTERN);
    const sentenceCount = sentences.length;
    const wordCounts = sentences.map((s) => s.text.split(/\s+/).filter(Boolean).length);
    const { mean } = stats(wordCounts);
    const { dialogueRatio } = computeDialogueRatio(section.text);
    const { readingEase } = fleschKincaid(section.text);
    const flags = pacingAnalysis(section.text, lineTable, filePath);

    return {
        title: section.title,
        lineStart: section.lineStart,
        lineEnd: section.lineEnd,
        wordCount: words,
        sentenceCount,
        avgSentenceLength: Math.round(mean * 10) / 10,
        dialogueRatio: Math.round(dialogueRatio * 100) / 100,
        fleschReadingEase: readingEase,
        pacingFlags: flags
    };
}

/**
 * Split a single file into one or more ChapterRanges.
 *
 * When `splitByHeading` is false (default manuscript model), the whole file
 * is one chapter. When true, the file is split at top-level (`#`/`##`)
 * headings; leading content before the first heading becomes an "Untitled"
 * chapter (skipped if blank).
 *
 * Each returned ChapterRange has its `sections` populated. Sections split on
 * deeper headings (`###`-`######`) and scene-break markers (`***`, `---`)
 * when the file is heading-split; on any heading plus scene breaks when the
 * file is one chapter.
 */
export function listChaptersInFile(
    text: string,
    filePath: string,
    fileBasename: string,
    splitByHeading: boolean
): ChapterRange[] {
    if (!text.trim()) return [];

    if (!splitByHeading) {
        const sections = listSections(text, { splitOnAllHeadings: true });
        return [
            {
                title: fileBasename,
                filePath,
                fileBasename,
                lineStart: 1,
                lineEnd: text.split('\n').length,
                text,
                sections
            }
        ];
    }

    const lines = text.split('\n');
    const boundaries: { title: string; lineIdx: number }[] = [];
    for (let i = 0; i < lines.length; i++) {
        if (TOP_LEVEL_HEADING.test(lines[i]!)) {
            const m = lines[i]!.match(HEADING_TITLE);
            boundaries.push({ title: m ? m[1]! : 'Untitled', lineIdx: i });
        }
    }

    if (boundaries.length === 0) {
        // No top-level headings: fall back to whole-file chapter.
        const sections = listSections(text, { splitOnAllHeadings: true });
        return [
            {
                title: fileBasename,
                filePath,
                fileBasename,
                lineStart: 1,
                lineEnd: lines.length,
                text,
                sections
            }
        ];
    }

    const chapters: ChapterRange[] = [];

    // Leading content before first heading (if non-blank).
    const firstIdx = boundaries[0]!.lineIdx;
    if (firstIdx > 0) {
        const leadingLines = lines.slice(0, firstIdx);
        const leadingText = leadingLines.join('\n');
        if (leadingText.trim()) {
            const trimmedStart = leadingLines.findIndex((l) => l.trim() !== '');
            const startLine = trimmedStart >= 0 ? trimmedStart + 1 : 1;
            const sections = listSections(leadingText, { splitOnAllHeadings: false });
            chapters.push({
                title: 'Untitled',
                filePath,
                fileBasename,
                lineStart: startLine,
                lineEnd: firstIdx,
                text: leadingText,
                sections
            });
        }
    }

    // Each heading starts a chapter; ends at the line before the next heading (or EOF).
    for (let b = 0; b < boundaries.length; b++) {
        const cur = boundaries[b]!;
        const endLineExclusive = b + 1 < boundaries.length ? boundaries[b + 1]!.lineIdx : lines.length;
        const chapterLines = lines.slice(cur.lineIdx, endLineExclusive);
        const chapterText = chapterLines.join('\n');
        const sections = listSections(chapterText, { splitOnAllHeadings: false });
        chapters.push({
            title: cur.title,
            filePath,
            fileBasename,
            lineStart: cur.lineIdx + 1,
            lineEnd: endLineExclusive,
            text: chapterText,
            sections
        });
    }

    return chapters;
}

/** Compute metrics for a chapter (including per-section breakdown). */
export function chapterMetrics(chapter: ChapterRange): ChapterMetrics {
    const lineTable = buildLineOffsetTable(chapter.text);
    const words = countWords(chapter.text);
    const sentences = splitSentences(chapter.text, ABBREVIATIONS_PATTERN);
    const sentenceCount = sentences.length;
    const wordCounts = sentences.map((s) => s.text.split(/\s+/).filter(Boolean).length);
    const { mean, stddev } = stats(wordCounts);
    const { dialogueRatio } = computeDialogueRatio(chapter.text);
    const { readingEase, gradeLevel } = fleschKincaid(chapter.text);
    const flags = pacingAnalysis(chapter.text, lineTable, chapter.filePath);

    return {
        filePath: chapter.filePath,
        fileBasename: chapter.fileBasename,
        title: chapter.title,
        lineStart: chapter.lineStart,
        lineEnd: chapter.lineEnd,
        wordCount: words,
        sentenceCount,
        avgSentenceLength: Math.round(mean * 10) / 10,
        sentenceLengthStddev: Math.round(stddev * 10) / 10,
        dialogueRatio: Math.round(dialogueRatio * 100) / 100,
        narrationRatio: Math.round((1 - dialogueRatio) * 100) / 100,
        fleschReadingEase: readingEase,
        fleschKincaidGrade: gradeLevel,
        pacingFlags: flags,
        sections: chapter.sections.map((s) => computeSectionMetrics(s, chapter.filePath))
    };
}

/**
 * Compute per-character appearance summaries across a manuscript.
 *
 * Uses extracted entities (characters only) and checks each chapter's text
 * for the character's name or aliases. Text matching (rather than line
 * numbers) is robust to multi-file manuscripts where entity extraction and
 * chapter boundaries come from different sources.
 *
 * Returns entries sorted by occurrences descending, filtered to characters
 * with at least `CHARACTER_MIN_OCCURRENCES` occurrences, capped at
 * `CHARACTER_MAX_ROWS`.
 */
export function characterAppearances(chapters: ChapterRange[], entities: ExtractedEntity[]): CharacterAppearance[] {
    const characters = entities.filter((e) => e.type === 'character' && e.occurrences >= CHARACTER_MIN_OCCURRENCES);

    return characters
        .map((entity): CharacterAppearance => {
            const names = [entity.name, ...entity.aliases].filter((n) => n.length > 0);
            const matchers = names.map((n) => buildNameMatcher(n));

            const chapterIndices: number[] = [];
            for (let i = 0; i < chapters.length; i++) {
                const text = chapters[i]!.text;
                if (matchers.some((m) => m.test(text))) chapterIndices.push(i);
            }

            const lastSeenChapter = chapterIndices.length > 0 ? chapterIndices[chapterIndices.length - 1]! : -1;
            const chaptersSinceLastSeen = chapterIndices.length === 0 ? -1 : chapters.length - 1 - lastSeenChapter;

            return {
                entityId: entity.id,
                name: entity.name,
                occurrences: entity.occurrences,
                chapterIndices,
                lastSeenChapter,
                chaptersSinceLastSeen
            };
        })
        .sort((a, b) => b.occurrences - a.occurrences)
        .slice(0, CHARACTER_MAX_ROWS);
}

/** Build a word-boundary regex matcher for a character name, escaping regex specials. */
function buildNameMatcher(name: string): RegExp {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i');
}

const VALID_ENTITY_TYPES: EntityType[] = ['character', 'location', 'plot-thread', 'theme', 'item'];

/** Extract the original entity type from its ID prefix (`character:freddy` → `character`). */
function originalTypeFromId(entityId: string): EntityType | null {
    const colonIdx = entityId.indexOf(':');
    if (colonIdx <= 0) return null;
    const prefix = entityId.slice(0, colonIdx);
    return VALID_ENTITY_TYPES.includes(prefix as EntityType) ? (prefix as EntityType) : null;
}

/** Detect entities whose type was overridden by comparing the ID prefix with the current type. */
function collectReclassified(entities: ExtractedEntity[]): ReclassifiedEntity[] {
    const result: ReclassifiedEntity[] = [];
    for (const entity of entities) {
        const originalType = originalTypeFromId(entity.id);
        if (originalType && originalType !== entity.type) {
            result.push({
                entityId: entity.id,
                name: entity.name,
                originalType,
                currentType: entity.type,
                occurrences: entity.occurrences
            });
        }
    }
    return result;
}

/** Collect dismissed entities with their original type and occurrence count. */
function collectDismissed(entities: ExtractedEntity[], dismissedIds: Set<string>): DismissedEntity[] {
    const result: DismissedEntity[] = [];
    for (const entity of entities) {
        if (!dismissedIds.has(entity.id)) continue;
        const originalType = originalTypeFromId(entity.id);
        result.push({
            entityId: entity.id,
            name: entity.name,
            originalType: originalType ?? entity.type,
            occurrences: entity.occurrences
        });
    }
    return result;
}

/** Aggregate per-chapter metrics into a full manuscript snapshot. */
export function manuscriptMetrics(
    chapters: ChapterRange[],
    entities: ExtractedEntity[],
    dismissedIds?: Set<string>
): ManuscriptMetrics {
    const disSet = dismissedIds ?? new Set<string>();

    // Partition entities: dismissed ones go into a separate list, the rest
    // are active for character/reclassified computation.
    const activeEntities = entities.filter((e) => !disSet.has(e.id));
    const chapterMetricsList = chapters.map(chapterMetrics);

    let totalWords = 0;
    let totalSentences = 0;
    let totalSections = 0;
    let weightedDialogue = 0;
    let weightedReadingEase = 0;
    let weightedGrade = 0;
    const allWordCounts: number[] = [];
    const allFlags: PacingFlag[] = [];

    for (const cm of chapterMetricsList) {
        totalWords += cm.wordCount;
        totalSentences += cm.sentenceCount;
        totalSections += cm.sections.length;
        weightedDialogue += cm.dialogueRatio * cm.wordCount;
        weightedReadingEase += cm.fleschReadingEase * cm.wordCount;
        weightedGrade += cm.fleschKincaidGrade * cm.wordCount;
        // Adjust flag lines from chapter-relative to file-absolute for navigation.
        for (const flag of cm.pacingFlags) {
            allFlags.push({
                ...flag,
                lineStart: cm.lineStart + flag.lineStart - 1,
                lineEnd: cm.lineStart + flag.lineEnd - 1
            });
        }
    }

    // Recompute manuscript-wide sentence-length stats by re-splitting each chapter's text.
    for (const chapter of chapters) {
        const sentences = splitSentences(chapter.text, ABBREVIATIONS_PATTERN);
        for (const s of sentences) {
            allWordCounts.push(s.text.split(/\s+/).filter(Boolean).length);
        }
    }
    const { mean: avgSentenceLength, stddev: sentenceLengthStddev } = stats(allWordCounts);

    const characters = characterAppearances(chapters, activeEntities);
    const reclassified = collectReclassified(activeEntities);
    const dismissed = collectDismissed(entities, disSet);

    return {
        generatedAt: Date.now(),
        chapterCount: chapterMetricsList.length,
        sectionCount: totalSections,
        totalWords,
        totalSentences,
        avgSentenceLength: Math.round(avgSentenceLength * 10) / 10,
        sentenceLengthStddev: Math.round(sentenceLengthStddev * 10) / 10,
        dialogueRatio: totalWords > 0 ? Math.round((weightedDialogue / totalWords) * 100) / 100 : 0,
        narrationRatio: totalWords > 0 ? Math.round((1 - weightedDialogue / totalWords) * 100) / 100 : 1,
        fleschReadingEase: totalWords > 0 ? Math.round((weightedReadingEase / totalWords) * 10) / 10 : 0,
        fleschKincaidGrade: totalWords > 0 ? Math.round((weightedGrade / totalWords) * 10) / 10 : 0,
        chapters: chapterMetricsList,
        characters,
        reclassified,
        dismissed,
        pacingFlags: allFlags
    };
}
