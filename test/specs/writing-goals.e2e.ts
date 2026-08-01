import { browser } from '@wdio/globals';
import { expect } from 'chai';
import { obsidianPage } from 'wdio-obsidian-service';
import { openFile, openQuillSidebar, isMobileEmulation } from '../helpers/obsidian-helpers.js';

/**
 * Writing goals & sessions — dashboard card render + focus-session lifecycle.
 * Exercises the 2.0.0 flagship end-to-end: open a manuscript, refresh the
 * dashboard so the goals card has metrics, then drive the session button and
 * verify the ledger state changes.
 */
describe('Writing goals & sessions', () => {
    beforeEach(function () {
        if (isMobileEmulation()) return this.skip();
    });
    beforeEach(async () => {
        await obsidianPage.resetVault();
    });

    /** Click a visible button whose trimmed text matches, within the sidebar. */
    async function clickSidebarButton(text: string): Promise<boolean> {
        return browser.execute((label: string) => {
            const sidebar = document.querySelector('.quill-sidebar');
            const btns = Array.from((sidebar ?? document).querySelectorAll<HTMLButtonElement>('button'));
            const match = btns.find((b) => (b.textContent ?? '').trim() === label && b.offsetParent !== null);
            if (!match) return false;
            match.click();
            return true;
        }, text);
    }

    /** Read the live `writingGoals` plugin state (or null when absent). */
    async function readSession(): Promise<{ session: unknown } | null> {
        return browser.execute(() => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const p = (window as unknown as { app: any }).app.plugins.plugins['eventide-quill'];
            return p?.writingGoals ?? null;
        }) as Promise<{ session: unknown } | null>;
    }

    it('renders the goals card and runs a focus session start/stop', async () => {
        await openFile('manuscript/Chapter 01.md');
        // Refresh the dashboard so metrics + the goals card exist.
        await browser.execute(() => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const p = (window as unknown as { app: any }).app.plugins.plugins['eventide-quill'];
            return p.refreshDashboard();
        });
        await openQuillSidebar();
        await browser.pause(400);

        // The goals card only renders once metrics are available.
        await browser.waitUntil(
            async () => {
                const has = (await browser.execute(() => {
                    const sidebar = document.querySelector('.quill-sidebar');
                    return sidebar ? (sidebar.textContent ?? '').includes('Writing goals') : false;
                })) as boolean;
                return has;
            },
            { timeout: 10_000, timeoutMsg: 'writing-goals card never rendered' }
        );

        // No session yet.
        expect((await readSession())?.session ?? null).to.equal(null);

        // Start a session via the card button.
        const started = await clickSidebarButton('Start session');
        expect(started).to.equal(true, 'could not find/click the Start session button');
        await browser.pause(300);
        expect((await readSession())?.session ?? null).to.not.equal(null);

        // Stop the session.
        const stopped = await clickSidebarButton('Stop session');
        expect(stopped).to.equal(true, 'could not find/click the Stop session button');
        expect(stopped).to.equal(true, 'could not find/click the Stop session button');
        await browser.pause(300);
        expect((await readSession())?.session ?? null).to.equal(null);
    });
});
