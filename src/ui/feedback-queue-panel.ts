/**
 * Encapsulated feedback-queue list renderer.
 *
 * Rendered inside the Review tab's "Queue" subtab by {@link ReviewPanel}. Reads
 * the plugin's in-memory job map and renders pending / running / completed
 * sections with per-job actions (cancel, delete, open report). DOM events are
 * registered on the caller's render-events {@link Component} so they tear down
 * with the surrounding panel re-render.
 */
import { type Component } from 'obsidian';
import type EventideQuillPlugin from '../main';
import { type FeedbackJob, type FeedbackJobStatus } from '../ai/feedback-queue';
import { getPersonaById } from '../ai/feedback';
import { getAnalysisModeById } from '../ai/analysis';
import { getManuscriptAnalysisModeById } from '../ai/manuscript-analysis';

export interface FeedbackQueueHandlers {
    onCancel: (id: string) => void;
    onDelete: (id: string) => void;
    onOpenReport: (job: FeedbackJob) => void;
    onDiscuss: (job: FeedbackJob) => void;
    onRunNow: () => void;
    onClearCompleted: () => void;
}

/** Human label for a job's engine (and its persona/mode where relevant). */
function engineLabel(job: FeedbackJob): string {
    if (job.engine === 'editorial') {
        return getPersonaById(job.personaId ?? '')?.name ?? 'Editorial feedback';
    }
    if (job.engine === 'critical') {
        return getAnalysisModeById(job.mode ?? '')?.label ?? 'Critical analysis';
    }
    return getManuscriptAnalysisModeById(job.mode ?? '')?.label ?? 'Manuscript analysis';
}

/** Rough relative-time string for display (e.g. "just now", "3m ago", "2h ago"). */
function relativeTime(ms: number): string {
    const secs = Math.round((Date.now() - ms) / 1000);
    if (secs < 45) return 'just now';
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.round(hrs / 24);
    return `${days}d ago`;
}

const STATUS_LABEL: Record<FeedbackJobStatus, string> = {
    queued: 'Queued',
    running: 'Running',
    succeeded: 'Complete',
    failed: 'Failed',
    cancelled: 'Cancelled'
};

/** Count of jobs that should badge the subtab button (active + recent completions). */
export function feedbackQueueBadgeCount(jobs: FeedbackJob[]): number {
    return jobs.filter((j) => j.status === 'queued' || j.status === 'running').length;
}

/**
 * Render the queue list into `container`. Clears nothing itself — the caller
 * manages the container lifecycle (it is invoked from a fresh render).
 */
export function renderFeedbackQueue(
    container: HTMLElement,
    plugin: EventideQuillPlugin,
    events: Component,
    handlers: FeedbackQueueHandlers
): void {
    const jobs = plugin.getFeedbackJobs();
    const active = jobs.filter((j) => j.status === 'queued' || j.status === 'running');
    const completed = jobs.filter((j) => j.status !== 'queued' && j.status !== 'running');

    // --- Toolbar: manual "Run now" + bulk "Clear completed". ---
    const toolbar = container.createDiv({ cls: 'quill-feedback-queue__toolbar' });

    const hasCompleted = jobs.some((j) => j.status !== 'queued' && j.status !== 'running');
    if (hasCompleted) {
        const clearBtn = toolbar.createEl('button', {
            cls: 'quill-feedback-queue__clear',
            text: 'Clear completed'
        });
        events.registerDomEvent(clearBtn, 'click', () => handlers.onClearCompleted());
    }

    const runBtn = toolbar.createEl('button', {
        cls: 'quill-feedback-queue__run-now',
        text: 'Run next queued job'
    });
    runBtn.disabled = active.length === 0 || !plugin.getDefaultChatProvider().provider;
    if (!runBtn.disabled) {
        events.registerDomEvent(runBtn, 'click', () => handlers.onRunNow());
    }

    if (jobs.length === 0) {
        container.createEl('p', {
            cls: 'quill-feedback-queue__empty',
            text: 'No feedback jobs yet. Pick a review type and turn on the queue toggle to add one.'
        });
        return;
    }

    // --- Active (queued + running) section ---
    if (active.length > 0) {
        const section = container.createDiv({ cls: 'quill-feedback-queue__section' });
        section.createEl('p', { cls: 'quill-feedback-queue__section-label', text: 'In progress' });
        for (const job of active.sort((a, b) => a.createdAt - b.createdAt)) {
            renderJobCard(section, job, events, handlers);
        }
    }

    // --- Completed section ---
    if (completed.length > 0) {
        const section = container.createDiv({ cls: 'quill-feedback-queue__section' });
        section.createEl('p', { cls: 'quill-feedback-queue__section-label', text: 'Completed' });
        for (const job of completed) {
            renderJobCard(section, job, events, handlers);
        }
    }
}

function renderJobCard(
    container: HTMLElement,
    job: FeedbackJob,
    events: Component,
    handlers: FeedbackQueueHandlers
): void {
    const card = container.createDiv({ cls: `quill-feedback-queue__card quill-feedback-queue__card--${job.status}` });

    const head = card.createDiv({ cls: 'quill-feedback-queue__card-head' });
    head.createEl('span', {
        cls: `quill-feedback-queue__status quill-feedback-queue__status--${job.status}`,
        text: STATUS_LABEL[job.status]
    });
    head.createEl('span', {
        cls: 'quill-feedback-queue__time',
        text: relativeTime(job.completedAt ?? job.createdAt)
    });

    card.createEl('p', { cls: 'quill-feedback-queue__title', text: job.title });
    card.createEl('p', { cls: 'quill-feedback-queue__meta', text: `${engineLabel(job)} · ${job.scope}` });

    if (job.status === 'failed' && job.error) {
        card.createEl('p', { cls: 'quill-feedback-queue__error', text: job.error });
    }

    // --- Actions ---
    const actions = card.createDiv({ cls: 'quill-feedback-queue__actions' });

    if (job.status === 'queued' || job.status === 'running') {
        const cancel = actions.createEl('button', { cls: 'quill-feedback-queue__action', text: 'Cancel' });
        events.registerDomEvent(cancel, 'click', () => handlers.onCancel(job.id));
    }

    if (job.status === 'succeeded' && job.reportNotePath) {
        if (job.engine === 'editorial') {
            const discuss = actions.createEl('button', {
                cls: 'quill-feedback-queue__action quill-feedback-queue__action--primary',
                text: 'Discuss'
            });
            events.registerDomEvent(discuss, 'click', () => handlers.onDiscuss(job));
        }
        const open = actions.createEl('button', {
            cls: 'quill-feedback-queue__action',
            text: 'Open report'
        });
        events.registerDomEvent(open, 'click', () => handlers.onOpenReport(job));
    }

    if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') {
        const del = actions.createEl('button', { cls: 'quill-feedback-queue__action', text: 'Delete' });
        events.registerDomEvent(del, 'click', () => handlers.onDelete(job.id));
    }
}
