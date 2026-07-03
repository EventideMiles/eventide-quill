/**
 * Shared feedback-report archive helper.
 *
 * Every completed feedback report — whether produced asynchronously by the
 * feedback queue or interactively by the Review tab — is auto-saved to the
 * vault as durable, dated markdown. The vault note is the single canonical
 * home of the report content; the queue sidecar holds only status + the
 * snapshot + a `reportNotePath` pointer (never a duplicate of the report text).
 *
 * Sovereignty principle: when {@link EventideQuillSettings.autoSaveFeedbackReports}
 * is off, NO report is written anywhere — and that is deliberate, not a gap.
 * Declining vault writes must not silently redirect the report into hidden
 * plugin data. The report is held in-memory for the session only.
 */
import { Notice, normalizePath } from 'obsidian';
import type EventideQuillPlugin from '../main';

/** Where the report came from — drives the `quill-report-source` frontmatter key. */
export type ReportSource = 'queue' | 'review';

/** Report engine — drives the `quill-persona` vs `quill-mode` frontmatter key. */
export type ReportKind = 'editorial' | 'critical' | 'manuscript';

export interface ReportArchiveInput {
    /** The full report markdown (model output), rendered as-is under the header. */
    reportMarkdown: string;
    /** Whether this report came from the async queue or an interactive Review run. */
    source: ReportSource;
    /** Engine kind: 'editorial' writes `quill-persona`; 'critical'/'manuscript' write `quill-mode`. */
    kind: ReportKind;
    /** Persona id (editorial) or analysis mode id (critical/manuscript) — also the filename label. */
    id: string;
    /** Human-readable title for the report heading (e.g. "Beta reader", "Plot logic"). */
    title: string;
    /** Scope label as configured at submit/run time (e.g. "document", "full manuscript"). */
    scope: string;
    /** Vault path of the primary manuscript the report was generated from. */
    manuscriptPath: string;
}

/** Build a filesystem-safe, sortable, local-time filename: `YYYY-MM-DD_HH-MM-SS_<id>.md`. */
function buildArchiveFilename(id: string, ms: number): string {
    const d = new Date(ms);
    const pad = (n: number): string => String(n).padStart(2, '0');
    // Local getters (not toISOString, which is UTC) so the dated filename reflects
    // the writer's calendar day — same rationale as formatLocalDate in fandom-cache.
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(
        d.getHours()
    )}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
    const safeId =
        id
            .replace(/[^a-z0-9-]/gi, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '') || 'report';
    return `${stamp}_${safeId}.md`;
}

/** Double-quote a YAML scalar value, escaping inner quotes and backslashes. */
function yamlQuote(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Persist a completed feedback report to the vault archive. Returns the created
 * note's vault path, or `null` if the write was skipped (autosave off) or failed
 * (folder unwritable). Never throws — a failed archive write must not fail the
 * job; the report remains available in-memory for the session.
 */
export async function saveReportArchive(
    plugin: EventideQuillPlugin,
    input: ReportArchiveInput
): Promise<string | null> {
    if (!plugin.settings.autoSaveFeedbackReports) return null;

    const folder = normalizePath(plugin.settings.feedbackReportFolder || 'eventide-quill-reports');
    const vault = plugin.app.vault;

    try {
        if (!(await vault.adapter.exists(folder))) {
            await vault.adapter.mkdir(folder);
        }
    } catch (err) {
        console.warn(`Quill: could not create feedback report folder "${folder}"`, err);
        new Notice('Quill: could not save the feedback report — folder unavailable.');
        return null;
    }

    const now = Date.now();
    const filename = buildArchiveFilename(input.id, now);
    const createdAtIso = new Date(now).toISOString();

    // Resolve a non-colliding path. Same-second completions with the same label
    // (e.g. a batch resolving together) get a `-1`, `-2` suffix.
    let candidate = normalizePath(`${folder}/${filename}`);
    const dotIdx = candidate.lastIndexOf('.');
    const stem = dotIdx > 0 ? candidate.slice(0, dotIdx) : candidate;
    const ext = dotIdx > 0 ? candidate.slice(dotIdx) : '.md';
    let suffix = 1;
    while (vault.getAbstractFileByPath(candidate)) {
        candidate = normalizePath(`${stem}-${suffix}${ext}`);
        suffix++;
    }

    const personaLine =
        input.kind === 'editorial' ? `quill-persona: ${yamlQuote(input.id)}` : `quill-mode: ${yamlQuote(input.id)}`;

    const frontmatter = [
        '---',
        `quill-engine: ${yamlQuote(input.kind)}`,
        `quill-report-type: ${yamlQuote(input.id)}`,
        `quill-report-source: ${yamlQuote(input.source)}`,
        personaLine,
        `quill-scope: ${yamlQuote(input.scope)}`,
        `quill-manuscript-path: ${yamlQuote(input.manuscriptPath)}`,
        `quill-createdAt: ${yamlQuote(createdAtIso)}`,
        '---',
        ''
    ].join('\n');

    const header = `# ${input.title} — ${input.scope}\n\n> Generated ${createdAtIso} from \`${input.manuscriptPath}\`\n\n`;
    const body = `${frontmatter}${header}${input.reportMarkdown.trim()}\n`;

    try {
        await vault.create(candidate, body);
        return candidate;
    } catch (err) {
        console.warn(`Quill: failed to write feedback report to "${candidate}"`, err);
        new Notice('Quill: could not save the feedback report to the vault.');
        return null;
    }
}
