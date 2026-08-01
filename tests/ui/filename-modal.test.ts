// @vitest-environment happy-dom
import '../helpers/ui-setup';
import { describe, expect, it } from 'vitest';
import { App } from 'obsidian';
import { FilenameModal } from '../../src/ui/filename-modal';

describe('filename-modal', () => {
    it('renders the title, an input with the default name, and Cancel + Save buttons', () => {
        const modal = new FilenameModal(new App(), 'my-session', () => {}, 'Save session');
        modal.onOpen();

        expect(modal.titleEl.textContent).to.equal('Save session');
        const input = modal.contentEl.querySelector('input') as HTMLInputElement;
        expect(input.value).to.equal('my-session');
        const texts = Array.from(modal.contentEl.querySelectorAll('button')).map((b) => b.textContent?.trim());
        expect(texts).to.include('Cancel');
        expect(texts).to.include('Save');
    });

    it('calls onChoose with the input value when Save is clicked', () => {
        let chosen: string | null = null;
        const modal = new FilenameModal(new App(), 'default', (path) => {
            chosen = path;
        });
        modal.onOpen();
        const input = modal.contentEl.querySelector('input') as HTMLInputElement;
        input.value = 'custom-name';
        (modal.contentEl.querySelector('button.mod-cta') as HTMLButtonElement).click();
        expect(chosen).to.equal('custom-name');
    });

    it('falls back to the default name when the input is blank', () => {
        let chosen: string | null = null;
        const modal = new FilenameModal(new App(), 'fallback', (path) => {
            chosen = path;
        });
        modal.onOpen();
        (modal.contentEl.querySelector('input') as HTMLInputElement).value = '   ';
        (modal.contentEl.querySelector('button.mod-cta') as HTMLButtonElement).click();
        expect(chosen).to.equal('fallback');
    });

    it('uses "Save conversation" as the default title', () => {
        const modal = new FilenameModal(new App(), 'x', () => {});
        modal.onOpen();
        expect(modal.titleEl.textContent).to.equal('Save conversation');
    });
});
