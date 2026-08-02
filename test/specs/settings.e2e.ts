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

    /** Open the Eventide Quill settings tab and wait for its page entries to render. */
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

    /** Toggle the first `.setting-item` on the current page matching `namePattern`; returns whether one was found and clicked. */
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

    /**
     * Click the always-visible action button on a Welcome checklist row (e.g.
     * "Pick a default chat model"). The checklist lives inside the settings
     * page element, which on desktop Obsidian is in a separate window's
     * document — so it is found via `getCurrentPageEl()`, not `document`.
     */
    async function clickWelcomeChecklistButton(rowLabel: string): Promise<boolean> {
        return browser.execute((label: string) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const s = (window as unknown as { app: any }).app.setting;
            const pageEl = typeof s.getCurrentPageEl === 'function' ? s.getCurrentPageEl() : null;
            if (!pageEl) return false;
            const row = Array.from(
                pageEl.querySelectorAll('.quill-settings__welcome-checklist-row') as NodeListOf<HTMLElement>
            ).find((r) => (r.textContent ?? '').includes(label));
            const btn = row?.querySelector<HTMLElement>('button.quill-settings__welcome-checklist-btn');
            if (!btn) return false;
            btn.click();
            return true;
        }, rowLabel);
    }

    /** Current settings page stack titles (e.g. ['AI providers', 'Default models']). */
    async function currentPageStack(): Promise<string[]> {
        return browser.execute(() => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const s = (window as unknown as { app: any }).app.setting;
            return (s.pageStack ?? []).map((p: { page: { title?: string } }) => p.page.title ?? '');
        }) as Promise<string[]>;
    }

    /** Names of every `.setting-item` on the current settings page. */
    async function currentPageSettingNames(): Promise<string[]> {
        return browser.execute(() => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const s = (window as unknown as { app: any }).app.setting;
            const pageEl = typeof s.getCurrentPageEl === 'function' ? s.getCurrentPageEl() : null;
            if (!pageEl) return [];
            return Array.from(pageEl.querySelectorAll('.setting-item') as NodeListOf<HTMLElement>).map(
                (el) => el.querySelector('.setting-item-name')?.textContent?.trim() ?? ''
            );
        }) as Promise<string[]>;
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

    it('disabling gremlins cascades to disable aggressive scanning', async () => {
        await openPluginSettings();
        await openSettingsPage('Linter');
        const orig = await readSettings<{ enableGremlins: boolean; enableAggressiveGremlins: boolean }>();

        // Ensure both are on first (aggressive can only be toggled while gremlins is on).
        if (!orig.enableGremlins) await toggleSettingByName(/invisible character/i);
        if (!(await readSettings<{ enableAggressiveGremlins: boolean }>()).enableAggressiveGremlins) {
            await toggleSettingByName(/aggressive scan/i);
        }
        await browser.pause(150);

        // Disabling gremlins must cascade-set aggressive scanning off (setControlValue).
        await toggleSettingByName(/invisible character/i);
        await browser.pause(150);
        const after = await readSettings<{ enableGremlins: boolean; enableAggressiveGremlins: boolean }>();
        expect(after.enableGremlins).to.equal(false);
        expect(after.enableAggressiveGremlins).to.equal(false);

        // Restore original state.
        if (orig.enableGremlins) await toggleSettingByName(/invisible character/i);
        if (orig.enableAggressiveGremlins && (await readSettings<{ enableAggressiveGremlins: boolean }>()).enableAggressiveGremlins === false) {
            await toggleSettingByName(/aggressive scan/i);
        }
        await closeSettings();
    });

    /** Number of flash-highlighted settings on the current page. */
    async function flashCount(): Promise<number> {
        return browser.execute(() => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const s = (window as unknown as { app: any }).app.setting;
            const pageEl = typeof s.getCurrentPageEl === 'function' ? s.getCurrentPageEl() : null;
            if (!pageEl) return 0;
            return pageEl.querySelectorAll('.quill-settings__flash').length;
        }) as Promise<number>;
    }

    /** Poll `currentPageStack()` until it equals `expected` (deep-link navigation). */
    async function waitForPageStack(expected: string[]): Promise<void> {
        await browser.waitUntil(
            async () => JSON.stringify(await currentPageStack()) === JSON.stringify(expected),
            { timeout: 8000, timeoutMsg: `page stack never reached ${JSON.stringify(expected)}: ${JSON.stringify(await currentPageStack())}` }
        );
    }

    it('Welcome "Take me there" on chat model deep-links into Default models', async () => {
        await openPluginSettings();
        await openSettingsPage('Welcome');

        const clicked = await clickWelcomeChecklistButton('Pick a default chat model');
        expect(clicked).to.equal(true, 'could not locate the chat-model checklist button — selector drift');

        await waitForPageStack(['AI providers', 'Default models']);
        const names = await currentPageSettingNames();
        expect(names).to.include('Default chat model');
        await browser.waitUntil(async () => (await flashCount()) === 1, {
            timeout: 8000,
            timeoutMsg: 'Default chat model was not flash-highlighted after deep-link'
        });
        await closeSettings();
    });

    it('Welcome "Take me there" on daily goal lands on the General setting', async () => {
        await openPluginSettings();
        await openSettingsPage('Welcome');

        const clicked = await clickWelcomeChecklistButton('Set a daily writing goal');
        expect(clicked).to.equal(true, 'could not locate the daily-goal checklist button — selector drift');

        await waitForPageStack(['General']);
        const names = await currentPageSettingNames();
        expect(names).to.include('Daily writing goal');
        await closeSettings();
    });

    it('Welcome "Take me there" on AI provider lands on the AI providers page', async () => {
        await openPluginSettings();
        await openSettingsPage('Welcome');

        const clicked = await clickWelcomeChecklistButton('Add an AI provider');
        expect(clicked).to.equal(true, 'could not locate the AI-provider checklist button — selector drift');

        await waitForPageStack(['AI providers']);
        await closeSettings();
    });

    it('renders the "+ add command" affordance and appends a slash command (regression: add buttons were lost in the 2.1.0 declarative migration)', async () => {
        await openPluginSettings();
        await openSettingsPage('Lorebook');

        const before = await readSettings<{ slashCommands: unknown[] }>();
        expect(before.slashCommands.length).to.equal(0);

        // The add button lives inside the settings page element (a separate
        // document on desktop), so scope the query via getCurrentPageEl — same
        // pattern as clickWelcomeChecklistButton.
        const clicked = await browser.execute(() => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const s = (window as unknown as { app: any }).app.setting;
            const pageEl = typeof s.getCurrentPageEl === 'function' ? s.getCurrentPageEl() : null;
            const btn = pageEl?.querySelector('.quill-slash-command-list__add') as HTMLElement | null;
            if (!btn) return false;
            btn.click();
            return true;
        });
        expect(clicked, 'could not find the "+ add command" button — selector drift').to.equal(true);

        await browser.waitUntil(
            async () => {
                const s = await readSettings<{ slashCommands: unknown[] }>();
                return s.slashCommands.length === 1;
            },
            { timeout: 8000, timeoutMsg: 'slash command was not added after clicking "+ add command"' }
        );
        await closeSettings();
    });
});
