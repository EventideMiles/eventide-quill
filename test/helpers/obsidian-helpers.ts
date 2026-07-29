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

/**
 * Thrown by {@link openFile} when a vault path doesn't resolve to a file.
 * Distinct from a generic Error so a future spec can catch path failures
 * specifically (e.g. to retry against a fallback fixture) without matching
 * on message text. Mirrors the production codebase's typed-error convention
 * (AGENTS.md "Error handling") — kept out of that doc's enumeration because
 * this is test infra, not production control-flow.
 *
 * Not exported — currently thrown internally only. Add `export` if a future
 * spec needs to `instanceof`-check it.
 */
class VaultPathError extends Error {
    constructor(path: string, operation: string) {
        super(`${operation}: vault path does not resolve: ${path}`);
        this.name = 'VaultPathError';
    }
}

/**
 * Thrown by {@link waitForAssistantBubble} when its internal `found` invariant
 * is violated (waitUntil reported success but no bubble was captured). Should
 * never fire in practice — when it does, it's a helper bug, not a test bug.
 *
 * Not exported — currently thrown internally only. Add `export` if a future
 * spec needs to `instanceof`-check it.
 */
class AssistantWaitError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AssistantWaitError';
    }
}

/** Active Obsidian App, untyped — its API is huge and we only touch a tiny slice. */
type ObsidianApp = {
    vault: {
        /** Returns only files (null for folders / missing). Safer than getAbstractFileByPath for our use. */
        getFileByPath: (path: string) => unknown;
        read: (file: unknown) => Promise<string>;
        create: (path: string, content: string) => Promise<unknown>;
        modify: (file: unknown, content: string) => Promise<unknown>;
        adapter: { write: (path: string, content: string) => Promise<void> };
    };
    workspace: {
        getLeaf: (isNew: boolean) => { openFile: (file: unknown) => Promise<void> };
        getActiveFile: () => unknown;
    };
    commands: { executeCommandById: (id: string) => void };
};

/** Open a file by vault path. When `newLeaf` is true (default false) the file
 *  opens in a fresh leaf; otherwise it opens in the active leaf. Throws
 *  {@link VaultPathError} if the path doesn't resolve to a file (missing, or
 *  resolves to a folder) so a typo in a fixture path surfaces immediately. */
export async function openFile(path: string, newLeaf = false): Promise<void> {
    const opened = await browser.execute(
        async (p, n) => {
            const app = (window as unknown as { app: ObsidianApp }).app;
            // getFileByPath returns null for both missing paths AND folders —
            // a folder path flowing into openFile would fail confusingly
            // otherwise.
            const file = app.vault.getFileByPath(p);
            if (!file) return false;
            await app.workspace.getLeaf(n).openFile(file);
            return true;
        },
        path,
        newLeaf
    );
    if (!opened) throw new VaultPathError(path, 'openFile');
}

/** Open the Quill sidebar view via command, then wait for the tab bar. */
export async function openQuillSidebar(): Promise<void> {
    await browser.executeObsidianCommand('eventide-quill:quill-dashboard-open');
    const tabBar = await browser.$('.quill-sidebar__tab-bar');
    await tabBar.waitForDisplayed({ timeout: 10_000 });
}

/**
 * Returns true when running under the mobile-emulation capability
 * (`emulateMobile: true` in `wdio:obsidianOptions`). Used by specs that test
 * desktop-specific UI flows (mode-picker popovers, right-click context menus
 * with desktop layout assumptions) to skip on mobile — the `mobile-smoke`
 * spec covers mobile validation separately.
 */
export function isMobileEmulation(): boolean {
    // WDIO 9 stores the requested capabilities (as-specified in wdio.conf.mts)
    // on `browser.requestedCapabilities`, NOT on `browser.capabilities` (which
    // holds the Chromium session caps after launch — the obsidian options are
    // stripped during session negotiation). Read `emulateMobile` from the
    // requested caps to detect the mobile-emulation capability.
    const reqCaps = (browser as unknown as { requestedCapabilities?: Record<string, unknown> }).requestedCapabilities;
    const opts = reqCaps?.['wdio:obsidianOptions'] as { emulateMobile?: boolean } | undefined;
    return opts?.emulateMobile === true;
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
 * Wait until the next assistant chat bubble appears after a send AND has
 * rendered non-empty response text. Returns the bubble element. Uses
 * `waitUntil` rather than `waitForDisplayed` because the bubble doesn't exist
 * in the DOM until the assistant starts streaming.
 *
 * The non-empty-text requirement is what proves the response actually rendered
 * — the previous version checked the bubble's `--streaming` class as a proxy,
 * which had a fallthrough bug: a bubble that ended streaming with no text
 * (empty response, race between stream-end and text-paint) would satisfy the
 * wait. Requiring text directly is the strongest signal.
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
            // Require non-empty (non-whitespace) text. The bubble is added to
            // the DOM the moment streaming starts but starts empty; an empty
            // bubble that has finished streaming is a real failure case (empty
            // response), not a success. Trim before the emptiness check so a
            // stray newline or padding whitespace from rendering doesn't
            // satisfy the wait prematurely.
            const text = (await last.getText()).trim();
            if (text.length === 0) return false;
            found = last;
            return true;
        },
        { timeout: timeoutMs, timeoutMsg: 'assistant bubble never produced text' }
    );
    if (!found) throw new AssistantWaitError('waitForAssistantBubble: internal error — found unset after waitUntil succeeded');
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
