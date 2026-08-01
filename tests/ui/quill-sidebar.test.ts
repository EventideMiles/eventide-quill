// @vitest-environment happy-dom
import '../helpers/ui-setup';
import { describe, expect, it } from 'vitest';
import { App, WorkspaceLeaf } from 'obsidian';
import { QuillSidebarView } from '../../src/ui/quill-sidebar';
import type EventideQuillPlugin from '../../src/main';

/** Build a minimal `EventideQuillPlugin` stub for sidebar construction. */
function makePlugin(): EventideQuillPlugin {
    return {
        app: new App(),
        settings: { defaultTab: 'dashboard', enableDashboard: true, writingDailyGoal: 0 } as EventideQuillPlugin['settings'],
        currentDashboardMetrics: null,
        currentManuscriptFileData: null,
        currentDashboardSnapshots: null,
        currentManuscriptFolder: '',
        writingGoals: { version: 1, lastSeen: {}, todayDate: '', todayWords: 0, days: {}, bestStreak: 0, session: null },
        getDefaultChatProvider: () => ({ provider: null, modelId: '' }),
        getDefaultEmbedProvider: () => ({ provider: null, modelId: '' }),
        getDefaultImageProvider: () => ({ provider: null, modelId: '' }),
        batchFixInProgress: false,
        refreshDashboard: async () => {},
        getFeedbackJobs: () => [],
        coWriterSession: null,
        feedbackAbort: null,
        analysisAbort: null,
        feedbackQueueAbort: null,
        isGenerating: () => false,
        hasInFlightGeneration: () => false,
        currentLoreRelationships: null,
        currentManuscriptEntities: [],
        currentManuscriptText: '',
        lintState: null,
        linterSettings: null
    } as unknown as EventideQuillPlugin;
}

describe('QuillSidebarView', () => {
    it('constructs with the correct view type + display text', () => {
        const view = new QuillSidebarView((new (WorkspaceLeaf as unknown as new (app?: unknown) => object)(new App())) as unknown as WorkspaceLeaf, makePlugin());
        expect(view.getViewType()).to.include('quill');
        expect(view.getDisplayText()).to.equal('Quill');
    });

    it('defaults to the configured default tab', () => {
        const plugin = makePlugin();
        plugin.settings.defaultTab = 'dashboard';
        const view = new QuillSidebarView((new (WorkspaceLeaf as unknown as new (app?: unknown) => object)(new App())) as unknown as WorkspaceLeaf, plugin);
        expect(view.isDashboardActive()).to.equal(true);
    });

    it('renders the top tab bar with six tabs on open', async () => {
        const leaf = (new (WorkspaceLeaf as unknown as new (app?: unknown) => object)(new App())) as unknown as WorkspaceLeaf;
        const view = new QuillSidebarView(leaf, makePlugin());
        await view.onOpen();

        const tabLabels = Array.from((leaf as unknown as { containerEl: HTMLElement }).containerEl.querySelectorAll('.quill-sidebar__tab'))
            .map((el: Element) => el.getAttribute('aria-label') ?? '');
        expect(tabLabels).to.include('Dashboard');
        expect(tabLabels).to.include('Linter');
        expect(tabLabels).to.include('Co-writer');
        expect(tabLabels).to.include('Review');
        expect(tabLabels).to.include('Context');
        expect(tabLabels).to.include('Lorebook');
    });
});
