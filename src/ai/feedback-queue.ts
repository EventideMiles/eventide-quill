/**
 * Async feedback queue — job model, persistence, and runner.
 *
 * The queue lets a writer submit a chapter (or selection/scene/manuscript) for
 * feedback and return later to find a completed report. The hard part — the
 * feedback engine (personas, message builder, async generator) — already lives
 * in `feedback.ts`. This module is a lifecycle + persistence layer around it:
 *
 *  - {@link FeedbackJob} model + {@link SerializedContext} snapshot.
 *  - Per-job JSON sidecars under `<pluginDataDir>/feedback-queue/` plus a
 *    lightweight `index.json`, mirroring `conversation-store.ts` exactly
 *    (`vault.adapter`, `normalizePath`, mkdir-on-first-write, a serialized
 *    index write-lock, schemaVersion, LRU prune, Notice-on-error).
 *  - {@link runFeedbackJob} — a single-job runner that accumulates the
 *    `getFeedback` stream into a report string, archives it to the vault via
 *    {@link saveReportArchive}, and stamps `reportNotePath` on the job.
 *
 * Report content is content-canonical-in-vault: the sidecar holds status + the
 * snapshot + a `reportNotePath` pointer — never the report markdown. The
 * transient {@link FeedbackJob.reportMarkdown} is in-memory only (session cache
 * for the UI when autosave is off) and stripped at persist time.
 */
import { Notice, normalizePath, type Vault } from 'obsidian';
import { type AiProvider, type ChatChunk, type ChatMessage } from './provider';
import { buildFeedbackMessages, getFeedback, getPersonaById, type FeedbackPersona } from './feedback';
import {
    type AnalysisMode,
    type AnalysisScope,
    buildAnalysisMessages,
    getAnalysis,
    getAnalysisModeById
} from './analysis';
import { createReadOnlyToolRegistry } from './tools';
import type { ToolContext } from './tools/tool';
import type { ExtractedEntity, VoiceMarker } from '../core/context-engine/types';
import { saveReportArchive, type ReportArchiveInput } from './feedback-archive';
import type { NarrativeVoicePreset } from '../types';
import type EventideQuillPlugin from '../main';

const SCHEMA_VERSION = 1;
const JOB_ID_RE = /^fq_[a-z0-9_-]+$/;
const QUEUE_FOLDER = 'feedback-queue';
const INDEX_FILENAME = 'index.json';

export type FeedbackJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type FeedbackJobScope = 'selection' | 'scene' | 'document' | 'manuscript';
/** Which Review engine produced (or will run) this job. Drives runner dispatch + archive kind. */
export type FeedbackEngine = 'editorial' | 'critical' | 'manuscript';

/**
 * Resolved context at submit time — the report reflects what was true when the
 * writer submitted, not when the runner picks it up. A job is deterministic
 * given its snapshot: re-running a cancelled job re-reads the snapshot, never
 * the live file (which may have drifted).
 *
 * Engine-specific: the discriminator `kind` lets the runner narrow without
 * correlating against {@link FeedbackJob.engine}.
 */
export type SerializedContext = EditorialSnapshot | CriticalSnapshot;

/** Editorial feedback snapshot — manuscript + lore content messages to inject. */
export interface EditorialSnapshot {
    kind: 'editorial';
    /** Content injected between system prompt and user instruction (manuscript + lore reference). */
    contentMessages: ChatMessage[];
    /** Vault-context excerpt used in the system-prompt build. */
    vaultContext: string;
    /** Narrative voice preset captured at submit time. */
    narrativePreset: NarrativeVoicePreset;
}

/** Critical-analysis snapshot — resolved scope text + deterministic signal + lore refs. */
export interface CriticalSnapshot {
    kind: 'critical';
    mode: AnalysisMode;
    /** Scoped text to analyze (selection / scene / document), captured at submit. */
    text: string;
    scope: AnalysisScope;
    /** Absolute 1-based line range of `text` in the source file. */
    lineStart?: number;
    lineEnd?: number;
    fileName?: string;
    /** Deterministic signal from the context engine (snapshot, not re-resolved). */
    characters: ExtractedEntity[];
    plotThreads: string[];
    voiceMarker?: VoiceMarker;
    vaultContext: string;
    /** Lore reference messages resolved at submit, injected at run. */
    loreMessages: ChatMessage[];
}

export interface FeedbackJob {
    id: string;
    title: string;
    /** Which Review engine this job runs. */
    engine: FeedbackEngine;
    /** One of FEEDBACK_PERSONAS (or 'custom'). Editorial only. */
    personaId?: string;
    /** Analysis mode id (critical engine; manuscript mode in 3c). */
    mode?: string;
    manuscriptPath: string;
    scope: FeedbackJobScope;
    /** When scope = 'selection'. */
    selectionRange?: { from: number; to: number };
    /** Writer's optional focus/custom instruction. */
    focusPrompt?: string;
    contextSnapshot: SerializedContext;
    status: FeedbackJobStatus;
    createdAt: number;
    startedAt?: number;
    completedAt?: number;
    /** Vault path of the auto-saved report note — canonical home of the report content. */
    reportNotePath?: string;
    /** Failure message (status = 'failed'). */
    error?: string;
    /** Transient in-memory report cache; stripped at persist time (content-canonical-in-vault). */
    reportMarkdown?: string;
}

/** One row in the queue index (the lightweight metadata; the blob holds the rest). */
export interface JobIndexEntry {
    id: string;
    title: string;
    engine: FeedbackEngine;
    personaId?: string;
    mode?: string;
    manuscriptPath: string;
    scope: FeedbackJobScope;
    status: FeedbackJobStatus;
    createdAt: number;
    completedAt?: number;
    reportNotePath?: string;
    sizeBytes: number;
}

interface JobIndexFile {
    schemaVersion: number;
    entries: JobIndexEntry[];
}

interface FeedbackJobBlob {
    schemaVersion: number;
    job: Omit<FeedbackJob, 'reportMarkdown'>;
}

/** Resolve the queue directory under a plugin data dir. */
export function resolveQueueDir(dataDir: string): string {
    return normalizePath(`${dataDir}/${QUEUE_FOLDER}`);
}

class InvalidJobIdError extends Error {
    constructor(id: string, detail?: string) {
        super(detail ? `Invalid feedback job id: ${id} (${detail})` : `Invalid feedback job id: ${id}`);
        this.name = 'InvalidJobIdError';
    }
}

function jobFilePath(dir: string, id: string): string {
    if (!JOB_ID_RE.test(id)) {
        throw new InvalidJobIdError(id, 'path construction');
    }
    return normalizePath(`${dir}/${id}.json`);
}

/** Mint a fresh job id: `fq_<base36-timestamp>_<rand>`. */
export function mintJobId(): string {
    return `fq_${Date.now().toString(36)}_${((Math.random() * 46656) | 0).toString(36)}`;
}

async function ensureDir(vault: Vault, dir: string): Promise<void> {
    if (!(await vault.adapter.exists(dir))) await vault.adapter.mkdir(dir);
}

async function readJson<T>(vault: Vault, path: string): Promise<T | null> {
    if (!(await vault.adapter.exists(path))) return null;
    try {
        const raw = await vault.adapter.read(path);
        return JSON.parse(raw) as T;
    } catch (err) {
        // Corrupt sidecar — don't bring down the feature; report and treat as absent.
        console.warn(`Quill: failed to read ${path}`, err);
        return null;
    }
}

// Per-process write lock on the index so concurrent saves don't clobber each
// other's index update.
let indexWriteChain: Promise<void> = Promise.resolve();
function withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = indexWriteChain.then(fn, fn);
    indexWriteChain = next.then(
        () => undefined,
        () => undefined
    );
    return next;
}

function entryFromJob(job: FeedbackJob, sizeBytes: number): JobIndexEntry {
    return {
        id: job.id,
        title: job.title,
        engine: job.engine,
        personaId: job.personaId,
        mode: job.mode,
        manuscriptPath: job.manuscriptPath,
        scope: job.scope,
        status: job.status,
        createdAt: job.createdAt,
        completedAt: job.completedAt,
        reportNotePath: job.reportNotePath,
        sizeBytes
    };
}

/** List queue jobs (index rows), newest-first by createdAt. */
export async function listFeedbackJobs(vault: Vault, dir: string): Promise<JobIndexEntry[]> {
    const index = await readJson<JobIndexFile>(vault, normalizePath(`${dir}/${INDEX_FILENAME}`));
    const entries = index?.entries ?? [];
    return [...entries].sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Persist a job's sidecar blob and refresh its index row. Active jobs
 * (queued/running) are always retained; LRU eviction targets only completed
 * jobs beyond {@link EventideQuillSettings.feedbackQueueLimit}.
 */
export async function saveFeedbackJob(
    vault: Vault,
    dir: string,
    job: FeedbackJob,
    limit?: number
): Promise<JobIndexEntry> {
    await ensureDir(vault, dir);
    if (!JOB_ID_RE.test(job.id)) {
        throw new InvalidJobIdError(job.id, 'save');
    }

    // Strip the transient report markdown — content-canonical-in-vault.
    const { reportMarkdown: _omit, ...persistable } = job;
    void _omit;
    const blob: FeedbackJobBlob = { schemaVersion: SCHEMA_VERSION, job: persistable };
    const json = JSON.stringify(blob);
    const jobPath = jobFilePath(dir, job.id);
    const indexPath = normalizePath(`${dir}/${INDEX_FILENAME}`);
    const entry = entryFromJob(job, json.length);

    try {
        await vault.adapter.write(jobPath, json);
        await withIndexLock(async () => {
            const cur = (await readJson<JobIndexFile>(vault, indexPath)) ?? {
                schemaVersion: SCHEMA_VERSION,
                entries: []
            };
            const entries = cur.entries.filter((e) => e.id !== job.id);
            entries.push(entry);

            // LRU prune: never evict active jobs; bound completed jobs to the limit.
            const cap = limit && limit > 0 ? limit : entries.length;
            const active = entries.filter((e) => e.status === 'queued' || e.status === 'running');
            const completed = entries
                .filter((e) => e.status !== 'queued' && e.status !== 'running')
                .sort((a, b) => (b.completedAt ?? b.createdAt) - (a.completedAt ?? a.createdAt));
            const keepCompleted = completed.slice(0, Math.max(0, cap - active.length));
            const evict = completed.slice(Math.max(0, cap - active.length));
            for (const e of evict) {
                try {
                    const p = jobFilePath(dir, e.id);
                    if (await vault.adapter.exists(p)) await vault.adapter.remove(p);
                } catch (err) {
                    console.warn(`Quill: skipping eviction for job ${e.id}`, err);
                }
            }
            const out: JobIndexFile = {
                schemaVersion: SCHEMA_VERSION,
                entries: [...active, ...keepCompleted]
            };
            await vault.adapter.write(indexPath, JSON.stringify(out, null, 2));
        });
    } catch (err) {
        console.warn(`Quill: failed to save feedback job ${job.id}`, err);
        new Notice('Could not save the feedback job.');
        throw err;
    }
    return entry;
}

/** Load one job's full blob by id (null if missing or unparsable). */
export async function loadFeedbackJob(vault: Vault, dir: string, id: string): Promise<FeedbackJob | null> {
    let path: string;
    try {
        path = jobFilePath(dir, id);
    } catch {
        console.warn(`Quill: rejecting malformed feedback job id in load: ${id}`);
        return null;
    }
    const blob = await readJson<FeedbackJobBlob>(vault, path);
    if (!blob?.job) return null;
    // On load, a job saved as 'running' resumes as 'queued' (the run restarts),
    // mirroring the subagent running→interrupted restore pattern.
    if (blob.job.status === 'running') blob.job.status = 'queued';
    return blob.job;
}

/** Delete one job (sidecar + index row). No-op if absent. */
export async function deleteFeedbackJob(vault: Vault, dir: string, id: string): Promise<void> {
    let path: string;
    try {
        path = jobFilePath(dir, id);
    } catch {
        console.warn(`Quill: rejecting malformed feedback job id in delete: ${id}`);
        return;
    }
    await withIndexLock(async () => {
        if (await vault.adapter.exists(path)) {
            await vault.adapter.remove(path);
        }
        const indexPath = normalizePath(`${dir}/${INDEX_FILENAME}`);
        const cur = await readJson<JobIndexFile>(vault, indexPath);
        if (!cur) return;
        const out: JobIndexFile = {
            schemaVersion: SCHEMA_VERSION,
            entries: cur.entries.filter((e) => e.id !== id)
        };
        await vault.adapter.write(indexPath, JSON.stringify(out, null, 2));
    });
}

/** Mark a job failed (helper used by the runner). */
function markFailed(job: FeedbackJob, error: string): FeedbackJob {
    job.status = 'failed';
    job.error = error;
    job.completedAt = Date.now();
    return job;
}

/**
 * Run a single feedback job to completion, archiving the report to the vault.
 * Mutates and returns `job` with its TERMINAL status set (`succeeded` /
 * `failed` / `cancelled`) plus `reportNotePath` / `error` / `completedAt`.
 *
 * Dispatches by snapshot kind: editorial wraps {@link getFeedback}; critical
 * wraps {@link getAnalysis} (with a read-only tool registry, routed through
 * streamWithTools so the model can verify findings against the vault). The
 * caller (the scheduler/orchestrator) owns the `queued → running` transition —
 * including `startedAt` and persisting it — so this function only assigns the
 * terminal status.
 */
export async function runFeedbackJob(
    plugin: EventideQuillPlugin,
    job: FeedbackJob,
    signal: AbortSignal
): Promise<FeedbackJob> {
    const chat = plugin.getDefaultChatProvider();
    if (!chat.provider) {
        return markFailed(job, 'No AI provider configured. Set one up in settings.');
    }

    let fullResponse: string;
    try {
        const snapshot = job.contextSnapshot;
        if (snapshot.kind === 'editorial') {
            const persona: FeedbackPersona | undefined =
                job.personaId === 'custom' ? undefined : getPersonaById(job.personaId ?? '');
            if (job.personaId !== 'custom' && !persona) {
                return markFailed(job, `Unknown persona: ${job.personaId ?? ''}`);
            }
            fullResponse = await streamEditorial(plugin, job, snapshot, chat.provider, chat.modelId, signal);
        } else {
            fullResponse = await streamCritical(plugin, job, snapshot, chat.provider, chat.modelId, signal);
        }
    } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
            job.status = 'cancelled';
        } else {
            job.status = 'failed';
            job.error = err instanceof Error ? err.message : String(err);
        }
        job.completedAt = Date.now();
        return job;
    }

    if (signal.aborted) {
        job.status = 'cancelled';
        job.completedAt = Date.now();
        return job;
    }

    // Archive the report to the vault (the single canonical home of the content).
    // When autosave is off, this returns null and the report stays in-memory only.
    const reportNotePath = await saveReportArchive(plugin, archiveInputFor(job, fullResponse));
    job.reportNotePath = reportNotePath ?? undefined;
    job.reportMarkdown = fullResponse;
    job.status = 'succeeded';
    job.completedAt = Date.now();
    return job;
}

/** Accumulate a ChatChunk stream into a string, honoring the abort signal. */
async function accumulate(stream: AsyncGenerator<ChatChunk>, signal: AbortSignal): Promise<string> {
    let full = '';
    for await (const chunk of stream) {
        if (signal.aborted) break;
        if (chunk.done) continue;
        full += chunk.text ?? '';
    }
    return full;
}

/** Rebuild the editorial payload from the snapshot and stream it to completion. */
async function streamEditorial(
    plugin: EventideQuillPlugin,
    job: FeedbackJob,
    snapshot: EditorialSnapshot,
    provider: NonNullable<AiProvider>,
    modelId: string | undefined,
    signal: AbortSignal
): Promise<string> {
    const persona = job.personaId === 'custom' ? undefined : getPersonaById(job.personaId ?? '');
    const baseMessages = buildFeedbackMessages(persona, {
        vaultContext: snapshot.vaultContext,
        narrativePreset: snapshot.narrativePreset,
        customInstruction: job.focusPrompt
    });
    // [system, ...snapshot content, user instruction], mirroring requestFeedback.
    const apiMessages: ChatMessage[] = [baseMessages[0]!, ...snapshot.contentMessages, baseMessages[1]!];
    return accumulate(
        getFeedback(provider, persona, {
            vaultContext: snapshot.vaultContext,
            narrativePreset: snapshot.narrativePreset,
            model: modelId,
            temperature: plugin.settings.analysisTemperature,
            maxTokens: plugin.settings.analysisMaxOutputTokens,
            signal,
            customInstruction: job.focusPrompt,
            existingMessages: apiMessages
        }),
        signal
    );
}

/** Rebuild the critical-analysis payload from the snapshot and stream it to completion. */
async function streamCritical(
    plugin: EventideQuillPlugin,
    job: FeedbackJob,
    snapshot: CriticalSnapshot,
    provider: NonNullable<AiProvider>,
    modelId: string | undefined,
    signal: AbortSignal
): Promise<string> {
    const registry = createReadOnlyToolRegistry(plugin, plugin.settings.lorebookNetworkTools);
    const ctx: ToolContext = { plugin, signal };
    const base = buildAnalysisMessages(snapshot.mode, {
        text: snapshot.text,
        scope: snapshot.scope,
        lineStart: snapshot.lineStart,
        lineEnd: snapshot.lineEnd,
        fileName: snapshot.fileName,
        vaultContext: snapshot.vaultContext,
        voiceMarker: snapshot.voiceMarker,
        characters: snapshot.characters,
        plotThreads: snapshot.plotThreads,
        customInstruction: job.focusPrompt,
        registry: registry ?? undefined
    });
    // Inject lore references between the system prompt and user instruction,
    // mirroring requestAnalysis.
    const initialWithLore = snapshot.loreMessages.length
        ? [base[0]!, ...snapshot.loreMessages, ...base.slice(1)]
        : base;
    return accumulate(
        getAnalysis(provider, snapshot.mode, {
            text: snapshot.text,
            scope: snapshot.scope,
            lineStart: snapshot.lineStart,
            lineEnd: snapshot.lineEnd,
            fileName: snapshot.fileName,
            vaultContext: snapshot.vaultContext,
            voiceMarker: snapshot.voiceMarker,
            characters: snapshot.characters,
            plotThreads: snapshot.plotThreads,
            model: modelId,
            signal,
            customInstruction: job.focusPrompt,
            temperature: plugin.settings.analysisTemperature,
            maxTokens: plugin.settings.analysisMaxOutputTokens,
            existingMessages: initialWithLore,
            registry: registry ?? undefined,
            ctx
        }),
        signal
    );
}

/** Build the archive input for a finished job, engine-aware. */
function archiveInputFor(job: FeedbackJob, reportMarkdown: string): ReportArchiveInput {
    const snapshot = job.contextSnapshot;
    if (snapshot.kind === 'editorial') {
        const persona = getPersonaById(job.personaId ?? '');
        return {
            reportMarkdown,
            source: 'queue',
            kind: 'editorial',
            id: job.personaId ?? 'custom',
            title: persona?.name ?? 'Custom feedback',
            scope: job.scope,
            manuscriptPath: job.manuscriptPath
        };
    }
    const modeMeta = getAnalysisModeById(snapshot.mode);
    return {
        reportMarkdown,
        source: 'queue',
        kind: 'critical',
        id: snapshot.mode,
        title: modeMeta?.label ?? snapshot.mode,
        scope: job.scope,
        manuscriptPath: job.manuscriptPath
    };
}
