import { describe, it, expect } from 'vitest';
import { detectTextToolCall, buildToolNudgeMessage, MAX_TEXT_TOOL_NUDGES } from '../../../src/ai/tools/text-tool-detect';

const TOOLS = [
    'edit_note',
    'insert_note',
    'append_to_note',
    'vault_lookup',
    'grep_notes',
    'propose_entry',
    'manuscript_mentions',
    'measure_folder'
];

describe('detectTextToolCall', () => {
    it('returns null for ordinary prose', () => {
        expect(detectTextToolCall('She walked to the door and opened it.', TOOLS)).toBeNull();
    });

    it('returns null for an empty response', () => {
        expect(detectTextToolCall('', TOOLS)).toBeNull();
    });

    it('returns null when no tools are registered', () => {
        expect(detectTextToolCall('edit_note(old_text: "x")', [])).toBeNull();
    });

    it('detects a bare text-form call: edit_note(...)', () => {
        const leak = detectTextToolCall('edit_note(old_text: "foo", new_text: "bar")', TOOLS);
        expect(leak).not.toBeNull();
        expect(leak!.name).toBe('edit_note');
        expect(leak!.snippet).toContain('edit_note(');
    });

    it('detects a call inside a fenced code block', () => {
        const resp = 'Here is my edit:\n```\npropose_entry(name: "Sarah", body: "...")\n```';
        const leak = detectTextToolCall(resp, TOOLS);
        expect(leak).not.toBeNull();
        expect(leak!.name).toBe('propose_entry');
    });

    it('detects a call with leading whitespace / markdown', () => {
        const leak = detectTextToolCall('- vault_lookup(path: "Characters/Sarah.md")', TOOLS);
        expect(leak).not.toBeNull();
        expect(leak!.name).toBe('vault_lookup');
    });

    it('does not match a tool name embedded in a longer word', () => {
        // "not_edit_note" should not trip the boundary check.
        expect(detectTextToolCall('some_not_edit_note_thing(args)', TOOLS)).toBeNull();
    });

    it('does not false-positive on prose that merely mentions a tool by name', () => {
        // Tool name present but not followed by '(' → not a call.
        expect(detectTextToolCall('You could use vault_lookup to check that.', TOOLS)).toBeNull();
    });

    it('returns the earliest-position leak when several are present', () => {
        const resp = 'first grep_notes("x") then edit_note(old_text: "y")';
        const leak = detectTextToolCall(resp, TOOLS);
        expect(leak).not.toBeNull();
        expect(leak!.name).toBe('grep_notes');
    });

    it('tolerates whitespace between the tool name and the opening paren', () => {
        const leak = detectTextToolCall('measure_folder  (paths: ["a"])', TOOLS);
        expect(leak).not.toBeNull();
        expect(leak!.name).toBe('measure_folder');
    });

    it('truncates the snippet to a reasonable length', () => {
        const longArgs = 'old_text: "' + 'x'.repeat(400) + '"';
        const leak = detectTextToolCall(`edit_note(${longArgs})`, TOOLS);
        expect(leak).not.toBeNull();
        expect(leak!.snippet.length).toBeLessThanOrEqual(100);
    });
});

describe('buildToolNudgeMessage', () => {
    it('builds a user-role message that names the leaked tool', () => {
        const msg = buildToolNudgeMessage({ name: 'edit_note', snippet: 'edit_note(old_text: "x")' });
        expect(msg.role).toBe('user');
        expect(msg.content).toContain('edit_note');
        expect(msg.content).toContain('tool_calls');
        expect(msg.content).toContain('tool-calling interface');
    });

    it('references the snippet so the model recognizes its own output', () => {
        const msg = buildToolNudgeMessage({ name: 'propose_entry', snippet: 'propose_entry(name: ...)' });
        expect(msg.content).toContain('propose_entry(name: ...)');
    });
});

describe('MAX_TEXT_TOOL_NUDGES', () => {
    it('is a small positive integer (bounds the retry loop)', () => {
        expect(Number.isInteger(MAX_TEXT_TOOL_NUDGES)).toBe(true);
        expect(MAX_TEXT_TOOL_NUDGES).toBeGreaterThanOrEqual(1);
        expect(MAX_TEXT_TOOL_NUDGES).toBeLessThanOrEqual(3);
    });
});
