import { describe, it, expect } from 'vitest';
import { getReviewDiscussSystemPrompt } from '../../src/ai/prompts';

describe('getReviewDiscussSystemPrompt', () => {
    it('includes the tool-discipline clause', () => {
        const prompt = getReviewDiscussSystemPrompt('editorial');
        // Mirrors the lorebook-coach pattern: the discipline clause must be
        // inlined in the system prompt itself, not rely on per-request injection.
        expect(prompt).toContain('tool_calls field');
        expect(prompt).toMatch(/never write a tool invocation as text/i);
        expect(prompt).toContain('edit_note(');
    });

    it('states the approval-gate contract', () => {
        const prompt = getReviewDiscussSystemPrompt('critical');
        // The model must know nothing reaches the vault without the writer's click.
        expect(prompt).toMatch(/approves or rejects/i);
        expect(prompt).toMatch(/nothing reaches the vault without their click/i);
    });

    it('tells the model to wait for the writer to ask before proposing edits', () => {
        const prompt = getReviewDiscussSystemPrompt('manuscript');
        expect(prompt).toMatch(/do NOT propose edits preemptively/i);
        // Word-boundary spans a line break in the prompt; \s+ accommodates it.
        expect(prompt).toMatch(/wait for the writer to ask for\s+or\s+agree to/i);
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
});
