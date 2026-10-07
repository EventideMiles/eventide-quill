import { browser } from '@wdio/globals';
import { expect } from 'chai';
import { obsidianPage } from 'wdio-obsidian-service';
import { isMobileEmulation } from '../helpers/obsidian-helpers.js';

/**
 * Mobile responsive layout — the highest-value mobile coverage since the
 * feature specs (co-writer, settings, etc.) all `this.skip()` on mobile
 * emulation. These tests assert the mobile-specific CSS that the other specs
 * can't: the compact-width button-row collapse + hamburger overflow, and that
 * no panel forces horizontal page scroll at the 390×844 viewport (the most
 * common mobile regression — a fixed-width element blowing out the pane).
 *
 * Robust by design: pure CSS-class + viewport-width assertions, no chat flows
 * (which are flaky under the mobile overlay). Runs on both capabilities — a
 * basic smoke on desktop, the mobile-assertive checks gated on
 * {@link isMobileEmulation}.
 */
describe('Mobile responsive layout', () => {
    beforeEach(async () => {
        await obsidianPage.resetVault();
    });

    /** Assert the page does not force horizontal scroll at the current viewport. */
    async function assertNoHorizontalOverflow(label: string): Promise<void> {
        const overflow = await browser.execute(() => ({
            client: document.documentElement.clientWidth,
            scroll: document.documentElement.scrollWidth
        }));
        expect(
            overflow.scroll <= overflow.client,
            `${label}: horizontal overflow at emulated viewport (scroll ${overflow.scroll} > client ${overflow.client})`
        ).to.equal(true);
    }

    it('engages the co-writer compact-width layout on mobile (button-row collapse + overflow hamburger)', async function () {
        await browser.executeObsidianCommand('eventide-quill:quill-cowriter-open');
        const bottom = await browser.$('.quill-cowriter-panel__bottom');
        await bottom.waitForDisplayed({ timeout: 15_000 });

        if (isMobileEmulation()) {
            // At 390px (under the 420px threshold) the bottom row receives the
            // --compact modifier and the secondary actions fold into a hamburger
            // overflow button that is CSS-hidden on wide panes.
            const compactBottom = await browser.$('.quill-cowriter-panel__bottom--compact');
            await compactBottom.waitForExist({ timeout: 10_000 });
            const overflowBtn = await browser.$('.quill-cowriter-panel__overflow-btn');
            expect(await overflowBtn.isDisplayed(), 'overflow hamburger should be visible under compact-width').to.equal(true);
        }
        await assertNoHorizontalOverflow('co-writer');
    });

    it('keeps the dashboard within the mobile viewport with no horizontal scroll', async function () {
        if (!isMobileEmulation()) this.skip();
        await browser.executeObsidianCommand('eventide-quill:quill-dashboard-open');
        await browser.waitUntil(async () => (await browser.$('[class*="quill-dashboard"]')).isExisting(), {
            timeout: 15_000,
            timeoutMsg: 'dashboard never rendered'
        });
        await assertNoHorizontalOverflow('dashboard');
    });

    it('keeps the review tab within the mobile viewport with no horizontal scroll', async function () {
        if (!isMobileEmulation()) this.skip();
        await browser.executeObsidianCommand('eventide-quill:quill-review-open');
        // The review panel renders inside the shared sidebar content container,
        // so wait on the tab bar (the same signal openQuillSidebar uses) rather
        // than a review-specific class — the report container only exists once a
        // report is actually run.
        await browser.waitUntil(async () => (await browser.$('.quill-sidebar__tab-bar')).isExisting(), {
            timeout: 15_000,
            timeoutMsg: 'review sidebar never rendered'
        });
        await assertNoHorizontalOverflow('review');
    });

    it('renders the lorebook sub-tab bar compact on mobile and full on desktop with no clipping', async function () {
        await browser.executeObsidianCommand('eventide-quill:quill-lorebook-open');
        const bar = await browser.$('.quill-sidebar__subtab-bar');
        await bar.waitForDisplayed({ timeout: 15_000 });

        if (isMobileEmulation()) {
            // At 390px (under the shared 420px compact threshold) the lorebook
            // bar collapses to the active sub-tab + the More overflow button
            // instead of wrapping/clipping all five tabs.
            const moreBtn = await browser.$('.quill-sidebar__subtab--more');
            await moreBtn.waitForExist({ timeout: 10_000 });
            expect(await moreBtn.isDisplayed(), 'lorebook More button should be visible under compact width').to.equal(true);
            const subtabs = await browser.$$('.quill-sidebar__subtab:not(.quill-sidebar__subtab--more)');
            expect(
                subtabs.length,
                `compact lorebook bar should show only the active sub-tab (found ${subtabs.length})`
            ).to.equal(1);
        } else {
            // Desktop: a default-width sidebar sits below the 420px compact
            // threshold (compact engages there by design, same as the co-writer
            // button row) — widen the sidebar's workspace split so this branch
            // exercises the full bar. Obsidian's workspace reconciles inline
            // widths on its own layout ticks, so each poll re-asserts the
            // widened layout before checking the mode.
            const widen = (): Promise<{ compact: boolean; width: number }> =>
                browser.execute(() => {
                    const split = document.querySelector('.quill-sidebar')?.closest('.workspace-split') as HTMLElement | null;
                    if (split) {
                        split.style.width = '600px';
                        split.style.flex = '0 0 600px';
                    }
                    return {
                        compact: document.querySelectorAll('.quill-sidebar__subtab--more').length > 0,
                        width: document.querySelector('.quill-sidebar')?.getBoundingClientRect().width ?? -1
                    };
                });
            await browser.waitUntil(
                async () => {
                    const state = await widen();
                    return !state.compact && state.width > 420;
                },
                {
                    timeout: 10_000,
                    timeoutMsg: 'lorebook bar never left compact mode after widening the sidebar'
                }
            );
            // All five sub-tabs render (single row when they fit, wrapped when
            // they don't — never clipped). Read in the same tick as a final
            // width re-assert so a layout restore can't race the read.
            const texts = await widen().then(() =>
                browser.execute(() =>
                    Array.from(document.querySelectorAll('.quill-sidebar__subtab:not(.quill-sidebar__subtab--more)')).map(
                        (b) => b.textContent ?? ''
                    )
                )
            );
            for (const expected of ['Document', 'Manuscript', 'Relationships', 'Memories', 'Hygiene']) {
                expect(texts, `lorebook sub-tab "${expected}" should be visible on desktop`).to.include(expected);
            }
        }
        await assertNoHorizontalOverflow('lorebook');
    });
});
