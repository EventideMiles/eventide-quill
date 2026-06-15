import { ExtractedEntity } from './types';
import { splitSentences } from '../../utils/text-analysis';

/** Expanded stoplist: pronouns, articles, common non-name words, months, days, etc. */
const NAME_STOPLIST = new Set([
    'I', 'The', 'A', 'An', 'It', 'He', 'She', 'They', 'We', 'You',
    'His', 'Her', 'Their', 'Them', 'Its', 'My', 'Your', 'Our',
    'This', 'That', 'These', 'Those',
    'There', 'Here', 'Then', 'Now', 'When', 'What', 'Where', 'Who', 'Why', 'How',
    'And', 'But', 'Or', 'Nor', 'For', 'Yet', 'So',
    'To', 'From', 'In', 'On', 'At', 'By', 'With', 'Of', 'As',
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
    'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
    'Spring', 'Summer', 'Autumn', 'Winter',
    'Chapter', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven',
    'Eight', 'Nine', 'Ten', 'Once', 'Up', 'Down', 'Left', 'Right',
    'Yes', 'No', 'Maybe', 'Oh', 'Well', 'So', 'Because',
]);

/** Titles that should be stripped when extracting names. */
const TITLES = new Set([
    'Mr', 'Mrs', 'Ms', 'Dr', 'Uncle', 'Aunt', 'Cousin', 'Grandmother', 'Grandfather',
    'Sir', 'Madam', 'Lord', 'Lady', 'Captain', 'Doctor', 'Professor', 'Detective',
    'Agent', 'General', 'Colonel', 'Major', 'Private', 'Sergeant', 'Father', 'Mother',
    'Brother', 'Sister', 'Son', 'Daughter', 'King', 'Queen', 'Prince', 'Princess',
    'Duke', 'Duchess',
]);

/** Minimum occurrences required for a mid-sentence capitalized word to qualify as a character. */
const MIN_MID_SENTENCE_OCCURRENCES = 2;

const ABBREVIATIONS_PATTERN = new RegExp(
    '\\b(Mr|Mrs|Ms|Dr|Sr|Jr|St|Rev|Prof|Gen|Capt|Maj)\\.$', 'i'
);

/** Normalize a name into an ID-safe token: lowercase, spaces → hyphens. */
function normalizeName(name: string): string {
    return name.toLowerCase().replace(/\s+/g, '-');
}

/** Build ExtractedEntity from data. */
function makeEntity(
    type: 'character' | 'location' | 'plot-thread',
    name: string,
    occurrences: number,
    lines: Set<number>,
    aliases?: string[],
): ExtractedEntity {
    return {
        id: `${type}:${normalizeName(name)}`,
        type,
        name,
        occurrences,
        lines: [...lines].slice(0, 50),
        aliases: aliases ?? [],
        pinned: false,
        removed: false,
        manual: false,
    };
}

/** Extract character candidates from dialogue attribution patterns. */
function extractFromDialogue(text: string): Map<string, { count: number; lines: Set<number> }> {
    const map = new Map<string, { count: number; lines: Set<number> }>();
    const lineMap = buildLineOffsetTable(text);

    // Pattern 1: "quote", Name said
    const p1 = /"[^"]*"\s*,?\s*([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s+(?:said|asked|replied|whispered|shouted|yelled|cried|murmured|muttered|whined|bellowed|screamed|hissed|snapped|snarled|growled|scoffed|snorted|laughed|chuckled|sobbed|sighed|breathed|gasped|panted|mused|added|corrected)\b/gi;

    // Pattern 2: Name said, "quote"
    const p2 = /\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s+(?:said|asked|replied|whispered|shouted|yelled|cried|murmured|muttered|whined|bellowed|screamed|hissed|snapped|snarled|growled|scoffed|snorted|laughed|chuckled|sobbed|sighed|breathed|gasped|panted|mused|added|corrected)\s*,?\s*"[^"]*"/gi;

    for (const pattern of [p1, p2]) {
        let m: RegExpExecArray | null;
        while ((m = pattern.exec(text)) !== null) {
            const raw = m[1];
            if (!raw) continue;
            const name = stripTitle(raw.trim());
            if (!name) continue;
            const firstWord = name.split(' ')[0];
            if (!firstWord || NAME_STOPLIST.has(firstWord)) continue;

            const line = getLineFromOffset(lineMap, m.index);
            const entry = map.get(name) ?? { count: 0, lines: new Set<number>() };
            entry.count++;
            if (line && entry.lines.size < 50) entry.lines.add(line);
            map.set(name, entry);
        }
    }

    return map;
}

/** Extract character candidates from possessive forms ("Sarah's"). */
function extractFromPossessives(text: string): Map<string, { count: number; lines: Set<number> }> {
    const map = new Map<string, { count: number; lines: Set<number> }>();
    const lineMap = buildLineOffsetTable(text);
    const re = /\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)'s\b/g;

    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        const raw = m[1];
        if (!raw) continue;
        const name = stripTitle(raw.trim());
        if (!name) continue;
        const firstWord = name.split(' ')[0];
        if (!firstWord || NAME_STOPLIST.has(firstWord)) continue;

        const line = getLineFromOffset(lineMap, m.index);
        const entry = map.get(name) ?? { count: 0, lines: new Set<number>() };
        entry.count++;
        if (line && entry.lines.size < 50) entry.lines.add(line);
        map.set(name, entry);
    }

    return map;
}

/** Extract character candidates from mid-sentence capitalized words. */
function extractFromMidSentence(text: string): Map<string, { count: number; lines: Set<number> }> {
    const map = new Map<string, { count: number; lines: Set<number> }>();
    const sentences = splitSentences(text, ABBREVIATIONS_PATTERN);

    for (const sentence of sentences) {
        const words = sentence.text.match(/\b[A-Z][a-z]+\b/g);
        if (!words) continue;

        for (let i = 1; i < words.length; i++) {
            const word = words[i];
            if (!word) continue;
            if (NAME_STOPLIST.has(word)) continue;

            const line = sentence.line;
            const entry = map.get(word) ?? { count: 0, lines: new Set<number>() };
            entry.count++;
            if (entry.lines.size < 50) entry.lines.add(line);
            map.set(word, entry);
        }
    }

    // Keep only those with sufficient occurrences
    const filtered = new Map<string, { count: number; lines: Set<number> }>();
    for (const [word, data] of map) {
        if (data.count >= MIN_MID_SENTENCE_OCCURRENCES) {
            filtered.set(word, data);
        }
    }

    return filtered;
}

/** Merge multi-word names with single-name aliases. */
function mergeMultiWordAndAliases(
    text: string,
    candidates: Map<string, { count: number; lines: Set<number> }>,
): Map<string, { count: number; lines: Set<number>; aliases: string[] }> {
    const lineMap = buildLineOffsetTable(text);

    // Find multi-word names that appear in text and whose first word is also a candidate.
    const multiWordPattern = /\b([A-Z][a-z]+)\s([A-Z][a-z]+)\b/g;
    const mwCandidates = new Map<string, { count: number; lines: Set<number> }>();

    let m: RegExpExecArray | null;
    while ((m = multiWordPattern.exec(text)) !== null) {
        // Avoid matching at start of sentences only (those are likely not names).
        const before = text[m.index - 1];
        if (before && /\S/.test(before)) {
            // Mid-sentence occurrence; more likely a name.
            const fullName = m[0];
            if (!fullName) continue;
            const line = getLineFromOffset(lineMap, m.index);
            const entry = mwCandidates.get(fullName) ?? { count: 0, lines: new Set<number>() };
            entry.count++;
            if (line && entry.lines.size < 50) entry.lines.add(line);
            mwCandidates.set(fullName, entry);
        }
    }

    const result = new Map<string, { count: number; lines: Set<number>; aliases: string[] }>();

    // Seed with single-word candidates.
    for (const [name, data] of candidates) {
        result.set(name, { ...data, aliases: [] });
    }

    // Merge multi-word names into candidates if their first word is a candidate.
    for (const [fullName, mwData] of mwCandidates) {
        const parts = fullName.split(' ');
        const firstName = parts[0];
        if (!firstName) continue;
        const existingFirst = result.get(firstName);

        if (existingFirst && !NAME_STOPLIST.has(firstName)) {
            // Merge counts and lines into full name entity.
            const mergedCount = existingFirst.count + mwData.count;
            const mergedLines = new Set<number>(existingFirst.lines);
            for (const l of mwData.lines) {
                if (mergedLines.size < 50) mergedLines.add(l);
            }

            result.set(fullName, {
                count: mergedCount,
                lines: mergedLines,
                aliases: [firstName],
            });

            // Remove the first-name-only entry.
            result.delete(firstName);
        } else if (mwData.count >= 2) {
            // Standalone multi-word candidate without alias merge.
            const existing = result.get(fullName);
            if (!existing) {
                result.set(fullName, { ...mwData, aliases: [] });
            }
        }
    }

    return result;
}

/** Strip a leading title from a name (e.g., "Father Marcus" → "Marcus"). */
function stripTitle(name: string | undefined): string | null {
    if (!name) return null;
    const parts = name.trim().split(/\s+/);
    const first = parts[0];
    if (!first) return name.trim();
    if (parts.length >= 2 && TITLES.has(first)) {
        return parts.slice(1).join(' ');
    }
    return name.trim();
}

/** Build an array of line-start offsets for O(log n) lookups. */
function buildLineOffsetTable(text: string): number[] {
    const offsets: number[] = [0];
    let idx = 0;
    while (idx < text.length) {
        if (text[idx] === '\n') {
            offsets.push(idx + 1);
        }
        idx++;
    }
    return offsets;
}

/** Get a 1-based line number from an offset using the table. */
function getLineFromOffset(table: number[], offset: number): number | null {
    let lo = 0, hi = table.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const lineStart = table[mid];
        if (lineStart === undefined) break;
        if (lineStart <= offset) lo = mid + 1;
        else hi = mid - 1;
    }
    return hi >= 0 ? hi + 1 : null; // 1-based
}

/** Extract characters using multi-pass heuristics. */
export function extractCharacters(text: string): ExtractedEntity[] {
    if (!text.trim()) return [];

    const dialogue = extractFromDialogue(text);
    const possessives = extractFromPossessives(text);
    const midSentence = extractFromMidSentence(text);

    // Merge maps: dialogue and possessive are high-confidence; mid-sentence is lower.
    const merged = new Map<string, { count: number; lines: Set<number> }>();

    for (const [name, data] of dialogue) {
        const e = merged.get(name) ?? { count: 0, lines: new Set<number>() };
        e.count += data.count;
        for (const l of data.lines) if (e.lines.size < 50) e.lines.add(l);
        merged.set(name, e);
    }

    for (const [name, data] of possessives) {
        const e = merged.get(name) ?? { count: 0, lines: new Set<number>() };
        e.count += data.count;
        for (const l of data.lines) if (e.lines.size < 50) e.lines.add(l);
        merged.set(name, e);
    }

    // Mid-sentence: only add to existing or include if strong enough.
    for (const [name, data] of midSentence) {
        const e = merged.get(name) ?? { count: 0, lines: new Set<number>() };
        e.count += data.count;
        for (const l of data.lines) if (e.lines.size < 50) e.lines.add(l);
        merged.set(name, e);
    }

    const withAliases = mergeMultiWordAndAliases(text, merged);

    // Filter: require at least some occurrences.
    // Dialogue/possessive-based names are strong even at 1; mid-sentence-only needs more.
    const MIN_TOTAL_OCCURRENCES = 2;
    const entities: ExtractedEntity[] = [];

    for (const [name, data] of withAliases) {
        if (data.count < MIN_TOTAL_OCCURRENCES) continue;
        entities.push(makeEntity('character', name, data.count, data.lines, data.aliases));
    }

    entities.sort((a, b) => b.occurrences - a.occurrences);
    return entities;
}

/** Extract locations using prepositional and repeated-capitalized patterns. */
export function extractLocations(text: string, characterNames: Set<string>): ExtractedEntity[] {
    if (!text.trim()) return [];

    const lineMap = buildLineOffsetTable(text);
    const candidates = new Map<string, { count: number; lines: Set<number> }>();

    // Pass 1: preposition + "the" + capitalized word(s)
    const prepRe = /\b(?:to|into|across|through|toward|from|at|in|near|by|beyond|along|around|past|behind|before|above|below|beneath|under|over|inside|outside|onto|within|upon)\s+the\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\b/gi;
    let m: RegExpExecArray | null;

    while ((m = prepRe.exec(text)) !== null) {
        const raw = m[1];
        if (!raw) continue;
        const name = raw.trim();
        if (characterNames.has(name)) continue;
        addCandidate(candidates, lineMap, name, m.index);
    }

    // Pass 2: repeated "the [CapitalizedNoun]"
    const theRe = /\bthe\s+([A-Z][a-z]+)\b/g;
    while ((m = theRe.exec(text)) !== null) {
        const raw = m[1];
        if (!raw) continue;
        const word = raw.trim();
        if (characterNames.has(word) || NAME_STOPLIST.has(word)) continue;
        addCandidate(candidates, lineMap, word, m.index);
    }

    const entities: ExtractedEntity[] = [];
    for (const [name, data] of candidates) {
        if (data.count < 2) continue;
        entities.push(makeEntity('location', name, data.count, data.lines));
    }

    entities.sort((a, b) => b.occurrences - a.occurrences);
    return entities;
}

function addCandidate(
    map: Map<string, { count: number; lines: Set<number> }>,
    lineMap: number[],
    name: string,
    offset: number,
) {
    const line = getLineFromOffset(lineMap, offset);
    const e = map.get(name) ?? { count: 0, lines: new Set<number>() };
    e.count++;
    if (line && e.lines.size < 50) e.lines.add(line);
    map.set(name, e);
}

/** Lightweight plot-thread extraction from repeated three-word capitalized phrases. */
export function extractPlotThreads(
    text: string,
    characterNames: Set<string>,
    locationNames: Set<string>,
): ExtractedEntity[] {
    if (!text.trim()) return [];

    const lineMap = buildLineOffsetTable(text);
    const candidates = new Map<string, { count: number; lines: Set<number> }>();

    // Three consecutive capitalized words.
    const threeRe = /\b([A-Z][a-z]+\s+[A-Z][a-z]+\s+[A-Z][a-z]+)\b/g;
    let m: RegExpExecArray | null;

    while ((m = threeRe.exec(text)) !== null) {
        const raw = m[1];
        if (!raw) continue;
        const phrase = raw.trim();
        if (characterNames.has(phrase) || locationNames.has(phrase)) continue;
        addCandidate(candidates, lineMap, phrase, m.index);
    }

    const entities: ExtractedEntity[] = [];
    for (const [name, data] of candidates) {
        if (data.count < 2) continue;
        entities.push(makeEntity('plot-thread', name, data.count, data.lines));
    }

    entities.sort((a, b) => b.occurrences - a.occurrences);
    return entities;
}

/** Run all extraction steps and deduplicate by priority (character > location > plot-thread). */
export function extractAllEntities(text: string): ExtractedEntity[] {
    const characters = extractCharacters(text);
    const charNames = new Set<string>();
    for (const c of characters) {
        charNames.add(c.name);
        for (const a of c.aliases) charNames.add(a);
    }

    const locations = extractLocations(text, charNames);
    const locNames = new Set<string>();
    for (const l of locations) locNames.add(l.name);

    const threads = extractPlotThreads(text, charNames, locNames);

    // Deduplicate by name: higher-priority type wins.
    const seen = new Map<string, ExtractedEntity>();

    const addIfNew = (e: ExtractedEntity) => {
        const key = e.name.toLowerCase();
        if (!seen.has(key)) {
            seen.set(key, e);
        }
    };

    for (const e of characters) addIfNew(e);
    for (const e of locations) addIfNew(e);
    for (const e of threads) addIfNew(e);

    const all = [...seen.values()];
    all.sort((a, b) => b.occurrences - a.occurrences);
    return all;
}
