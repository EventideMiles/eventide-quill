import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../src/ai/provider';
import {
    buildFileLabel,
    buildRequestBreakdown,
    formatBreakdownTooltip,
    formatTokenIndicatorText,
    getBudgetColor
} from '../../src/ui/token-indicator';

describe('token-indicator — buildFileLabel', () => {
    it.each([
        [3, 2, '3 manuscript + 2 reference'],
        [1, 0, '1 manuscript'],
        [0, 1, '1 reference'],
        [0, 0, 'No files in context']
    ])('manuscript=%i reference=%i → %s', (m, r, expected) => {
        expect(buildFileLabel(m, r)).to.equal(expected);
    });
});

describe('token-indicator — formatTokenIndicatorText', () => {
    it('formats within-budget text', () => {
        expect(formatTokenIndicatorText('Chat', 1000, 8192)).to.equal('Chat \u00b7 1000 / 8192 tokens');
    });
    it('adds (over budget) when total exceeds max', () => {
        expect(formatTokenIndicatorText('Chat', 9000, 8192)).to.include('(over budget)');
    });
});

describe('token-indicator — getBudgetColor', () => {
    it.each([
        [0, 'var(--color-green)'],
        [59, 'var(--color-green)'],
        [60, 'var(--color-yellow)'],
        [79, 'var(--color-yellow)'],
        [80, 'var(--color-orange)'],
        [99, 'var(--color-orange)'],
        [100, 'var(--color-red)'],
        [150, 'var(--color-red)']
    ])('pct=%i → %s', (pct, expected) => {
        expect(getBudgetColor(pct)).to.equal(expected);
    });
});

describe('token-indicator — formatBreakdownTooltip', () => {
    it('renders sections with percentages + a total line', () => {
        const tooltip = formatBreakdownTooltip(
            {
                sections: [
                    { label: 'Tool definitions', tokens: 300 },
                    { label: 'Chat history', tokens: 700, detail: '2 turns' }
                ],
                total: 1000
            },
            8192
        );
        expect(tooltip).to.include('Token breakdown:');
        expect(tooltip).to.include('Tool definitions');
        expect(tooltip).to.include('300');
        expect(tooltip).to.include('30%');
        expect(tooltip).to.include('Chat history (2 turns)');
        expect(tooltip).to.include(`Total: ${(1000).toLocaleString()} / ${(8192).toLocaleString()} window`);
    });
});

describe('token-indicator — buildRequestBreakdown', () => {
    it('categorizes system messages and buckets user/assistant as chat history', () => {
        const messages: ChatMessage[] = [
            { role: 'system', content: 'You are a helpful writing assistant.' },
            { role: 'user', content: 'Write a scene where the detective arrives.' },
            { role: 'assistant', content: 'The detective stepped through the doorway...' }
        ];
        const breakdown = buildRequestBreakdown(messages, 400);
        expect(breakdown.sections.length).to.equal(3); // Tool defs + System prompt + Chat history
        expect(breakdown.sections[0]!.label).to.equal('Tool definitions');
        expect(breakdown.sections[0]!.tokens).to.equal(400);
        expect(breakdown.sections.some((s) => s.label === 'System / mode prompt')).to.equal(true);
        const chat = breakdown.sections.find((s) => s.label === 'Chat history');
        expect(chat).to.exist;
        expect(chat!.detail).to.include('2 turns');
        expect(breakdown.total).to.be.greaterThan(0);
    });

    it('counts tool-result messages as tokens but not as turns', () => {
        const messages: ChatMessage[] = [
            { role: 'user', content: 'What characters are in chapter 1?' },
            { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'manuscript_mentions', arguments: '{}' }] },
            { role: 'tool', content: 'Sarah Connor, John Connor', toolCallId: 'c1', name: 'manuscript_mentions' },
            { role: 'assistant', content: 'The characters are Sarah and John.' }
        ];
        const breakdown = buildRequestBreakdown(messages, 0);
        const chat = breakdown.sections.find((s) => s.label === 'Chat history');
        expect(chat).to.exist;
        // 3 real turns (user + tool-call-bearing assistant + final assistant);
        // only the role:'tool' result is excluded from the turn count.
        expect(chat!.detail).to.include('3 turns');
    });
});
