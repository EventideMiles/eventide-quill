// @vitest-environment happy-dom
import '../helpers/ui-setup';
import { describe, expect, it } from 'vitest';
import { App } from 'obsidian';
import { FixWithAiModal } from '../../src/ui/fix-with-ai-modal';
import type { LintResult } from '../../src/core/linter/types';
import type EventideQuillPlugin from '../../src/main';

/** Build a long-sentences `LintResult` fixture with the given overrides. */
function makeResult(overrides: Partial<LintResult> = {}): LintResult {
    return {
        rule: 'long-sentences',
        line: 1,
        text: 'A very long sentence that goes on and on.',
        start: 0,
        end: 44,
        message: 'This sentence is too long.',
        suggestion: null,
        ...overrides
    } as unknown as LintResult;
}

describe('fix-with-ai-modal', () => {
    it('renders the custom instruction view with the rule name + a textarea', () => {
        const plugin = { settings: { enableDebugLogging: false } } as unknown as EventideQuillPlugin;
        const modal = new FixWithAiModal(
            new App(),
            plugin,
            makeResult(),
            'A very long sentence that goes on and on.\nMore text.',
            () => {},
            'rewrite shorter'
        );
        modal.onOpen();

        // Title includes the rule name.
        expect(modal.titleEl.textContent).to.include('Long');
        // Custom instruction UI.
        expect(modal.contentEl.textContent).to.include('Custom instruction');
        expect(modal.contentEl.querySelector('textarea')).to.exist;
        // The custom instruction is pre-filled.
        expect((modal.contentEl.querySelector('textarea') as HTMLTextAreaElement).value).to.include('rewrite shorter');
    });

    it('has a Back button in the custom-input view', () => {
        const plugin = { settings: {} } as unknown as EventideQuillPlugin;
        const modal = new FixWithAiModal(new App(), plugin, makeResult(), 'text\n', () => {}, 'instruction');
        modal.onOpen();
        const texts = Array.from(modal.contentEl.querySelectorAll('button')).map((b) => b.textContent?.trim());
        expect(texts.some((t) => t?.toLowerCase().includes('back'))).to.equal(true);
    });

    it('onClose empties the content', () => {
        const plugin = { settings: {} } as unknown as EventideQuillPlugin;
        const modal = new FixWithAiModal(new App(), plugin, makeResult(), 'text\n', () => {}, 'x');
        modal.onOpen();
        expect(modal.contentEl.children.length).to.be.greaterThan(0);
        modal.onClose();
        expect(modal.contentEl.children.length).to.equal(0);
    });
});
