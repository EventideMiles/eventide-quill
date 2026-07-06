import { Component, Setting } from 'obsidian';
import type EventideQuillPlugin from '../main';
import type { ChapterMetrics, ManuscriptMetrics, ManuscriptSnapshot, SectionMetrics } from '../core/dashboard/types';
import {
    MANUSCRIPT_PRESETS,
    DEFAULT_WORD_COUNT_TARGET,
    DEFAULT_MANUSCRIPT_TARGET,
    DEFAULT_TARGET_GRADE_LEVEL,
    DEFAULT_SPLIT_BY_HEADING,
    DEFAULT_INCLUDE_SUBFOLDERS
} from '../core/dashboard/presets';
import { flowLabel } from '../core/dashboard/readability';
import { getActiveDocument, renderDocumentHeader } from './document-header';

/** Expand state for chapter rows, keyed by `${filePath}:${lineStart}`. Survives re-renders. */
const expandedChapters = new Set<string>();

/** Check whether a chat model is configured (gates "Fix with AI" buttons). */
function hasChatProvider(plugin: EventideQuillPlugin): boolean {
    return !!plugin.getDefaultChatProvider().provider && !plugin.batchFixInProgress;
}

/** Visual status for target comparison. */
type TargetStatus = 'good' | 'warning' | 'danger';

/** Compute how far a grade level is from its target. */
function gradeLevelStatus(actual: number, target: number): { status: TargetStatus; label: string } {
    const diff = actual - target;
    const abs = Math.abs(diff);
    if (abs <= 1) return { status: 'good', label: 'on target' };
    if (abs <= 2) return { status: 'warning', label: diff > 0 ? 'above target' : 'below target' };
    return {
        status: 'danger',
        label: diff > 0 ? 'way above target' : 'way below target'
    };
}

/** Compute progress status for a word-count-vs-target ratio. */
function progressStatus(ratio: number): { status: TargetStatus; label: string } {
    if (ratio >= 1) return { status: 'good', label: 'target met' };
    if (ratio >= 0.8) return { status: 'good', label: 'on track' };
    if (ratio >= 0.5) return { status: 'warning', label: 'behind' };
    return { status: 'danger', label: 'far behind' };
}

/** Format a 0-1 ratio as a percentage string. */
function pct(ratio: number): string {
    return `${Math.round(ratio * 100)}%`;
}

/** Format an epoch millisecond timestamp as a human-readable relative time. */
function formatRelativeTime(ms: number): string {
    const delta = Date.now() - ms;
    if (delta < 60_000) return 'just now';
    if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
    if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
    return `${Math.floor(delta / 86_400_000)}d ago`;
}

/** Clamp a value to a min/max range. */
function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

/**
 * Render the Dashboard tab content into `container`.
 *
 * Pattern B (free function) — mirrors `renderContextTab`. The container is
 * a fresh scroll div created by `QuillSidebarView` on each render; the
 * `component` owns DOM event teardown.
 */
export function renderDashboardTab(container: HTMLElement, plugin: EventideQuillPlugin, component: Component): void {
    container.empty();

    const doc = getActiveDocument(plugin.app);
    renderDocumentHeader(container, doc);

    if (!doc) {
        container.createEl('p', {
            cls: 'quill-empty-hint',
            text: 'Open a manuscript to view dashboard metrics.'
        });
        return;
    }

    // Refresh button row.
    const actionBar = container.createEl('div', { cls: 'quill-dashboard-panel__actions' });
    const refreshBtn = actionBar.createEl('button', {
        cls: 'quill-dashboard-panel__refresh-btn',
        text: 'Refresh dashboard'
    });
    component.registerDomEvent(refreshBtn, 'click', () => {
        void plugin.refreshDashboard();
    });

    const metrics = plugin.currentDashboardMetrics;
    if (!metrics) {
        container.createEl('p', {
            cls: 'quill-dashboard-panel__empty',
            text: 'No metrics yet. Click "refresh dashboard" to analyze the manuscript.'
        });
        return;
    }

    // Generated-at timestamp — re-written every 60s so it ages between refreshes.
    // Uses isConnected guard to self-clean on re-render (the chapter expand/collapse
    // path calls renderDashboardTab with the same component, so registerInterval alone
    // would accumulate duplicates). The interval is also registered on the component so
    // full unload (tab switch, view detach) cleans up properly.
    const tsEl = actionBar.createEl('span', {
        cls: 'quill-dashboard-panel__timestamp',
        text: `Updated ${formatRelativeTime(metrics.generatedAt)}`
    });
    const tickId = window.setInterval(() => {
        if (!tsEl.isConnected) {
            window.clearInterval(tickId);
            return;
        }
        tsEl.textContent = `Updated ${formatRelativeTime(metrics.generatedAt)}`;
    }, 60_000);
    component.registerInterval(tickId);

    renderSummary(container, metrics, plugin);
    renderFlowScore(container, metrics);
    renderChapterList(container, metrics, plugin, component);
    renderPacingHeatmap(container, metrics, plugin, component);
    renderReadability(container, metrics, plugin);
    renderCharacterList(container, metrics, plugin, component);
    renderReclassifiedList(container, metrics, plugin, component);
    renderDismissedList(container, metrics, plugin, component);
    renderTrends(container, plugin.currentDashboardSnapshots);
}

/** Render the top-level manuscript summary grid. */
function renderSummary(container: HTMLElement, metrics: ManuscriptMetrics, plugin: EventideQuillPlugin): void {
    const section = container.createEl('div', { cls: 'quill-dashboard-panel__section' });
    section.createEl('div', { cls: 'quill-dashboard-panel__section-heading', text: 'Manuscript' });

    const target = plugin.currentManuscriptFileData?.manuscriptTarget ?? DEFAULT_MANUSCRIPT_TARGET;
    const ratio = target > 0 ? metrics.totalWords / target : 0;
    const progressPct = clamp(ratio * 100, 0, 100);
    const { status: pStatus, label: pLabel } = progressStatus(ratio);

    // Progress bar.
    const bar = section.createEl('div', { cls: 'quill-dashboard-panel__progress-bar' });
    bar.createEl('div', {
        cls: `quill-dashboard-panel__progress-fill quill-dashboard-panel__progress-fill--${pStatus}`,
        attr: { style: `width: ${progressPct}%` }
    });

    // Status text below the bar — a sibling, not a child, so the bar's
    // `overflow: hidden` + 6px height can't clip it.
    section.createEl('div', {
        cls: `quill-dashboard-panel__progress-label quill-dashboard-panel__target-status--${pStatus}`,
        text: `${metrics.totalWords.toLocaleString()} / ${target.toLocaleString()} words \u00B7 ${pLabel}`
    });

    const grid = section.createEl('div', { cls: 'quill-dashboard-panel__summary-grid' });

    const stats: { label: string; value: string }[] = [
        { label: 'Chapters', value: String(metrics.chapterCount) },
        { label: 'Scenes', value: String(metrics.sectionCount) },
        { label: 'Avg sentence', value: `${metrics.avgSentenceLength}w` },
        { label: 'Dialogue', value: pct(metrics.dialogueRatio) },
        { label: 'Flow', value: String(metrics.narrativeFlowScore) }
    ];

    for (const stat of stats) {
        const cell = grid.createEl('div', { cls: 'quill-dashboard-panel__summary-stat' });
        cell.createEl('div', { cls: 'quill-dashboard-panel__summary-stat-value', text: stat.value });
        cell.createEl('div', { cls: 'quill-dashboard-panel__summary-stat-label', text: stat.label });
    }
}

/**
 * Render the narrative-flow section: a 0-100 score with a colored bar and the
 * tier label, plus the two rhythm signals that feed it (sentence + paragraph
 * length stddev). Deterministic and local — no AI. The bar reuses the summary
 * progress-bar classes so the existing `--good`/`--warning`/`--danger` SCSS
 * styles it for free.
 */
function renderFlowScore(container: HTMLElement, metrics: ManuscriptMetrics): void {
    const section = container.createEl('div', { cls: 'quill-dashboard-panel__section' });
    const headingRow = section.createEl('div', { cls: 'quill-dashboard-panel__heading-row' });
    headingRow.createEl('div', { cls: 'quill-dashboard-panel__section-heading', text: 'Narrative flow' });
    headingRow.createEl('span', {
        cls: 'quill-dashboard-panel__readability-info',
        attr: {
            title:
                'Narrative-flow score measures prose rhythm at two scales (sentence and paragraph length), ' +
                'penalizes uniformly short/long runs, and rewards a balanced dialogue/narration mix. ' +
                'It is a rough guide to pacing variety, not a verdict on the writing.'
        },
        text: '(?)'
    });

    const score = metrics.narrativeFlowScore;
    const status = flowStatus(score);
    const label = flowLabel(score);

    const bar = section.createEl('div', { cls: 'quill-dashboard-panel__progress-bar' });
    bar.createEl('div', {
        cls: `quill-dashboard-panel__progress-fill quill-dashboard-panel__progress-fill--${status}`,
        attr: { style: `width: ${clamp(score, 0, 100)}%` }
    });
    section.createEl('div', {
        cls: `quill-dashboard-panel__progress-label quill-dashboard-panel__target-status--${status}`,
        text: `${score} \u00B7 ${label}`
    });

    const grid = section.createEl('div', { cls: 'quill-dashboard-panel__readability-grid' });
    grid.createEl('div', { cls: 'quill-dashboard-panel__readability-score' }).setText(
        `Sentence variety: \u03C3 = ${metrics.sentenceLengthStddev} words`
    );
    grid.createEl('div', { cls: 'quill-dashboard-panel__readability-score' }).setText(
        `Paragraph rhythm: \u03C3 = ${metrics.paragraphLengthStddev} words`
    );
}

/** Render the expandable chapter list. */
function renderChapterList(
    container: HTMLElement,
    metrics: ManuscriptMetrics,
    plugin: EventideQuillPlugin,
    component: Component
): void {
    const section = container.createEl('div', { cls: 'quill-dashboard-panel__section' });
    section.createEl('div', { cls: 'quill-dashboard-panel__section-heading', text: 'Chapters' });

    const target = plugin.currentManuscriptFileData?.wordCountTarget ?? DEFAULT_WORD_COUNT_TARGET;

    for (let i = 0; i < metrics.chapters.length; i++) {
        const chapter = metrics.chapters[i]!;
        const id = `${chapter.filePath}:${chapter.lineStart}`;
        const expanded = expandedChapters.has(id);

        const row = section.createEl('div', {
            cls: `quill-dashboard-panel__chapter${expanded ? ' quill-dashboard-panel__chapter--expanded' : ''}`
        });

        // Clickable header row.
        const head = row.createEl('div', {
            cls: 'quill-dashboard-panel__chapter-head',
            attr: { role: 'button', tabindex: '0' }
        });
        component.registerDomEvent(head, 'click', () => {
            if (expandedChapters.has(id)) {
                expandedChapters.delete(id);
            } else {
                expandedChapters.add(id);
            }
            renderDashboardTab(container.closest('.quill-dashboard-panel__scroll') as HTMLElement, plugin, component);
        });
        component.registerDomEvent(head, 'keydown', (evt: KeyboardEvent) => {
            if (evt.key === 'Enter' || evt.key === ' ') {
                evt.preventDefault();
                head.click();
            }
        });

        // Chevron.
        head.createEl('span', {
            cls: `quill-dashboard-panel__chevron${expanded ? ' quill-dashboard-panel__chevron--open' : ''}`,
            text: '\u25B8'
        });

        // Chapter name + line range.
        const nameWrap = head.createEl('div', { cls: 'quill-dashboard-panel__chapter-name-wrap' });
        nameWrap.createEl('span', { cls: 'quill-dashboard-panel__chapter-name', text: chapter.title });
        nameWrap.createEl('span', {
            cls: 'quill-dashboard-panel__chapter-meta',
            text: `${chapter.wordCount.toLocaleString()}w \u00B7 ${pct(chapter.dialogueRatio)} dialogue`
        });

        // Word-count bar vs target — colored by progress status.
        const chapterRatio = target > 0 ? chapter.wordCount / target : 0;
        const barWidth = clamp(chapterRatio * 100, 0, 100);
        const { status: cStatus } = progressStatus(chapterRatio);
        const bar = head.createEl('div', { cls: 'quill-dashboard-panel__chapter-bar' });
        bar.createEl('div', {
            cls: `quill-dashboard-panel__chapter-bar-fill quill-dashboard-panel__chapter-bar-fill--${cStatus}`,
            attr: { style: `width: ${barWidth}%` }
        });

        // Expanded section rows.
        if (expanded && chapter.sections.length > 0) {
            const sectionList = row.createEl('div', { cls: 'quill-dashboard-panel__section-list' });
            for (const sm of chapter.sections) {
                renderSectionRow(sectionList, sm, chapter, plugin, component);
            }
        }
    }
}
/** Render a single section (scene) row inside an expanded chapter. */
function renderSectionRow(
    container: HTMLElement,
    section: SectionMetrics,
    chapter: ChapterMetrics,
    plugin: EventideQuillPlugin,
    component: Component
): void {
    const wrapper = container.createEl('div', { cls: 'quill-dashboard-panel__section-wrapper' });

    // First line: title + meta.
    const row = wrapper.createEl('div', { cls: 'quill-dashboard-panel__section-row' });
    const title = section.title ?? 'Scene';
    row.createEl('span', { cls: 'quill-dashboard-panel__section-title', text: title });
    row.createEl('span', {
        cls: 'quill-dashboard-panel__section-meta',
        text: `${section.wordCount.toLocaleString()}w \u00B7 ${section.avgSentenceLength}w/sentence \u00B7 ${pct(section.dialogueRatio)} dialogue`
    });

    // Pacing flags below — each is a multi-line clickable block.
    for (const flag of section.pacingFlags) {
        const isShort = flag.kind === 'uniform-short';
        const label = isShort ? 'Uniformly short sentences' : 'Uniformly long sentences';
        const detail = isShort
            ? 'Staccato rhythm — consider varying sentence length.'
            : 'Dense passage — consider breaking up.';
        // Flags are already in file-absolute coordinates (normalized by computeSectionMetrics).
        const absLine = flag.lineStart;
        const absEnd = flag.lineEnd;
        const chip = wrapper.createEl('div', {
            cls: `quill-dashboard-panel__pacing-chip quill-dashboard-panel__pacing-chip--${flag.kind}`,
            attr: { role: 'button', tabindex: '0', title: 'Click to jump to this passage' }
        });
        chip.createEl('div', { cls: 'quill-dashboard-panel__pacing-chip-label', text: label });
        chip.createEl('div', { cls: 'quill-dashboard-panel__pacing-chip-detail', text: detail });
        chip.createEl('div', {
            cls: 'quill-dashboard-panel__pacing-chip-line',
            text: `Avg ${flag.avgSentenceLength} words/sentence \u00B7 lines ${absLine}\u2013${absEnd}`
        });
        component.registerDomEvent(chip, 'click', () => {
            void plugin.jumpToDashboardLine(chapter.filePath, absLine);
        });
        component.registerDomEvent(chip, 'keydown', (evt: KeyboardEvent) => {
            // Ignore key events originating from nested controls (e.g. the "Fix with AI" button).
            if (evt.target !== chip) return;
            if (evt.key === 'Enter' || evt.key === ' ') {
                evt.preventDefault();
                void plugin.jumpToDashboardLine(chapter.filePath, absLine);
            }
        });

        // "Fix with AI" button — only shown when a chat model is configured.
        if (hasChatProvider(plugin)) {
            const fixBtn = chip.createEl('button', {
                cls: 'quill-dashboard-panel__pacing-fix-btn',
                text: 'Fix with AI'
            });
            component.registerDomEvent(fixBtn, 'click', (evt: MouseEvent) => {
                evt.stopPropagation();
                void plugin.fixSinglePacingFlag({ ...flag, lineStart: absLine, lineEnd: absEnd });
            });
        }
    }
}
/** Render the pacing heatmap (one bar per chapter) with clickable legend. */
function renderPacingHeatmap(
    container: HTMLElement,
    metrics: ManuscriptMetrics,
    plugin: EventideQuillPlugin,
    component: Component
): void {
    const allFlags = metrics.pacingFlags;
    if (allFlags.length === 0 && metrics.chapters.length === 0) return;

    const section = container.createEl('div', { cls: 'quill-dashboard-panel__section' });

    // Heading row with optional "Fix all" button.
    const headingRow = section.createEl('div', { cls: 'quill-dashboard-panel__heading-row' });
    headingRow.createEl('div', { cls: 'quill-dashboard-panel__section-heading', text: 'Pacing' });
    if (hasChatProvider(plugin) && allFlags.length > 0) {
        const fixAllBtn = headingRow.createEl('button', {
            cls: 'quill-dashboard-panel__fix-all-btn',
            text: 'Fix all with AI'
        });
        component.registerDomEvent(fixAllBtn, 'click', () => {
            void plugin.fixAllPacingWithAi();
        });
    }

    const heatmap = section.createEl('div', { cls: 'quill-dashboard-panel__heatmap' });

    for (const chapter of metrics.chapters) {
        const flagCount = chapter.pacingFlags.length;
        const severity = flagCount === 0 ? 'none' : flagCount <= 2 ? 'low' : 'high';
        const cell = heatmap.createEl('div', {
            cls: `quill-dashboard-panel__heatmap-cell quill-dashboard-panel__heatmap-cell--${severity}`,
            attr: { title: `${chapter.title}: ${flagCount} pacing flag${flagCount !== 1 ? 's' : ''}` }
        });
        cell.createEl('span', { cls: 'quill-dashboard-panel__heatmap-label', text: chapter.title });
    }

    if (allFlags.length > 0) {
        const legend = section.createEl('div', { cls: 'quill-dashboard-panel__heatmap-legend' });
        for (const flag of allFlags.slice(0, 10)) {
            const isShort = flag.kind === 'uniform-short';
            const label = isShort ? 'Uniformly short sentences' : 'Uniformly long sentences';
            const detail = isShort
                ? 'Staccato rhythm — consider varying sentence length.'
                : 'Dense passage — consider breaking up.';
            const item = legend.createEl('div', {
                cls: `quill-dashboard-panel__pacing-chip quill-dashboard-panel__heatmap-flag quill-dashboard-panel__pacing-chip--${flag.kind}`,
                attr: { role: 'button', tabindex: '0', title: 'Click to jump to this passage' }
            });
            item.createEl('div', { cls: 'quill-dashboard-panel__pacing-chip-label', text: label });
            item.createEl('div', { cls: 'quill-dashboard-panel__pacing-chip-detail', text: detail });
            item.createEl('div', {
                cls: 'quill-dashboard-panel__pacing-chip-line',
                text: `Avg ${flag.avgSentenceLength} words/sentence \u00B7 line ${flag.lineStart}`
            });
            component.registerDomEvent(item, 'click', () => {
                void plugin.jumpToDashboardLine(flag.filePath, flag.lineStart);
            });
            component.registerDomEvent(item, 'keydown', (evt: KeyboardEvent) => {
                // Ignore key events originating from nested controls (e.g. the "Fix with AI" button).
                if (evt.target !== item) return;
                if (evt.key === 'Enter' || evt.key === ' ') {
                    evt.preventDefault();
                    void plugin.jumpToDashboardLine(flag.filePath, flag.lineStart);
                }
            });

            // "Fix with AI" button on each legend chip.
            if (hasChatProvider(plugin)) {
                const fixBtn = item.createEl('button', {
                    cls: 'quill-dashboard-panel__pacing-fix-btn',
                    text: 'Fix with AI'
                });
                component.registerDomEvent(fixBtn, 'click', (evt: MouseEvent) => {
                    evt.stopPropagation();
                    void plugin.fixSinglePacingFlag(flag);
                });
            }
        }
        if (allFlags.length > 10) {
            legend.createEl('div', {
                cls: 'quill-dashboard-panel__heatmap-flag',
                text: `\u2026and ${allFlags.length - 10} more`
            });
        }
    }
}

/** Render the manuscript-wide readability scores. */
function renderReadability(container: HTMLElement, metrics: ManuscriptMetrics, plugin: EventideQuillPlugin): void {
    const section = container.createEl('div', { cls: 'quill-dashboard-panel__section' });
    const headingRow = section.createEl('div', { cls: 'quill-dashboard-panel__heading-row' });
    headingRow.createEl('div', { cls: 'quill-dashboard-panel__section-heading', text: 'Readability' });
    headingRow.createEl('span', {
        cls: 'quill-dashboard-panel__readability-info',
        attr: {
            title: 'Readability scores are rough guides \u2014 they help aim toward your target audience, not pin down an exact grade.'
        },
        text: '(?)'
    });

    const formula = plugin.settings.readabilityFormula;

    const grid = section.createEl('div', { cls: 'quill-dashboard-panel__readability-grid' });

    const targetGrade = plugin.currentManuscriptFileData?.targetGradeLevel;

    switch (formula) {
        case 'dale-chall': {
            const label = daleChallLabel(metrics.daleChallRawScore);
            grid.createEl('div', { cls: 'quill-dashboard-panel__readability-score' }).setText(
                `Dale-Chall: ${metrics.daleChallRawScore} (${label})`
            );
            renderGradeTarget(grid, metrics.daleChallGradeLevel, targetGrade);
            break;
        }
        case 'flesch-kincaid': {
            const easeLabel = readabilityEaseLabel(metrics.fleschReadingEase);
            grid.createEl('div', { cls: 'quill-dashboard-panel__readability-score' }).setText(
                `Reading ease: ${metrics.fleschReadingEase} (${easeLabel})`
            );
            renderGradeTarget(grid, metrics.fleschKincaidGrade, targetGrade);
            break;
        }
        case 'ari': {
            grid.createEl('div', { cls: 'quill-dashboard-panel__readability-score' }).setText(
                `ARI: ${metrics.ariScore} (${ariLabel(metrics.ariScore)})`
            );
            renderGradeTarget(grid, metrics.ariScore, targetGrade);
            break;
        }
        case 'reweighted-flesch': {
            const label = readabilityEaseLabel(metrics.reweightedFleschReadingEase);
            grid.createEl('div', { cls: 'quill-dashboard-panel__readability-score' }).setText(
                `Reweighted Flesch: ${metrics.reweightedFleschReadingEase} (${label})`
            );
            renderGradeTarget(grid, metrics.reweightedFleschGradeLevel, targetGrade);
            break;
        }
        case 'custom-composite': {
            grid.createEl('div', { cls: 'quill-dashboard-panel__readability-score' }).setText(
                `Custom composite: ${metrics.customCompositeScore} (${compositeLabel(metrics.customCompositeScore)})`
            );
            break;
        }
    }
}

/** Render grade-level target comparison line.
 *  If targetGrade is undefined, just shows the grade level. */
function renderGradeTarget(grid: HTMLElement, actualGrade: number, targetGrade: number | undefined): void {
    const gradeEl = grid.createEl('div', { cls: 'quill-dashboard-panel__readability-score' });
    if (targetGrade === undefined) {
        gradeEl.setText(`Grade level: ${actualGrade}`);
        return;
    }
    const { status, label } = gradeLevelStatus(actualGrade, targetGrade);
    const dir = actualGrade > targetGrade ? 'simplify' : 'add complexity';
    const hint = status === 'good' ? '' : ` \u2014 consider ${dir}`;
    gradeEl.createEl('span').setText(`Grade level: ${actualGrade} (target: ${targetGrade}) `);
    gradeEl.createEl('span', {
        cls: `quill-dashboard-panel__target-status quill-dashboard-panel__target-status--${status}`,
        text: `${label}${hint}`
    });
}

/** Map a Dale-Chall raw score to a readability label. */
function daleChallLabel(score: number): string {
    if (score >= 60) return 'very easy';
    if (score >= 50) return 'easy';
    if (score >= 40) return 'moderate';
    if (score >= 30) return 'difficult';
    return 'very difficult';
}

/** Map a composite score to a label. */
function compositeLabel(score: number): string {
    if (score >= 80) return 'very readable';
    if (score >= 60) return 'readable';
    if (score >= 40) return 'moderate';
    if (score >= 20) return 'complex';
    return 'very complex';
}

/** Map a narrative-flow score to a 3-tier bar color (good/warning/danger). */
function flowStatus(score: number): TargetStatus {
    if (score >= 60) return 'good';
    if (score >= 40) return 'warning';
    return 'danger';
}

/** Map an ARI score to a readability label. */
function ariLabel(score: number): string {
    if (score <= 4) return 'very easy';
    if (score <= 6) return 'easy';
    if (score <= 9) return 'average';
    if (score <= 12) return 'difficult';
    return 'very difficult';
}

/** Map a Flesch Reading Ease score to a human-readable label. */
function readabilityEaseLabel(score: number): string {
    if (score >= 90) return 'very easy';
    if (score >= 70) return 'easy';
    if (score >= 60) return 'standard';
    if (score >= 50) return 'fairly difficult';
    if (score >= 30) return 'difficult';
    return 'very difficult';
}

/** Render the character appearance tracker. */
function renderCharacterList(
    container: HTMLElement,
    metrics: ManuscriptMetrics,
    plugin: EventideQuillPlugin,
    component: Component
): void {
    if (metrics.characters.length === 0) return;

    const section = container.createEl('div', { cls: 'quill-dashboard-panel__section' });
    section.createEl('div', { cls: 'quill-dashboard-panel__section-heading', text: 'Characters' });

    for (const character of metrics.characters) {
        const row = section.createEl('div', { cls: 'quill-dashboard-panel__character-row' });
        row.createEl('span', { cls: 'quill-dashboard-panel__character-name', text: character.name });

        const meta = row.createEl('span', { cls: 'quill-dashboard-panel__character-meta' });
        if (character.chaptersSinceLastSeen < 0) {
            meta.setText(`${character.occurrences} mentions · absent from all chapters`);
        } else if (character.chaptersSinceLastSeen === 0) {
            meta.setText(`${character.occurrences} mentions · present in latest chapter`);
        } else {
            meta.setText(
                `${character.occurrences} mentions · last seen ${character.chaptersSinceLastSeen} chapter${
                    character.chaptersSinceLastSeen !== 1 ? 's' : ''
                } ago`
            );
        }

        // Reclassify button — moves entity out of the character list.
        const reclassifyBtn = row.createEl('button', {
            cls: 'quill-dashboard-panel__reclassify-btn',
            text: 'Not a character',
            attr: { title: 'Move to other entities' }
        });
        component.registerDomEvent(reclassifyBtn, 'click', () => {
            void plugin.reclassifyDashboardEntity(character.entityId, 'location');
        });
    }
}

/** Capitalize the first letter of a string. */
function cap(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Render reclassified entities with type selector buttons. */
function renderReclassifiedList(
    container: HTMLElement,
    metrics: ManuscriptMetrics,
    plugin: EventideQuillPlugin,
    component: Component
): void {
    if (metrics.reclassified.length === 0) return;

    const section = container.createEl('div', { cls: 'quill-dashboard-panel__section' });
    section.createEl('div', { cls: 'quill-dashboard-panel__section-heading', text: 'Other entities' });

    for (const entity of metrics.reclassified) {
        const row = section.createEl('div', { cls: 'quill-dashboard-panel__reclassified-row' });
        row.createEl('span', { cls: 'quill-dashboard-panel__character-name', text: entity.name });

        const meta = row.createEl('span', { cls: 'quill-dashboard-panel__character-meta' });
        meta.setText(`${entity.occurrences} mentions · was ${entity.originalType}, now ${entity.currentType}`);

        // Type selector buttons.
        const btnGroup = row.createEl('div', { cls: 'quill-dashboard-panel__type-btns' });

        for (const type of ['location', 'plot-thread', 'theme', 'item'] as const) {
            const isActive = entity.currentType === type;
            const btn = btnGroup.createEl('button', {
                cls: `quill-dashboard-panel__type-btn${isActive ? ' quill-dashboard-panel__type-btn--active' : ''}`,
                text: cap(type),
                attr: isActive ? { disabled: 'true' } : {}
            });
            if (!isActive) {
                component.registerDomEvent(btn, 'click', () => {
                    void plugin.reclassifyDashboardEntity(entity.entityId, type);
                });
            }
        }

        // Revert button — restores original extracted type.
        const revertBtn = btnGroup.createEl('button', {
            cls: 'quill-dashboard-panel__type-btn quill-dashboard-panel__type-btn--revert',
            text: `Restore ${cap(entity.originalType)}`,
            attr: { title: `Revert to original type (${entity.originalType})` }
        });
        component.registerDomEvent(revertBtn, 'click', () => {
            void plugin.reclassifyDashboardEntity(entity.entityId, null);
        });

        // Dismiss button — removes the entity from all dashboard sections.
        const dismissBtn = btnGroup.createEl('button', {
            cls: 'quill-dashboard-panel__type-btn quill-dashboard-panel__type-btn--dismiss',
            text: 'Dismiss',
            attr: { title: 'Remove this entity from the dashboard entirely' }
        });
        component.registerDomEvent(dismissBtn, 'click', () => {
            void plugin.dismissDashboardEntity(entity.entityId);
        });
    }
}

/** Render dismissed entities with restore buttons. */
function renderDismissedList(
    container: HTMLElement,
    metrics: ManuscriptMetrics,
    plugin: EventideQuillPlugin,
    component: Component
): void {
    if (metrics.dismissed.length === 0) return;

    const section = container.createEl('div', { cls: 'quill-dashboard-panel__section' });
    section.createEl('div', { cls: 'quill-dashboard-panel__section-heading', text: 'Dismissed' });

    for (const entity of metrics.dismissed) {
        const row = section.createEl('div', { cls: 'quill-dashboard-panel__dismissed-row' });
        row.createEl('span', { cls: 'quill-dashboard-panel__character-name', text: entity.name });

        const meta = row.createEl('span', { cls: 'quill-dashboard-panel__character-meta' });
        meta.setText(`${entity.occurrences} mentions · was ${entity.originalType}`);

        const restoreBtn = row.createEl('button', {
            cls: 'quill-dashboard-panel__type-btn quill-dashboard-panel__type-btn--revert',
            text: 'Restore',
            attr: { title: `Restore "${entity.name}" to its original type (${entity.originalType})` }
        });
        component.registerDomEvent(restoreBtn, 'click', () => {
            void plugin.restoreDashboardEntity(entity.entityId);
        });
    }
}

/** Render the historical trends sparkline. */
function renderTrends(container: HTMLElement, snapshots: ManuscriptSnapshot[] | null): void {
    if (!snapshots || snapshots.length < 2) return;

    const section = container.createEl('div', { cls: 'quill-dashboard-panel__section' });
    section.createEl('div', { cls: 'quill-dashboard-panel__section-heading', text: 'Word count trend' });

    const points = snapshots;
    const wordCounts = points.map((s) => s.totalWords);
    const max = Math.max(...wordCounts);
    const min = Math.min(...wordCounts);
    const range = max - min || 1;

    const width = 200;
    const height = 40;
    const stepX = width / (points.length - 1);

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const svg = activeDocument.createElementNS(SVG_NS, 'svg');
    svg.classList.add('quill-dashboard-panel__trend-chart');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    section.appendChild(svg);

    const polylinePoints = points
        .map((s, i) => {
            const x = i * stepX;
            const y = height - ((s.totalWords - min) / range) * (height - 4) - 2;
            return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(' ');

    const polyline = activeDocument.createElementNS(SVG_NS, 'polyline');
    polyline.setAttribute('points', polylinePoints);
    polyline.setAttribute('fill', 'none');
    polyline.setAttribute('stroke', 'currentColor');
    polyline.setAttribute('stroke-width', '1.5');
    svg.appendChild(polyline);

    // Velocity: words per day between first and last snapshot.
    const first = points[0]!;
    const last = points[points.length - 1]!;
    const daysElapsed = (last.takenAt - first.takenAt) / 86_400_000;
    if (daysElapsed > 0) {
        const velocity = Math.round((last.totalWords - first.totalWords) / daysElapsed);
        section.createEl('div', {
            cls: 'quill-dashboard-panel__trend-velocity',
            text: `${velocity.toLocaleString()} words/day over ${points.length} snapshots`
        });
    }
}

// ── Settings subtab ───────────────────────────────────────────────────────────

/**
 * Render the Dashboard settings subtab.
 *
 * Shows preset manuscript-type buttons (short story, novel, epic, etc.)
 * that load typical defaults, followed by individually editable target
 * fields and toggle options. Values are per-manuscript — stored in the
 * sidecar `quill-data.json` and override global plugin settings.
 */
export function renderDashboardSettingsTab(
    container: HTMLElement,
    plugin: EventideQuillPlugin,
    component: Component
): void {
    container.empty();

    const msFile = plugin.currentManuscriptFileData;

    // Current effective values: per-manuscript overrides fall back to preset defaults.
    const wordCountTarget = msFile?.wordCountTarget ?? DEFAULT_WORD_COUNT_TARGET;
    const manuscriptTarget = msFile?.manuscriptTarget ?? DEFAULT_MANUSCRIPT_TARGET;
    const targetGradeLevel = msFile?.targetGradeLevel;
    const splitByHeading = msFile?.splitByHeading ?? DEFAULT_SPLIT_BY_HEADING;
    const includeSubfolders = msFile?.includeSubfolders ?? DEFAULT_INCLUDE_SUBFOLDERS;

    // --- Manuscript type presets ---

    const presetSection = container.createEl('div', { cls: 'quill-dashboard-panel__section' });
    presetSection.createEl('div', { cls: 'quill-dashboard-panel__section-heading', text: 'Manuscript type' });
    presetSection.createEl('p', {
        cls: 'quill-dashboard-panel__settings-hint',
        text: 'Click a preset to load typical defaults, then fine-tune below.'
    });

    const presetGrid = presetSection.createEl('div', { cls: 'quill-dashboard-panel__preset-grid' });
    for (const preset of MANUSCRIPT_PRESETS) {
        const isActive =
            wordCountTarget === preset.wordCountTarget &&
            manuscriptTarget === preset.manuscriptTarget &&
            (targetGradeLevel ?? DEFAULT_TARGET_GRADE_LEVEL) === preset.targetGradeLevel;

        const card = presetGrid.createEl('div', {
            cls: `quill-dashboard-panel__preset-card${isActive ? ' quill-dashboard-panel__preset-card--active' : ''}`,
            attr: { role: 'button', tabindex: '0' }
        });
        card.createEl('div', { cls: 'quill-dashboard-panel__preset-label', text: preset.label });
        card.createEl('div', { cls: 'quill-dashboard-panel__preset-desc', text: preset.description });
        card.createEl('div', {
            cls: 'quill-dashboard-panel__preset-detail',
            text: `${preset.wordCountTarget.toLocaleString()}w/chapter \u00B7 grade ${preset.targetGradeLevel}`
        });

        component.registerDomEvent(card, 'click', () => {
            void plugin.updateManuscriptSettings({
                wordCountTarget: preset.wordCountTarget,
                manuscriptTarget: preset.manuscriptTarget,
                targetGradeLevel: preset.targetGradeLevel
            });
        });
        component.registerDomEvent(card, 'keydown', (evt: KeyboardEvent) => {
            if (evt.key === 'Enter' || evt.key === ' ') {
                evt.preventDefault();
                void plugin.updateManuscriptSettings({
                    wordCountTarget: preset.wordCountTarget,
                    manuscriptTarget: preset.manuscriptTarget,
                    targetGradeLevel: preset.targetGradeLevel
                });
            }
        });
    }

    // --- Targets ---

    const targetSection = container.createEl('div', { cls: 'quill-dashboard-panel__section' });
    targetSection.createEl('div', { cls: 'quill-dashboard-panel__section-heading', text: 'Targets' });

    new Setting(targetSection)
        .setName('Chapter word count target')
        .setDesc('Target words per chapter. Used for the progress bars in the chapter list.')
        .addText((text) =>
            text.setValue(String(wordCountTarget)).inputEl.addEventListener('blur', () => {
                const n = parseInt(text.inputEl.value, 10);
                if (!isNaN(n) && n >= 100 && n <= 20000) {
                    void plugin.updateManuscriptSettings({ wordCountTarget: n });
                } else {
                    text.setValue(String(wordCountTarget));
                }
            })
        );

    new Setting(targetSection)
        .setName('Manuscript word count target')
        .setDesc('Total target for the whole manuscript.')
        .addText((text) =>
            text.setValue(String(manuscriptTarget)).inputEl.addEventListener('blur', () => {
                const n = parseInt(text.inputEl.value, 10);
                if (!isNaN(n) && n >= 1000 && n <= 500000) {
                    void plugin.updateManuscriptSettings({ manuscriptTarget: n });
                } else {
                    text.setValue(String(manuscriptTarget));
                }
            })
        );

    new Setting(targetSection)
        .setName('Target grade level')
        .setDesc('Target flesch-kincaid grade level for the readability display. Leave empty to ignore.')
        .addText((text) =>
            text
                .setPlaceholder('None')
                .setValue(targetGradeLevel !== undefined ? String(targetGradeLevel) : '')
                .inputEl.addEventListener('blur', () => {
                    const raw = text.inputEl.value.trim();
                    if (raw === '') {
                        void plugin.updateManuscriptSettings({ targetGradeLevel: undefined });
                    } else {
                        const n = parseInt(raw, 10);
                        if (!isNaN(n) && n >= 1 && n <= 20) {
                            void plugin.updateManuscriptSettings({ targetGradeLevel: n });
                        } else {
                            text.setValue(targetGradeLevel !== undefined ? String(targetGradeLevel) : '');
                        }
                    }
                })
        );

    // --- Options ---

    const optionsSection = container.createEl('div', { cls: 'quill-dashboard-panel__section' });
    optionsSection.createEl('div', { cls: 'quill-dashboard-panel__section-heading', text: 'Options' });

    new Setting(optionsSection)
        .setName('Split chapters by heading')
        .setDesc('Treat # and ## headings as chapter boundaries within each file. When off, each file is one chapter.')
        .addToggle((toggle) =>
            toggle.setValue(splitByHeading).onChange(async (value) => {
                await plugin.updateManuscriptSettings({ splitByHeading: value });
            })
        );

    new Setting(optionsSection)
        .setName('Include subfolders')
        .setDesc('Recursively scan subfolders of the active file when resolving manuscript chapters.')
        .addToggle((toggle) =>
            toggle.setValue(includeSubfolders).onChange(async (value) => {
                await plugin.updateManuscriptSettings({ includeSubfolders: value });
            })
        );
}
