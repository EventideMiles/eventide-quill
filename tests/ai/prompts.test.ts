import { describe, it, expect } from 'vitest';
import { getReviewDiscussSystemPrompt } from '../../src/ai/prompts';

describe('getReviewDiscussSystemPrompt', () => {
    it('includes the tool-discipline clause', () => {
        const prompt = getReviewDiscussSystemPrompt('editorial');
        expect(prompt).toContain('tool_calls field');
        expect(prompt).toMatch(/tool invocation written as text/i);
        expect(prompt).toContain('edit_note(');
    });

    it('states the approval-gate contract', () => {
        const prompt = getReviewDiscussSystemPrompt('critical');
        // The model must know nothing reaches the vault without the writer's click.
        expect(prompt).toMatch(/approves\s+or\s+rejects/i);
        expect(prompt).toMatch(/nothing reaches the vault/i);
    });

    it('tells the model to wait for the writer to ask before proposing edits', () => {
        const prompt = getReviewDiscussSystemPrompt('manuscript');
        expect(prompt).toMatch(/propose edits only after the writer asks/i);
    });

    it('advertises the editing tools by name', () => {
        const prompt = getReviewDiscussSystemPrompt('editorial');
        for (const tool of ['edit_note', 'insert_note', 'append_to_note', 'revise_edit']) {
            expect(prompt).toContain(tool);
        }
    });

    it('varies the engine label in the opening line', () => {
        const editorial = getReviewDiscussSystemPrompt('editorial');
        const critical = getReviewDiscussSystemPrompt('critical');
        const manuscript = getReviewDiscussSystemPrompt('manuscript');
        expect(editorial.toLowerCase()).toContain('editorial feedback');
        expect(critical.toLowerCase()).toContain('critical analysis');
        expect(manuscript.toLowerCase()).toContain('manuscript analysis');
    });

    it('uses the supplied engineLabel when given', () => {
        const prompt = getReviewDiscussSystemPrompt('critical', 'Plot logic');
        expect(prompt.toLowerCase()).toContain('plot logic');
    });

    it('includes an engine-specific scope reminder', () => {
        const editorial = getReviewDiscussSystemPrompt('editorial');
        const critical = getReviewDiscussSystemPrompt('critical');
        const manuscript = getReviewDiscussSystemPrompt('manuscript');
        expect(editorial).toMatch(/Editorial lens:/);
        expect(critical).toMatch(/Critical lens:/);
        expect(manuscript).toMatch(/Manuscript lens:/);
    });

    it('mentions vault_lookup and grep_notes as context-gathering tools', () => {
        const prompt = getReviewDiscussSystemPrompt('editorial');
        expect(prompt).toContain('vault_lookup');
        expect(prompt).toContain('grep_notes');
    });

    it('tells the model to prefer natural punctuation over em dashes', () => {
        const prompt = getReviewDiscussSystemPrompt('editorial');
        expect(prompt).toMatch(/natural.*punctuation/i);
        expect(prompt).toMatch(/em dashes/i);
        const generic = getReviewDiscussSystemPrompt('generic');
        expect(generic).toMatch(/natural.*punctuation/i);
    });

    describe('generic (Path B — manual entry)', () => {
        it('produces a valid prompt when engine is "generic"', () => {
            const prompt = getReviewDiscussSystemPrompt('generic');
            // Path B framing: the writer pasted a review, not the AI delivering a report.
            expect(prompt).toMatch(/review\s+or\s+critique/i);
            expect(prompt).toMatch(/the writer pasted the review/i);
        });

        it('produces a valid prompt when engine is omitted', () => {
            const prompt = getReviewDiscussSystemPrompt();
            expect(prompt).toMatch(/review\s+or\s+critique/i);
        });

        it('includes the coach-persona framing (actionable, prioritized)', () => {
            const prompt = getReviewDiscussSystemPrompt('generic');
            expect(prompt).toMatch(/start with what is working/i);
            expect(prompt).toMatch(/2-3 areas/i);
            expect(prompt).toMatch(/actionable\s+suggestion/i);
        });

        it('still includes the tool-discipline + approval-gate clauses', () => {
            const prompt = getReviewDiscussSystemPrompt('generic');
            expect(prompt).toContain('tool_calls field');
            expect(prompt).toContain('edit_note(');
            expect(prompt).toMatch(/approves\s+or\s+rejects/i);
            expect(prompt).toContain('vault_lookup');
        });

        it('does NOT reference a specific engine lens', () => {
            const prompt = getReviewDiscussSystemPrompt('generic');
            expect(prompt).not.toMatch(/Editorial lens:/);
            expect(prompt).not.toMatch(/Critical lens:/);
            expect(prompt).not.toMatch(/Manuscript lens:/);
        });
    });
});
