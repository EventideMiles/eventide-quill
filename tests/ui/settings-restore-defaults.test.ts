// @vitest-environment happy-dom
import '../helpers/ui-setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App, Modal } from 'obsidian';
import type { SettingDefinitionAction, SettingDefinitionPage } from 'obsidian';
import { DEFAULT_SETTINGS, EventideQuillSettingTab } from '../../src/settings';
import { ConfirmModal } from '../../src/ui/confirm-modal';
import type EventideQuillPlugin from '../../src/main';

// The stub Modal.open() is a no-op, so ConfirmModal never renders its buttons
// in tests unless we intercept. This spy renders each opened modal's DOM and
// records the instance so a test can click Cancel / Restore on the real modal.
let modals: ConfirmModal[] = [];
/** Restore the pristine stub Modal.open() after a test has captured modals. */
let restoreOpen: () => void;

beforeEach(() => {
    modals = [];
    const spy = vi.spyOn(Modal.prototype, 'open').mockImplementation(function (this: Modal) {
        modals.push(this as ConfirmModal);
        void this.onOpen();
    });
    restoreOpen = (): void => spy.mockRestore();
});

afterEach(() => {
    restoreOpen();
});

/**
 * Extract the Model behaviors page's confirm-gated "Restore defaults" action
 * from the live declarative definitions tree — the same action the framework
 * invokes when the writer clicks the row.
 */
function restoreDefaultsAction(tab: EventideQuillSettingTab): SettingDefinitionAction['action'] {
    for (const item of tab.getSettingDefinitions()) {
        const page = item as SettingDefinitionPage;
        if (page.type !== 'page' || page.name !== 'Model behaviors') continue;
        for (const child of page.items ?? []) {
            if ('action' in child && child.name === 'Restore defaults') {
                return (child as SettingDefinitionAction).action;
            }
        }
    }
    throw new Error('"Restore defaults" action not found on the Model behaviors page');
}

/** Find a button by its trimmed label text inside the given root. */
function findButton(root: HTMLElement | null, label: string): HTMLButtonElement | null {
    if (!root) return null;
    return Array.from(root.querySelectorAll('button')).find((b) => b.textContent?.trim() === label) ?? null;
}

/** The most recently opened confirmation modal (throws when none opened). */
function lastModal(): ConfirmModal {
    const modal = modals.at(-1);
    if (!modal) throw new Error('No confirmation modal was opened');
    return modal;
}

describe('Model behaviors — Restore all defaults action', () => {
    it('resets aiResponseLanguage to empty (plus a sanity field) and persists via saveSettings', async () => {
        const settings = { ...DEFAULT_SETTINGS, aiResponseLanguage: 'French', enableDashboard: false };
        const saveSettings = vi.fn(async (): Promise<void> => {});
        const plugin = { settings, saveSettings, manifest: { id: 'eventide-quill' } } as unknown as EventideQuillPlugin;
        const tab = new EventideQuillSettingTab(new App(), plugin);

        const action = restoreDefaultsAction(tab);
        action(createDiv(), 0);

        // The action opens the confirmation modal rather than restoring directly.
        const modal = lastModal();
        expect(modals).to.have.lengthOf(1);
        expect(modal.titleEl.textContent).to.equal('Restore all defaults?');
        expect(settings.aiResponseLanguage).to.equal('French'); // untouched before confirm

        const confirm = findButton(modal.contentEl, 'Restore');
        expect(confirm).to.exist;
        confirm!.click();

        await vi.waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(1));
        expect(settings.aiResponseLanguage).to.equal('');
        expect(settings.enableDashboard).to.equal(true);
    });
});
