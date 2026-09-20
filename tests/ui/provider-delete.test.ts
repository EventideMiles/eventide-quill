// @vitest-environment happy-dom
import '../helpers/ui-setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App, Modal } from 'obsidian';
import { EventideQuillSettingTab } from '../../src/settings';
import { ConfirmModal } from '../../src/ui/confirm-modal';
import type { ModelConfig, ModelRole, ProviderConfig } from '../../src/ai/provider';
import type EventideQuillPlugin from '../../src/main';

// The stub Modal.open() is a no-op, so ConfirmModal never renders its buttons
// in tests unless we intercept. This spy renders each opened modal's DOM and
// records the instance so a test can click Cancel / Delete on the real modal.
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

/** Build a provider fixture with sensible defaults and the given overrides. */
function makeProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
    return {
        id: 'prov-a',
        name: 'Provider A',
        type: 'openai-compatible',
        endpoint: 'http://localhost:1234/v1',
        apiKey: '',
        models: [],
        maxContextTokens: 32768,
        maxOutputTokens: 4096,
        ...overrides
    };
}

/** Build a model fixture. */
function makeModel(id: string, role: ModelRole, model: string): ModelConfig {
    return { id, role, model };
}

/** Build the settings tab over a stubbed plugin and render the target provider's detail page. */
function makeHarness(
    target: ProviderConfig,
    providers: ProviderConfig[],
    defaults: [string, string, string] = ['', '', '']
): {
    tab: EventideQuillSettingTab;
    settings: {
        aiProviders: ProviderConfig[];
        aiDefaultChatProvider: string;
        aiDefaultEmbedProvider: string;
        aiDefaultImageProvider: string;
    };
    saveSettings: ReturnType<typeof vi.fn>;
    container: HTMLElement;
} {
    const settings = {
        aiProviders: providers,
        aiDefaultChatProvider: defaults[0],
        aiDefaultEmbedProvider: defaults[1],
        aiDefaultImageProvider: defaults[2]
    };
    const saveSettings = vi.fn(async (): Promise<void> => {});
    const plugin = { settings, saveSettings } as unknown as EventideQuillPlugin;
    const tab = new EventideQuillSettingTab(new App(), plugin);
    const container = createDiv();
    tab.renderProviderPage(container, target);
    return { tab, settings, saveSettings, container };
}

/** Find the first `.setting-item` row whose name cell matches `name` exactly. */
function findSettingRow(container: HTMLElement, name: string): HTMLElement | null {
    for (const row of Array.from(container.querySelectorAll<HTMLElement>('.setting-item'))) {
        const rowName = row.querySelector('.setting-item-name')?.textContent?.trim();
        if (rowName === name) return row;
    }
    return null;
}

/** Find a button by its trimmed label text. */
function findButton(root: HTMLElement | null, label: string): HTMLButtonElement | null {
    if (!root) return null;
    return Array.from(root.querySelectorAll('button')).find((b) => b.textContent?.trim() === label) ?? null;
}

/** Click the labeled button, throwing a readable error when it is missing. */
function clickButton(root: HTMLElement | null, label: string): void {
    const button = findButton(root, label);
    if (!button) throw new Error(`Button "${label}" not found`);
    button.click();
}

/** The most recently opened confirmation modal (throws when none opened). */
function lastModal(): ConfirmModal {
    const modal = modals.at(-1);
    if (!modal) throw new Error('No confirmation modal was opened');
    return modal;
}

describe('provider detail page — Delete provider control', () => {
    it('renders a visible warning-styled Delete button in a "Delete provider" row', () => {
        const provider = makeProvider();
        const { container } = makeHarness(provider, [provider]);

        const row = findSettingRow(container, 'Delete provider');
        expect(row).to.exist;

        const button = findButton(row, 'Delete');
        expect(button).to.exist;
        expect(button?.classList.contains('mod-warning')).to.equal(true);
    });

    it('opens the confirmation modal on click; cancelling leaves settings untouched', () => {
        const a = makeProvider({ id: 'prov-a', name: 'Provider A' });
        const b = makeProvider({ id: 'prov-b', name: 'Provider B' });
        const { settings, saveSettings, container } = makeHarness(a, [a, b]);

        clickButton(findSettingRow(container, 'Delete provider'), 'Delete');

        const modal = lastModal();
        expect(modal.titleEl.textContent).to.equal('Delete provider?');
        expect(modal.contentEl.textContent).to.include('Provider A');
        // Neither dynamic warning applies to this fixture.
        expect(modal.contentEl.textContent).to.not.include('will be reset');
        expect(modal.contentEl.textContent).to.not.include('only provider');

        clickButton(modal.contentEl, 'Cancel');

        expect(settings.aiProviders).to.have.lengthOf(2);
        expect(saveSettings).not.toHaveBeenCalled();
    });

    it('confirming removes the provider, saves, and clears the dangling default-model keys', async () => {
        const a = makeProvider({
            id: 'prov-a',
            name: 'Provider A',
            models: [makeModel('m1', 'chat', 'model-a'), makeModel('m2', 'embed', 'model-b'), makeModel('m3', 'image', 'model-c')]
        });
        const b = makeProvider({ id: 'prov-b', name: 'Provider B' });
        const { tab, settings, saveSettings, container } = makeHarness(a, [a, b], ['prov-a/m1', 'prov-a/m2', 'prov-a/m3']);
        const updateSpy = vi.spyOn(tab, 'update');

        clickButton(findSettingRow(container, 'Delete provider'), 'Delete');
        clickButton(lastModal().contentEl, 'Delete');

        expect(settings.aiProviders.map((p) => p.id)).to.deep.equal(['prov-b']);
        expect(settings.aiDefaultChatProvider).to.equal('');
        expect(settings.aiDefaultEmbedProvider).to.equal('');
        expect(settings.aiDefaultImageProvider).to.equal('');
        expect(saveSettings).toHaveBeenCalledTimes(1);
        // The re-render fires from saveSettings().then(...) — wait for the microtask chain.
        await vi.waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1));
    });

    it('warns in the modal when the provider backs default models and when it is the last one', () => {
        const only = makeProvider({ id: 'prov-a', name: 'Provider A', models: [makeModel('m1', 'chat', 'model-a')] });
        const { settings, saveSettings, container } = makeHarness(only, [only], ['prov-a/m1', '', '']);

        clickButton(findSettingRow(container, 'Delete provider'), 'Delete');

        const message = lastModal().contentEl.textContent ?? '';
        expect(message).to.include('Provider A');
        expect(message).to.include('will be reset');
        expect(message).to.include('only provider');

        clickButton(lastModal().contentEl, 'Delete');

        expect(settings.aiProviders).to.have.lengthOf(0);
        expect(settings.aiDefaultChatProvider).to.equal('');
        expect(saveSettings).toHaveBeenCalledTimes(1);
    });

    it('removes by id, not by name, when two providers share a name', () => {
        const a = makeProvider({ id: 'prov-a', name: 'Same name' });
        const b = makeProvider({ id: 'prov-b', name: 'Same name' });
        const { settings, container } = makeHarness(b, [a, b]);

        clickButton(findSettingRow(container, 'Delete provider'), 'Delete');
        clickButton(lastModal().contentEl, 'Delete');

        expect(settings.aiProviders.map((p) => p.id)).to.deep.equal(['prov-a']);
    });
});
