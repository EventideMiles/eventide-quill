import { TFile, Vault } from 'obsidian';

/** Capitalized words to ignore — not character names. */
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

/** Maximum vault files to examine. */
const MAX_FILES_TO_SCAN = 20;

/** Maximum characters to read per matched file. */
const MAX_CHARS_PER_FILE = 2000;

/** Minimum occurrences for a name to be considered established. */
const MIN_NAME_OCCURRENCES = 3;

/**
 * Extract potential character/entity names from text using heuristics.
 * Looks for capitalized words (not at sentence start) that appear
 * multiple times in the document.
 */
export function extractNames(text: string): string[] {
    // Split into sentences so we can filter out sentence-start capitals
    const sentences = text.split(/[.!?]+\s+/);
    const candidates = new Map<string, number>();

    for (const sentence of sentences) {
        const words = sentence.match(/\b[A-Z][a-z]+\b/g);
        if (!words) continue;

        for (const word of words) {
            // Skip the first word of each sentence (likely sentence-start capitalization)
            if (word === words[0]) continue;
            if (NAME_STOPLIST.has(word)) continue;

            candidates.set(word, (candidates.get(word) ?? 0) + 1);
        }
    }

    // Also catch multi-word proper names (e.g. "New York", "Sarah Connor")
    const multiWordPattern = /\b([A-Z][a-z]+)\s([A-Z][a-z]+)\b/g;
    let match: RegExpExecArray | null;
    while ((match = multiWordPattern.exec(text)) !== null) {
        const fullName = match[0];
        if (!sentences.some((s) => s.startsWith(fullName))) {
            candidates.set(fullName, (candidates.get(fullName) ?? 0) + 1);
        }
    }

    return Array.from(candidates.entries())
        .filter(([, count]) => count >= MIN_NAME_OCCURRENCES)
        .sort(([, a], [, b]) => b - a)
        .map(([name]) => name);
}

/**
 * Search the vault for files that reference the extracted names and
 * return a formatted context string for inclusion in the AI prompt.
 */
export async function gatherVaultContext(
    vault: Vault,
    documentText: string,
): Promise<string> {
    const names = extractNames(documentText);
    if (names.length === 0) return '';

    const allFiles = vault.getMarkdownFiles();

    // First pass: match by filename (no I/O)
    const matchedFiles: { file: TFile; score: number }[] = [];

    for (const file of allFiles) {
        const path = file.path.toLowerCase();
        const matches = names.filter((n) => path.includes(n.toLowerCase()));
        if (matches.length >= 1) {
            matchedFiles.push({ file, score: matches.length });
        }
    }

    // Sort by match score (most relevant first) and limit
    matchedFiles.sort((a, b) => b.score - a.score);
    const topFiles = matchedFiles.slice(0, MAX_FILES_TO_SCAN);

    if (topFiles.length === 0) return '';

    // Second pass: read file contents and find matching lines
    const snippets: string[] = [];

    for (const { file, score } of topFiles) {
        try {
            const content = await vault.cachedRead(file);
            const head = content.slice(0, MAX_CHARS_PER_FILE);
            const foundNames = names.filter(
                (n) => head.toLowerCase().includes(n.toLowerCase()),
            );
            if (foundNames.length < 2 && score < 2) continue;

            // Extract relevant lines
            const lines = head.split('\n').slice(0, 30);
            const matchingLines = lines.filter((line) =>
                foundNames.some((n) =>
                    line.toLowerCase().includes(n.toLowerCase()),
                ),
            );

            snippets.push(
                `[${file.path}]${
                    matchingLines.length > 0
                        ? `\n  ${matchingLines.slice(0, 5).join('\n  ')}`
                        : ''
                }`,
            );
        } catch {
            // Skip files that fail to read
        }
    }

    if (snippets.length === 0) return '';

    return (
        `Characters and references found in vault:\n${names.join(', ')}\n\n` +
        `Related notes:\n${snippets.join('\n\n')}`
    );
}
