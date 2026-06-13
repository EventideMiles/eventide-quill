import { LintResult } from './types';
import { ALL_RULES } from './rules';

export type { LintResult } from './types';

export function lint(text: string): LintResult[] {
    const results: LintResult[] = [];

    for (const rule of ALL_RULES) {
        try {
            const ruleResults = rule(text);
            results.push(...ruleResults);
        } catch (e) {
            console.error(`Linter rule failed: ${rule.name}`, e);
        }
    }

    results.sort((a, b) => a.line - b.line || a.column - b.column);

    return results;
}
