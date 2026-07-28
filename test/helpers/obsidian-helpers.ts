/**
 * Shared helpers for the E2E specs — routines that drive Obsidian via the
 * WebdriverIO `browser` API. Kept here (not inline) because every spec needs
 * at least the "open a manuscript file" dance, and the type cast through
 * `window.app` is noisy to repeat.
 *
 * These run inside the WDIO worker process; calls to `browser.execute(...)`
 * cross into the Obsidian renderer. Mock-server helpers (in `mock-server.ts`)
 * stay separate because they talk to the parent process's HTTP listener.
 */
import { browser } from '@wdio/globals';

/** Active Obsidian App, untyped — its API is huge and we only touch a tiny slice. */
type ObsidianApp = {
    vault: {
        getAbstractFileByPath: (path: string) => unknown;
        read: (file: unknown) => Promise<string>;
        adapter: { write: (path: string, content: string) => Promise<void> };
    };
    workspace: {
        getLeaf: (isNew: boolean) => { openFile: (file: unknown) => Promise<void> };
        getActiveFile: () => unknown;
    };
    commands: { executeCommandById: (id: string) => void };
};

/** Open a file by vault path. When `newLeaf` is true (default false) the file
 *  opens in a fresh leaf; otherwise it opens in the active leaf. Throws if the
 *  path doesn't resolve — matches `readVaultFile`'s missing-file behavior so a
 *  typo in a fixture path surfaces immediately rather than silently no-oping. */
export async function openFile(path: string, newLeaf = false): Promise<void> {
    const opened = await browser.execute(
        async (p, n) => {
            const app = (window as unknown as { app: ObsidianApp }).app;
            const file = app.vault.getAbstractFileByPath(p);
            if (!file) return false;
            await app.workspace.getLeaf(n).openFile(file);
            return true;
        },
        path,
        newLeaf
    );
    if (!opened) throw new Error(`openFile: vault path does not resolve: ${path}`);
}

/** Overwrite a vault file's contents (creates the file if missing). */
export async function writeVaultFile(path: string, content: string): Promise<void> {
    await browser.execute(
        async (p, c) => {
            const app = (window as unknown as { app: ObsidianApp }).app;
            await app.vault.adapter.write(p, c);
        },
        path,
        content
    );
}

/** Read a vault file's contents as a string. */
export async function readVaultFile(path: string): Promise<string> {
    return browser.execute(
        async (p) => {
            const app = (window as unknown as { app: ObsidianApp }).app;
            const file = app.vault.getAbstractFileByPath(p);
            if (!file) throw new Error(`vault file not found: ${p}`);
            return app.vault.read(file);
        },
        path
    );
}

/**
 * Click the sidebar tab whose button title matches `label` (e.g., 'Review',
 * 'Co-writer'). More robust than relying on icon classes since the tab order
 * isn't load-bearing.
 */
export async function clickSidebarTab(label: string): Promise<void> {
    const tab = await browser.$(`.quill-sidebar__tab[title="${label}"]`);
    await tab.waitForDisplayed({ timeout: 5_000 });
    await tab.click();
}

/** Open the Quill sidebar view via command, then wait for the tab bar. */
export async function openQuillSidebar(): Promise<void> {
    await browser.executeObsidianCommand('eventide-quill:quill-dashboard-open');
    const tabBar = await browser.$('.quill-sidebar__tab-bar');
    await tabBar.waitForDisplayed({ timeout: 10_000 });
}

/**
 * Type into the co-writer chat input and press Enter to send. Returns the
 * count of assistant bubbles present BEFORE the send — pass this to
 * {@link waitForAssistantBubble} / {@link waitForAssistantDone} so they wait
 * for THIS turn's bubble rather than short-circuiting on a stale bubble left
 * over from a prior test in the same spec (the co-writer session persists
 * across `it()` blocks; `resetVault` clears files, not in-memory chat state).
 */
export async function sendCoWriterMessage(text: string): Promise<number> {
    const input = await browser.$('.quill-cowriter-panel__input');
    await input.waitForDisplayed({ timeout: 10_000 });
    const baseline = (await browser.$$('.quill-cowriter-panel__chat-bubble--assistant')) as unknown as WebdriverIO.Element[];
    const baselineCount = baseline.length;
    await input.setValue(text);
    await browser.keys('Enter');
    return baselineCount;
}

/**
 * Count the assistant chat bubbles currently in the DOM. Exposed so specs that
 * need to wait on a turn triggered by something other than
 * {@link sendCoWriterMessage} (e.g. clicking a UI button) can capture the same
 * baseline the message helper returns.
 */
export async function assistantBubbleCount(): Promise<number> {
    const bubbles = (await browser.$$('.quill-cowriter-panel__chat-bubble--assistant')) as unknown as WebdriverIO.Element[];
    return bubbles.length;
}

/**
 * Wait until the next assistant chat bubble appears after a send. Returns the
 * bubble element. Uses `waitUntil` rather than `waitForDisplayed` because the
 * bubble doesn't exist in the DOM until the assistant starts streaming.
 *
 * Pass the {@link sendCoWriterMessage}-returned `baseline` so the wait ignores
 * stale non-empty bubbles from prior turns. Without it, the wait returns as
 * soon as ANY assistant bubble has text — which in a multi-test spec is the
 * previous test's leftover bubble, not the current turn's response.
 */
export async function waitForAssistantBubble(timeoutMs = 20_000, baseline = 0): Promise<WebdriverIO.Element> {
    let found: WebdriverIO.Element | null = null;
    await browser.waitUntil(
        async () => {
            const bubbles = (await browser.$$('.quill-cowriter-panel__chat-bubble--assistant')) as unknown as WebdriverIO.Element[];
            // Require a NEW bubble beyond the baseline — stale bubbles from
            // prior turns must not satisfy the wait.
            if (bubbles.length <= baseline) return false;
            const last = bubbles[bubbles.length - 1]!;
            const text = await last.getText();
            if (text.length === 0) {
                // Streaming bubble starts empty — wait for either text or the
                // streaming flag to clear.
                const cls = await last.getAttribute('class');
                if (cls?.includes('streaming')) return false;
            }
            found = last;
            return true;
        },
        { timeout: timeoutMs, timeoutMsg: 'assistant bubble never produced text' }
    );
    if (!found) throw new Error('waitForAssistantBubble: internal error — found unset after waitUntil succeeded');
    return found;
}

/**
 * Wait until no streaming bubble remains (the assistant turn is done). Useful
 * before reading the final assistant text or asserting on side effects.
 *
 * Pass the {@link sendCoWriterMessage}-returned `baseline` so the wait
 * verifies the NEW turn produced a bubble (count > baseline) AND finished
 * streaming. Without it, a fresh send that hasn't yet produced a streaming
 * bubble would satisfy `streaming.length === 0` immediately on a stale DOM.
 */
export async function waitForAssistantDone(timeoutMs = 30_000, baseline = 0): Promise<void> {
    let sawNewBubble = false;
    await browser.waitUntil(
        async () => {
            const bubbles = (await browser.$$('.quill-cowriter-panel__chat-bubble--assistant')) as unknown as WebdriverIO.Element[];
            if (bubbles.length > baseline) sawNewBubble = true;
            if (!sawNewBubble) return false;
            const streaming = (await browser.$$('.quill-cowriter-panel__chat-bubble--streaming')) as unknown as WebdriverIO.Element[];
            return streaming.length === 0;
        },
        { timeout: timeoutMs, timeoutMsg: 'assistant streaming never finished' }
    );
}
