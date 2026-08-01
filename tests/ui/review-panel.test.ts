// @vitest-environment happy-dom
import '../helpers/ui-setup';
import { describe, expect, it } from 'vitest';
import { App } from 'obsidian';
import { ReviewPanel } from '../../src/ui/review-panel';
import type EventideQuillPlugin from '../../src/main';

function makePlugin(): EventideQuillPlugin {
    return {
        app: new App(),
        settings: {
            enableCriticalAnalysis: true,
            enableManuscriptAnalysis: true,
            enableFeedbackQueue: true,
            reviewSuggestedEditsEnabled: true,
            autoSaveFeedbackReports: true,
            feedbackReportFolder: 'reviews',
            feedbackQueueLimit: 20,
            feedbackQueueAutoRun: true,
            writingDailyGoal: 0
        } as EventideQuillPlugin['settings'],
        coWriterSession: null,
        getFeedbackJobs: () => [],
        getDefaultChatProvider: () => ({ provider: null, modelId: '' }),
        listChatModels: () => [],
    } as unknown as EventideQuillPlugin;
}

describe('ReviewPanel', () => {
    it('constructs without crashing', () => {
        const panel = new ReviewPanel(new App());
        expect(panel).to.exist;
    });

    it('renders the Create subtab with engine options on setContainer', () => {
        const container = createDiv();
        const panel = new ReviewPanel(new App());
        // The sidebar sets the plugin reference after construction.
        (panel as unknown as { plugin: EventideQuillPlugin }).plugin = makePlugin();
        panel.setContainer(container);
        // Should render the subtab bar + engine picker.
        expect(container.children.length).to.be.greaterThan(0);
        expect(container.textContent?.length).to.be.greaterThan(0);
    });
});
