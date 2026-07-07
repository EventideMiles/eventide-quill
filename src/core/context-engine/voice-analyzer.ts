import { VoiceMarker } from './types';
import { splitSentences } from '../../utils/text-analysis';

const ABBREVIATIONS_PATTERN = new RegExp('\\b(Mr|Mrs|Ms|Dr|Sr|Jr|St|Rev|Prof|Gen|Capt|Maj)\\.$', 'i');

const FIRST_PERSON_PRONOUNS = /\b(I|me|my|mine|myself)\b/gi;
const THIRD_PERSON_PRONOUNS = /\b(he|she|him|her|his|hers|himself|herself|they|them|their|theirs|themselves)\b/gi;
const SECOND_PERSON_PRONOUNS = /\b(you|your|yours|yourself)\b/gi;

const PAST_INDICATORS =
    /\b(was|were|had|been|did|went|came|said|took|gave|made|knew|thought|felt|saw|heard|looked|turned|walked|stood|sat)\b/gi;
const PRESENT_INDICATORS =
    /\b(is|are|has|have|does|goes|comes|says|takes|gives|makes|knows|thinks|feels|sees|hears|looks|turns|walks|stands|sits)\b/gi;

/** Analyze narrative voice markers in text. */
export function analyzeVoice(text: string): VoiceMarker {
    if (!text.trim()) {
        return {
            pov: 'unknown',
            tense: 'unknown',
            avgSentenceLength: 0,
            dialogueRatio: 0,
            descriptionRatio: 1
        };
    }

    const pov = detectPov(text);
    const tense = detectTense(text);
    const avgSentenceLength = computeAvgSentenceLength(text);
    const { dialogueRatio, descriptionRatio } = computeDialogueRatio(text);

    return {
        pov,
        tense,
        avgSentenceLength,
        dialogueRatio,
        descriptionRatio
    };
}

/** Detect the narrative point of view based on pronoun usage. */
function detectPov(text: string): string {
    const firstCount = countMatches(text, FIRST_PERSON_PRONOUNS);
    const thirdCount = countMatches(text, THIRD_PERSON_PRONOUNS);
    const secondCount = countMatches(text, SECOND_PERSON_PRONOUNS);

    const total = firstCount + thirdCount + secondCount;
    if (total === 0) return 'unknown';

    const firstPct = firstCount / total;
    const thirdPct = thirdCount / total;
    const secondPct = secondCount / total;

    if (firstPct > 0.3) return 'first-person';
    if (secondPct > 0.3) return 'second-person';
    if (thirdPct > 0.6) return 'third-person';
    return 'unknown';
}

/** Detect the narrative tense based on verb indicators. */
function detectTense(text: string): string {
    const pastCount = countMatches(text, PAST_INDICATORS);
    const presentCount = countMatches(text, PRESENT_INDICATORS);

    if (pastCount > presentCount * 1.5) return 'past';
    if (presentCount > pastCount * 1.5) return 'present';
    return 'mixed';
}

/** Count the number of regex matches in a string using matchAll. */
function countMatches(text: string, pattern: RegExp): number {
    return Array.from(text.matchAll(pattern)).length;
}

/** Compute the average sentence length in words from the given text. */
function computeAvgSentenceLength(text: string): number {
    const sentences = splitSentences(text, ABBREVIATIONS_PATTERN);
    if (sentences.length === 0) return 0;

    let totalWords = 0;
    for (const s of sentences) {
        const words = s.text.split(/\s+/).filter((w) => w.length > 0);
        totalWords += words.length;
    }

    return sentences.length > 0 ? Math.round(totalWords / sentences.length) : 0;
}

/** Compute the ratio of dialogue (quoted text) and description in the given text. */
export function computeDialogueRatio(text: string): { dialogueRatio: number; descriptionRatio: number } {
    let inQuotes = false;
    let quotedChars = 0;
    let whitespaceChars = 0;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '"') {
            inQuotes = !inQuotes;
        } else if (inQuotes) {
            quotedChars++;
        } else if (ch && /\s/.test(ch)) {
            whitespaceChars++;
        }
    }

    const total = text.length - whitespaceChars;
    if (total === 0) return { dialogueRatio: 0, descriptionRatio: 1 };

    const dialogueRatio = quotedChars / total;
    const descriptionRatio = Math.max(0, Math.min(1, 1 - dialogueRatio));

    return {
        dialogueRatio: Math.round(dialogueRatio * 100) / 100,
        descriptionRatio: Math.round(descriptionRatio * 100) / 100
    };
}
