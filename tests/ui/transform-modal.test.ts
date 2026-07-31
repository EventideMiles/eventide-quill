// @vitest-environment happy-dom
import '../helpers/ui-setup';
import { describe, expect, it } from 'vitest';
import { App } from 'obsidian';
import { TransformModal } from '../../src/ui/transform-modal';

describe('transform-modal', () => {
    it('renders the title, word count, textarea, and Cancel + Transform buttons', () => {
        const modal = new TransformModal(new App(), 'hello world foo', () => {});
        modal.onOpen();

        expect(modal.contentEl.textContent).to.include('Custom transformation');
        expect(modal.contentEl.textContent).to.include('3 words');
        expect(modal.contentEl.querySelector('textarea')).to.exist;

        const texts = Array.from(modal.contentEl.querySelectorAll('button')).map((b) => b.textContent?.trim());
        expect(texts).to.include('Cancel');
        expect(texts).to.include('Transform');
    });

    it('fires onSubmit with the instruction when Transform is clicked', () => {
        let submitted: string | null = null;
        const modal = new TransformModal(new App(), 'some text', (instr) => {
            submitted = instr;
        });
        modal.onOpen();

        // Type into the textarea.
        const textarea = modal.contentEl.querySelector('textarea') as HTMLTextAreaElement;
        textarea.value = 'rewrite from the antagonist perspective';
        textarea.dispatchEvent(new Event('input'));

        // Click Transform.
        const transformBtn = Array.from(modal.contentEl.querySelectorAll('button')).find(
            (b) => b.textContent?.trim() === 'Transform'
        ) as HTMLButtonElement;
        transformBtn.click();

        expect(submitted).to.equal('rewrite from the antagonist perspective');
    });

    it('does nothing when Transform is clicked with an empty instruction', () => {
        let submitted = false;
        const modal = new TransformModal(new App(), 'some text', () => {
            submitted = true;
        });
        modal.onOpen();

        const transformBtn = Array.from(modal.contentEl.querySelectorAll('button')).find(
            (b) => b.textContent?.trim() === 'Transform'
        ) as HTMLButtonElement;
        transformBtn.click();

        expect(submitted).to.equal(false);
    });

    it('onClose empties the content', () => {
        const modal = new TransformModal(new App(), 'text', () => {});
        modal.onOpen();
        expect(modal.contentEl.children.length).to.be.greaterThan(0);
        modal.onClose();
        expect(modal.contentEl.children.length).to.equal(0);
    });
});
