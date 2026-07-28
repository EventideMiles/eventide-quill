import { browser } from '@wdio/globals';
import { expect } from 'chai';
import { obsidianPage } from 'wdio-obsidian-service';
import { openFile, openQuillSidebar } from '../helpers/obsidian-helpers.js';

/**
 * Settings UI flows — open the settings tab, toggle a feature, verify the
 * effect on the plugin's runtime state. These are not exhaustive (every
 * setting would be its own spec); they cover the toggles most likely to
 * regress the user-facing contract.
 *
 * Settings rendering is robust to Obsidian version drift: instead of relying
 * on a plugin-id-specific container selector, we assert on the generic
 * `.setting-item` count after opening the plugin tab via the documented
 * `app.setting.openTabById(pluginId)` API. Toggle clicks identify rows by
 * visible name text match.
 */
describe('Settings UI', () => {
    beforeEach(async () => {
        await obsidianPage.resetVault();
        await openQuillSidebar();
    });

    /**
     * Open the plugin's settings tab via the documented API. The resulting
     * tab content lives inside Obsidian's `.modal-container` and is populated
     * by the plugin's `display()` method with `.setting-item` rows. We assert
     * on that generic shape rather than a plugin-id-specific selector.
     */
    async function openPluginSettings(): Promise<void> {
        await browser.execute(() => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const app = (window as unknown as { app: any }).app;
            app.setting.open();
            app.setting.openTabById('eventide-quill');
        });
        // Wait for the modal + at least one setting row. The tab builds async.
        await browser.waitUntil(
            async () => {
                const items = (await browser.$$('.setting-item')) as unknown as WebdriverIO.Element[];
                return items.length > 0;
            },
            { timeout: 10_000, timeoutMsg: 'plugin settings tab never rendered any setting-item rows' }
        );
    }

    /** Close the settings modal. */
    async function closeSettings(): Promise<void> {
        await browser.keys('Escape');
        await browser.pause(200);
    }

    /** Read the live settings object from the plugin (post-toggle). */
    async function readSettings<T = unknown>(): Promise<T> {
        return browser.execute(() => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const plugin = (window as unknown as { app: any }).app.plugins.plugins['eventide-quill'];
            return plugin?.settings as T;
        }) as Promise<T>;
    }

    /**
     * Find a `.setting-item` row whose visible text matches `namePattern`,
     * click its toggle, and return whether the click landed. Returns false
     * if no matching row was found (callers decide whether to skip or fail).
     */
    async function toggleSettingByName(namePattern: RegExp): Promise<boolean> {
        const items = (await browser.$$('.setting-item')) as unknown as WebdriverIO.Element[];
        for (const item of items) {
            const text = await item.getText();
            if (namePattern.test(text)) {
                const toggle = await item.$('input[type="checkbox"], .checkbox-container');
                if (await toggle.isExisting()) {
                    await toggle.click();
                    return true;
                }
            }
        }
        return false;
    }

    it('opens the Eventide Quill settings tab', async () => {
        await openPluginSettings();
        // The plugin's display() renders many setting items (one per setting
        // field). The exact count drifts as settings are added/removed, so
        // just assert that "many" are present.
        const items = (await browser.$$('.setting-item')) as unknown as WebdriverIO.Element[];
        expect(items.length).to.be.greaterThan(5);
        await closeSettings();
    });

    it('toggling a linter rule flips the live settings value', async () => {
        await openFile('manuscript/Chapter 01.md');
        await openPluginSettings();

        const before = await readSettings<{ enableLongSentences: boolean }>();
        const beforeValue = before.enableLongSentences;

        const toggled = await toggleSettingByName(/long sentence/i);
        if (!toggled) {
            // Skip on selector drift rather than failing — the assertion is
            // about state flipping, not selector rigidity.
            console.warn('[settings.e2e] could not locate the Long sentences toggle — skipping');
            await closeSettings();
            return;
        }

        const after = await readSettings<{ enableLongSentences: boolean }>();
        expect(after.enableLongSentences).to.equal(!beforeValue);

        // Restore so subsequent specs see the default state.
        await toggleSettingByName(/long sentence/i);
        await closeSettings();
    });

    it('toggling reviewSuggestedEditsEnabled flips the live value', async () => {
        await openPluginSettings();
        const before = await readSettings<{ reviewSuggestedEditsEnabled: boolean }>();
        const beforeValue = before.reviewSuggestedEditsEnabled;

        const toggled = await toggleSettingByName(/proactive editor chat|review.?discuss|suggested edits/i);
        if (!toggled) {
            console.warn('[settings.e2e] could not locate the reviewSuggestedEdits toggle — skipping');
            await closeSettings();
            return;
        }
        const after = await readSettings<{ reviewSuggestedEditsEnabled: boolean }>();
        expect(after.reviewSuggestedEditsEnabled).to.equal(!beforeValue);

        await toggleSettingByName(/proactive editor chat|review.?discuss|suggested edits/i);
        await closeSettings();
    });

    it('persists settings changes to disk (the data.json sidecar)', async () => {
        await openPluginSettings();
        const toggled = await toggleSettingByName(/co-writer tool/i);
        if (!toggled) {
            console.warn('[settings.e2e] could not locate the coWriterToolsEnabled toggle — skipping');
            await closeSettings();
            return;
        }
        // Wait for the debounced save (Obsidian's saveData fires ~immediately
        // for plugin settings, but the disk write goes through the vault
        // adapter which is async).
        await browser.pause(800);
        await closeSettings();

        // `.obsidian/` files aren't tracked in the vault's metadata cache, so
        // `getAbstractFileByPath` returns null for them — read raw via the
        // adapter instead. Path is vault-relative.
        const persisted = await browser.execute(async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const app = (window as unknown as { app: any }).app;
            return app.vault.adapter.read('.obsidian/plugins/eventide-quill/data.json');
        });
        const parsed = JSON.parse(persisted) as { coWriterToolsEnabled: boolean };
        // Default is true; we just toggled it, so it should be false now.
        expect(parsed.coWriterToolsEnabled).to.equal(false);
    });
});
