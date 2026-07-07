import { describe, it, expect } from 'vitest';
import { FEEDBACK_PERSONAS, getPersonaById, buildFeedbackMessages } from '../../src/ai/feedback';
import type { FeedbackPersona } from '../../src/ai/feedback';

describe('FEEDBACK_PERSONAS', () => {
    it('contains at least 4 personas', () => {
        expect(FEEDBACK_PERSONAS.length).toBeGreaterThanOrEqual(4);
    });

    it('includes developmental-editor, line-editor, beta-reader, and coach', () => {
        const ids = FEEDBACK_PERSONAS.map((p) => p.id);
        expect(ids).toContain('developmental-editor');
        expect(ids).toContain('line-editor');
        expect(ids).toContain('beta-reader');
        expect(ids).toContain('coach');
    });

    it('every persona has non-empty id, name, description, and instructions', () => {
        for (const persona of FEEDBACK_PERSONAS) {
            expect(persona.id.length).toBeGreaterThan(0);
            expect(persona.name.length).toBeGreaterThan(0);
            expect(persona.description.length).toBeGreaterThan(0);
            expect(persona.instructions.length).toBeGreaterThan(0);
        }
    });

    it('has no duplicate ids', () => {
        const ids = FEEDBACK_PERSONAS.map((p) => p.id);
        expect(new Set(ids).size).toBe(ids.length);
    });
});

describe('getPersonaById', () => {
    it('finds a persona by id', () => {
        const persona = getPersonaById('developmental-editor');
        expect(persona).toBeDefined();
        expect(persona!.name).toBe('Developmental editor');
    });

    it('returns undefined for an unknown id', () => {
        expect(getPersonaById('nonexistent')).toBeUndefined();
    });

    it('returns undefined for empty string', () => {
        expect(getPersonaById('')).toBeUndefined();
    });
});

describe('buildFeedbackMessages', () => {
    it('returns a system + user message pair', () => {
        const messages = buildFeedbackMessages();
        expect(messages).toHaveLength(2);
        expect(messages[0]!.role).toBe('system');
        expect(messages[1]!.role).toBe('user');
    });

    it('includes persona instructions when a persona is provided', () => {
        const persona: FeedbackPersona = FEEDBACK_PERSONAS[0]!;
        const messages = buildFeedbackMessages(persona);
        expect(messages[0]!.content).toContain(persona.instructions);
    });

    it('includes custom instruction in the user message when provided', () => {
        const messages = buildFeedbackMessages(undefined, { customInstruction: 'Focus on dialogue' });
        expect(messages[1]!.content).toContain('Focus on dialogue');
    });

    it('works without any arguments (defaults)', () => {
        const messages = buildFeedbackMessages();
        expect(messages[0]!.content.length).toBeGreaterThan(0);
        expect(messages[1]!.content.length).toBeGreaterThan(0);
    });
});
