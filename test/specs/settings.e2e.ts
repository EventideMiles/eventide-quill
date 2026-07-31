import { browser } from '@wdio/globals';
import { expect } from 'chai';
import { obsidianPage } from 'wdio-obsidian-service';
import { openFile, openQuillSidebar, isMobileEmulation } from '../helpers/obsidian-helpers.js';

/**
 * Settings UI flows — open the settings tab, navigate into a declarative
 * SettingDefinitionPage, toggle a feature, and verify the effect on the
 * plugin's runtime state. Page navigation uses Obsidian's internal
 * `app.setting` nav API (`getNavigableSettingItems` + `activateSettingItem`),
 * the 1.13 declarative counterparts to `openTabById`.
 */
describe('Settings UI', () => {
    beforeEach(function () {
        if (isMobileEmulation()) return this.skip();
    });
    beforeEach(async () => {
        await obsidianPage.resetVault();
        await openQuillSidebar();
    });

    async function openPluginSettings(): Promise<void> {
        await browser.execute(() => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const app = (window as unknown as { app: any }).app;
            app.setting.open();
            app.setting.openTabById('eventide-quill');
        });
        await browser.waitUntil(
            async () => {
                const items = (await browser.execute(() => {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const s = (window as unknown as { app: any }).app.setting;
                    return typeof s.getNavigableSettingItems === 'function' ? s.getNavigableSettingItems().length : 0;
                })) as number;
                return items > 0;
            },
            { timeout: 10_000, timeoutMsg: 'plugin settings tab never rendered its page entries' }
        );
    }

    /**
     * Navigate into a top-level settings page by name (e.g. "Linter") via the
     * internal nav API, then pause for the page content to mount.
     */
    async function openSettingsPage(pageName: string): Promise<void> {
        await browser.execute((name: string) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const s = (window as unknown as { app: any }).app.setting;
            const items = typeof s.getNavigableSettingItems === 'function' ? s.getNavigableSettingItems() : [];
            const target = items.find((el: HTMLElement) => {
                const n = el.querySelector('.setting-item-name')?.textContent?.trim() ?? '';
                return n === name || (el.textContent ?? '').trim().startsWith(name);
            });
            if (target && typeof s.activateSettingItem === 'function') s.activateSettingItem(target);
        }, pageName);
        await browser.pause(300);
    }

    async function closeSettings(): Promise<void> {
        await browser.keys('Escape');
        await browser.pause(200);
    }

    async function readSettings<T = unknown>(): Promise<T> {
        return browser.execute(() => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const plugin = (window as unknown as { app: any }).app.plugins.plugins['eventide-quill'];
            return plugin?.settings as T;
        }) as Promise<T>;
    }

    async function toggleSettingByName(namePattern: RegExp): Promise<boolean> {
        return browser.execute(
            (patternSource: string) => {
                const pattern = new RegExp(patternSource, 'i');
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const s = (window as unknown as { app: any }).app.setting;
                // Declarative page content lives under the settings modal's current
                // page element (not the top-level document), so scope to it when
                // available — fall back to the whole document otherwise.
                const roots: ParentNode[] = [];
                if (typeof s.getCurrentPageEl === 'function') {
                    const cur = s.getCurrentPageEl();
                    if (cur) roots.push(cur);
                }
                roots.push(document);
                let match: HTMLElement | null = null;
                for (const root of roots) {
                    match = Array.from(root.querySelectorAll<HTMLElement>('.setting-item')).find((el) =>
                        pattern.test(el.textContent ?? '')
                    ) ?? null;
                    if (match) break;
                }
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

    it('opens the Eventide Quill settings tab with six navigable pages', async () => {
        await openPluginSettings();
        const names = (await browser.execute(() => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const s = (window as unknown as { app: any }).app.setting;
            const items = typeof s.getNavigableSettingItems === 'function' ? s.getNavigableSettingItems() : [];
            return items.map((el: HTMLElement) => el.querySelector('.setting-item-name')?.textContent?.trim() ?? '');
        })) as string[];
        expect(names).to.deep.equal(['Welcome', 'General', 'Lorebook', 'Linter', 'AI providers', 'Model behaviors']);
        await closeSettings();
    });

    it('exposes the internal settings-nav API the declarative suite depends on', async () => {
        await openPluginSettings();
        const api = (await browser.execute(() => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const s = (window as unknown as { app: any }).app.setting ?? {};
            return {
                openTabById: typeof s.openTabById === 'function',
                getNavigableSettingItems: typeof s.getNavigableSettingItems === 'function',
                activateSettingItem: typeof s.activateSettingItem === 'function',
                getCurrentPageEl: typeof s.getCurrentPageEl === 'function'
            };
        })) as Record<string, boolean>;
        // Canary: if Obsidian renames these, the settings E2E breaks loudly here
        // instead of producing mystifying "selector drift" failures downstream.
        expect(api.openTabById && api.getNavigableSettingItems && api.activateSettingItem && api.getCurrentPageEl).to.equal(
            true,
            `settings nav API changed: ${JSON.stringify(api)}`
        );
        await closeSettings();
    });

    it('toggling a linter rule flips the live settings value', async () => {
        await openFile('manuscript/Chapter 01.md');
        await openPluginSettings();
        await openSettingsPage('Linter');

        const before = await readSettings<{ enableLongSentences: boolean }>();
        const beforeValue = before.enableLongSentences;

        const toggled = await toggleSettingByName(/long sentence/i);
        expect(toggled).to.equal(true, 'could not locate the Long sentences toggle — selector drift');

        const after = await readSettings<{ enableLongSentences: boolean }>();
        expect(after.enableLongSentences).to.equal(!beforeValue);

        await toggleSettingByName(/long sentence/i);
        await closeSettings();
    });

    it('toggling reviewSuggestedEditsEnabled flips the live value', async () => {
        await openPluginSettings();
        await openSettingsPage('Model behaviors');
        const before = await readSettings<{ reviewSuggestedEditsEnabled: boolean }>();
        const beforeValue = before.reviewSuggestedEditsEnabled;

        const toggled = await toggleSettingByName(/proactive editor chat|review.?discuss|suggested edits/i);
        expect(toggled).to.equal(true, 'could not locate the review-discuss toggle — selector drift');

        const after = await readSettings<{ reviewSuggestedEditsEnabled: boolean }>();
        expect(after.reviewSuggestedEditsEnabled).to.equal(!beforeValue);

        await toggleSettingByName(/proactive editor chat|review.?discuss|suggested edits/i);
        await closeSettings();
    });

    it('persists settings changes to disk (the data.json sidecar)', async () => {
        await openPluginSettings();
        await openSettingsPage('Welcome');
        const toggled = await toggleSettingByName(/co-writer tool/i);
        expect(toggled).to.equal(true, 'could not locate the coWriterToolsEnabled toggle — selector drift');
        await browser.pause(800);
        await closeSettings();

        const persisted = await browser.execute(async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const app = (window as unknown as { app: any }).app;
            return app.vault.adapter.read('.obsidian/plugins/eventide-quill/data.json');
        });
        const parsed = JSON.parse(persisted) as { coWriterToolsEnabled: boolean };
        expect(parsed.coWriterToolsEnabled).to.equal(false);
    });
});
