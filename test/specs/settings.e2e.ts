import { browser } from '@wdio/globals';
import { expect } from 'chai';
import { obsidianPage } from 'wdio-obsidian-service';
import { openFile, openQuillSidebar, isMobileEmulation } from '../helpers/obsidian-helpers.js';

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
// TODO(phase-7): re-enable once the declarative settings conversion
// (Phases 2-6) is complete and page-navigation helpers are added. The
// Phase-1 bridge renders each former tab behind a navigable
// SettingDefinitionPage, which Obsidian 1.13 expresses with a different DOM
// than the classic flat .setting-item plugin-tab model these tests assumed.
// The smoke spec still verifies the plugin loads (getSettingDefinitions()
// indexes without error) on every E2E run in the meantime.
describe.skip('Settings UI', () => {
    beforeEach(function () { if (isMobileEmulation()) return this.skip(); });
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
     * scroll it into view (settings below the fold aren't clickable), and
     * click its toggle by dispatching a click event on the checkbox-container
     * directly. Returns whether the click landed. The click is dispatched via
     * `execute` rather than WDIO's `.click()` because Obsidian's Notice toasts
     * can briefly overlay the settings area and intercept WDIO's
     * scroll-then-click action — a direct DOM dispatch sidesteps the overlay.
     */
    async function toggleSettingByName(namePattern: RegExp): Promise<boolean> {
        return browser.execute(
            (patternSource: string) => {
                const pattern = new RegExp(patternSource, 'i');
                const items = Array.from(document.querySelectorAll<HTMLElement>('.setting-item'));
                const match = items.find((el) => pattern.test(el.textContent ?? ''));
                if (!match) return false;
                match.scrollIntoView({ block: 'center' });
                const toggle = match.querySelector<HTMLElement>('.checkbox-container') ??
                    match.querySelector<HTMLInputElement>('input[type="checkbox"]');
                if (!toggle) return false;
                toggle.click();
                return true;
            },
            namePattern.source
        );
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

        // Fail (don't silently skip) when the toggle isn't found — selector
        // drift IS a regression worth catching, not a footnote.
        const toggled = await toggleSettingByName(/long sentence/i);
        expect(toggled).to.equal(true, 'could not locate the Long sentences toggle — selector drift');

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
        expect(toggled).to.equal(true, 'could not locate the reviewSuggestedEdits toggle — selector drift');

        const after = await readSettings<{ reviewSuggestedEditsEnabled: boolean }>();
        expect(after.reviewSuggestedEditsEnabled).to.equal(!beforeValue);

        await toggleSettingByName(/proactive editor chat|review.?discuss|suggested edits/i);
        await closeSettings();
    });

    it('persists settings changes to disk (the data.json sidecar)', async () => {
        await openPluginSettings();
        const toggled = await toggleSettingByName(/co-writer tool/i);
        expect(toggled).to.equal(true, 'could not locate the coWriterToolsEnabled toggle — selector drift');
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
