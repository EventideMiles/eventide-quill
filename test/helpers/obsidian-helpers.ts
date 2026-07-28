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

/** Read the live Obsidian App instance from the renderer's global scope. */
export async function getApp(): Promise<ObsidianApp> {
    return (await browser.execute(() => {
        return (window as unknown as { app: ObsidianApp }).app;
    })) as ObsidianApp;
}

/** Open a file by vault path in a new leaf. No-op if the path doesn't exist. */
export async function openFile(path: string, newLeaf = false): Promise<void> {
    await browser.execute(
        async (p, n) => {
            const app = (window as unknown as { app: ObsidianApp }).app;
            const file = app.vault.getAbstractFileByPath(p);
            if (file) await app.workspace.getLeaf(n).openFile(file);
        },
        path,
        newLeaf
    );
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

/** Type into the co-writer chat input and press Enter to send. */
export async function sendCoWriterMessage(text: string): Promise<void> {
    const input = await browser.$('.quill-cowriter-panel__input');
    await input.waitForDisplayed({ timeout: 10_000 });
    await input.setValue(text);
    await browser.keys('Enter');
}

/**
 * Wait until the next assistant chat bubble appears after a send. Returns the
 * bubble element. Uses `waitUntil` rather than `waitForDisplayed` because the
 * bubble doesn't exist in the DOM until the assistant starts streaming.
 */
export async function waitForAssistantBubble(timeoutMs = 20_000): Promise<WebdriverIO.Element> {
    let found: WebdriverIO.Element | null = null;
    await browser.waitUntil(
        async () => {
            const bubbles = (await browser.$$('.quill-cowriter-panel__chat-bubble--assistant')) as unknown as WebdriverIO.Element[];
            if (bubbles.length === 0) return false;
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
 */
export async function waitForAssistantDone(timeoutMs = 30_000): Promise<void> {
    await browser.waitUntil(
        async () => {
            const streaming = (await browser.$$('.quill-cowriter-panel__chat-bubble--streaming')) as unknown as WebdriverIO.Element[];
            return streaming.length === 0;
        },
        { timeout: timeoutMs, timeoutMsg: 'assistant streaming never finished' }
    );
}
