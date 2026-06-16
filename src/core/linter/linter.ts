import { LintResult } from './types';
import {
    checkAdverbs,
    checkAiCliches,
    checkAiEmDashes,
    checkAiFillerAdverbs,
    checkAiHedging,
    checkAiNegation,
    checkAiWrapUps,
    checkComplexWords,
    checkDialogueTags,
    checkEchoes,
    checkLongSentences,
    checkPassiveVoice,
    checkQualifiers,
    checkRepeatedWords,
    checkTellingVsShowing
} from './rules';

export type { LintResult } from './types';

export interface LintOptions {
    enableLongSentences?: boolean;
    maxSentenceWords?: number;
    enablePassiveVoice?: boolean;
    enableAdverbCheck?: boolean;
    enableQualifierCheck?: boolean;
    enableRepeatedWords?: boolean;
    minRepeatedWordLength?: number;
    enableEchoes?: boolean;
    enableTellingVsShowing?: boolean;
    enableDialogueTags?: boolean;
    enableComplexWords?: boolean;
    maxSyllablesPerWord?: number;
    enableAiCliches?: boolean;
    enableAiEmDashes?: boolean;
    enableAiNegation?: boolean;
    enableAiFillerAdverbs?: boolean;
    enableAiHedging?: boolean;
    enableAiWrapUps?: boolean;
}

/** Run all enabled lint rules against `text` and return the combined results. */
export function lint(text: string, options?: LintOptions): LintResult[] {
    const results: LintResult[] = [];
    const opts = options ?? {};

    /** Execute a rule function, catching and logging any errors. */
    const run = (fn: () => LintResult[], name: string) => {
        try {
            results.push(...fn());
        } catch (e) {
            console.error(`Linter rule failed: ${name}`, e);
        }
    };

    if (opts.enableLongSentences ?? true) {
        run(() => checkLongSentences(text, opts.maxSentenceWords), 'long-sentences');
    }

    if (opts.enablePassiveVoice ?? false) {
        run(() => checkPassiveVoice(text), 'passive-voice');
    }

    if (opts.enableAdverbCheck ?? true) {
        run(() => checkAdverbs(text), 'adverbs');
    }

    if (opts.enableQualifierCheck ?? true) {
        run(() => checkQualifiers(text), 'qualifiers');
    }

    if (opts.enableRepeatedWords ?? true) {
        run(() => checkRepeatedWords(text, opts.minRepeatedWordLength), 'repeated-words');
    }

    if (opts.enableEchoes ?? true) {
        run(() => checkEchoes(text), 'echoes');
    }

    if (opts.enableTellingVsShowing ?? true) {
        run(() => checkTellingVsShowing(text), 'telling-vs-showing');
    }

    if (opts.enableDialogueTags ?? true) {
        run(() => checkDialogueTags(text), 'dialogue-tags');
    }

    if (opts.enableComplexWords ?? true) {
        run(() => checkComplexWords(text, opts.maxSyllablesPerWord), 'complex-words');
    }

    if (opts.enableAiCliches ?? true) {
        run(() => checkAiCliches(text), 'ai-cliches');
    }

    if (opts.enableAiEmDashes ?? true) {
        run(() => checkAiEmDashes(text), 'ai-em-dashes');
    }

    if (opts.enableAiNegation ?? true) {
        run(() => checkAiNegation(text), 'ai-negation');
    }

    if (opts.enableAiFillerAdverbs ?? true) {
        run(() => checkAiFillerAdverbs(text), 'ai-filler-adverbs');
    }

    if (opts.enableAiHedging ?? true) {
        run(() => checkAiHedging(text), 'ai-hedging');
    }

    if (opts.enableAiWrapUps ?? true) {
        run(() => checkAiWrapUps(text), 'ai-wrap-ups');
    }

    results.sort((a, b) => a.line - b.line || a.column - b.column);

    return results;
}
