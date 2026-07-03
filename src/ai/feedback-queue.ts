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
import { type ChatMessage } from './provider';
import { buildFeedbackMessages, getFeedback, getPersonaById, type FeedbackPersona } from './feedback';
import { saveReportArchive } from './feedback-archive';
import type { NarrativeVoicePreset } from '../types';
import type EventideQuillPlugin from '../main';

const SCHEMA_VERSION = 1;
const JOB_ID_RE = /^fq_[a-z0-9_-]+$/;
const QUEUE_FOLDER = 'feedback-queue';
const INDEX_FILENAME = 'index.json';

export type FeedbackJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type FeedbackJobScope = 'selection' | 'scene' | 'document' | 'manuscript';

/**
 * Resolved context at submit time — the report reflects what was true when the
 * writer submitted, not when the runner picks it up. A job is deterministic
 * given its snapshot: re-running a cancelled job re-reads the snapshot, never
 * the live file (which may have drifted).
 */
export interface SerializedContext {
    /** Content injected between system prompt and user instruction (manuscript + lore reference messages). */
    contentMessages: ChatMessage[];
    /** Vault-context excerpt used in the system-prompt build. */
    vaultContext: string;
    /** Narrative voice preset captured at submit time. */
    narrativePreset: NarrativeVoicePreset;
}

export interface FeedbackJob {
    id: string;
    title: string;
    /** One of FEEDBACK_PERSONAS (or 'custom'). */
    personaId: string;
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
    personaId: string;
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
        personaId: job.personaId,
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
 * Mutates and returns `job` with updated status + `reportNotePath`/`error`.
 * The caller persists the returned job (or the runner persists inline — both
 * are valid; here the caller owns persistence to keep the runner testable).
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

    const persona: FeedbackPersona | undefined = job.personaId === 'custom' ? undefined : getPersonaById(job.personaId);
    if (job.personaId !== 'custom' && !persona) {
        return markFailed(job, `Unknown persona: ${job.personaId}`);
    }

    const context = job.contextSnapshot;
    const baseMessages = buildFeedbackMessages(persona, {
        vaultContext: context.vaultContext,
        narrativePreset: context.narrativePreset,
        customInstruction: job.focusPrompt
    });
    // Rebuild the payload from the snapshot — do NOT re-read the live file.
    // [system, ...snapshot content, user instruction], mirroring requestFeedback.
    const apiMessages: ChatMessage[] = [baseMessages[0]!, ...context.contentMessages, baseMessages[1]!];

    job.status = 'running';
    job.startedAt = Date.now();
    job.error = undefined;

    try {
        const stream = getFeedback(chat.provider, persona, {
            vaultContext: context.vaultContext,
            narrativePreset: context.narrativePreset,
            model: chat.modelId,
            temperature: plugin.settings.analysisTemperature,
            maxTokens: plugin.settings.analysisMaxOutputTokens,
            signal,
            customInstruction: job.focusPrompt,
            existingMessages: apiMessages
        });

        let fullResponse = '';
        for await (const chunk of stream) {
            if (signal.aborted) break;
            if (chunk.done) continue;
            fullResponse += chunk.text ?? '';
        }

        if (signal.aborted) {
            job.status = 'cancelled';
            job.completedAt = Date.now();
            return job;
        }

        // Archive the report to the vault (the single canonical home of the content).
        // When autosave is off, this returns null and the report stays in-memory only.
        const reportNotePath = await saveReportArchive(plugin, {
            reportMarkdown: fullResponse,
            source: 'queue',
            kind: 'editorial',
            id: job.personaId,
            title: persona?.name ?? 'Custom feedback',
            scope: job.scope,
            manuscriptPath: job.manuscriptPath
        });
        job.reportNotePath = reportNotePath ?? undefined;
        job.reportMarkdown = fullResponse;
        job.status = 'succeeded';
        job.completedAt = Date.now();
        return job;
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
}
