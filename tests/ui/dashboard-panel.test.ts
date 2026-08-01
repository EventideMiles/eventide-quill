// @vitest-environment happy-dom
import '../helpers/ui-setup';
import { describe, expect, it } from 'vitest';
import { Component } from 'obsidian';
import { renderDashboardTab } from '../../src/ui/dashboard-panel';
import type { ChapterMetrics, ManuscriptMetrics } from '../../src/core/dashboard/types';
import type EventideQuillPlugin from '../../src/main';

/** Full ChapterMetrics with sensible defaults; override only what a test asserts on. */
function makeChapter(overrides: Partial<ChapterMetrics> = {}): ChapterMetrics {
    return {
        filePath: 'manuscript/ch1.md',
        fileBasename: 'ch1',
        title: 'Chapter 1',
        lineStart: 1,
        lineEnd: 100,
        wordCount: 5000,
        sentenceCount: 200,
        avgSentenceLength: 25,
        sentenceLengthStddev: 10,
        dialogueRatio: 0.3,
        narrationRatio: 0.7,
        fleschReadingEase: 75,
        fleschKincaidGrade: 6,
        daleChallRawScore: 80,
        daleChallGradeLevel: 6,
        reweightedFleschReadingEase: 78,
        reweightedFleschGradeLevel: 5,
        customCompositeScore: 76,
        narrativeFlowScore: 72,
        paragraphLengthStddev: 50,
        ariScore: 7,
        pacingFlags: [],
        sections: [],
        ...overrides
    };
}

/** Full ManuscriptMetrics with defaults + two chapters. */
function makeMetrics(overrides: Partial<ManuscriptMetrics> = {}): ManuscriptMetrics {
    return {
        generatedAt: Date.now(),
        chapterCount: 2,
        sectionCount: 4,
        totalWords: 10000,
        totalSentences: 400,
        avgSentenceLength: 25,
        sentenceLengthStddev: 10,
        dialogueRatio: 0.3,
        narrationRatio: 0.7,
        fleschReadingEase: 75,
        fleschKincaidGrade: 6,
        daleChallRawScore: 80,
        daleChallGradeLevel: 6,
        reweightedFleschReadingEase: 78,
        reweightedFleschGradeLevel: 5,
        customCompositeScore: 76,
        narrativeFlowScore: 72,
        paragraphLengthStddev: 50,
        ariScore: 7,
        chapters: [makeChapter(), makeChapter({ title: 'Chapter 2', wordCount: 5000 })],
        characters: [],
        reclassified: [],
        dismissed: [],
        pacingFlags: [],
        ...overrides
    };
}

/** Plugin stub satisfying what renderDashboardTab reads. */
function makePlugin(metrics: ManuscriptMetrics | null): EventideQuillPlugin {
    return {
        app: {
            workspace: {
                getActiveFile: () => ({
                    path: 'manuscript/ch1.md',
                    name: 'ch1.md',
                    basename: 'ch1',
                    extension: 'md',
                    stat: { mtime: 0, ctime: 0, size: 0 },
                    parent: null
                }),
                getLeavesOfType: () => []
            },
            vault: { getMarkdownFiles: () => [] },
            metadataCache: { getFileCache: () => null }
        },
        settings: {
            writingDailyGoal: 500,
            readabilityFormula: 'reweighted-flesch',
            dashboardAutoRefreshMinutes: 0
        } as EventideQuillPlugin['settings'],
        currentDashboardMetrics: metrics,
        currentManuscriptFileData: { manuscriptTarget: 80000 } as EventideQuillPlugin['currentManuscriptFileData'],
        currentDashboardSnapshots: [],
        writingGoals: {
            version: 1,
            lastSeen: {},
            todayDate: '',
            todayWords: 250,
            days: {},
            bestStreak: 3,
            session: null
        },
        getDefaultChatProvider: () => ({ provider: null, modelId: '' }),
        batchFixInProgress: false
    } as unknown as EventideQuillPlugin;
}

describe('dashboard-panel — renderDashboardTab', () => {
    it('renders the manuscript summary, writing goals card, and chapter list', () => {
        const container = createDiv();
        const component = new Component();
        renderDashboardTab(container, makePlugin(makeMetrics()), component);

        // Manuscript summary heading + total words.
        expect(container.textContent).to.include('Manuscript');
        expect(container.textContent).to.include((10000).toLocaleString());

        // Writing goals card (the 2.0.1 flagship).
        expect(container.textContent).to.include('Writing goals');
        expect(container.textContent).to.include('250');
        expect(container.textContent).to.include('500');

        // Chapter list.
        expect(container.textContent).to.include('Chapter 1');
        expect(container.textContent).to.include('Chapter 2');

        component.unload();
    });

    it('shows the session timer controls', () => {
        const container = createDiv();
        const component = new Component();
        renderDashboardTab(container, makePlugin(makeMetrics()), component);

        const buttons = container.querySelectorAll('button');
        const texts = Array.from(buttons).map((b) => b.textContent?.trim());
        expect(texts).to.include('Start session');

        component.unload();
    });

    it('shows an empty hint when no metrics are available', () => {
        const container = createDiv();
        const component = new Component();
        renderDashboardTab(container, makePlugin(null), component);

        expect(container.textContent).to.include('No metrics yet');
        component.unload();
    });

    it('renders the goal-met indicator when today meets the goal', () => {
        const container = createDiv();
        const component = new Component();
        const plugin = makePlugin(makeMetrics());
        plugin.writingGoals.todayWords = 600; // exceeds goal of 500
        renderDashboardTab(container, plugin, component);

        expect(container.textContent).to.include('goal met');
        component.unload();
    });
});
