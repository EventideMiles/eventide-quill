import { App, SuggestModal, type TFile, normalizePath } from 'obsidian';
import type EventideQuillPlugin from '../main';

interface ReportEntry {
    file: TFile;
    /** Human label for the report (engine + persona/mode, from frontmatter). */
    label: string;
    /** The dated filename — used for newest-first sorting + display. */
    name: string;
}

/**
 * Picker for saved feedback-report notes (the dated `{label}.md` files written
 * by {@link saveReportArchive} to `feedbackReportFolder`). Lets the writer pull
 * an old report into the Review Results sub-tab for follow-up discussion — even
 * one long since cleared from the queue. Lists only files carrying
 * `quill-report-type` frontmatter, newest-first.
 */
export class ReportSuggestModal extends SuggestModal<ReportEntry> {
    private readonly onChoose: (file: TFile) => void;
    private readonly reports: ReportEntry[];
    readonly isEmpty: boolean;

    constructor(app: App, plugin: EventideQuillPlugin, onChoose: (file: TFile) => void) {
        super(app);
        this.onChoose = onChoose;
        this.setPlaceholder('Select a saved report to discuss…');
        this.reports = this.gatherReports(plugin);
        this.isEmpty = this.reports.length === 0;
    }

    private gatherReports(plugin: EventideQuillPlugin): ReportEntry[] {
        const folder = normalizePath(plugin.settings.feedbackReportFolder || 'eventide-quill-reports');
        const prefix = folder.endsWith('/') ? folder : `${folder}/`;
        const out: ReportEntry[] = [];
        for (const file of plugin.app.vault.getMarkdownFiles()) {
            // Reports live under the configured folder. Match the folder itself
            // or any path beneath it.
            if (file.path !== folder && !file.path.startsWith(prefix)) continue;
            const fm = plugin.app.metadataCache.getFileCache(file)?.frontmatter;
            const typeRaw: unknown = fm?.['quill-report-type'];
            if (!typeRaw) continue;
            const typeStr = typeof typeRaw === 'string' ? typeRaw : 'report';
            out.push({ file, label: typeStr, name: file.name });
        }
        // Newest-first: the dated filenames sort lexicographically by timestamp.
        return out.sort((a, b) => (a.name < b.name ? 1 : -1));
    }

    getSuggestions(query: string): ReportEntry[] {
        const q = query.toLowerCase();
        if (!q) return this.reports;
        return this.reports.filter((r) => r.label.toLowerCase().includes(q) || r.name.toLowerCase().includes(q));
    }

    renderSuggestion(entry: ReportEntry, el: HTMLElement): void {
        el.createEl('div', { text: entry.label });
        el.createEl('div', { cls: 'quill-context-panel__item-matched', text: entry.name });
    }

    onChooseSuggestion(entry: ReportEntry): void {
        this.onChoose(entry.file);
    }
}
