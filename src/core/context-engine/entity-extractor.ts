import { ExtractedEntity } from './types';
import { splitSentences } from '../../utils/text-analysis';

/** Expanded stoplist: pronouns, articles, common non-name words, months, days, etc. */
const NAME_STOPLIST = new Set([
    'I',
    'The',
    'A',
    'An',
    'It',
    'He',
    'She',
    'They',
    'We',
    'You',
    'His',
    'Her',
    'Their',
    'Them',
    'Its',
    'My',
    'Your',
    'Our',
    'This',
    'That',
    'These',
    'Those',
    'There',
    'Here',
    'Then',
    'Now',
    'When',
    'What',
    'Where',
    'Who',
    'Why',
    'How',
    'And',
    'But',
    'Or',
    'Nor',
    'For',
    'Yet',
    'So',
    'To',
    'From',
    'In',
    'On',
    'At',
    'By',
    'With',
    'Of',
    'As',
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
    'Sunday',
    'Spring',
    'Summer',
    'Autumn',
    'Winter',
    'Chapter',
    'One',
    'Two',
    'Three',
    'Four',
    'Five',
    'Six',
    'Seven',
    'Eight',
    'Nine',
    'Ten',
    'Once',
    'Up',
    'Down',
    'Left',
    'Right',
    'Yes',
    'No',
    'Maybe',
    'Oh',
    'Well',
    'Because'
]);

// ── Title prefixes ───────────────────────────────────────────────────────────
// Abbreviated titles require a trailing period in the text (Mr., Dr., Mrs.).
const TITLE_ABBREVIATIONS = ['Mr', 'Mrs', 'Ms', 'Dr', 'St', 'Rev', 'Prof', 'Gen', 'Capt', 'Maj'];

// Full-word titles never take a period (Sir, Lord, Captain, Father, ...).
const TITLE_FULL_WORDS = [
    'Uncle',
    'Aunt',
    'Cousin',
    'Grandmother',
    'Grandfather',
    'Sir',
    'Madam',
    'Lord',
    'Lady',
    'Captain',
    'Doctor',
    'Professor',
    'Detective',
    'Agent',
    'General',
    'Colonel',
    'Major',
    'Private',
    'Sergeant',
    'Father',
    'Mother',
    'Brother',
    'Sister',
    'Son',
    'Daughter',
    'King',
    'Queen',
    'Prince',
    'Princess',
    'Duke',
    'Duchess'
];

/** Combined set of all title words for membership checks (mid-sentence filter, etc.). */
const TITLES = new Set([...TITLE_ABBREVIATIONS, ...TITLE_FULL_WORDS]);

// ── Name suffixes ────────────────────────────────────────────────────────────
// Abbreviated suffixes: Jr., Sr., Esq. (period optional in source text).
const SUFFIX_ABBREVIATIONS = ['Jr', 'Sr', 'Esq'];
// Full-word suffixes: Junior, Senior.
const SUFFIX_FULL_WORDS = ['Junior', 'Senior'];
/** Combined set of suffix words for membership checks. */
const SUFFIXES = new Set([...SUFFIX_ABBREVIATIONS, ...SUFFIX_FULL_WORDS]);

// Roman numeral suffixes II–XIII as a regex source string.
const ROMAN_NUMERAL_SRC = 'I{2,3}|IV|V(?:I{1,3})?|IX|X(?:I{1,3})?';

// ── Reusable regex source strings ─────────────────────────────────────────────

/**
 * Optional title prefix regex source.
 * Matches abbreviated titles with a required period (Mr., Dr.) OR full-word
 * titles without a period (Sir, Lord, Captain). Always followed by whitespace.
 */
const TITLE_PREFIX_SRC =
    '(?:' +
    '(?:' +
    TITLE_ABBREVIATIONS.join('|') +
    ')\\.\\s+' +
    '|' +
    '(?:' +
    TITLE_FULL_WORDS.join('|') +
    ')\\s+' +
    ')';

/**
 * Negative lookahead that prevents the last-name capture group from
 * swallowing suffix words like "Jr" or "Junior" (which would otherwise
 * match `[A-Z][a-z]+`). Roman numerals are safe because they're all-caps.
 */
const LAST_NAME_NEGATIVE_LOOKAHEAD = '(?!' + [...SUFFIX_ABBREVIATIONS, ...SUFFIX_FULL_WORDS].join('|') + ')\\b';

/**
 * Optional name suffix regex source.
 * Matches " Jr.", " Sr." (period optional), " Junior", " Senior", or a
 * Roman numeral II–XIII. Always preceded by whitespace.
 */
const SUFFIX_SRC =
    '(?:\\s+(?:' +
    '(?:' +
    SUFFIX_ABBREVIATIONS.join('|') +
    ')\\.?' +
    '|' +
    '(?:' +
    SUFFIX_FULL_WORDS.join('|') +
    ')' +
    '|' +
    '(?:' +
    ROMAN_NUMERAL_SRC +
    ')' +
    '))';

/**
 * Full name capture group regex source.
 *
 * Structure: (optional title prefix) + FirstName + (optional LastName) + (optional suffix)
 *
 * Captures "Sarah Connor", "Mrs. Norrell", "Lord Byron", "Martin King Jr.",
 * "John Paul II", or plain "Marcus" as a single unit. The negative lookahead
 * on the last-name group prevents suffix words from being captured as a
 * surname.
 */
const NAME_GROUP_SRC =
    '(' +
    '(?:' +
    TITLE_PREFIX_SRC +
    ')?' +
    '[A-Z][a-z]+' +
    '(?:\\s+' +
    LAST_NAME_NEGATIVE_LOOKAHEAD +
    '[A-Z][a-z]+)?' +
    '(?:' +
    SUFFIX_SRC +
    ')?' +
    ')';

/** Minimum occurrences for a mid-sentence capitalized word to qualify as a character. */
const MIN_MID_SENTENCE_OCCURRENCES = 2;

const ABBREVIATIONS_PATTERN = new RegExp('\\b(Mr|Mrs|Ms|Dr|Sr|Jr|St|Rev|Prof|Gen|Capt|Maj)\\.$', 'i');

/** Normalize a name into an ID-safe token: lowercase, strip periods, spaces → hyphens. */
function normalizeName(name: string): string {
    return name.toLowerCase().replace(/\./g, '').replace(/\s+/g, '-');
}

/** Build ExtractedEntity from data. */
function makeEntity(
    type: 'character' | 'location' | 'plot-thread',
    name: string,
    occurrences: number,
    lines: Set<number>,
    aliases?: string[]
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
        manual: false
    };
}

/** Check whether a word is a Roman numeral (II–XIII). */
function isRomanNumeral(word: string): boolean {
    return /^(?:I{2,3}|IV|V(?:I{1,3})?|IX|X(?:I{1,3})?)$/.test(word);
}

/**
 * Split a multi-word name into its meaningful components (excluding titles and suffixes).
 * "Mrs. Norrell" → ["Norrell"], "Freddy Lupin" → ["Freddy", "Lupin"],
 * "Martin King Jr." → ["Martin", "King"], "John Paul II" → ["John", "Paul"].
 */
function splitNameComponents(name: string): string[] {
    const parts = name.trim().split(/\s+/);
    const components: string[] = [];
    for (const part of parts) {
        const clean = part.replace(/\.$/, '');
        if (TITLES.has(clean)) continue;
        if (SUFFIXES.has(clean)) continue;
        if (isRomanNumeral(clean)) continue;
        components.push(clean);
    }
    return components;
}

// ── Line-offset helpers ───────────────────────────────────────────────────────

/** Build an array of line-start offsets for O(log n) lookups. */
function buildLineOffsetTable(text: string): number[] {
    const offsets: number[] = [0];
    let idx = 0;
    while (idx < text.length) {
        if (text[idx] === '\n') offsets.push(idx + 1);
        idx++;
    }
    return offsets;
}

/** Get a 1-based line number from an offset using binary search. */
function getLineFromOffset(table: number[], offset: number): number | null {
    let lo = 0,
        hi = table.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const lineStart = table[mid];
        if (lineStart === undefined) break;
        if (lineStart <= offset) lo = mid + 1;
        else hi = mid - 1;
    }
    return hi >= 0 ? hi + 1 : null;
}

function addCandidate(
    map: Map<string, { count: number; lines: Set<number> }>,
    lineMap: number[],
    name: string,
    offset: number
): void {
    const line = getLineFromOffset(lineMap, offset);
    const e = map.get(name) ?? { count: 0, lines: new Set<number>() };
    e.count++;
    if (line && e.lines.size < 50) e.lines.add(line);
    map.set(name, e);
}

// ── Character extraction passes ───────────────────────────────────────────────

const DIALOGUE_VERBS =
    'said|asked|replied|whispered|shouted|yelled|cried|murmured|muttered|whined|bellowed|screamed|hissed|snapped|snarled|growled|scoffed|snorted|laughed|chuckled|sobbed|sighed|breathed|gasped|panted|mused|added|corrected';

/** Extract character candidates from dialogue attribution patterns. */
function extractFromDialogue(
    text: string,
    excludeNames?: Set<string>
): Map<string, { count: number; lines: Set<number> }> {
    const map = new Map<string, { count: number; lines: Set<number> }>();
    const lineMap = buildLineOffsetTable(text);

    // Pattern 1: "quote", Name said
    const p1 = new RegExp('"[^"]*"\\s*,?\\s*' + NAME_GROUP_SRC + '\\s+(?:' + DIALOGUE_VERBS + ')\\b', 'gi');
    // Pattern 2: Name said, "quote"
    const p2 = new RegExp('\\b' + NAME_GROUP_SRC + '\\s+(?:' + DIALOGUE_VERBS + ')\\s*,?\\s*"[^"]*"', 'gi');

    for (const pattern of [p1, p2]) {
        let m: RegExpExecArray | null;
        while ((m = pattern.exec(text)) !== null) {
            const name = m[1]?.trim();
            if (!name) continue;
            if (isStoplistName(name)) continue;
            if (excludeNames?.has(name)) continue;
            addCandidate(map, lineMap, name, m.index);
        }
    }
    return map;
}

/** Extract character candidates from possessive forms ("Sarah's", "Mrs. Norrell's"). */
function extractFromPossessives(
    text: string,
    excludeNames?: Set<string>
): Map<string, { count: number; lines: Set<number> }> {
    const map = new Map<string, { count: number; lines: Set<number> }>();
    const lineMap = buildLineOffsetTable(text);
    const re = new RegExp('\\b' + NAME_GROUP_SRC + "'s\\b", 'g');

    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        const name = m[1]?.trim();
        if (!name) continue;
        if (isStoplistName(name)) continue;
        if (excludeNames?.has(name)) continue;
        addCandidate(map, lineMap, name, m.index);
    }
    return map;
}

/** Extract single capitalized words from mid-sentence positions. */
function extractFromMidSentence(
    text: string,
    excludeNames?: Set<string>
): Map<string, { count: number; lines: Set<number> }> {
    const map = new Map<string, { count: number; lines: Set<number> }>();
    const sentences = splitSentences(text, ABBREVIATIONS_PATTERN);

    for (const sentence of sentences) {
        const words = sentence.text.match(/\b[A-Z][a-z]+\b/g);
        if (!words) continue;

        for (let i = 1; i < words.length; i++) {
            const word = words[i];
            if (!word) continue;
            // Filter stoplist, titles, and suffixes — these should never be
            // standalone character candidates.
            if (NAME_STOPLIST.has(word)) continue;
            if (TITLES.has(word)) continue;
            if (SUFFIXES.has(word)) continue;
            if (excludeNames?.has(word)) continue;

            const line = sentence.line;
            const entry = map.get(word) ?? { count: 0, lines: new Set<number>() };
            entry.count++;
            if (entry.lines.size < 50) entry.lines.add(line);
            map.set(word, entry);
        }
    }

    // Keep only those with sufficient occurrences.
    const filtered = new Map<string, { count: number; lines: Set<number> }>();
    for (const [word, data] of map) {
        if (data.count >= MIN_MID_SENTENCE_OCCURRENCES) filtered.set(word, data);
    }
    return filtered;
}

/** Return true if the first meaningful word of `name` is in the stoplist or is a standalone title. */
function isStoplistName(name: string): boolean {
    const firstWord = name.split(/[.\s]/)[0];
    return !firstWord || NAME_STOPLIST.has(firstWord);
}

// ── Alias resolution ─────────────────────────────────────────────────────────

/**
 * Merge multi-word names with single-name aliases.
 *
 * Algorithm:
 * 1. Build a component-word index from multi-word candidates already in the map
 *    (from dialogue / possessive passes). E.g. "Freddy Lupin" → { "Freddy" → ["Freddy Lupin"], "Lupin" → ["Freddy Lupin"] }.
 * 2. For each single-word candidate, check if it matches exactly one multi-word
 *    name's component. If so, merge counts/lines and record the single word as
 *    an alias. If the word matches multiple multi-word names (ambiguous, e.g.
 *    two characters share a first name), skip the merge.
 * 3. Scan text for title-aware multi-word names not yet captured and try to
 *    resolve remaining single-word candidates against them.
 */
function mergeMultiWordAndAliases(
    text: string,
    candidates: Map<string, { count: number; lines: Set<number> }>
): Map<string, { count: number; lines: Set<number>; aliases: string[] }> {
    const result = new Map<string, { count: number; lines: Set<number>; aliases: string[] }>();

    // Seed with all candidates.
    for (const [name, data] of candidates) {
        result.set(name, { ...data, aliases: [] });
    }

    // Helper to merge counts/lines from a single-word candidate into a multi-word one.
    const mergeInto = (fullName: string, aliasName: string): void => {
        const target = result.get(fullName);
        const source = result.get(aliasName);
        if (!target || !source) return;
        target.count += source.count;
        for (const l of source.lines) {
            if (target.lines.size < 50) target.lines.add(l);
        }
        if (!target.aliases.includes(aliasName)) {
            target.aliases.push(aliasName);
        }
        result.delete(aliasName);
    };

    // --- Pass 1: resolve single-word candidates against existing multi-word candidates ---
    // Build component index from multi-word names currently in the result.
    const resolveAgainstExisting = (): void => {
        // componentWord → Set of full names that contain it
        const componentIndex = new Map<string, Set<string>>();
        for (const name of result.keys()) {
            const parts = name.split(/\s+/);
            if (parts.length < 2) continue;
            for (const comp of splitNameComponents(name)) {
                let set = componentIndex.get(comp);
                if (!set) {
                    set = new Set();
                    componentIndex.set(comp, set);
                }
                set.add(name);
            }
        }

        // Resolve single-word candidates.
        const singleWords = [...result.keys()].filter((n) => !n.includes(' '));
        for (const single of singleWords) {
            const matches = componentIndex.get(single);
            if (!matches || matches.size !== 1) continue; // 0 = no match, >1 = ambiguous
            const fullName = [...matches][0]!;
            if (fullName) mergeInto(fullName, single);
        }
    };

    resolveAgainstExisting();

    // --- Pass 2: scan text for additional multi-word names and resolve again ---
    const lineMap = buildLineOffsetTable(text);
    const nameScanRe = new RegExp('\\b' + NAME_GROUP_SRC + '\\b', 'g');
    let scanMatch: RegExpExecArray | null;

    while ((scanMatch = nameScanRe.exec(text)) !== null) {
        const fullName = scanMatch[1]?.trim();
        if (!fullName) continue;
        if (!fullName.includes(' ')) continue; // skip single-word matches from this pass
        if (result.has(fullName)) continue; // already captured

        // Check that this is a mid-sentence occurrence (preceded by non-whitespace).
        const before = text[scanMatch.index - 1];
        if (!before || /\s/.test(before)) continue;

        // Add the multi-word name as a new candidate.
        const line = getLineFromOffset(lineMap, scanMatch.index);
        const entry = { count: 0, lines: new Set<number>() };
        entry.count++;
        if (line && entry.lines.size < 50) entry.lines.add(line);
        result.set(fullName, { ...entry, aliases: [] });
    }

    resolveAgainstExisting();

    return result;
}

// ── Public extraction functions ───────────────────────────────────────────────

/** Extract characters using multi-pass heuristics. */
export function extractCharacters(text: string, excludeNames?: Set<string>): ExtractedEntity[] {
    if (!text.trim()) return [];

    const dialogue = extractFromDialogue(text, excludeNames);
    const possessives = extractFromPossessives(text, excludeNames);
    const midSentence = extractFromMidSentence(text, excludeNames);

    // Merge maps.
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
    for (const [name, data] of midSentence) {
        const e = merged.get(name) ?? { count: 0, lines: new Set<number>() };
        e.count += data.count;
        for (const l of data.lines) if (e.lines.size < 50) e.lines.add(l);
        merged.set(name, e);
    }

    const withAliases = mergeMultiWordAndAliases(text, merged);

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

    // Pass 1: preposition + "the" + capitalized word(s).
    const prepRe =
        /\b(?:to|into|across|through|toward|from|at|in|near|by|beyond|along|around|past|behind|before|above|below|beneath|under|over|inside|outside|onto|within|upon)\s+the\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\b/gi;
    let m: RegExpExecArray | null;

    while ((m = prepRe.exec(text)) !== null) {
        const name = m[1]?.trim();
        if (!name) continue;
        if (characterNames.has(name)) continue;
        addCandidate(candidates, lineMap, name, m.index);
    }

    // Pass 2: repeated "the [CapitalizedNoun]".
    const theRe = /\bthe\s+([A-Z][a-z]+)\b/g;
    while ((m = theRe.exec(text)) !== null) {
        const word = m[1]?.trim();
        if (!word) continue;
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

/** Lightweight plot-thread extraction from repeated three-word capitalized phrases. */
export function extractPlotThreads(
    text: string,
    characterNames: Set<string>,
    locationNames: Set<string>
): ExtractedEntity[] {
    if (!text.trim()) return [];

    const lineMap = buildLineOffsetTable(text);
    const candidates = new Map<string, { count: number; lines: Set<number> }>();

    const threeRe = /\b([A-Z][a-z]+\s+[A-Z][a-z]+\s+[A-Z][a-z]+)\b/g;
    let m: RegExpExecArray | null;

    while ((m = threeRe.exec(text)) !== null) {
        const phrase = m[1]?.trim();
        if (!phrase) continue;
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

/**
 * Run all extraction steps and deduplicate by priority.
 *
 * Locations are detected BEFORE characters so that location-like names
 * (e.g. "Howlington") are excluded from the character candidate pool. This
 * reduces misclassification of place names as characters.
 */
export function extractAllEntities(text: string): ExtractedEntity[] {
    // Step 1: detect location candidates without character-name filtering.
    const rawLocations = extractLocations(text, new Set());
    const locationNames = new Set<string>();
    for (const l of rawLocations) locationNames.add(l.name);

    // Step 2: extract characters, excluding raw location candidates.
    const characters = extractCharacters(text, locationNames);
    const charNames = new Set<string>();
    for (const c of characters) {
        charNames.add(c.name);
        for (const a of c.aliases) charNames.add(a);
    }

    // Step 3: finalize locations — drop any that were claimed as characters.
    const locations = rawLocations.filter((l) => !charNames.has(l.name));
    const locNames = new Set<string>();
    for (const l of locations) locNames.add(l.name);

    // Step 4: plot threads.
    const threads = extractPlotThreads(text, charNames, locNames);

    // Deduplicate by name: character > location > plot-thread.
    const seen = new Map<string, ExtractedEntity>();
    const addIfNew = (e: ExtractedEntity) => {
        const key = e.name.toLowerCase();
        if (!seen.has(key)) seen.set(key, e);
    };

    for (const e of characters) addIfNew(e);
    for (const e of locations) addIfNew(e);
    for (const e of threads) addIfNew(e);

    const all = [...seen.values()];
    all.sort((a, b) => b.occurrences - a.occurrences);
    return all;
}
