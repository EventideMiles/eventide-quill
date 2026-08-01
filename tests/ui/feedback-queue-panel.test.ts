// @vitest-environment happy-dom
import '../helpers/ui-setup';
import { describe, expect, it } from 'vitest';
import { Component } from 'obsidian';
import { feedbackQueueBadgeCount, renderFeedbackQueue, type FeedbackQueueHandlers } from '../../src/ui/feedback-queue-panel';
import type { FeedbackJob } from '../../src/ai/feedback-queue';
import type EventideQuillPlugin from '../../src/main';

/** Build a succeeded-job fixture with the given overrides. */
function makeJob(overrides: Partial<FeedbackJob> = {}): FeedbackJob {
    return {
        id: 'fq_test',
        title: 'Test job',
        engine: 'editorial',
        status: 'succeeded',
        createdAt: Date.now(),
        completedAt: null,
        error: null,
        reportMarkdown: null,
        reportNotePath: null,
        ...overrides
    } as FeedbackJob;
}

/** Build a minimal `EventideQuillPlugin` stub exposing the jobs list + queue settings. */
function makePlugin(jobs: FeedbackJob[]): EventideQuillPlugin {
    return {
        getFeedbackJobs: () => jobs,
        settings: {
            enableFeedbackQueue: true,
            feedbackQueueLimit: 20,
            feedbackQueueAutoRun: true,
            autoSaveFeedbackReports: true,
            feedbackReportFolder: 'reviews'
        },
        getDefaultChatProvider: () => ({ provider: null, modelId: '' }),
        batchFixInProgress: false
    } as unknown as EventideQuillPlugin;
}

const noopHandlers: FeedbackQueueHandlers = {
    onCancel: () => {},
    onDelete: () => {},
    onOpenReport: () => {},
    onDiscuss: () => {},
    onDiscussSavedReport: () => {},
    onRunNow: () => {},
    onClearCompleted: () => {}
};

describe('feedbackQueueBadgeCount', () => {
    it('counts queued + running jobs', () => {
        expect(
            feedbackQueueBadgeCount([
                makeJob({ status: 'queued' }),
                makeJob({ status: 'running' }),
                makeJob({ status: 'succeeded' }),
                makeJob({ status: 'queued' })
            ])
        ).to.equal(3);
    });

    it('returns 0 for empty or all-complete', () => {
        expect(feedbackQueueBadgeCount([])).to.equal(0);
        expect(feedbackQueueBadgeCount([makeJob({ status: 'succeeded' })])).to.equal(0);
    });
});

describe('renderFeedbackQueue', () => {
    it('renders a card per job with the title + status', () => {
        const container = createDiv();
        renderFeedbackQueue(
            container,
            makePlugin([
                makeJob({ id: 'fq_1', title: 'Chapter 1 review', status: 'succeeded' }),
                makeJob({ id: 'fq_2', title: 'Chapter 2 review', status: 'queued' })
            ]),
            new Component(),
            noopHandlers
        );
        expect(container.textContent).to.include('Chapter 1 review');
        expect(container.textContent).to.include('Chapter 2 review');
    });

    it('shows the error message for failed jobs', () => {
        const container = createDiv();
        renderFeedbackQueue(
            container,
            makePlugin([makeJob({ status: 'failed', error: 'Connection refused' })]),
            new Component(),
            noopHandlers
        );
        expect(container.textContent).to.include('Connection refused');
    });

    it('renders a cancel button for queued jobs', () => {
        const container = createDiv();
        renderFeedbackQueue(
            container,
            makePlugin([makeJob({ id: 'fq_x', status: 'queued' })]),
            new Component(),
            noopHandlers
        );
        const texts = Array.from(container.querySelectorAll('button')).map((b) => b.textContent?.trim());
        expect(texts).to.include('Cancel');
    });
});
