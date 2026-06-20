export type Severity = 'info' | 'warning' | 'error';

export interface LintResult {
    line: number;
    column: number;
    length: number;
    message: string;
    severity: Severity;
    rule: string;
}

export interface LintFix {
    description: string;
    apply(text: string, line: number, column: number, length: number): string | null;
}

export interface LintRule {
    id: string;
    name: string;
    description: string;
    severity: Severity;
    check(text: string): LintResult[];
}

export const FIXABLE_RULES = new Set([
    'qualifiers',
    'adverbs',
    'ai-filler-adverbs',
    'ai-hedging',
    'ai-wrap-ups',
    'ai-em-dashes',
    'gremlins'
]);

export interface RuleInfo {
    name: string;
    description: string;
    example: string;
}

export const RULE_INFO: Record<string, RuleInfo> = {
    'long-sentences': {
        name: 'Long sentences',
        description: 'Flags sentences that exceed the configured word limit.',
        example: 'Break long sentences into shorter ones for readability and pacing.'
    },
    'passive-voice': {
        name: 'Passive voice',
        description: 'Flags "was/were/been/being" + past participle constructions.',
        example: 'Use active voice unless the emphasis belongs on the receiver of the action.'
    },
    adverbs: {
        name: 'Adverbs',
        description: 'Flags -ly adverbs that qualify weak verbs.',
        example: 'Replace "He walked slowly" with a concrete action: "He trudged."'
    },
    qualifiers: {
        name: 'Qualifiers',
        description: 'Flags hedging words (very, really, quite, rather, somewhat, etc.) that weaken prose.',
        example: 'Remove or replace with a stronger word: "very happy" → "delighted."'
    },
    'repeated-words': {
        name: 'Repeated words',
        description: 'Flags words used 3+ times in a single sentence.',
        example: 'Vary word choice to avoid awkward repetition in a sentence.'
    },
    echoes: {
        name: 'Echoes',
        description: 'Flags the same word or short phrase starting 3+ consecutive sentences in a paragraph.',
        example: 'Vary sentence openings to avoid a repetitive rhythm.'
    },
    'telling-vs-showing': {
        name: 'Telling vs. showing',
        description:
            'Flags direct emotion-naming (he was angry, she felt sad) where showing through action or dialogue would be stronger.',
        example: 'Instead of "He was nervous," describe clammy hands, darting eyes, or a wavering voice.'
    },
    'dialogue-tags': {
        name: 'Dialogue tags',
        description:
            'Flags non-"said" and non-"asked" dialogue tags used more than once (whispered, murmured, growled, etc.). "Said" and "asked" are invisible and never flagged.',
        example: 'Replace repetitive tags with action beats or omit where the speaker is clear.'
    },
    'complex-words': {
        name: 'Complex words',
        description: 'Flags words with more than the configured syllable limit.',
        example: 'Consider a simpler alternative your readers will recognize instantly.'
    },
    'ai-cliches': {
        name: 'AI clichés',
        description: 'Flags overused words common in AI-generated prose (tapestry, delve, realm, glimmer, etc.).',
        example: 'Replace with natural, specific language that fits your narrative voice.'
    },
    'ai-em-dashes': {
        name: 'Em dashes',
        description: 'Flags em dashes (—), which AI prose tends to overuse.',
        example: 'Consider commas, colons, semicolons, or splitting the sentence instead.'
    },
    'ai-negation': {
        name: 'Negation patterns',
        description: 'Flags "it\'s not X, it\'s Y" and "not because X but because Y" constructions.',
        example: 'State what things are directly instead of describing what they are not.'
    },
    'ai-filler-adverbs': {
        name: 'Filler adverbs',
        description: 'Flags strategy adverbs common in AI prose (quietly, deliberately, gently, slowly, etc.).',
        example: 'Describe the concrete action instead of adding an adverb.'
    },
    'ai-hedging': {
        name: 'Hedging language',
        description:
            'Flags hedging words (might, could, perhaps, maybe, sort of, in a sense, etc.) that weaken certainty.',
        example: 'Use direct language unless character uncertainty is intentional.'
    },
    'ai-wrap-ups': {
        name: 'Wrap-up phrases',
        description: 'Flags concluding phrases (in conclusion, to summarize, ultimately, etc.).',
        example: 'End on action, dialogue, or unresolved tension — not summary.'
    },
    gremlins: {
        name: 'Gremlins',
        description:
            'Flags non-printing Unicode format characters (zero-width spaces, soft hyphens, variation selectors, etc.) that may be AI watermarks or copy-paste artifacts.',
        example:
            'Remove invisible characters that serve no purpose in prose — they can interfere with editing and introduce hidden tracking.'
    }
};
