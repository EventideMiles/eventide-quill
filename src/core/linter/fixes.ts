import { LintFix } from './types';

export const FIXES: Record<string, LintFix> = {
    qualifiers: {
        description: 'Remove qualifier',
        apply: () => ''
    },
    adverbs: {
        description: 'Remove adverb',
        apply: () => ''
    },
    'ai-filler-adverbs': {
        description: 'Remove filler adverb',
        apply: () => ''
    },
    'ai-hedging': {
        description: 'Remove hedging language',
        apply: () => ''
    },
    'ai-wrap-ups': {
        description: 'Remove wrap-up phrase',
        apply: () => ''
    },
    'ai-em-dashes': {
        description: 'Replace em dash with period',
        apply: () => '.'
    },
    gremlins: {
        description: 'Remove invisible character',
        apply: () => ''
    }
};
