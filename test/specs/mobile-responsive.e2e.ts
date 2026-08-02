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
});
