import { Notice, Platform } from 'obsidian';

/**
 * Detects when Obsidian's mobile WebView is suspended mid AI-stream and warns
 * the writer on resume.
 *
 * Why this exists: on mobile, {@link isStreamingSupported} is false, so every
 * AI call goes through the buffered `requestUrl` path. When the OS suspends
 * the app (screen lock, app switch), the WebView kills the in-flight request
 * and Obsidian exposes NO lifecycle hook for the suspension. The rejection
 * lands in the consumer's catch as a raw network error with no friendly
 * framing. This watchdog listens to the DOM `visibilitychange` event (which
 * the Capacitor/WebView fires on background/foreground) and, if a generation
 * was in flight when the app was backgrounded, surfaces a clear Notice on
 * resume explaining what happened and how to recover.
 *
 * Desktop is a no-op in practice: `document.hidden` rarely flips during a
 * desktop session and the native-fetch streaming transport there survives
 * brief window blurs. Attaching the listener is harmless either way.
 */
export class MobileStreamWatchdog {
    private readonly isInFlight: () => boolean;
    private suspendedDuringStream = false;
    private attached = false;
    private boundHandler: (() => void) | null = null;
    private attachedDoc: Document | null = null;

    /**
     * @param isInFlight - Returns true when any AI generation is actively in
     *   flight (a stream/connection is open). Polled on each visibility change.
     *   Typically the plugin's `hasInFlightGeneration()`.
     */
    constructor(isInFlight: () => boolean) {
        this.isInFlight = isInFlight;
    }

    /** Begin listening. Idempotent — safe to call from `onload` on every load. */
    attach(): void {
        if (this.attached) return;
        this.boundHandler = () => this.handleVisibilityChange();
        // Store the document so detach() removes the listener from the SAME
        // document even if activeDocument has changed by unload time (e.g. a
        // popout closing), which would otherwise leave the handler dangling.
        // Added directly with addEventListener rather than registerDomEvent
        // because the watchdog is owned at the plugin root, outside any
        // Component lifecycle, and must bind to activeDocument specifically so
        // popout windows behave; cleanup is handled explicitly in detach().
        this.attachedDoc = activeDocument;
        activeDocument.addEventListener('visibilitychange', this.boundHandler);
        this.attached = true;
    }

    /** Stop listening and reset. Idempotent — safe to call from `onunload`. */
    detach(): void {
        if (this.attached && this.boundHandler && this.attachedDoc) {
            this.attachedDoc.removeEventListener('visibilitychange', this.boundHandler);
        }
        this.attachedDoc = null;
        this.boundHandler = null;
        this.attached = false;
        this.suspendedDuringStream = false;
    }

    private handleVisibilityChange(): void {
        // Read .hidden from the same document the listener was bound to, not
        // a possibly-stale activeDocument reference.
        if (this.attachedDoc?.hidden ?? activeDocument.hidden) {
            // App backgrounded. If a generation is in flight, flag it — the OS
            // will most likely kill the request before the app resumes (mobile
            // `requestUrl` provides no abort hook and no suspension notice).
            if (this.isInFlight()) {
                this.suspendedDuringStream = true;
            }
            return;
        }
        // App foregrounded. If we backgrounded mid-stream, warn the writer that
        // the in-flight flow likely failed and how to recover. The actual error
        // (if any) lands separately in the originating surface's catch handler.
        if (this.suspendedDuringStream) {
            this.suspendedDuringStream = false;
            new Notice(
                'Quill: Obsidian was backgrounded while an AI flow was running — it likely failed. Re-run the request if no result appears, and keep the app in focus during AI flows.'
            );
        }
    }
}

/** Throttle window for {@link notifyMobileStreamRisk} — once per 10 minutes. */
const RISK_NOTICE_THROTTLE_MS = 10 * 60 * 1000;
let lastRiskNotice = 0;

/**
 * On mobile, show a one-time-ish Notice reminding the writer to keep the app
 * in focus (screen on, no app-switching) while an AI flow runs — backgrounding
 * the app will most likely kill the in-flight request (see
 * {@link MobileStreamWatchdog}). Throttled to at most once per 10 minutes so
 * it doesn't nag across rapid successive runs. No-op on desktop. Call from
 * each user-initiated long-running AI entry point (feedback, analysis,
 * manuscript, co-writer, transform, queue run).
 */
export function notifyMobileStreamRisk(): void {
    if (!Platform.isMobile) return;
    const now = Date.now();
    if (now - lastRiskNotice < RISK_NOTICE_THROTTLE_MS) return;
    lastRiskNotice = now;
    new Notice('Quill: AI running — keep the app in focus and the screen on. Backgrounding may interrupt it.');
}
