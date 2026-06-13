export type Severity = 'info' | 'warning' | 'error';

export interface LintResult {
    line: number;
    column: number;
    length: number;
    message: string;
    severity: Severity;
    rule: string;
}

export interface LintRule {
    id: string;
    name: string;
    description: string;
    severity: Severity;
    check(text: string): LintResult[];
}
