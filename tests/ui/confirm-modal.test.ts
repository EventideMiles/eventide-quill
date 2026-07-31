// @vitest-environment happy-dom
import '../helpers/ui-setup';
import { describe, expect, it } from 'vitest';
import { App } from 'obsidian';
import { ConfirmModal } from '../../src/ui/confirm-modal';

describe('confirm-modal', () => {
    it('renders the title, message, Cancel, and Confirm buttons', () => {
        const modal = new ConfirmModal(new App(), 'Delete?', 'Are you sure?', () => {}, 'Delete');
        modal.onOpen();

        expect(modal.titleEl.textContent).to.equal('Delete?');
        expect(modal.contentEl.textContent).to.include('Are you sure?');

        const texts = Array.from(modal.contentEl.querySelectorAll('button')).map((b) => b.textContent?.trim());
        expect(texts).to.include('Cancel');
        expect(texts).to.include('Delete');
        // The confirm button has the mod-cta class.
        const confirmBtn = modal.contentEl.querySelector('button.mod-cta');
        expect(confirmBtn).to.exist;
    });

    it('fires onConfirm when the confirm button is clicked', () => {
        let confirmed = false;
        const modal = new ConfirmModal(new App(), 'T', 'M', () => {
            confirmed = true;
        });
        modal.onOpen();

        const confirmBtn = modal.contentEl.querySelector('button.mod-cta') as HTMLButtonElement;
        confirmBtn.click();

        expect(confirmed).to.equal(true);
    });

    it('renders + fires an optional secondary action button', () => {
        let secondaryFired = false;
        const modal = new ConfirmModal(
            new App(),
            'T',
            'M',
            () => {},
            'OK',
            { text: 'Save first', handler: () => {
                secondaryFired = true;
            } }
        );
        modal.onOpen();

        const texts = Array.from(modal.contentEl.querySelectorAll('button')).map((b) => b.textContent?.trim());
        expect(texts).to.include('Save first');

        const secondaryBtn = Array.from(modal.contentEl.querySelectorAll('button')).find(
            (b) => b.textContent?.trim() === 'Save first'
        ) as HTMLButtonElement;
        secondaryBtn.click();

        expect(secondaryFired).to.equal(true);
    });

    it('uses "Confirm" as the default button text', () => {
        const modal = new ConfirmModal(new App(), 'T', 'M', () => {});
        modal.onOpen();
        const texts = Array.from(modal.contentEl.querySelectorAll('button')).map((b) => b.textContent?.trim());
        expect(texts).to.include('Confirm');
    });
});
