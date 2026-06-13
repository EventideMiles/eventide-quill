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
]);
