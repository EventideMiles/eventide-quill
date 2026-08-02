import {
    App,
    ExtraButtonComponent,
    Modal,
    Notice,
    PluginSettingTab,
    Setting,
    SettingDefinitionItem,
    SettingDefinitionPage,
    SettingPage,
    SuggestModal
} from 'obsidian';
import EventideQuillPlugin from './main';
import { ModelCapability, ModelInfo, ModelRole, ProviderConfig, ProviderType, roleSatisfies } from './ai/provider';
import { createProvider, generateModelId, generateProviderId } from './ai/provider-registry';
import { DEFAULT_IMAGE_PROXY_PROMPT } from './ai/vision';
import { NarrativeVoicePreset, NARRATIVE_VOICE_PRESETS } from './types';
import { ConfirmModal } from './ui/confirm-modal';
import type { ReadabilityFormula } from './core/dashboard/types';
import type { LoreEntryType } from './core/dashboard/lorebook-types';
import { LORE_ENTRY_TYPES, LORE_TYPE_LABELS } from './core/dashboard/lorebook-types';
import type { WikiLinkBehavior } from './ai/prompts';
import type { WikiStats } from './ai/tools/fandom-cache';
import { formatLocalDate } from './ai/tools/fandom-cache';
import { isValidWikipediaLang } from './ai/tools/wikipedia-lookup';

export type LinterMode = 'all' | 'prose' | 'ai';
/** Which sidebar tab opens by default. Mirrors the dropdown options in the General settings. */
export type DefaultTab = 'linter' | 'context' | 'review' | 'cowriter' | 'dashboard' | 'lorebook';

/**
 * A user-defined slash command for the co-writer chat input. Typing `/`
 * at the start of a line opens a picker listing matching commands;
 * choosing one inserts `body` into the textarea, fully editable before
 * sending. The `name` is stored WITHOUT the leading slash and is the
 * match key (kebab-case-only — see {@link SLASH_COMMAND_NAME_PATTERN}).
 */
export interface SlashCommand {
    /** Match key shown in the picker, without the leading `/`. Lowercased, trimmed, unique, kebab-case. */
    name: string;
    /** One-line description shown under the name in the picker. Empty string = none. */
    description: string;
    /** Body text inserted into the textarea when chosen. The writer can edit it before sending. */
    body: string;
}

/**
 * Validation rule for {@link SlashCommand.name}: lowercase letters,
 * digits, and hyphens only, must start with a letter, length 1-40.
 * Mirrored in the slash-command suggest picker's trigger regex.
 */
export const SLASH_COMMAND_NAME_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;

export interface EventideQuillSettings {
    linterMode: LinterMode;
    enableLongSentences: boolean;
    maxSentenceWords: number;
    enablePassiveVoice: boolean;
    enableAdverbCheck: boolean;
    enableQualifierCheck: boolean;
    enableRepeatedWords: boolean;
    minRepeatedWordLength: number;
    enableEchoes: boolean;
    enableTellingVsShowing: boolean;
    enableDialogueTags: boolean;
    enableComplexWords: boolean;
    maxSyllablesPerWord: number;
    enableAiCliches: boolean;
    enableAiEmDashes: boolean;
    enableAiNegation: boolean;
    enableAiFillerAdverbs: boolean;
    enableAiHedging: boolean;
    enableAiWrapUps: boolean;
    enableGremlins: boolean;
    enableAggressiveGremlins: boolean;
    enableCrutchWords: boolean;
    crutchWords: string[];
    crutchWordThreshold: number;
    lintOnSave: boolean;
    aiProviders: ProviderConfig[];
    aiDefaultChatProvider: string;
    aiDefaultEmbedProvider: string;
    /** Composite "providerId/modelId" for the default image (vision) model. Empty = none. */
    aiDefaultImageProvider: string;
    /**
     * One-time acknowledgment that the writer has read the Anthropic content-
     * policy warning. Set true when the writer confirms the modal that appears
     * the first time they select the Anthropic provider type in AddProviderModal
     * or in the type dropdown. Permanent — once acknowledged, the modal does
     * not reappear in this vault.
     */
    anthropicBanRiskAcknowledged: boolean;
    /** One-time acknowledgment of the copy-editor (grammar) persona's caveat. */
    copyEditorAck: boolean;
    transformTemperature: number;
    transformVaultContext: boolean;
    transformMaxOutputTokens: number;
    wikiLinkBehavior: WikiLinkBehavior;
    narrativeVoicePreset: NarrativeVoicePreset;
    customNarrativeVoiceRules: string;
    analysisTemperature: number;
    analysisMaxOutputTokens: number;
    enableCriticalAnalysis: boolean;
    enableManuscriptAnalysis: boolean;
    manuscriptAnalysisTemperature: number;
    manuscriptAnalysisMaxOutputTokens: number;
    manuscriptAnalysisChunkTokenSize: number;
    embeddingsTopKChunks: number;
    embeddingChunkTokenSize: number;
    enableEmbeddingWarming: boolean;
    enableFullEmbedPickerOption: boolean;
    folderTopKOverrides: Record<string, number>;
    enableDebugLogging: boolean;
    embeddingWarmingDebounceSeconds: number;
    linterTemperature: number;
    linterMaxOutputTokens: number;
    enableLinterAiFixes: boolean;
    contextTokenBudget: number;
    contextCompactAtPercent: number;
    compactSummarySentences: number;
    /**
     * Context refinement — the deterministic, surgical complement to AI
     * compaction. When on (default), accepted/discarded lore drafts and stale
     * vault reads are compressed in the model's API history to compact outcome
     * markers (keeping `quillAnchorId` so rewind still works), and a free
     * refinement pass runs before the AI compaction fallback when a
     * conversation approaches the threshold. Off = pure AI compaction only
     * (the pre-2.0.1 behavior). See `src/ai/context-refinement.ts`.
     */
    contextRefinementEnabled: boolean;
    contextIncludeVaultContext: boolean;
    contextMaxVaultFiles: number;
    contextMaxCharsPerFile: number;
    contextAutoScan: boolean;
    coWriterTemperature: number;
    coWriterMaxOutputTokens: number;
    /** Max tool-calling rounds per response. 0 = unlimited. Default: 0. */
    coWriterMaxToolRounds: number;
    /**
     * How many saved co-writer conversations to retain on disk. Older sessions
     * are LRU-evicted (by last-saved time) when the limit is exceeded. Default 25.
     */
    coWriterSessionHistoryLimit: number;
    /**
     * When true, auto-snapshot the active co-writer conversation to its sidecar
     * after each completed turn (discuss / coach / lorebook). Off by default —
     * the snapshot deep-clones the full state (both API arrays, recent images,
     * change queues) on the main thread, so it's opt-in for writers who want
     * crash/restart resilience between explicit saves. Trailing-debounced so a
     * turn followed immediately by auto-options collapses to one write.
     */
    coWriterAutoSavePerTurn: boolean;
    coWriterVaultContext: boolean;
    coWriterAppendNewline: boolean;
    enableCoWriterThought: boolean;
    coWriterVoiceMatch: boolean;
    enableInlineDirectives: boolean;
    enableDashboard: boolean;
    defaultTab: DefaultTab;
    dashboardAutoRefreshMinutes: number;
    dashboardAutoSnapshotOnSave: boolean;
    dashboardMaxSnapshots: number;
    readabilityFormula: ReadabilityFormula;
    /** Daily writing word goal (0 disables goals/streak). Default 500. */
    writingDailyGoal: number;
    /**
     * User-defined slash commands for the co-writer chat input. Typing
     * `/` at the start of a line opens a picker of matching commands;
     * choosing one inserts the body into the textarea, editable before
     * sending. Empty (the default) disables the picker entirely —
     * typing `/` at start-of-line does nothing. No enable toggle; the
     * empty-list-is-off rule keeps the description single-sourced
     * (no triple-copy sync per the tool-gating conventions).
     */
    slashCommands: SlashCommand[];
    lorebookFolders: string[];
    /** Per-folder entry-type default. Absent key = "mixed" (use per-file quill-type). */
    lorebookFolderTypes: Record<string, LoreEntryType>;
    coWriterLoreContext: boolean;
    reviewLoreContext: boolean;
    /** Whether the co-writer may use AI tool-calling. Default: on. */
    coWriterToolsEnabled: boolean;
    /** Master gate for network tools (fetch_url, fandom_lookup, wikipedia_lookup). Default: on. */
    lorebookNetworkTools: boolean;
    /** Fandom wiki subdomains the model may query (e.g., ['starwars', 'memory-alpha']). */
    lorebookFandomWikis: string[];
    /** Danger setting: when on, the model may query ANY Fandom wiki, ignoring the allowlist. Default: off. */
    lorebookFandomAllowAllWikis: boolean;
    /**
     * Local Fandom cache gate. When on, fandom_page/fandom_image write through to a
     * sidecar on every live fetch, and (from Stage 3) the cache answers even when
     * `lorebookNetworkTools` is off — consent is at sync time, silent after.
     * Default: on (strictly improves drafting privacy). See `.planning/pr-local-fandom-cache.md`.
     */
    lorebookFandomCacheEnabled: boolean;
    /** Wikipedia language subdomain (e.g., 'en', 'fr', 'de'). */
    lorebookWikipediaLang: string;
    /** Per-tool result truncation cap (approximate tokens). */
    lorebookToolMaxTokens: number;
    /** Gate for image-fetching tools (fetch_image_url, fandom_image, wikipedia_image). Default: on. */
    lorebookImageTools: boolean;
    /** Max image dimension (longest side, px) before downscale. Keeps vision payloads small. */
    lorebookImageMaxDimension: number;
    /**
     * Max output tokens for the Regime B image-description proxy call. Higher
     * values let the model describe multi-character images in detail; lower
     * values are faster on local hardware. The model stops early when done.
     */
    lorebookImageMaxDescriptionTokens: number;
    /**
     * Proxy prompt for Regime B (text-only chat model + dedicated image model):
     * how the image model should caption images it translates to text for the
     * chat model. Customizable per-writer focus.
     */
    lorebookImageProxyPrompt: string;
    /**
     * Two-pass image description for Regime B: when on AND more than one image
     * is attached, the image model first counts + labels each visible
     * character across the batch, then describes each with that list as
     * grounding. Helps weak vision models keep per-character descriptions
     * coherent across a group. Off by default — it costs an extra model call
     * per batch, which writers with a strong vision model don't need.
     */
    lorebookImageTwoPassDescription: boolean;
    /**
     * Heading texts (case-insensitive, trimmed) that mark a lore entry's
     * image-gallery section. The lorebook scanner parses image embeds within
     * any section under one of these headings. Empty disables image
     * extraction entirely. Defaults cover the common conventions.
     */
    loreEntryImageSectionHeaders: string[];
    /**
     * Soft cap on the number of images extracted per lore entry. Overflow is
     * silently dropped at scan time — the cap is a token/latency budget tool,
     * not a content rule. The writer can still place more embeds in the
     * note body; only the scanner's `images` array is bounded.
     */
    loreEntryImageMaxPerEntry: number;
    /**
     * Agent image-attachment gate. When on, the lorebook coach can include an
     * `images` parameter when calling `propose_entry`, and the
     * `attach_lore_image` tool is registered for batch edits. Both flow
     * through the existing review queue — nothing is written without the
     * writer's approval. When off, the parameter is removed from the tool's
     * schema (so the model cannot attempt it) and the tool is not registered,
     * but the writer's manual image attachment via `![[file]]` embeds keeps
     * working unchanged. Default: on.
     */
    loreEntryImageAttachments: boolean;
    /**
     * Folder where agent-attached images are written on approval. Empty (the
     * default) defers to Obsidian's configured attachment folder
     * (`app.vault.getConfig('attachmentFolderPath')`). Vault-relative path;
     * `normalizePath()`-wrapped before any vault write.
     */
    loreEntryImageAttachmentFolder: string;
    /**
     * When on (default), `propose_entry` refuses to draft a new entry whose
     * exact name already matches an existing note anywhere in the vault, and
     * returns a length-aware message routing the model to `edit_note` /
     * `insert_note` / `append_to_note` instead. Prevents duplicate notes that
     * strand [[wikilinks]] pointing at the original. Off = unconditional
     * create (the pre-2.0.1 behavior) — escape hatch.
     */
    lorePreferEditOverCreate: boolean;
    /**
     * When on, follow-up discussion of a review report runs through the
     * co-writer session machinery with editing tools enabled, so the editor
     * can propose specific, reviewable inline-diff edits (not just advisory
     * prose). Off preserves the pre-2.0.1 text-only chat behavior. Default:
     * on.
     */
    reviewSuggestedEditsEnabled: boolean;
    /**
     * Free-form world-building rules injected into the review-discuss context
     * so the model follows them when writing or editing prose. Examples:
     * "This world uses magic based on sound. Swords are called 'blades'
     * regardless of shape." Default: empty.
     */
    reviewWorldRules: string;
    /** Master toggle for the async feedback queue. Off hides the Queue tab and the Review handoff. Default: on. */
    enableFeedbackQueue: boolean;
    /** Max queue jobs retained on disk (sidecar blobs). Older completed jobs are LRU-evicted; the vault report note is never touched by LRU. Default 20. */
    feedbackQueueLimit: number;
    /** When on, the scheduler ticks while Obsidian is open and runs queued jobs. Off = jobs queue but only run on explicit "Run now". Default: on. */
    feedbackQueueAutoRun: boolean;
    /**
     * Auto-save every completed feedback report (async queue + interactive
     * Review) to the vault as dated markdown under `feedbackReportFolder`. The
     * vault note is the single canonical home of the report content — the
     * sidecar holds only status + the snapshot + a `reportNotePath` pointer.
     * Off = no vault writes AND no other persistence: the report is held
     * in-memory for the session only, and the job record persists so it can be
     * re-run to regenerate the report (no silent sidecar fallback, by design).
     * Default: on.
     */
    autoSaveFeedbackReports: boolean;
    /** Vault folder for auto-saved feedback reports. Created on first write. `normalizePath()`-wrapped on every constructed path. Default `eventide-quill-reports`. */
    feedbackReportFolder: string;
}

export const DEFAULT_SETTINGS: EventideQuillSettings = {
    linterMode: 'all',
    enableLongSentences: true,
    maxSentenceWords: 40,
    enablePassiveVoice: false,
    enableAdverbCheck: true,
    enableQualifierCheck: true,
    enableRepeatedWords: true,
    minRepeatedWordLength: 4,
    enableEchoes: true,
    enableTellingVsShowing: true,
    enableDialogueTags: true,
    enableComplexWords: true,
    maxSyllablesPerWord: 5,
    enableAiCliches: true,
    enableAiEmDashes: true,
    enableAiNegation: true,
    enableAiFillerAdverbs: true,
    enableAiHedging: true,
    enableAiWrapUps: true,
    enableGremlins: true,
    enableAggressiveGremlins: false,
    enableCrutchWords: true,
    crutchWords: [],
    crutchWordThreshold: 5,
    lintOnSave: false,
    aiProviders: [
        {
            id: 'local-default',
            name: 'LM Studio local',
            type: 'openai-compatible',
            endpoint: 'http://localhost:1234/v1',
            apiKey: '',
            models: [
                { id: 'local-chat', role: 'chat', model: 'local-model' },
                { id: 'local-embed', role: 'embed', model: 'local-model' }
            ],
            maxContextTokens: 32768,
            maxOutputTokens: 4096
        }
    ] as ProviderConfig[],
    aiDefaultChatProvider: 'local-default/local-chat',
    aiDefaultEmbedProvider: 'local-default/local-embed',
    aiDefaultImageProvider: '',
    anthropicBanRiskAcknowledged: false,
    copyEditorAck: false,
    transformTemperature: 1.0,
    transformVaultContext: true,
    transformMaxOutputTokens: 4096,
    wikiLinkBehavior: 'preserve',
    narrativeVoicePreset: 'third-limited',
    customNarrativeVoiceRules: 'No genre-specific or context-specific rules configured.',
    analysisTemperature: 0.7,
    analysisMaxOutputTokens: 2048,
    enableCriticalAnalysis: true,
    enableManuscriptAnalysis: true,
    manuscriptAnalysisTemperature: 0.5,
    manuscriptAnalysisMaxOutputTokens: 3072,
    manuscriptAnalysisChunkTokenSize: 1024,
    embeddingsTopKChunks: 10,
    embeddingChunkTokenSize: 512,
    enableEmbeddingWarming: false,
    enableFullEmbedPickerOption: false,
    folderTopKOverrides: {},
    enableDebugLogging: false,
    embeddingWarmingDebounceSeconds: 30,
    linterTemperature: 0.3,
    linterMaxOutputTokens: 512,
    enableLinterAiFixes: true,
    contextTokenBudget: 8192,
    contextCompactAtPercent: 80,
    compactSummarySentences: 3,
    contextRefinementEnabled: true,
    contextIncludeVaultContext: true,
    contextMaxVaultFiles: 20,
    contextMaxCharsPerFile: 2000,
    contextAutoScan: true,
    coWriterTemperature: 1.0,
    coWriterMaxOutputTokens: 2048,
    coWriterMaxToolRounds: 0,
    coWriterSessionHistoryLimit: 25,
    coWriterAutoSavePerTurn: false,
    coWriterVaultContext: true,
    coWriterAppendNewline: true,
    enableCoWriterThought: true,
    coWriterVoiceMatch: true,
    enableInlineDirectives: true,
    enableDashboard: true,
    defaultTab: 'dashboard',
    dashboardAutoRefreshMinutes: 10,
    dashboardAutoSnapshotOnSave: false,
    dashboardMaxSnapshots: 100,
    readabilityFormula: 'reweighted-flesch',
    writingDailyGoal: 500,
    slashCommands: [],
    lorebookFolders: [],
    lorebookFolderTypes: {},
    coWriterLoreContext: true,
    reviewLoreContext: true,
    coWriterToolsEnabled: true,
    lorebookNetworkTools: true,
    lorebookFandomWikis: [],
    lorebookFandomAllowAllWikis: false,
    lorebookFandomCacheEnabled: true,
    lorebookWikipediaLang: 'en',
    lorebookToolMaxTokens: 2000,
    lorebookImageTools: true,
    lorebookImageMaxDimension: 512,
    lorebookImageMaxDescriptionTokens: 2048,
    lorebookImageProxyPrompt: DEFAULT_IMAGE_PROXY_PROMPT,
    lorebookImageTwoPassDescription: false,
    loreEntryImageSectionHeaders: ['Reference', 'Reference images', 'Gallery', 'Forms', 'Appearance', 'Art'],
    loreEntryImageMaxPerEntry: 4,
    loreEntryImageAttachments: true,
    loreEntryImageAttachmentFolder: '',
    lorePreferEditOverCreate: true,
    reviewSuggestedEditsEnabled: true,
    reviewWorldRules: '',
    enableFeedbackQueue: true,
    feedbackQueueLimit: 20,
    feedbackQueueAutoRun: true,
    autoSaveFeedbackReports: true,
    feedbackReportFolder: 'eventide-quill-reports'
};

const POWER_OF_TWO_OPTIONS = [4096, 8192, 16384, 32768, 65536, 131072];

/** Simple text input modal for prompting the user for a value. */
class InputModal extends Modal {
    private result = '';

    /** Store the prompt fields and the submit callback. */
    constructor(
        app: App,
        private title: string,
        private placeholder: string,
        private onSubmit: (value: string) => void
    ) {
        super(app);
    }

    /** Render the prompt: heading, text input, and Cancel/OK buttons. */
    onOpen(): void {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: this.title });

        const input = contentEl.createEl('input', {
            type: 'text',
            cls: 'quill-input-modal__input',
            attr: { placeholder: this.placeholder }
        });

        const buttonRow = contentEl.createDiv({ cls: 'quill-input-modal__actions' });

        buttonRow.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());

        const submitBtn = buttonRow.createEl('button', { text: 'OK', cls: 'mod-cta' });
        submitBtn.addEventListener('click', () => {
            this.result = input.value;
            this.close();
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                this.result = input.value;
                this.close();
            }
        });
    }

    /** Clear the modal and fire `onSubmit` with the entered value (no-op when cancelled). */
    onClose(): void {
        const { contentEl } = this;
        contentEl.empty();
        if (this.result) {
            this.onSubmit(this.result);
        }
    }
}

/** Modal that shows available models from a provider's endpoint. */
class ModelFetchModal extends SuggestModal<ModelInfo> {
    private models: ModelInfo[];

    /** Capture the model list and the selection callback, and start in search mode. */
    constructor(
        app: App,
        models: ModelInfo[],
        private onSelect: (modelId: string) => void
    ) {
        super(app);
        this.models = models;
        this.setPlaceholder('Search models...');
        this.limit = 50;
    }

    /** Filter suggestions by query. */
    getSuggestions(query: string): ModelInfo[] {
        const q = query.toLowerCase();
        return this.models.filter((m) => m.id.toLowerCase().includes(q));
    }

    /** Render each suggestion row. */
    renderSuggestion(model: ModelInfo, el: HTMLElement): void {
        el.createDiv({ text: model.id });
        if (model.ownedBy) {
            el.createEl('small', {
                text: model.ownedBy,
                attr: { style: 'color: var(--text-muted); margin-left: 8px;' }
            });
        }
    }

    /** When user selects a model, invoke the callback. */
    onChooseSuggestion(model: ModelInfo): void {
        this.onSelect(model.id);
    }
}

/** Modal to pick a provider type when adding a new provider. */
class AddProviderModal extends SuggestModal<{ type: ProviderType; label: string; defaultEndpoint: string }> {
    private options: { type: ProviderType; label: string; defaultEndpoint: string }[] = [
        { type: 'openai-compatible', label: 'OpenAI-compatible', defaultEndpoint: 'http://localhost:1234/v1' },
        { type: 'ollama', label: 'Ollama', defaultEndpoint: 'http://localhost:11434' },
        {
            type: 'anthropic',
            label: 'Anthropic Claude (native Messages API)',
            defaultEndpoint: 'https://api.anthropic.com/v1'
        },
        {
            type: 'gemini',
            label: 'Google Gemini (native GenerateContent API)',
            defaultEndpoint: 'https://generativelanguage.googleapis.com/v1beta'
        }
    ];

    /** Remember the selection callback and start in search mode. */
    constructor(
        app: App,
        private onChoose: (type: ProviderType, defaultEndpoint: string) => void
    ) {
        super(app);
        this.setPlaceholder('Choose provider type...');
    }

    /** Filter options by query. */
    getSuggestions(query: string): { type: ProviderType; label: string; defaultEndpoint: string }[] {
        const q = query.toLowerCase();
        return this.options.filter((o) => o.label.toLowerCase().includes(q));
    }

    /** Render each option. */
    renderSuggestion(option: { type: ProviderType; label: string }, el: HTMLElement): void {
        el.createDiv({ text: option.label });
    }

    /** When user selects a type, invoke the callback. */
    onChooseSuggestion(option: { type: ProviderType; label: string; defaultEndpoint: string }): void {
        this.onChoose(option.type, option.defaultEndpoint);
    }
}

/**
 * Confirmation modal that fires once before the writer configures an Anthropic
 * provider. See `EventideQuillSettingTab.openAnthropicBanRiskWarning` for the
 * policy background. Multi-paragraph body so the writer can't glance-and-click
 * through it; the primary button is intentionally worded as "I understand the
 * risk — continue" rather than a generic "OK" so the acknowledgment is
 * unambiguous.
 */
class AnthropicBanRiskModal extends Modal {
    private readonly onConfirm: () => void | Promise<void>;

    /** Set the modal title and store the confirmation callback. */
    constructor(app: App, onConfirm: () => void | Promise<void>) {
        super(app);
        this.titleEl.setText('Before you add Anthropic Claude');
        this.onConfirm = onConfirm;
    }

    /** Render the multi-paragraph policy warning and the explicit-risk Continue button. */
    onOpen(): void {
        const container = this.contentEl.createDiv({ cls: 'quill-anthropic-warning' });

        container.createEl('p', {
            text:
                'Anthropic prohibits sexually explicit content and graphic or gratuitous violence ' +
                'for ALL access — including the API, including content you submit for critique or analysis. ' +
                'Their filter is automated and account-level. Repeated violations, even from prose you ' +
                'have already written and are asking Claude to evaluate, can get your account terminated ' +
                'and forfeit any remaining API credits. Appeals are not always successful.'
        });

        container.createEl('p', {
            text:
                'If you write romance, erotica, horror, thrillers, dark fantasy, or any prose that ' +
                'includes on-page sexual content, sexual violence, or graphic gore, Anthropic is the ' +
                'wrong provider for your work. Gemini and local providers (Ollama, LM Studio) do not ' +
                'have this content-policy risk at the account level.'
        });

        container.createEl('p', {
            text:
                'There is no free tier for the Anthropic API — new accounts get a one-time $5 credit, ' +
                'then pay-as-you-go per token. Consumer Claude Pro/Max subscriptions do NOT grant API access.',
            cls: 'quill-anthropic-warning__muted'
        });

        const btnRow = container.createDiv({ cls: 'quill-confirm-modal__btn-row' });
        const cancelBtn = btnRow.createEl('button', { text: 'Cancel' });
        // Modal does not extend Component (no registerDomEvent); raw listener
        // is the established pattern for modals in this codebase.
        cancelBtn.addEventListener('click', () => this.close());

        const confirmBtn = btnRow.createEl('button', {
            text: 'I understand the risk — continue',
            cls: 'mod-warning'
        });
        // Lock out re-entry while the async onConfirm() is in flight so a
        // double-click can't fire the action twice. Both buttons disable on
        // confirmation start; on rejection they re-enable so the writer can
        // retry, on success the modal closes.
        let confirming = false;
        confirmBtn.addEventListener('click', () => {
            if (confirming) return;
            confirming = true;
            confirmBtn.disabled = true;
            cancelBtn.disabled = true;
            Promise.resolve(this.onConfirm())
                .then(() => this.close())
                .catch((err: unknown) => {
                    console.error('Quill: Anthropic warning confirmation failed.', err);
                    confirming = false;
                    confirmBtn.disabled = false;
                    cancelBtn.disabled = false;
                });
        });
    }
}

/** Human-readable byte count for the per-wiki cache management rows (Stage 4). */
function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** One-line summary of a wiki's cache for its management-row description (Stage 4). */
function formatFandomCacheStats(stats: WikiStats): string {
    const size = formatBytes(stats.sizeBytes);
    if (stats.pages === 0 && stats.images === 0) {
        return `Empty — ${size} on disk. Use "Sync now" above to populate.`;
    }
    const date = stats.lastSynced > 0 ? formatLocalDate(stats.lastSynced) : 'never';
    return `${stats.pages} page${stats.pages === 1 ? '' : 's'}, ${stats.images} image${stats.images === 1 ? '' : 's'} — ${size} on disk. Last synced: ${date}.`;
}

/** Declarative settings root for Eventide Quill (Obsidian 1.13+). */
export class EventideQuillSettingTab extends PluginSettingTab {
    plugin: EventideQuillPlugin;
    /**
     * The currently-open imperative bridge page (Phase 1 of the declarative
     * migration). Each former tab renders through a `SettingPage` whose
     * `display()` records itself here so mutation handlers can trigger an
     * in-place re-render via {@link refreshBridge} — the framework's
     * `update()` re-runs `getSettingDefinitions()` but does not re-invoke an
     * already-open imperative page's factory. This field goes away as each tab
     * is converted to declarative `items` (Phases 2–6).
     */
    private activeBridgePage: { containerEl: HTMLElement; render: (content: HTMLElement) => void } | null = null;

    /** Hold the plugin reference so settings handlers can read/write the live settings object. */
    constructor(app: App, plugin: EventideQuillPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    /**
     * Declarative settings root (Obsidian 1.13+). Returns the six former tabs
     * as navigable {@link SettingDefinitionPage}s. Until each tab is converted
     * to declarative controls (Phases 2–6), its page renders imperatively via
     * {@link bridgePage} — a thin `SettingPage` subclass that calls the
     * pre-existing `renderXxxTab` method into the page's container. The
     * framework renders the page entries (with navigation and unified search
     * at the page level) and calls each page's `display()` on open.
     */
    getSettingDefinitions(): SettingDefinitionItem[] {
        // Setup completion — drives the Welcome page's attention indicator.
        // Checks configuration state only (providers, model, goal); the
        // manuscript check is session state that changes with the active file
        // and isn't reliably populated at definition time.
        const setupComplete =
            this.plugin.settings.aiProviders.length > 0 &&
            !!this.plugin.settings.aiDefaultChatProvider &&
            this.plugin.settings.writingDailyGoal > 0;
        return [
            {
                type: 'page',
                name: 'Welcome',
                desc: 'Getting started, features, and privacy.',
                items: this.welcomeItems(),
                status: setupComplete ? null : 'warning'
            },
            {
                type: 'page',
                name: 'General',
                desc: 'Sidebar, features, dashboard, embeddings.',
                items: this.generalItems()
            },
            {
                type: 'page',
                name: 'Lorebook',
                desc: 'Lore scanning, coaches, fandom, images.',
                items: this.lorebookItems()
            },
            {
                type: 'page',
                name: 'Linter',
                desc: 'Prose linter rules and AI fixes.',
                items: this.linterItems()
            },
            {
                type: 'page',
                name: 'AI providers',
                desc: 'Providers, models, defaults.',
                items: this.aiProvidersItems(),
                displayValue: this.aiProviderDisplayValue(),
                status: this.aiProviderStatus()
            },
            {
                type: 'page',
                name: 'Model behaviors',
                desc: 'Voice, style, co-writer, review.',
                items: this.modelBehaviorsItems()
            }
        ];
    }

    /**
     * Called by an imperative detail {@link SettingPage} (provider or
     * default-models) when it opens: record it as the active page so mutation
     * handlers can re-render it in place via {@link refreshBridge}, and render
     * its content.
     */
    enterBridgePage(containerEl: HTMLElement, render: (content: HTMLElement) => void): void {
        this.activeBridgePage = { containerEl, render };
        this.renderBridgeContent(containerEl, render);
    }

    /**
     * Called by a {@link BridgeSettingPage} when it closes: clear the active
     * bridge page tracking if it still points at this page.
     */
    exitBridgePage(containerEl: HTMLElement): void {
        if (this.activeBridgePage?.containerEl === containerEl) this.activeBridgePage = null;
    }

    /**
     * Render one bridge page's content: the root styling class, the tab's
     * existing render method, the heading-grouped visual sections, and the
     * footer. Idempotent — emptying `containerEl` first makes it safe to call
     * repeatedly from {@link refreshBridge}.
     */
    private renderBridgeContent(containerEl: HTMLElement, render: (content: HTMLElement) => void): void {
        containerEl.empty();
        containerEl.addClass('quill-settings-root');
        // Render into a scroll-area so a long bridge page (provider fields +
        // model list + test buttons) scrolls. Without this wrapper the content
        // sat directly inside .quill-settings-root (overflow: hidden) and was
        // clipped — the provider/model data below the fold was unreachable.
        const scroll = containerEl.createDiv({ cls: 'quill-settings__scroll-area' });
        render(scroll);
        // Wrap runs of settings under each heading into bordered sections,
        // matching the pre-2.0.1 grouped look. Each tab renders into a single
        // `.quill-settings-content-*` div created by its render method.
        const content = scroll.querySelector<HTMLElement>('[class*="quill-settings-content-"]');
        if (content) this.groupSettingsByHeading(content);
        containerEl.createDiv({ cls: 'quill-settings__footer' });
    }

    /**
     * Re-render the currently-open bridge page in place after a mutation
     * (add/remove provider, slash command, folder override, etc.). Replaces the
     * pre-2.0.1 `this.refreshBridge()` full re-render. Falls back to `update()` when
     * no bridge page is active (e.g. at the root definition list). As tabs
     * convert to declarative controls (Phases 2–6), their mutation handlers
     * switch to `this.update()` / `this.refreshDomState()` and this method is
     * removed.
     */
    private refreshBridge(): void {
        if (this.activeBridgePage) {
            this.renderBridgeContent(this.activeBridgePage.containerEl, this.activeBridgePage.render);
        } else {
            this.update();
        }
    }

    /**
     * Declarative-control change hook. The base persists the value; we layer on
     * inter-setting cascades that the declarative model can't express inline
     * (a control has no onChange), then refresh the DOM so dependent controls'
     * `disabled`/`visible` predicates re-evaluate. Add per-key cases as tabs
     * are converted (Phases 2-6).
     */
    setControlValue(key: string, value: unknown): void | Promise<void> {
        const result = super.setControlValue(key, value);
        // Disabling invisible-character scanning also disables aggressive
        // scanning (which only makes sense with the base rule on).
        if (key === 'enableGremlins' && value === false && this.plugin.settings.enableAggressiveGremlins) {
            this.plugin.settings.enableAggressiveGremlins = false;
            void this.plugin.saveSettings();
        }
        // Turning embedding cache warming on kicks off a warming pass.
        if (key === 'enableEmbeddingWarming' && value === true) {
            void this.plugin.warmAllEmbeddingCaches();
        }
        // "Allow any wiki" is a footgun — surface a notice when it's enabled.
        if (key === 'lorebookFandomAllowAllWikis' && value === true) {
            new Notice('Quill: Fandom is now unrestricted — the co-writer can query any wiki it chooses.');
        }
        // Re-evaluate disabled/visible predicates so cascaded controls update
        // (e.g. the custom narrative-rules textarea shows only for the custom
        // preset, and aggressive scanning disables when gremlins is off).
        this.refreshDomState();
        return result;
    }

    /** Collect unique folder paths from the vault's markdown files. */
    private getVaultFolders(): string[] {
        const folderSet = new Set<string>();
        for (const file of this.app.vault.getMarkdownFiles()) {
            const parent = file.parent;
            if (parent && parent.path !== '/') {
                folderSet.add(parent.path);
            }
        }
        return [...folderSet].sort((a, b) => a.localeCompare(b));
    }

    /** Render the list of folder top-K override rows. */
    private renderFolderOverrides(container: HTMLElement): void {
        container.empty();
        const entries = Object.entries(this.plugin.settings.folderTopKOverrides).sort((a, b) =>
            a[0].localeCompare(b[0])
        );

        for (const [folder, count] of entries) {
            const row = container.createDiv({ cls: 'quill-folder-override-row' });
            row.createSpan({ cls: 'quill-folder-override-row__name', text: folder });

            const input = row.createEl('input', {
                cls: 'quill-folder-override-row__input',
                type: 'number',
                value: String(count),
                attr: { min: '1', max: '100' }
            });
            input.addEventListener('blur', () => {
                const n = parseInt(input.value, 10);
                if (!isNaN(n) && n >= 1 && n <= 100) {
                    this.plugin.settings.folderTopKOverrides[folder] = n;
                    void this.plugin.saveSettings();
                } else {
                    input.value = String(this.plugin.settings.folderTopKOverrides[folder]);
                    new Notice('Value must be between 1 and 100');
                }
            });

            const removeBtn = row.createEl('button', {
                cls: 'quill-folder-override-row__remove',
                text: '\u00d7'
            });
            removeBtn.addEventListener('click', () => {
                delete this.plugin.settings.folderTopKOverrides[folder];
                void this.plugin.saveSettings();
                this.renderFolderOverrides(container);
            });
        }
    }

    /** Render the list of lorebook folder rows. */
    private renderLorebookFolders(container: HTMLElement): void {
        container.empty();
        const folders = [...this.plugin.settings.lorebookFolders].sort((a, b) => a.localeCompare(b));

        if (folders.length === 0) {
            container.createDiv({
                cls: 'quill-settings__empty-hint',
                text: 'No lorebook folders configured. Add one to begin scanning for lore entries.'
            });
            return;
        }

        for (const folder of folders) {
            const row = container.createDiv({ cls: 'quill-folder-override-row' });
            row.createSpan({ cls: 'quill-folder-override-row__name', text: folder });

            // Folder entry-type default. "Mixed" (absent from the map) means each
            // file is typed by its own `quill-type` frontmatter; any other choice
            // makes every file in the folder that type unless overridden per-file.
            const typeSelect = row.createEl('select', { cls: 'quill-folder-override-row__select' });
            typeSelect.createEl('option', { value: '', text: 'Mixed' });
            for (const t of LORE_ENTRY_TYPES) {
                typeSelect.createEl('option', { value: t, text: LORE_TYPE_LABELS[t] });
            }
            const currentType = this.plugin.settings.lorebookFolderTypes[folder];
            typeSelect.value = currentType ?? '';
            typeSelect.addEventListener('change', () => {
                const v = typeSelect.value as LoreEntryType | '';
                if (v === '') {
                    delete this.plugin.settings.lorebookFolderTypes[folder];
                } else {
                    this.plugin.settings.lorebookFolderTypes[folder] = v;
                }
                void this.plugin.saveSettings();
            });

            const removeBtn = row.createEl('button', {
                cls: 'quill-folder-override-row__remove',
                text: '\u00d7'
            });
            removeBtn.addEventListener('click', () => {
                this.plugin.settings.lorebookFolders = this.plugin.settings.lorebookFolders.filter((f) => f !== folder);
                delete this.plugin.settings.lorebookFolderTypes[folder];
                void this.plugin.saveSettings().then(() => this.update());
            });
        }
    }

    /**
     * Render the per-card editor for user-defined slash commands. Each
     * card carries Name (kebab-case-validated, lowercase + trim on blur,
     * uniqueness-checked via Notice), Description (one-line, optional),
     * and Body (multi-line textarea). Per-field edits mutate the object
     * in place and save; structural changes (add/remove) do a full
     * `this.refreshBridge()` redraw, mirroring the `aiProviders` card pattern.
     */
    private renderSlashCommands(container: HTMLElement): void {
        container.empty();
        const commands = this.plugin.settings.slashCommands;

        if (commands.length === 0) {
            container.createDiv({
                cls: 'quill-settings__empty-hint',
                text: 'No slash commands configured. Add one to enable the / picker in the co-writer chat input.'
            });
            return;
        }

        for (const [index, cmd] of commands.entries()) {
            this.renderSlashCommandCard(container, cmd, index);
        }
    }

    /** Render one slash-command editor card. Mutates `cmd` in place on field edits. */
    private renderSlashCommandCard(container: HTMLElement, cmd: SlashCommand, index: number): void {
        const card = container.createDiv({ cls: 'quill-slash-command-card' });

        const headingRow = card.createDiv({ cls: 'quill-slash-command-card__heading' });
        new Setting(headingRow).setName(cmd.name ? `/${cmd.name}` : 'Untitled command').addButton((button) =>
            button.setButtonText('Remove').onClick(async () => {
                this.plugin.settings.slashCommands.splice(index, 1);
                await this.plugin.saveSettings();
                this.refreshBridge();
            })
        );

        new Setting(card)
            .setName('Name')
            .setDesc(
                'The trigger key (without the leading /). Kebab-case only: lowercase letters, digits, ' +
                    'and hyphens; must start with a letter. Unique across all commands.'
            )
            .addText((text) =>
                text
                    .setPlaceholder('E.g., summarize-passage')
                    .setValue(cmd.name)
                    .inputEl.addEventListener('blur', () => {
                        const trimmed = text.inputEl.value.trim().toLowerCase();
                        if (!SLASH_COMMAND_NAME_PATTERN.test(trimmed)) {
                            new Notice(
                                'Slash command names must be kebab-case (lowercase letters, digits, ' +
                                    'and hyphens; must start with a letter).'
                            );
                            // Revert to the saved name; the field stays editable so the writer can retry.
                            text.setValue(cmd.name);
                            return;
                        }
                        // Uniqueness check — skip self (allow saving the same value back unchanged).
                        const dup = this.plugin.settings.slashCommands.some(
                            (c, i) => i !== index && c.name === trimmed
                        );
                        if (dup) {
                            new Notice(`A slash command "/${trimmed}" already exists. Names must be unique.`);
                            text.setValue(cmd.name);
                            return;
                        }
                        cmd.name = trimmed;
                        void this.plugin.saveSettings();
                        // Refresh the heading so it shows the new "/name" instead of the placeholder.
                        this.refreshBridge();
                    })
            );

        new Setting(card)
            .setName('Description')
            .setDesc('One-line description shown under the name in the picker. Optional.')
            .addText((text) =>
                text
                    .setPlaceholder('E.g., ask the coach to summarize the current passage')
                    .setValue(cmd.description)
                    .inputEl.addEventListener('blur', () => {
                        cmd.description = text.inputEl.value.trim();
                        void this.plugin.saveSettings();
                    })
            );

        const bodySetting = new Setting(card)
            .setName('Body')
            .setDesc('Text inserted into the chat input when the command is chosen. Editable before sending.');
        bodySetting.addTextArea((area) => {
            area
                .setPlaceholder('Body text inserted into the co-writer chat input when this command is picked.')
                .setValue(cmd.body).inputEl.rows = 4;
            // settings.ts — no Component lifecycle available for the setting; raw
            // addEventListener is required to read the value on blur, mirroring the
            // surrounding lorebook image-prompts / folder-override idiom.
            area.inputEl.addEventListener('blur', () => {
                cmd.body = area.inputEl.value;
                void this.plugin.saveSettings();
            });
        });
    }

    /**
     * Wrap each run of settings under a heading (`.setting-item-heading`)
     * into a styled `.quill-settings__section` group, so a long tab reads as
     * visually distinct blocks instead of a flat list that bleeds together.
     *
     * Idempotent and DOM-move-based: elements aren't recreated, so event
     * listeners registered on them (and Setting objects' internal refs)
     * survive. Called from {@link display} after every tab's content is built.
     * Children appearing before the first heading stay at the top (ungrouped).
     */
    private groupSettingsByHeading(container: HTMLElement): void {
        const snapshot = Array.from(container.children) as HTMLElement[];
        let group: HTMLElement | null = null;
        for (const child of snapshot) {
            if (child.classList.contains('setting-item-heading')) {
                group = createDiv({ cls: 'quill-settings__section' });
                container.insertBefore(group, child);
                group.appendChild(child);
            } else if (group) {
                group.appendChild(child);
            }
        }
    }

    /** Render the welcome tab (onboarding + feature overview). */
    /**
     * Declarative items for the Welcome page. The onboarding content (hero,
     * getting-started, features, privacy/network-tool inventory, notes) is
     * rendered imperatively into a single setting row via {@link renderWelcomeTab};
     * the four tool-gating toggles inside it are duplicates of settings that
     * are native controls on the General and Lorebook pages (so they're
     * individually searchable there). Toggle changes call refreshBridge(), which
     * re-renders the page (the render re-runs on update()).
     */
    private welcomeItems(): SettingDefinitionItem[] {
        return [
            {
                name: 'Welcome',
                render: (setting) => {
                    setting.settingEl.empty();
                    this.renderWelcomeTab(setting.settingEl);
                }
            }
        ];
    }

    /** Render the Welcome page's imperative onboarding content (hero, checklist, features, privacy). */
    private renderWelcomeTab(containerEl: HTMLElement): void {
        const content = containerEl.createDiv({ cls: 'quill-settings-content-welcome' });

        // --- Hero ---

        const hero = content.createDiv({ cls: 'quill-settings__welcome-hero' });
        hero.createDiv({ cls: 'quill-settings__welcome-title', text: 'Eventide quill' });
        hero.createDiv({
            cls: 'quill-settings__welcome-tagline',
            text: 'A feedback-first writing assistant for novelists.'
        });

        // --- Set up Quill (live checklist — reflects current configuration) ---

        new Setting(content).setName('Getting set up').setHeading();

        const hasProviders = this.plugin.settings.aiProviders.length > 0;
        const hasChatModel = !!this.plugin.settings.aiDefaultChatProvider;
        const hasManuscript = !!this.plugin.currentManuscriptFolder;
        const hasGoal = this.plugin.settings.writingDailyGoal > 0;

        // Each settings-referencing step carries an always-visible action so the
        // writer can jump straight back to that setting from the checklist even
        // after it is complete. "Open your manuscript" references no settings
        // page, so it intentionally has no button.
        const setupSteps: { done: boolean; label: string; hint: string; actionLabel?: string; action?: () => void }[] =
            [
                {
                    done: hasProviders,
                    label: 'Add an AI provider',
                    hint: 'Ollama, LM Studio, or any OpenAI-compatible endpoint. (AI providers page)',
                    actionLabel: hasProviders ? 'Take me there' : 'Add',
                    action: hasProviders
                        ? () => this.openSettingsPage('AI providers')
                        : () => new AddProviderModal(this.app, (t, ep) => this.addProvider(t, ep)).open()
                },
                {
                    done: hasChatModel,
                    label: 'Pick a default chat model',
                    hint: 'The model used for chat, feedback, and the co-writer. (Default models page)',
                    actionLabel: 'Take me there',
                    action: () => this.openSettingsPage('AI providers', 'Default chat model', 'Default models')
                },
                {
                    done: hasManuscript,
                    label: 'Open your manuscript',
                    hint: 'Open a chapter file and refresh the dashboard so Quill can scan its context.'
                },
                {
                    done: hasGoal,
                    label: 'Set a daily writing goal',
                    hint: 'Track a writing streak on the dashboard. (General page)',
                    actionLabel: 'Take me there',
                    action: () => this.openSettingsPage('General', 'Daily writing goal')
                }
            ];
        const completed = setupSteps.filter((s) => s.done).length;
        content.createDiv({
            cls: 'quill-settings__welcome-progress',
            text: `${completed} of ${setupSteps.length} setup steps complete`
        });
        const checklist = content.createDiv({ cls: 'quill-settings__welcome-checklist' });
        for (const step of setupSteps) {
            const row = checklist.createDiv({ cls: 'quill-settings__welcome-checklist-row' });
            row.createSpan({
                cls: `quill-settings__welcome-checklist-mark${step.done ? ' quill-settings__welcome-checklist-mark--done' : ''}`,
                text: step.done ? '\u2713' : '\u25CB'
            });
            const body = row.createDiv({ cls: 'quill-settings__welcome-checklist-body' });
            body.createDiv({ cls: 'quill-settings__welcome-checklist-label', text: step.label });
            body.createDiv({ cls: 'quill-settings__welcome-checklist-hint', text: step.hint });
            if (step.action && step.actionLabel) {
                const btn = row.createEl('button', {
                    cls: 'quill-settings__welcome-checklist-btn',
                    text: step.actionLabel
                });
                btn.addEventListener('click', step.action);
            }
        }

        // --- Features ---

        new Setting(content).setName('Features').setHeading();

        const features = content.createDiv({ cls: 'quill-settings__welcome-features' });
        const featureItems: { icon: string; text: string }[] = [
            {
                icon: '\u2630',
                text: 'Manuscript dashboard with per-chapter analytics, pacing analysis, and readability tracking'
            },
            { icon: '\u2713', text: 'Prose linter with deterministic rules and AI-powered batch fixes' },
            {
                icon: '\u270E',
                text: 'AI feedback engine with developmental editor, line editor, beta reader, and coach personas'
            },
            { icon: '\u27A4', text: 'Co-writer with Direct, Discuss, Coach, and Fulfill modes' },
            { icon: '\u21BB', text: 'Selection transformations: improve, lengthen, shorten, change tone, or custom' },
            {
                icon: '\u2691',
                text: 'Critical analysis for plot logic, character consistency, continuity, and voice drift'
            },
            { icon: '\u2699', text: 'Context engine that auto-builds working context from your manuscript' },
            { icon: '\u26A1', text: 'Pluggable providers: Ollama, LM Studio, OpenAI-compatible, and more' }
        ];
        for (const item of featureItems) {
            const row = features.createDiv({ cls: 'quill-settings__welcome-feature' });
            row.createSpan({ cls: 'quill-settings__welcome-feature-icon', text: item.icon });
            row.createSpan({ cls: 'quill-settings__welcome-feature-text', text: item.text });
        }

        // --- What are you writing? (genre-tailored guidance) ---

        new Setting(content).setName('What are you writing?').setHeading();
        const genreTip = content.createDiv({
            cls: 'quill-settings__welcome-genre-tip',
            text: 'Pick the closest genre for guidance on which features to try first.'
        });
        const genreChips = content.createDiv({ cls: 'quill-settings__welcome-genre-chips' });
        const genres: { label: string; tip: string }[] = [
            {
                label: 'Fantasy',
                tip: 'Worldbuilding-heavy: set up a Lorebook folder (Lorebook page) and try the Lorebook Coach to draft entries from your manuscript.'
            },
            {
                label: 'Science fiction',
                tip: 'Track systems and canon in a Lorebook, and run Critical analysis to catch continuity gaps in the worldbuilding.'
            },
            {
                label: 'Romance',
                tip: 'The developmental-editor persona (Review tab) gives relationship-focused feedback; the line editor refines voice.'
            },
            {
                label: 'Mystery',
                tip: 'Use Critical analysis (plot logic + continuity) to track clues and red herrings across chapters.'
            },
            {
                label: 'Thriller',
                tip: 'Critical analysis flags pacing and continuity; the dashboard pacing heatmap shows where tension drags.'
            },
            {
                label: 'Literary',
                tip: 'The line-editor persona and the AI-prose linter rules sharpen sentence-level craft.'
            },
            {
                label: 'Historical',
                tip: 'A Lorebook keeps period detail consistent; network research tools (Wikipedia) help verify references.'
            },
            {
                label: 'Other',
                tip: 'Start with the co-writer (discuss mode) to brainstorm, and the Review tab for editorial feedback.'
            }
        ];
        for (const g of genres) {
            const chip = genreChips.createEl('button', { cls: 'quill-settings__welcome-genre-chip', text: g.label });
            chip.addEventListener('click', () => {
                genreTip.textContent = g.tip;
            });
        }

        // --- Privacy & network tools ---

        new Setting(content).setName('Privacy & network tools').setHeading();

        content.createDiv({
            cls: 'quill-settings__welcome-privacy-intro',
            text:
                'No telemetry. Your manuscript stays yours. The co-writer can call the tools ' +
                'below, which send requests to external sites — they are on by default so you ' +
                'do not have to hunt for them. Turn any off here to keep the AI working only ' +
                'with your local vault.'
        });

        // Inventory: what each outbound tool does and where the request goes.
        const netTools = content.createDiv({ cls: 'quill-settings__welcome-net-tools' });
        const netToolItems: { name: string; desc: string }[] = [
            {
                name: 'fetch_url',
                desc: 'Fetches a web page you or the model specify and returns its text.'
            },
            {
                name: 'fandom_lookup / fandom_page',
                desc: 'Queries a Fandom wiki in your allowlist (e.g., starwars.fandom.com) for canon.'
            },
            {
                name: 'fandom_image',
                desc: "Fetches images for a Fandom topic via the wiki API, and lists the page's other images with captions."
            },
            {
                name: 'wikipedia_lookup / wikipedia_page',
                desc: 'Queries Wikipedia (configurable language) for reference material.'
            },
            {
                name: 'wikipedia_image',
                desc: 'Fetches the lead image from a Wikipedia page (most often a portrait for biographies).'
            },
            {
                name: 'fetch_image_url',
                desc: 'Downloads an image from a URL so a vision model can interpret it.'
            }
        ];
        for (const t of netToolItems) {
            const row = netTools.createDiv({ cls: 'quill-settings__welcome-net-tool' });
            row.createEl('code', { cls: 'quill-settings__welcome-net-tool-name', text: t.name });
            row.createSpan({ cls: 'quill-settings__welcome-net-tool-desc', text: t.desc });
        }

        new Setting(content)
            .setName('Co-writer tools')
            .setDesc('Master switch for all co-writer tool-calling. Turning it off disables every tool above.')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.coWriterToolsEnabled).onChange(async (value) => {
                    this.plugin.settings.coWriterToolsEnabled = value;
                    await this.plugin.saveSettings();
                    this.refreshBridge();
                })
            );

        new Setting(content)
            .setName('Network research tools')
            .setDesc('Sends requests to external websites when the co-writer researches references.')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.lorebookNetworkTools).onChange(async (value) => {
                    this.plugin.settings.lorebookNetworkTools = value;
                    await this.plugin.saveSettings();
                    this.refreshBridge();
                })
            );

        new Setting(content)
            .setName('Image tool')
            .setDesc(
                'Allows image-fetching tools for a vision model — gates fetch_image_url, fandom_image, and wikipedia_image. ' +
                    'No effect unless a vision-capable chat model or a dedicated image model is configured.'
            )
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.lorebookImageTools).onChange(async (value) => {
                    this.plugin.settings.lorebookImageTools = value;
                    await this.plugin.saveSettings();
                    this.refreshBridge();
                })
            );

        new Setting(content)
            .setName('Agent image attachments')
            .setDesc(
                'Lets the lorebook coach and batch tools propose image attachments for your review. ' +
                    'On: the coach can attach images when drafting an entry, and the batch tool can attach ' +
                    'images to existing entries. Every attachment flows through the review queue — nothing ' +
                    'is written without your approval. Off: the agent cannot attach images, but you can ' +
                    'still add them manually via ![[file]] embeds. Does not affect other tools.'
            )
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.loreEntryImageAttachments).onChange(async (value) => {
                    this.plugin.settings.loreEntryImageAttachments = value;
                    await this.plugin.saveSettings();
                    this.refreshBridge();
                })
            );

        content.createDiv({
            cls: 'quill-settings__welcome-privacy',
            text:
                'Fandom queries respect an allowlist by default (empty = Fandom disabled); the ' +
                '"Allow any Fandom wiki" danger toggle overrides this. The Fandom page cache is a ' +
                'separate consent surface: populating it is a network act, but once cached, those ' +
                'pages answer locally even with network tools off — consent is at sync time, and ' +
                'you can clear each wiki from the General tab. AI providers you configure receive ' +
                'the manuscript text you send them — pick local providers (Ollama, LM Studio) to ' +
                'keep everything on your machine. Full per-tool controls live on the General tab.'
        });

        content.createDiv({
            cls: 'quill-settings__welcome-privacy',
            text:
                'Images you paste, drop, or attach in the co-writer chat are downscaled locally on your ' +
                'device before leaving it. They are then sent to your configured chat model (if vision-capable) ' +
                'or, when the chat model is text-only, to your separately-configured image model for a one-off ' +
                'description — the text model never receives the pixels. Local providers keep images on your ' +
                'machine just like manuscript text.'
        });

        content.createDiv({
            cls: 'quill-settings__welcome-tip',
            text:
                'Tip: images with one or two characters produce the richest descriptions. The model can ' +
                "focus on fine details (scars, jewelry, fabric texture) when it isn't spreading its " +
                'token budget across a crowd. For group shots, it will still cover every visible ' +
                'character — but each gets a shorter share. Crop tightly for best results.'
        });
    }

    /** Render the general settings tab. */
    /**
     * Declarative items for the General page. Every control's `key` matches a
     * {@link DEFAULT_SETTINGS} field, so the base {@link PluginSettingTab}
     * reads/writes/persists automatically — no onChange boilerplate. Numeric
     * bounds move from blur-handlers (with a Notice + revert) to the control's
     * `validate`, which surfaces an inline error. The Debug group is gated by a
     * `visible` predicate so it tree-shakes out of release builds.
     */
    private generalItems(): SettingDefinitionItem[] {
        return [
            {
                type: 'group',
                heading: 'Sidebar',
                items: [
                    {
                        name: 'Default tab',
                        desc: 'Which sidebar tab opens by default.',
                        control: {
                            type: 'dropdown',
                            key: 'defaultTab',
                            options: {
                                dashboard: 'Dashboard',
                                linter: 'Linter',
                                context: 'Context',
                                review: 'Review',
                                cowriter: 'Co-writer',
                                lorebook: 'Lorebook'
                            }
                        }
                    }
                ]
            },
            {
                type: 'group',
                heading: 'Feature toggles',
                items: [
                    {
                        name: 'Enable dashboard',
                        desc: 'Show the dashboard tab in the sidebar with per-manuscript analytics.',
                        control: { type: 'toggle', key: 'enableDashboard' }
                    },
                    {
                        name: 'Critical analysis',
                        desc: 'Show the analysis engine in the review tab and the right-click analyze command.',
                        control: { type: 'toggle', key: 'enableCriticalAnalysis' }
                    },
                    {
                        name: 'Manuscript analysis',
                        desc: 'Show the manuscript analysis engine in the review tab for full-manuscript structural diagnostics.',
                        control: { type: 'toggle', key: 'enableManuscriptAnalysis' }
                    }
                ]
            },
            {
                type: 'group',
                heading: 'Manuscript analysis engine',
                items: [
                    {
                        name: 'Compression chunk size (tokens)',
                        desc: 'Target tokens per chunk when using compress compaction (chat model summarization). The embedding chunk size is configured separately on the Model behaviors tab. Default: 1024.',
                        control: {
                            type: 'number',
                            key: 'manuscriptAnalysisChunkTokenSize',
                            min: 256,
                            max: 8192,
                            validate: (v) => (v >= 256 && v <= 8192 ? undefined : 'Value must be between 256 and 8192')
                        }
                    },
                    {
                        name: 'Manuscript analysis temperature',
                        desc: 'Temperature for manuscript analysis AI responses. Higher values produce more varied output; lower values are more deterministic. Range: 0.0 – 2.0. Default: 0.5.',
                        control: {
                            type: 'number',
                            key: 'manuscriptAnalysisTemperature',
                            min: 0,
                            max: 2,
                            step: 0.1,
                            validate: (v) => (v >= 0 && v <= 2 ? undefined : 'Value must be between 0.0 and 2.0')
                        }
                    },
                    {
                        name: 'Manuscript analysis max output tokens',
                        desc: 'Maximum tokens per manuscript analysis response. Higher allows more detailed reports but uses more quota. Default: 3072.',
                        control: {
                            type: 'number',
                            key: 'manuscriptAnalysisMaxOutputTokens',
                            min: 1,
                            max: 65536,
                            validate: (v) => (v >= 1 && v <= 65536 ? undefined : 'Value must be between 1 and 65536')
                        }
                    }
                ]
            },
            {
                type: 'group',
                heading: 'Debug',
                visible: () => __DEV__,
                items: [
                    {
                        name: 'Enable debug logging',
                        desc: 'When enabled, logs AI payload context to the browser console (console.warn). Useful for inspecting the actual data sent to providers.',
                        control: { type: 'toggle', key: 'enableDebugLogging' }
                    }
                ]
            },
            {
                type: 'group',
                heading: 'Dashboard',
                items: [
                    {
                        name: 'Readability formula',
                        desc: 'Which readability formula to display in the dashboard.',
                        control: {
                            type: 'dropdown',
                            key: 'readabilityFormula',
                            options: {
                                'reweighted-flesch': 'Reweighted flesch',
                                'flesch-kincaid': 'Flesch-kincaid',
                                ari: 'Automated readability index',
                                'custom-composite': 'Custom composite',
                                'dale-chall': 'Dale-chall'
                            }
                        }
                    },
                    {
                        name: 'Auto-refresh interval',
                        desc: 'Refresh the dashboard every n minutes when the tab is active (0 disables).',
                        control: {
                            type: 'number',
                            key: 'dashboardAutoRefreshMinutes',
                            min: 0,
                            max: 60,
                            validate: (v) => (v >= 0 && v <= 60 ? undefined : 'Value must be between 0 and 60')
                        }
                    },
                    {
                        name: 'Auto-snapshot on save',
                        desc: 'Record a word-count snapshot whenever a chapter file is saved.',
                        control: { type: 'toggle', key: 'dashboardAutoSnapshotOnSave' }
                    },
                    {
                        name: 'Max snapshots retained',
                        desc: 'Maximum number of historical snapshots to keep per manuscript (10-1000). Oldest are pruned first.',
                        control: {
                            type: 'number',
                            key: 'dashboardMaxSnapshots',
                            min: 10,
                            max: 1000,
                            validate: (v) => (v >= 10 && v <= 1000 ? undefined : 'Value must be between 10 and 1000')
                        }
                    },
                    {
                        name: 'Daily writing goal',
                        desc: 'Target words per day for the dashboard goals card and streak (0 disables). Default: 500.',
                        control: {
                            type: 'number',
                            key: 'writingDailyGoal',
                            min: 0,
                            max: 100000,
                            validate: (v) => (v >= 0 && v <= 100000 ? undefined : 'Value must be between 0 and 100000')
                        }
                    }
                ]
            },
            {
                name: 'Restore defaults',
                desc: 'Reset all general settings to their default values.',
                action: () => {
                    void this.restoreGeneralDefaults();
                }
            }
        ];
    }

    /** Restore-defaults action for the General page (resets across all tabs, matching pre-2.0.1 behavior). */
    private async restoreGeneralDefaults(): Promise<void> {
        const s = this.plugin.settings;
        const d = DEFAULT_SETTINGS;
        s.defaultTab = d.defaultTab;
        s.enableDashboard = d.enableDashboard;
        s.enableCriticalAnalysis = d.enableCriticalAnalysis;
        s.enableManuscriptAnalysis = d.enableManuscriptAnalysis;
        s.manuscriptAnalysisTemperature = d.manuscriptAnalysisTemperature;
        s.manuscriptAnalysisMaxOutputTokens = d.manuscriptAnalysisMaxOutputTokens;
        s.manuscriptAnalysisChunkTokenSize = d.manuscriptAnalysisChunkTokenSize;
        s.embeddingsTopKChunks = d.embeddingsTopKChunks;
        s.embeddingChunkTokenSize = d.embeddingChunkTokenSize;
        s.enableEmbeddingWarming = d.enableEmbeddingWarming;
        s.enableFullEmbedPickerOption = d.enableFullEmbedPickerOption;
        s.folderTopKOverrides = { ...d.folderTopKOverrides };
        s.enableDebugLogging = d.enableDebugLogging;
        s.embeddingWarmingDebounceSeconds = d.embeddingWarmingDebounceSeconds;
        s.dashboardAutoRefreshMinutes = d.dashboardAutoRefreshMinutes;
        s.dashboardAutoSnapshotOnSave = d.dashboardAutoSnapshotOnSave;
        s.dashboardMaxSnapshots = d.dashboardMaxSnapshots;
        s.readabilityFormula = d.readabilityFormula;
        s.writingDailyGoal = d.writingDailyGoal;
        s.lorebookFolders = [...d.lorebookFolders];
        s.lorebookFolderTypes = { ...d.lorebookFolderTypes };
        s.coWriterLoreContext = d.coWriterLoreContext;
        s.reviewLoreContext = d.reviewLoreContext;
        s.coWriterToolsEnabled = d.coWriterToolsEnabled;
        s.lorebookNetworkTools = d.lorebookNetworkTools;
        s.lorebookFandomWikis = [...d.lorebookFandomWikis];
        s.lorebookFandomAllowAllWikis = d.lorebookFandomAllowAllWikis;
        s.lorebookFandomCacheEnabled = d.lorebookFandomCacheEnabled;
        s.lorebookWikipediaLang = d.lorebookWikipediaLang;
        s.lorebookToolMaxTokens = d.lorebookToolMaxTokens;
        s.lorebookImageTools = d.lorebookImageTools;
        s.lorebookImageMaxDimension = d.lorebookImageMaxDimension;
        s.lorebookImageMaxDescriptionTokens = d.lorebookImageMaxDescriptionTokens;
        s.lorebookImageProxyPrompt = d.lorebookImageProxyPrompt;
        s.lorebookImageTwoPassDescription = d.lorebookImageTwoPassDescription;
        s.loreEntryImageSectionHeaders = [...d.loreEntryImageSectionHeaders];
        s.loreEntryImageMaxPerEntry = d.loreEntryImageMaxPerEntry;
        s.loreEntryImageAttachments = d.loreEntryImageAttachments;
        s.loreEntryImageAttachmentFolder = d.loreEntryImageAttachmentFolder;
        s.slashCommands = [...d.slashCommands];
        await this.plugin.saveSettings();
        this.update();
    }

    /** Render the Lorebook tab — lorebook config, cached wikis, lore entry images, lore folders. */
    /**
     * Declarative items for the Lorebook page. Scalar settings are native
     * controls; the dynamic collections (slash commands, lorebook folders,
     * fandom wiki allowlist, gallery section headings) and the conditional
     * cached-wikis manager are SettingDefinitionRender items (their elements
     * are dynamic arrays that don't map to fixed control keys, and the
     * cached-wikis view loads stats asynchronously). Providers on the AI
     * providers tab (Phase 6) are the one collection that benefits from a
     * SettingDefinitionList-of-pages.
     */
    private lorebookItems(): SettingDefinitionItem[] {
        return [
            {
                type: 'group',
                heading: 'Lorebook',
                items: [
                    {
                        name: 'Feed lore into co-writer',
                        desc: 'Automatically include relevant lore entries as context when generating with the co-writer. Retrieved via the embedding cache. Default: on.',
                        control: { type: 'toggle', key: 'coWriterLoreContext' }
                    },
                    {
                        name: 'Feed lore into review engines',
                        desc: 'Automatically include relevant lore entries as context for editorial feedback, critical analysis, and manuscript analysis. Default: on.',
                        control: { type: 'toggle', key: 'reviewLoreContext' }
                    },
                    {
                        name: 'Co-writer tool use',
                        desc: 'Let the co-writer (discuss, coach, and lorebook modes) call tools (manuscript mentions, lore siblings, vault lookup) via the model’s native tool-calling API so it can look up details mid-conversation. Turn off if your model doesn’t support tool calling or to avoid the extra turn consumption. Default: on.',
                        control: { type: 'toggle', key: 'coWriterToolsEnabled' }
                    },
                    {
                        name: 'Network tools',
                        desc: 'Allow the co-writer to call network tools (fetch_url, fandom_lookup, wikipedia_lookup). These send requests to external sites — disable only if you want to restrict the AI from researching canon, references, or web pages. Default: on.',
                        control: { type: 'toggle', key: 'lorebookNetworkTools' }
                    },
                    {
                        name: 'Fandom wikis',
                        desc: 'Comma-separated Fandom wiki subdomains the AI may query (e.g., "starwars, memory-alpha, lotr"). Leave empty to disable Fandom lookups.',
                        render: (setting) => this.renderFandomWikisField(setting)
                    },
                    {
                        name: 'Allow any wiki',
                        desc: 'Caution: lets the co-writer query ANY Fandom wiki subdomain it chooses, not just the allowlist above. Prefer the allowlist unless you specifically need this.',
                        control: { type: 'toggle', key: 'lorebookFandomAllowAllWikis' }
                    },
                    {
                        name: 'Fandom page cache',
                        desc: 'Save lookups to a local cache so repeats skip the network — more private, and works offline once cached. Once populated, cached pages answer even with network tools off (consent is at sync time). Lives in the plugin data folder, not your vault.',
                        control: { type: 'toggle', key: 'lorebookFandomCacheEnabled' }
                    },
                    {
                        name: 'Sync fandom wiki cache',
                        desc: 'Download every page from an allowlisted wiki into the local cache. Fair-rate and cancelable (via the cancel command). Useful before going offline.',
                        action: () => {
                            this.plugin.pickFandomWikiForSync();
                        }
                    },
                    {
                        name: 'Cached wikis',
                        desc: 'Per-wiki cache size, page/image counts, and last-sync time, with a clear-cache action.',
                        visible: () => this.plugin.settings.lorebookFandomCacheEnabled,
                        render: (setting) => this.renderFandomCachedWikis(setting)
                    },
                    {
                        name: 'Wikipedia language',
                        desc: 'Wikipedia language subdomain (e.g., "en", "fr", "de", "simple"). Default: en.',
                        control: {
                            type: 'text',
                            key: 'lorebookWikipediaLang',
                            validate: (v) =>
                                isValidWikipediaLang(v)
                                    ? undefined
                                    : 'Use a language subdomain like "en", "fr", or "simple".'
                        }
                    },
                    {
                        name: 'Network tool result limit (tokens)',
                        desc: 'Maximum tokens returned per network tool call. Default: 2000.',
                        control: {
                            type: 'number',
                            key: 'lorebookToolMaxTokens',
                            min: 100,
                            validate: (v) => (v >= 100 ? undefined : 'Value must be a number >= 100')
                        }
                    },
                    {
                        name: 'Image tools',
                        desc: 'Allow the co-writer to call image-fetching tools — fetch_image_url (download any image URL), fandom_image (Fandom lead/gallery images), and wikipedia_image (Wikipedia lead portraits). Images are downscaled before delivery. Requires a vision-capable chat model (role "Chat + image") or a dedicated image model (role "Image") to have any effect. Default: on.',
                        control: { type: 'toggle', key: 'lorebookImageTools' }
                    },
                    {
                        name: 'Image max dimension (px)',
                        desc: 'Longest-side cap before downscale. Smaller values save context budget. Default: 512.',
                        control: {
                            type: 'number',
                            key: 'lorebookImageMaxDimension',
                            min: 64,
                            max: 2048,
                            validate: (v) => (v >= 64 && v <= 2048 ? undefined : 'Value must be between 64 and 2048')
                        }
                    },
                    {
                        name: 'Image description token budget',
                        desc: 'Max output tokens for the Regime B image-description call. Higher values let the model describe every character in a group image; lower values are faster on local hardware. The model stops early when it finishes — this is a ceiling, not a target. Default: 2048.',
                        control: {
                            type: 'number',
                            key: 'lorebookImageMaxDescriptionTokens',
                            min: 256,
                            max: 8192,
                            validate: (v) => (v >= 256 && v <= 8192 ? undefined : 'Value must be between 256 and 8192')
                        }
                    },
                    {
                        name: 'Image proxy prompt',
                        desc: 'When your chat model is text-only and a separate image model is configured, this tells the image model how to describe images into text. Edit to focus on what matters for your fiction (clothing, architecture, mood, etc.).',
                        control: { type: 'textarea', key: 'lorebookImageProxyPrompt', rows: 4 }
                    },
                    {
                        name: 'Two-pass image description',
                        desc: 'When your chat model is text-only and a separate image model is configured, describe multi-image batches in two passes: the image model first counts and labels each visible character, then describes each with that list as grounding. Helps weaker vision models keep per-character descriptions coherent across a group. Only applies when more than one image is attached — single images skip the count pass.',
                        control: { type: 'toggle', key: 'lorebookImageTwoPassDescription' }
                    }
                ]
            },
            {
                type: 'group',
                heading: 'Lore entry images',
                items: [
                    {
                        name: 'Image gallery section headings',
                        desc: "Comma-separated headings that mark a lore entry's image-gallery section (case-insensitive). The scanner parses image embeds (e.g., `![[file.png]]`) under any matching heading and surfaces them to the AI via the get_lore_image tool. Subheadings within the gallery section become per-image labels (useful for multi-form characters). Example headings: 'Reference', 'Gallery', 'Forms', 'Appearance'.",
                        render: (setting) => this.renderStringListField(setting, 'loreEntryImageSectionHeaders')
                    },
                    {
                        name: 'Max images per lore entry',
                        desc: 'Soft cap on the number of images the scanner extracts per entry. Overflow is silently dropped — the cap is a budget tool, not a content rule. The writer can still place more embeds in the note body. Default: 4.',
                        control: {
                            type: 'number',
                            key: 'loreEntryImageMaxPerEntry',
                            min: 1,
                            max: 20,
                            validate: (v) => (v >= 1 && v <= 20 ? undefined : 'Value must be between 1 and 20')
                        }
                    },
                    {
                        name: 'Agent image attachments',
                        desc: 'Allow the lorebook coach and batch tools to propose image attachments for your review. On: the coach can attach images when drafting an entry, and the batch tool can attach images to existing entries. Every attachment flows through the review queue — nothing is written without your approval. Off: the agent cannot attach images, but you can still add them manually via ![[file]] embeds. Does not affect other tools. Default: on.',
                        control: { type: 'toggle', key: 'loreEntryImageAttachments' }
                    },
                    {
                        name: 'Attachment folder',
                        desc: 'Where agent-attached images are written on approval. Empty uses Obsidian’s configured attachment folder. Vault-relative path (e.g., "Attachments/Lore").',
                        control: { type: 'text', key: 'loreEntryImageAttachmentFolder' }
                    },
                    {
                        name: 'Prefer editing existing lore',
                        desc: 'When the lorebook coach drafts a new entry whose exact name already matches a note in your vault, refuse the draft and point it at edit_note / insert_note / append_to_note instead. Avoids duplicate notes that strand [[wikilinks]] pointing at the original. Off = allow unconditional creation. Default: on.',
                        control: { type: 'toggle', key: 'lorePreferEditOverCreate' }
                    }
                ]
            },
            {
                name: 'Slash commands',
                desc: 'Shortcut snippets for the co-writer chat input. Typing "/" at the start of a line opens a picker listing matching commands; choosing one inserts the body into the input, fully editable before sending. Empty list (the default) disables the picker. Names must be kebab-case (lowercase letters, digits, hyphens; must start with a letter).',
                render: (setting) => {
                    const wrap = setting.controlEl.createDiv({ cls: 'quill-slash-command-list' });
                    /** (Re)render the command cards plus the add-command affordance. */
                    const draw = () => {
                        wrap.empty();
                        this.renderSlashCommands(wrap);
                        const addBtn = wrap.createEl('button', {
                            text: '+ add command',
                            cls: 'quill-slash-command-list__add'
                        });
                        addBtn.addEventListener('click', () => {
                            this.plugin.settings.slashCommands.push({ name: '', description: '', body: '' });
                            void this.plugin.saveSettings().then(() => this.update());
                        });
                    };
                    draw();
                }
            },
            {
                name: 'Lorebook folders',
                desc: 'Folders scanned for lore entries. Any Markdown file under one of these folders is treated as a lore entry. Set a per-folder type default so every file inherits it without frontmatter; leave as mixed to type files individually via the quill-type key.',
                render: (setting) => {
                    const wrap = setting.controlEl.createDiv({ cls: 'quill-folder-overrides-list' });
                    /** (Re)render the folder rows plus the add-folder affordance. */
                    const draw = () => {
                        wrap.empty();
                        this.renderLorebookFolders(wrap);
                        const addBtn = wrap.createEl('button', {
                            text: '+ add folder',
                            cls: 'quill-folder-overrides-list__add'
                        });
                        addBtn.addEventListener('click', () => {
                            const folders = this.getVaultFolders().filter(
                                (f) => !this.plugin.settings.lorebookFolders.includes(f)
                            );
                            new FolderSuggestModal(this.app, folders, (folder) => {
                                if (this.plugin.settings.lorebookFolders.includes(folder)) {
                                    new Notice('Folder is already a lorebook folder.');
                                    return;
                                }
                                this.plugin.settings.lorebookFolders.push(folder);
                                void this.plugin.saveSettings().then(() => this.update());
                            }).open();
                        });
                    };
                    draw();
                }
            }
        ];
    }

    /** Comma-separated text field bound to a string[] settings field (fandom wikis). */
    private renderFandomWikisField(setting: Setting): void {
        const input = setting.controlEl.createEl('input', {
            type: 'text',
            cls: 'quill-fandom-wikis-input',
            attr: { placeholder: 'Starwars, memory-alpha, lotr' }
        });
        input.value = this.plugin.settings.lorebookFandomWikis.join(', ');
        input.addEventListener('blur', () => {
            this.plugin.settings.lorebookFandomWikis = input.value
                .split(',')
                .map((s) => s.trim().toLowerCase())
                .filter((s) => s.length > 0);
            void this.plugin.saveSettings();
            input.value = this.plugin.settings.lorebookFandomWikis.join(', ');
        });
    }

    /** Comma-separated text field bound to the crutch-words list setting. */
    private renderCrutchWordsField(setting: Setting): void {
        const input = setting.controlEl.createEl('input', {
            type: 'text',
            cls: 'quill-crutch-words-input',
            attr: { placeholder: 'Just, really, that' }
        });
        input.value = this.plugin.settings.crutchWords.join(', ');
        input.addEventListener('blur', () => {
            this.plugin.settings.crutchWords = input.value
                .split(',')
                .map((s) => s.trim().toLowerCase())
                .filter((s) => s.length > 0);
            void this.plugin.saveSettings();
            input.value = this.plugin.settings.crutchWords.join(', ');
        });
    }

    /** Comma-separated text field bound to a generic string[] settings field. */
    private renderStringListField(setting: Setting, key: 'loreEntryImageSectionHeaders'): void {
        const input = setting.controlEl.createEl('input', { type: 'text', cls: 'quill-stringlist-input' });
        input.value = this.plugin.settings[key].join(', ');
        input.addEventListener('blur', () => {
            this.plugin.settings[key] = input.value
                .split(',')
                .map((s) => s.trim())
                .filter((s) => s.length > 0);
            void this.plugin.saveSettings();
            input.value = this.plugin.settings[key].join(', ');
        });
    }

    /** Per-wiki cache stats + clear-cache buttons (async stats load). */
    private renderFandomCachedWikis(setting: Setting): void {
        const wrap = setting.controlEl.createDiv({ cls: 'quill-fandom-cached-wikis' });
        /** (Re)render one row per allowlisted wiki with live cache stats + a clear button. */
        const draw = () => {
            wrap.empty();
            const wikis = this.plugin.settings.lorebookFandomWikis;
            if (wikis.length === 0) {
                wrap.createDiv({ cls: 'quill-settings__empty-hint', text: 'No allowlisted wikis to show.' });
                return;
            }
            for (const wiki of wikis) {
                const row = new Setting(wrap).setName(wiki).setDesc('Loading cache stats…');
                row.addButton((btn) =>
                    btn
                        .setButtonText('Clear')
                        .setDestructive()
                        .onClick(async () => {
                            btn.setButtonText('Clearing…').setDisabled(true);
                            await this.plugin.clearFandomWikiCache(wiki);
                            this.update();
                        })
                );
                void this.plugin.fandomCache
                    ?.getWikiStats(wiki)
                    .then((stats) => {
                        row.setDesc(formatFandomCacheStats(stats));
                    })
                    .catch(() => {
                        row.setDesc('Cache stats unavailable.');
                    });
            }
        };
        draw();
    }

    /** Declarative items for the Linter page (prose + AI-detection + gremlins rules). */
    private linterItems(): SettingDefinitionItem[] {
        return [
            {
                type: 'group',
                heading: 'Prose linter',
                items: [
                    {
                        name: 'Linter mode',
                        desc: 'Choose which rule sets are active.',
                        control: {
                            type: 'dropdown',
                            key: 'linterMode',
                            options: { all: 'All rules', prose: 'Prose rules only', ai: 'AI detection only' }
                        }
                    },
                    {
                        name: 'Lint on save',
                        desc: 'Automatically run the prose linter when the document is saved.',
                        control: { type: 'toggle', key: 'lintOnSave' }
                    },
                    {
                        name: 'Long sentences',
                        desc: 'Flag sentences exceeding the word limit below.',
                        control: { type: 'toggle', key: 'enableLongSentences' }
                    },
                    {
                        name: 'Max words per sentence',
                        desc: 'Sentences longer than this many words will be flagged.',
                        control: {
                            type: 'number',
                            key: 'maxSentenceWords',
                            min: 1,
                            validate: (v) => (v >= 1 ? undefined : 'Value must be a number >= 1')
                        }
                    },
                    {
                        name: 'Passive voice',
                        desc: 'Flag instances of passive voice. Disabled by default — it is often a valid stylistic choice in fiction.',
                        control: { type: 'toggle', key: 'enablePassiveVoice' }
                    },
                    {
                        name: 'Adverbs',
                        desc: 'Flag adverbs (e.g. Quickly, slowly, very). Enabled by default — a common teaching tool for new writers.',
                        control: { type: 'toggle', key: 'enableAdverbCheck' }
                    },
                    {
                        name: 'Qualifiers',
                        desc: 'Flag weak qualifiers (very, really, quite, etc.).',
                        control: { type: 'toggle', key: 'enableQualifierCheck' }
                    },
                    {
                        name: 'Repeated words',
                        desc: 'Flag words repeated 3+ times in a single line.',
                        control: { type: 'toggle', key: 'enableRepeatedWords' }
                    },
                    {
                        name: 'Min word length for repeats',
                        desc: 'Words shorter than this are ignored by the repeated-words rule.',
                        control: {
                            type: 'number',
                            key: 'minRepeatedWordLength',
                            min: 1,
                            validate: (v) => (v >= 1 ? undefined : 'Value must be a number >= 1')
                        }
                    },
                    {
                        name: 'Echoes',
                        desc: 'Flag sentences in a paragraph that start with the same two words.',
                        control: { type: 'toggle', key: 'enableEchoes' }
                    },
                    {
                        name: 'Telling vs showing',
                        desc: 'Flag emotional tells (e.g. He felt angry) that could be shown instead.',
                        control: { type: 'toggle', key: 'enableTellingVsShowing' }
                    },
                    {
                        name: 'Dialogue tags',
                        desc: 'Flag overused or repetitive dialogue tags.',
                        control: { type: 'toggle', key: 'enableDialogueTags' }
                    },
                    {
                        name: 'Complex words',
                        desc: 'Flag words with many syllables that may be hard to read.',
                        control: { type: 'toggle', key: 'enableComplexWords' }
                    },
                    {
                        name: 'Max syllables per word',
                        desc: 'Words with at least this many syllables are flagged by the complex-words rule.',
                        control: {
                            type: 'number',
                            key: 'maxSyllablesPerWord',
                            min: 1,
                            validate: (v) => (v >= 1 ? undefined : 'Value must be a number >= 1')
                        }
                    }
                ]
            },
            {
                type: 'group',
                heading: 'Crutch words',
                items: [
                    {
                        name: 'Crutch-word detection',
                        desc: 'Flag your personal overused words (defined below) once each exceeds the limit. On by default; does nothing until you add words.',
                        control: { type: 'toggle', key: 'enableCrutchWords' }
                    },
                    {
                        name: 'Crutch words',
                        desc: 'Comma-separated words you tend to overuse (e.g. "just, really, that"). Each is flagged once it appears more than the limit below.',
                        render: (setting) => this.renderCrutchWordsField(setting)
                    },
                    {
                        name: 'Crutch-word limit',
                        desc: 'A crutch word is flagged once it appears more than this many times in the document.',
                        control: {
                            type: 'number',
                            key: 'crutchWordThreshold',
                            min: 1,
                            validate: (v) => (v >= 1 ? undefined : 'Value must be a number >= 1')
                        }
                    }
                ]
            },
            {
                type: 'group',
                heading: 'AI detection',
                items: [
                    {
                        name: 'AI clichés',
                        desc: 'Flag overused AI words (tapestry, testament, delve, vibrant, realm, etc.).',
                        control: { type: 'toggle', key: 'enableAiCliches' }
                    },
                    {
                        name: 'Em dashes',
                        desc: 'Flag em dashes (—). Common AI overuse — consider commas, colons, or sentence breaks.',
                        control: { type: 'toggle', key: 'enableAiEmDashes' }
                    },
                    {
                        name: 'Negation patterns',
                        desc: 'Flag "it\'s not X, it\'s y" constructions. State what things are directly.',
                        control: { type: 'toggle', key: 'enableAiNegation' }
                    },
                    {
                        name: 'Filler adverbs',
                        desc: 'Flag strategy adverbs common in AI prose (quietly, deliberately, gently, etc.).',
                        control: { type: 'toggle', key: 'enableAiFillerAdverbs' }
                    },
                    {
                        name: 'Hedging language',
                        desc: 'Flag hedging words (might, could, perhaps, maybe) that weaken prose.',
                        control: { type: 'toggle', key: 'enableAiHedging' }
                    },
                    {
                        name: 'Wrap-up phrases',
                        desc: 'Flag concluding phrases (in conclusion, to summarize, ultimately, etc.).',
                        control: { type: 'toggle', key: 'enableAiWrapUps' }
                    }
                ]
            },
            {
                type: 'group',
                heading: 'Gremlins',
                items: [
                    {
                        name: 'Invisible character detection',
                        desc: 'Flag invisible / zero-width / non-printing unicode characters (formatting controls, soft hyphens, variation selectors, etc.) that may be AI watermarks or copy-paste artifacts.',
                        control: { type: 'toggle', key: 'enableGremlins' }
                    },
                    {
                        name: 'Aggressive scanning',
                        desc: 'Scan for every unicode format character, including those legitimately used in emoji (keycaps, zwj sequences, variation selectors, tag characters, etc.). Recommended for security audits.',
                        control: {
                            type: 'toggle',
                            key: 'enableAggressiveGremlins',
                            disabled: () => !this.plugin.settings.enableGremlins
                        }
                    }
                ]
            },
            {
                name: 'Restore defaults',
                desc: 'Reset all linter settings to their default values.',
                action: () => {
                    void this.restoreLinterDefaults();
                }
            }
        ];
    }

    /** Restore-defaults action for the Linter page (linter-related fields only). */
    private async restoreLinterDefaults(): Promise<void> {
        const s = this.plugin.settings;
        const d = DEFAULT_SETTINGS;
        s.linterMode = d.linterMode;
        s.lintOnSave = d.lintOnSave;
        s.enableLongSentences = d.enableLongSentences;
        s.maxSentenceWords = d.maxSentenceWords;
        s.enablePassiveVoice = d.enablePassiveVoice;
        s.enableAdverbCheck = d.enableAdverbCheck;
        s.enableQualifierCheck = d.enableQualifierCheck;
        s.enableRepeatedWords = d.enableRepeatedWords;
        s.minRepeatedWordLength = d.minRepeatedWordLength;
        s.enableEchoes = d.enableEchoes;
        s.enableTellingVsShowing = d.enableTellingVsShowing;
        s.enableDialogueTags = d.enableDialogueTags;
        s.enableComplexWords = d.enableComplexWords;
        s.maxSyllablesPerWord = d.maxSyllablesPerWord;
        s.enableAiCliches = d.enableAiCliches;
        s.enableAiEmDashes = d.enableAiEmDashes;
        s.enableAiNegation = d.enableAiNegation;
        s.enableAiFillerAdverbs = d.enableAiFillerAdverbs;
        s.enableAiHedging = d.enableAiHedging;
        s.enableAiWrapUps = d.enableAiWrapUps;
        s.enableGremlins = d.enableGremlins;
        s.enableAggressiveGremlins = d.enableAggressiveGremlins;
        s.enableCrutchWords = d.enableCrutchWords;
        s.crutchWords = d.crutchWords;
        s.crutchWordThreshold = d.crutchWordThreshold;
        await this.plugin.saveSettings();
        this.update();
    }

    /** Render the AI providers configuration section. */
    /** Declarative items for the AI providers page: a list of navigable provider pages + a default-models page. */
    private aiProvidersItems(): SettingDefinitionItem[] {
        return [
            {
                type: 'list',
                heading: 'AI providers',
                emptyState: 'No providers configured. Click "Add provider" to set one up.',
                items: this.plugin.settings.aiProviders.map((p) => this.providerPageDefinition(p)),
                onDelete: (index) => {
                    this.plugin.settings.aiProviders.splice(index, 1);
                    this.validateDefaultProviders();
                    void this.plugin.saveSettings().then(() => this.update());
                },
                addItem: {
                    name: 'Add provider',
                    action: () => {
                        new AddProviderModal(this.app, (type, defaultEndpoint) =>
                            this.addProvider(type, defaultEndpoint)
                        ).open();
                    }
                }
            },
            {
                type: 'page',
                name: 'Default models',
                desc: 'Default chat, embed, and image models across all providers.',
                page: () => new DefaultModelsSettingPage(this),
                displayValue: this.defaultModelDisplayValue(),
                status: this.plugin.settings.aiDefaultChatProvider ? null : 'warning'
            }
        ];
    }

    /** Declarative page entry for one provider (model-count summary + warning status). */
    private providerPageDefinition(provider: ProviderConfig): SettingDefinitionPage {
        const count = provider.models.length;
        return {
            type: 'page',
            name: provider.name || 'Unnamed provider',
            desc: `${provider.type} • ${count} model${count === 1 ? '' : 's'}`,
            page: () => new ProviderSettingPage(this, provider),
            displayValue: `${count} model${count === 1 ? '' : 's'}`,
            status: count === 0 ? 'warning' : null
        };
    }

    /**
     * Deep-link into a settings page by name (e.g. "AI providers", "General"),
     * optionally hopping into a sub-page and scrolling to a specific setting
     * within it. Uses Obsidian's internal settings-nav API — `openTabById` is
     * the long-standing convention; `getNavigableSettingItems`/`activateSettingItem`
     * are its 1.13 declarative counterparts. Feature-detected: if the internal
     * API is unavailable (renamed/removed in a future build), falls back to just
     * opening the plugin tab so the writer can pick the page themselves.
     *
     * Navigation is poll-based because every hop (root list → page → sub-page)
     * re-renders asynchronously; `waitForAndActivate` retries until the target
     * entry shows up in `getNavigableSettingItems()` before activating it.
     */
    openSettingsPage(pageName: string, settingName?: string, subPageName?: string): void {
        const app = this.app as unknown as {
            setting?: {
                open?: () => void;
                openTabById?: (id: string) => void;
                clearPageStack?: () => void;
                getNavigableSettingItems?: () => HTMLElement[];
                activateSettingItem?: (el: HTMLElement) => void;
                getCurrentPageEl?: () => HTMLElement | null;
            };
        };
        const s = app.setting;
        if (!s?.open || !s.openTabById) return;
        s.open();
        s.openTabById(this.plugin.manifest.id);
        // Reset to the root page list so the target page entry is visible
        // (we may currently be deep in a sub-page).
        if (typeof s.clearPageStack === 'function') s.clearPageStack();

        // settings.ts — no Component lifecycle; window.setTimeout (one-shot).
        /** Poll `getNavigableSettingItems()` until the named entry appears, then activate it and run `then`. */
        const waitForAndActivate = (name: string, then: () => void, attempts = 0): void => {
            const items = typeof s.getNavigableSettingItems === 'function' ? s.getNavigableSettingItems() : [];
            const target = items.find((el: HTMLElement) => {
                const elName = el.querySelector('.setting-item-name')?.textContent?.trim() ?? '';
                return elName === name;
            });
            if (target && typeof s.activateSettingItem === 'function') {
                s.activateSettingItem(target);
                then();
            } else if (attempts < 15) {
                window.setTimeout(() => waitForAndActivate(name, then, attempts + 1), 60);
            }
        };

        /** After the page activates, drill into the optional sub-page, then scroll to the setting. */
        const hopIntoSubPage = (): void => {
            if (!subPageName) {
                if (settingName) this.scrollToSetting(settingName);
                return;
            }
            waitForAndActivate(subPageName, () => {
                if (settingName) this.scrollToSetting(settingName);
            });
        };

        waitForAndActivate(pageName, hopIntoSubPage);
    }

    /**
     * Find a setting by name on the active settings page, scroll it into view,
     * and flash it briefly. Retries up to ~1s while the page-transition
     * renders the target items.
     */
    private scrollToSetting(settingName: string): void {
        // settings.ts — no Component lifecycle; window.setTimeout for the
        // page-transition delay + flash removal (one-shot, not recurring).
        let attempts = 0;
        /** Locate the named setting row on the current page, center it, and flash it. */
        const tryScroll = () => {
            const app = this.app as unknown as { setting?: { getCurrentPageEl?: () => HTMLElement | null } };
            const pageEl = typeof app.setting?.getCurrentPageEl === 'function' ? app.setting.getCurrentPageEl() : null;
            if (pageEl) {
                const matches = pageEl.querySelectorAll('.setting-item');
                for (const item of Array.from(matches)) {
                    const name = item.querySelector('.setting-item-name')?.textContent?.trim() ?? '';
                    if (name === settingName) {
                        const el = item as HTMLElement;
                        el.scrollIntoView({ block: 'center' });
                        el.addClass('quill-settings__flash');
                        window.setTimeout(() => el.removeClass('quill-settings__flash'), 2500);
                        return;
                    }
                }
            }
            if (++attempts < 10) window.setTimeout(tryScroll, 100);
        };
        window.setTimeout(tryScroll, 100);
    }

    /** Display value for the AI providers page entry (configured-provider count, or "Not configured"). */
    private aiProviderDisplayValue(): string {
        const n = this.plugin.settings.aiProviders.length;
        return n === 0 ? 'Not configured' : `${n} provider${n === 1 ? '' : 's'}`;
    }

    /**
     * Warning status for the AI providers page entry. Flags the two states that
     * silently break every AI feature: no providers configured, or no default
     * chat model picked.
     */
    private aiProviderStatus(): 'warning' | null {
        return this.plugin.settings.aiProviders.length === 0 || !this.plugin.settings.aiDefaultChatProvider
            ? 'warning'
            : null;
    }

    /** Display value for the Default models page entry (resolved chat model, or "Not set"). */
    private defaultModelDisplayValue(): string {
        const key = this.plugin.settings.aiDefaultChatProvider;
        if (!key) return 'Not set';
        const slash = key.indexOf('/');
        if (slash < 0) return 'Not set';
        const pid = key.slice(0, slash);
        const mid = key.slice(slash + 1);
        const provider = this.plugin.settings.aiProviders.find((p) => p.id === pid);
        const model = provider?.models.find((m) => m.id === mid);
        return provider && model ? `${provider.name} — ${model.model}` : 'Not set';
    }

    /**
     * Render a full provider detail page (fields + model list + test buttons).
     * Public so {@link ProviderSettingPage} can call it; reuses the private
     * card renderers. Mutation handlers inside call refreshBridge(), which
     * re-renders the open provider page in place (via the bridge machinery).
     */
    renderProviderPage(containerEl: HTMLElement, provider: ProviderConfig): void {
        this.renderProviderFields(containerEl, provider);
        this.renderModelList(containerEl, provider);
        this.renderTestButtons(containerEl, provider);
    }

    /** Render a provider's editable fields (everything except the list-managed delete affordance). */
    private renderProviderFields(containerEl: HTMLElement, provider: ProviderConfig): void {
        // Name
        new Setting(containerEl)
            .setName('Name')
            .setDesc('A display name for this provider.')
            .addText((text) =>
                text.setValue(provider.name).onChange(async (value) => {
                    provider.name = value;
                    await this.plugin.saveSettings();
                })
            );

        // Type
        new Setting(containerEl)
            .setName('Type')
            .setDesc('The API format this provider uses.')
            .addDropdown((dropdown) =>
                dropdown
                    .addOption('openai-compatible', 'OpenAI-compatible')
                    .addOption('ollama', 'Ollama')
                    .addOption('anthropic', 'Anthropic Claude (native)')
                    .addOption('gemini', 'Google Gemini (native)')
                    .setValue(provider.type)
                    .onChange(async (value) => {
                        const newType = value as ProviderType;
                        // The Anthropic ban-risk warning fires before the type
                        // change is committed. Selecting Anthropic without prior
                        // acknowledgment triggers a confirmation modal; the type
                        // only flips if the writer confirms (or has already
                        // acknowledged in a prior session).
                        if (newType === 'anthropic' && !this.plugin.settings.anthropicBanRiskAcknowledged) {
                            this.openAnthropicBanRiskWarning(() => {
                                provider.type = newType;
                                provider.endpoint = 'https://api.anthropic.com/v1';
                                void this.plugin.saveSettings().then(() => this.refreshBridge());
                            });
                            // Revert the dropdown visually so a dismissed warning
                            // doesn't leave the type half-changed.
                            dropdown.setValue(provider.type);
                            return;
                        }
                        provider.type = newType;
                        if (newType === 'ollama') {
                            provider.endpoint = 'http://localhost:11434';
                            provider.apiKey = '';
                        } else if (newType === 'anthropic') {
                            provider.endpoint = 'https://api.anthropic.com/v1';
                        } else if (newType === 'gemini') {
                            provider.endpoint = 'https://generativelanguage.googleapis.com/v1beta';
                        }
                        await this.plugin.saveSettings();
                        this.refreshBridge();
                    })
            );

        // Endpoint URL
        new Setting(containerEl)
            .setName('Endpoint URL')
            .setDesc('The full base URL of the API endpoint. Used as-is with no path manipulation.')
            .addText((text) =>
                text
                    .setValue(provider.endpoint)
                    .setPlaceholder('E.g., http://localhost:1234/v1')
                    .onChange(async (value) => {
                        provider.endpoint = value;
                        await this.plugin.saveSettings();
                    })
            );

        // API Key — shown for OpenAI-compatible, Anthropic, and Gemini
        // (Ollama is local-only and hides the field entirely).
        if (provider.type !== 'ollama') {
            const apiKeyDesc =
                provider.type === 'anthropic'
                    ? 'Anthropic Console API key (sk-ant-...). Required.'
                    : provider.type === 'gemini'
                      ? 'Google AI Studio API key (AIza...). Required. Free tier available from ai.google.dev.'
                      : 'Optional. Leave blank for local providers.';
            const apiKeyPlaceholder =
                provider.type === 'anthropic' ? 'sk-ant-...' : provider.type === 'gemini' ? 'AIza...' : 'E.g., sk-...';
            new Setting(containerEl)
                .setName('API key')
                .setDesc(apiKeyDesc)
                .addText((text) =>
                    text
                        .setValue(provider.apiKey)
                        .setPlaceholder(apiKeyPlaceholder)
                        .onChange(async (value) => {
                            provider.apiKey = value;
                            await this.plugin.saveSettings();
                        })
                )
                .then((setting) => {
                    // Make it a password field
                    const input = setting.controlEl.querySelector('input');
                    if (input) input.type = 'password';
                });
        }

        // Context window
        new Setting(containerEl)
            .setName('Context window')
            .setDesc('Maximum context tokens for models on this endpoint.')
            .addDropdown((dropdown) => {
                for (const opt of POWER_OF_TWO_OPTIONS) {
                    dropdown.addOption(String(opt), String(opt));
                }
                dropdown.addOption('custom', 'Custom...');
                const current = String(provider.maxContextTokens);
                if (POWER_OF_TWO_OPTIONS.includes(provider.maxContextTokens)) {
                    dropdown.setValue(current);
                } else {
                    dropdown.setValue('custom');
                    containerEl.createDiv({
                        cls: 'quill-provider-card__setting-extra',
                        text: `Custom value: ${current}`
                    });
                }
                dropdown.onChange(async (value) => {
                    if (value === 'custom') {
                        new InputModal(this.app, 'Enter context token count', 'e.g. 24576', (customVal) => {
                            const n = parseInt(customVal, 10);
                            if (!isNaN(n) && n > 0) {
                                provider.maxContextTokens = n;
                                void this.plugin.saveSettings().then(() => this.refreshBridge());
                            } else {
                                new Notice('Value must be a positive number');
                            }
                        }).open();
                        return;
                    }
                    provider.maxContextTokens = parseInt(value, 10);
                    await this.plugin.saveSettings();
                    this.refreshBridge();
                });
            });

        // Max output tokens
        new Setting(containerEl)
            .setName('Max output tokens')
            .setDesc('Maximum tokens per response for all models on this endpoint.')
            .addText((text) =>
                text.setValue(String(provider.maxOutputTokens)).inputEl.addEventListener('blur', () => {
                    const n = parseInt(text.inputEl.value, 10);
                    if (!isNaN(n) && n >= 1) {
                        provider.maxOutputTokens = n;
                        void this.plugin.saveSettings();
                    } else {
                        text.setValue(String(provider.maxOutputTokens));
                        new Notice('Value must be a number ≥ 1');
                    }
                })
            );

        // Extra request parameters (advanced) — arbitrary JSON merged into every
        // chat-completion request body. Power-user escape hatch for gateway-
        // specific knobs (reasoning_effort, GLM thinking config, …). Mirrors the
        // raw addEventListener-on-blur idiom used by the surrounding fields.
        new Setting(containerEl)
            .setName('Extra request parameters')
            .setDesc(
                'Advanced. A JSON object merged into every chat request body — e.g. ' +
                    '{"reasoning_effort": "high"} or {"thinking": {"type": "enabled"}}. ' +
                    'Reserved keys (model, messages, stream) are ignored.'
            )
            .addTextArea((area) => {
                area.setPlaceholder('{"reasoning_effort": "high"}').setValue(provider.extraRequestBody ?? '');
                area.inputEl.rows = 3;
                // Live JSON lint is DISPLAY ONLY — it flags malformed input with
                // an inline error + red border as the writer types. The raw text
                // is always saved so in-progress edits persist; the provider
                // parses + merges only valid JSON, so malformed parameters never
                // reach a request.
                const status = area.inputEl.parentElement?.createDiv({ cls: 'quill-extra-body__status' });
                /** Set the inline lint status message and toggle the error UI. */
                const setStatus = (msg: string | null): void => {
                    if (!status) return;
                    if (msg) {
                        status.setText(msg);
                        status.addClass('quill-extra-body__status--error');
                        area.inputEl.addClass('quill-extra-body__input--invalid');
                    } else {
                        status.setText('');
                        status.removeClass('quill-extra-body__status--error');
                        area.inputEl.removeClass('quill-extra-body__input--invalid');
                    }
                };
                /** Lint the textarea value for display; does not gate saving. */
                const lint = (): void => {
                    const raw = area.inputEl.value.trim();
                    if (raw === '') {
                        setStatus(null);
                        return;
                    }
                    try {
                        const parsed: unknown = JSON.parse(raw);
                        setStatus(
                            typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
                                ? null
                                : 'Must be a JSON object (not an array or a bare value).'
                        );
                    } catch (e) {
                        setStatus(`Invalid JSON: ${e instanceof Error ? e.message : 'parse error'}`);
                    }
                };
                area.inputEl.addEventListener('input', () => lint());
                // Save the raw text unconditionally — malformed input persists for
                // the writer to fix but is never applied (the provider ignores it).
                area.inputEl.addEventListener('blur', () => {
                    provider.extraRequestBody = area.inputEl.value.trim() || undefined;
                    void this.plugin.saveSettings();
                });
                lint();
            })
            .then((s) => {
                // Gemini's body is nested (generationConfig, systemInstruction), so
                // the merge is shallow — point advanced users at the schema.
                if (provider.type === 'gemini') {
                    s.descEl.append(' Gemini uses a nested generationConfig — see ');
                    s.descEl.createEl('a', {
                        href: 'https://ai.google.dev/api/generate-content',
                        text: "Google's documentation",
                        attr: { target: '_blank', rel: 'noreferrer noopener' }
                    });
                    s.descEl.append(' for the full schema.');
                }
            });
    }

    /** Render the model list for a provider. */
    private renderModelList(containerEl: HTMLElement, provider: ProviderConfig): void {
        containerEl.createDiv({
            cls: 'quill-provider-card__models-heading',
            text: 'Models'
        });

        for (const [mIdx, model] of provider.models.entries()) {
            const modelCard = containerEl.createDiv({ cls: 'quill-provider-card__model' });

            new Setting(modelCard)
                .setName(`Model ${mIdx + 1}`)
                .setDesc(
                    'Use "Chat + image" for a vision-capable chat model (e.g. Gemma 4), or ' +
                        '"Image" for a dedicated model that describes images when your chat model is text-only.'
                )
                .addDropdown((dropdown) =>
                    dropdown
                        .addOption('chat', 'Chat')
                        .addOption('embed', 'Embed')
                        .addOption('both', 'Both')
                        .addOption('chat-image', 'Chat + image')
                        .addOption('image', 'Image')
                        .setValue(model.role)
                        .onChange(async (value) => {
                            model.role = value as ModelRole;
                            this.validateDefaultProviders();
                            await this.plugin.saveSettings();
                            this.refreshBridge();
                        })
                );

            new Setting(modelCard)
                .setName('Model ID')
                .setDesc('The model identifier sent to the API.')
                .addText((text) =>
                    text
                        .setValue(model.model)
                        .setPlaceholder('E.g., llama-3.3-70b')
                        .onChange(async (value) => {
                            model.model = value;
                            await this.plugin.saveSettings();
                        })
                )
                .addButton((button) =>
                    button
                        .setButtonText('Fetch models')
                        .setIcon('search')
                        .onClick(async () => {
                            await this.fetchAndSuggestModels(provider, model);
                        })
                );

            // Remove model button
            new Setting(modelCard).addButton((button) =>
                button.setButtonText('Remove model').onClick(async () => {
                    const idx = provider.models.indexOf(model);
                    if (idx !== -1) {
                        provider.models.splice(idx, 1);
                        this.validateDefaultProviders();
                        await this.plugin.saveSettings();
                        this.refreshBridge();
                    }
                })
            );
        }

        // Add model button
        new Setting(containerEl).addButton((button) =>
            button.setButtonText('Add model').onClick(async () => {
                const role = provider.models.length === 0 ? 'chat' : 'embed';
                const newModelId = generateModelId(`model-${provider.models.length + 1}`, role);
                provider.models.push({
                    id: newModelId,
                    role,
                    model: ''
                });
                await this.plugin.saveSettings();
                this.refreshBridge();
            })
        );
    }

    /** Render test connection and test embeddings buttons. */
    private renderTestButtons(containerEl: HTMLElement, provider: ProviderConfig): void {
        const testRow = containerEl.createDiv({ cls: 'quill-provider-card__test-row' });

        new Setting(testRow)
            .addButton((button) =>
                button.setButtonText('Test connection').onClick(async () => {
                    button.setDisabled(true);
                    button.setButtonText('Testing...');
                    try {
                        const ai = createProvider(provider);
                        const result = await ai.testConnection();
                        if (result.ok) {
                            new Notice(`Connected to "${provider.name}"`);
                        } else {
                            new Notice(`Connection failed: ${result.error}`);
                        }
                    } catch (err: unknown) {
                        const msg = err instanceof Error ? err.message : String(err);
                        new Notice(`Connection test error: ${msg}`);
                    } finally {
                        button.setDisabled(false);
                        button.setButtonText('Test connection');
                    }
                })
            )
            .addButton((button) =>
                button.setButtonText('Test embeddings').onClick(async () => {
                    button.setDisabled(true);
                    button.setButtonText('Testing...');
                    try {
                        const ai = createProvider(provider);
                        const result = await ai.testEmbeddings();
                        if (result.ok) {
                            new Notice(`Embeddings endpoint works for "${provider.name}"`);
                        } else {
                            new Notice(`Embeddings test failed: ${result.error}`);
                        }
                    } catch (err: unknown) {
                        const msg = err instanceof Error ? err.message : String(err);
                        new Notice(`Embeddings test error: ${msg}`);
                    } finally {
                        button.setDisabled(false);
                        button.setButtonText('Test embeddings');
                    }
                })
            );
    }

    /** Render the default chat/embed/image model dropdowns. Public so {@link DefaultModelsSettingPage} can call it. */
    renderDefaultModelSettings(containerEl: HTMLElement): void {
        // Collect chat-, embed-, and image-capable models across providers.
        // Image models may live on a different provider than chat — the proxy
        // caption call is fully isolated, so cross-provider routing is fine.
        const chatModels: { key: string; name: string }[] = [];
        const embedModels: { key: string; name: string }[] = [];
        const imageModels: { key: string; name: string }[] = [];

        for (const provider of this.plugin.settings.aiProviders) {
            for (const model of provider.models) {
                const key = `${provider.id}/${model.id}`;
                const name = `${provider.name} — ${model.model}`;
                if (roleSatisfies(model.role, 'chat')) {
                    chatModels.push({ key, name });
                }
                if (roleSatisfies(model.role, 'embed')) {
                    embedModels.push({ key, name });
                }
                if (roleSatisfies(model.role, 'image')) {
                    imageModels.push({ key, name });
                }
            }
        }

        new Setting(containerEl).setName('Default models').setHeading();

        new Setting(containerEl)
            .setName('Default chat model')
            .setDesc('The default model used for chat completions.')
            .addDropdown((dropdown) => {
                if (chatModels.length === 0) {
                    dropdown.addOption('', 'No chat models configured');
                } else {
                    for (const m of chatModels) {
                        dropdown.addOption(m.key, m.name);
                    }
                }
                dropdown.setValue(
                    chatModels.some((m) => m.key === this.plugin.settings.aiDefaultChatProvider)
                        ? this.plugin.settings.aiDefaultChatProvider
                        : ''
                );
                dropdown.onChange(async (value) => {
                    this.plugin.settings.aiDefaultChatProvider = value;
                    await this.plugin.saveSettings();
                    // Refresh the AI-providers / Default-models entry status indicators.
                    this.update();
                });
            });

        new Setting(containerEl)
            .setName('Default embed model')
            .setDesc('The default model used for embeddings.')
            .addDropdown((dropdown) => {
                if (embedModels.length === 0) {
                    dropdown.addOption('', 'No embed models configured');
                } else {
                    for (const m of embedModels) {
                        dropdown.addOption(m.key, m.name);
                    }
                }
                dropdown.setValue(
                    embedModels.some((m) => m.key === this.plugin.settings.aiDefaultEmbedProvider)
                        ? this.plugin.settings.aiDefaultEmbedProvider
                        : ''
                );
                dropdown.onChange(async (value) => {
                    const oldValue = this.plugin.settings.aiDefaultEmbedProvider;
                    if (value === oldValue) return;

                    // Reset dropdown to old value so cancellation doesn't leave stale UI state.
                    dropdown.setValue(oldValue);

                    // Warn that changing the embed model invalidates all cached embeddings.
                    new ConfirmModal(
                        this.app,
                        'Change embed model?',
                        'Changing the embed model will invalidate all cached embeddings in your vault. ' +
                            'Embedding cache files (quill-embeddings.json) will be deleted and rebuilt ' +
                            'with the new model. This may take a moment for large vaults.',
                        async () => {
                            await this.plugin.invalidateAllEmbeddingCaches();
                            this.plugin.settings.aiDefaultEmbedProvider = value;
                            // Auto-enable embedding warming — otherwise caches won't
                            // stay fresh and the model serves no purpose on its own.
                            if (!this.plugin.settings.enableEmbeddingWarming) {
                                this.plugin.settings.enableEmbeddingWarming = true;
                                new Notice(
                                    'Quill: Embedding warming enabled to keep caches fresh. ' +
                                        'Turn it off in settings if you prefer manual control.'
                                );
                            }
                            await this.plugin.saveSettings();
                            // Re-warm caches with the new model.
                            void this.plugin.warmAllEmbeddingCaches();
                            // Update dropdown to reflect the confirmed value.
                            dropdown.setValue(value);
                            new Notice('Quill: Embed model changed. Caches will rebuild in the background.');
                        },
                        'Change model'
                    ).open();
                });
            });

        new Setting(containerEl)
            .setName('Default image model')
            .setDesc(
                'The model used to interpret images (character art, maps, reference photos). ' +
                    'When your chat model is vision-capable (role "Chat + image"), images go ' +
                    'directly to it and this is unused. Otherwise this model describes images ' +
                    'into text for the chat model — it may live on a different provider.'
            )
            .addDropdown((dropdown) => {
                // Always offer an explicit "None" (empty value) so the slot can
                // be cleared back to the intentional no-image-model state even
                // once image models exist.
                dropdown.addOption('', imageModels.length === 0 ? 'None (no image models configured)' : 'None');
                for (const m of imageModels) {
                    dropdown.addOption(m.key, m.name);
                }
                dropdown.setValue(
                    imageModels.some((m) => m.key === this.plugin.settings.aiDefaultImageProvider)
                        ? this.plugin.settings.aiDefaultImageProvider
                        : ''
                );
                dropdown.onChange(async (value) => {
                    this.plugin.settings.aiDefaultImageProvider = value;
                    await this.plugin.saveSettings();
                });
            });
    }

    /** Render the Model behaviors settings tab. */
    /**
     * Declarative items for the Model behaviors page. Native controls for every
     * simple setting; each section's restore-defaults is the group's
     * `extraButtons` (a small "reset" icon in the heading). The narrative-voice
     * preset is a dropdown; its custom-rules textarea is a separate control
     * visible only for the `custom` preset (setControlValue re-evaluates
     * visibility via refreshDomState). Embedding warming's kick-off side-effect
     * lives in setControlValue. Folder-specific chunk overrides are a render
     * item (a dynamic-key map that doesn't fit the fixed-key control model).
     */
    private modelBehaviorsItems(): SettingDefinitionItem[] {
        /** Build a group's extraButtons entry: a reset icon that runs the given restore callback. */
        const restore = (tooltip: string, fn: () => Promise<void>) => ({
            extraButtons: [
                (btn: ExtraButtonComponent) =>
                    btn
                        .setIcon('rotate-ccw')
                        .setTooltip(tooltip)
                        .onClick(() => void fn())
            ]
        });
        return [
            {
                type: 'group',
                heading: 'Selection transformations',
                ...restore('Restore transformation defaults', () => this.restoreTransformDefaults()),
                items: [
                    {
                        name: 'Narrative voice',
                        desc: 'The narrative perspective and tense used when generating text.',
                        control: {
                            type: 'dropdown',
                            key: 'narrativeVoicePreset',
                            options: Object.fromEntries(NARRATIVE_VOICE_PRESETS.map((p) => [p.id, p.label]))
                        }
                    },
                    {
                        name: 'Custom narrative voice rules',
                        desc: 'Rules for your custom narrative voice (only used when the preset is "Custom").',
                        visible: () => this.plugin.settings.narrativeVoicePreset === 'custom',
                        control: { type: 'textarea', key: 'customNarrativeVoiceRules', rows: 6 }
                    },
                    {
                        name: 'Temperature',
                        desc: 'Higher values produce more creative output. Range: 0.0 – 2.0.',
                        control: {
                            type: 'number',
                            key: 'transformTemperature',
                            min: 0,
                            max: 2,
                            step: 0.1,
                            validate: (v) => (v >= 0 && v <= 2 ? undefined : 'Value must be between 0.0 and 2.0')
                        }
                    },
                    {
                        name: 'Vault context',
                        desc: 'Include cross-document vault context (character notes, worldbuilding, etc.) in transformation prompts.',
                        control: { type: 'toggle', key: 'transformVaultContext' }
                    },
                    {
                        name: 'Max output tokens',
                        desc: 'Maximum tokens per transformation response. Higher values allow longer rewrites.',
                        control: {
                            type: 'number',
                            key: 'transformMaxOutputTokens',
                            min: 1,
                            validate: (v) => (v >= 1 ? undefined : 'Value must be a number >= 1')
                        }
                    },
                    {
                        name: 'Wiki link handling',
                        desc: 'How AI should handle Obsidian wiki links ([[...]]) when rewriting or generating prose. "preserve" keeps them exactly as-is. "adaptive" allows the AI to adapt the display text after the pipe (|) to fit the prose while keeping the page name and heading intact.',
                        control: {
                            type: 'dropdown',
                            key: 'wikiLinkBehavior',
                            options: { preserve: 'Preserve exactly', adaptive: 'Adaptive (smart display text)' }
                        }
                    }
                ]
            },
            {
                type: 'group',
                heading: 'Co-writer',
                ...restore('Restore co-writer defaults', () => this.restoreCoWriterDefaults()),
                items: [
                    {
                        name: 'Temperature',
                        desc: 'Higher values produce more creative continuations. Range: 0.0 – 2.0.',
                        control: {
                            type: 'number',
                            key: 'coWriterTemperature',
                            min: 0,
                            max: 2,
                            step: 0.1,
                            validate: (v) => (v >= 0 && v <= 2 ? undefined : 'Value must be between 0.0 and 2.0')
                        }
                    },
                    {
                        name: 'Max output tokens',
                        desc: 'Maximum tokens per continuation. Higher values allow longer passages.',
                        control: {
                            type: 'number',
                            key: 'coWriterMaxOutputTokens',
                            min: 1,
                            validate: (v) => (v >= 1 ? undefined : 'Value must be a number >= 1')
                        }
                    },
                    {
                        name: 'Max tool rounds',
                        desc: 'Maximum number of tool-calling rounds per response. Set to 0 for unlimited — the model will call as many rounds as it needs (use Stop to cancel). Set a specific number to cap turn consumption. Default: 0 (unlimited).',
                        control: {
                            type: 'number',
                            key: 'coWriterMaxToolRounds',
                            min: 0,
                            validate: (v) => (v >= 0 ? undefined : 'Value must be a number >= 0')
                        }
                    },
                    {
                        name: 'Saved conversation limit',
                        desc: 'How many co-writer conversations to keep on disk. Starting a new chat saves the current one; older sessions are deleted (newest-first) once this limit is exceeded. Set to 0 to keep all. Default: 25.',
                        control: {
                            type: 'number',
                            key: 'coWriterSessionHistoryLimit',
                            min: 0,
                            validate: (v) => (v >= 0 ? undefined : 'Value must be a number >= 0')
                        }
                    },
                    {
                        name: 'Auto-save after each turn',
                        desc: 'Snapshot the active conversation to its saved-session file after every completed turn, so it survives a crash or restart without an explicit save. Off by default — the snapshot copies the full conversation state, so it adds some overhead on long sessions. De-bounced so a turn followed immediately by auto-options collapses to one write.',
                        control: { type: 'toggle', key: 'coWriterAutoSavePerTurn' }
                    },
                    {
                        name: 'Vault context',
                        desc: 'Include cross-document vault context (character notes, worldbuilding, etc.) in co-writer prompts.',
                        control: { type: 'toggle', key: 'coWriterVaultContext' }
                    },
                    {
                        name: 'Append trailing newline',
                        desc: 'Add a blank line after the continuation so you can keep writing without pressing enter twice.',
                        control: { type: 'toggle', key: 'coWriterAppendNewline' }
                    },
                    {
                        name: 'Show AI reasoning',
                        desc: "Display the AI's thought process in the co-writer panel. Disable for a cleaner interface.",
                        control: { type: 'toggle', key: 'enableCoWriterThought' }
                    },
                    {
                        name: 'Voice matching',
                        desc: 'Analyze the voice of your prose before generating to produce more consistent continuations. Adds a small delay before generation starts.',
                        control: { type: 'toggle', key: 'coWriterVoiceMatch' }
                    },
                    {
                        name: 'Inline directives',
                        desc: 'Parse `<!-- quill: ... -->` comments immediately preceding the cursor and feed them to the co-writer as steering. Disable to ignore directives entirely.',
                        control: { type: 'toggle', key: 'enableInlineDirectives' }
                    }
                ]
            },
            {
                type: 'group',
                heading: 'Analysis',
                ...restore('Restore analysis defaults', () => this.restoreAnalysisDefaults()),
                items: [
                    {
                        name: 'Analysis temperature',
                        desc: 'Temperature for AI analysis and feedback responses (companion mode). Range: 0.0 – 2.0.',
                        control: {
                            type: 'number',
                            key: 'analysisTemperature',
                            min: 0,
                            max: 2,
                            step: 0.1,
                            validate: (v) => (v >= 0 && v <= 2 ? undefined : 'Value must be between 0.0 and 2.0')
                        }
                    },
                    {
                        name: 'Analysis max output tokens',
                        desc: 'Maximum tokens per analysis response.',
                        control: {
                            type: 'number',
                            key: 'analysisMaxOutputTokens',
                            min: 1,
                            validate: (v) => (v >= 1 ? undefined : 'Value must be a number >= 1')
                        }
                    }
                ]
            },
            {
                type: 'group',
                heading: 'Feedback queue',
                ...restore('Restore feedback queue defaults', () => this.restoreFeedbackQueueDefaults()),
                items: [
                    {
                        name: 'Enable feedback queue',
                        desc: 'Show the queue sub-tab and allow queueing reviews to run unattended. Default: on.',
                        control: { type: 'toggle', key: 'enableFeedbackQueue' }
                    },
                    {
                        name: 'Proactive editor chat',
                        desc: 'After a report finishes, the follow-up discussion runs through the co-writer session with editing tools enabled, so the editor can propose specific, reviewable inline-diff edits (not just advisory prose). Every proposed edit still requires your approval before it reaches the vault. Turn off to keep the pre-2.0.1 text-only chat behavior. Default: on.',
                        control: { type: 'toggle', key: 'reviewSuggestedEditsEnabled' }
                    },
                    {
                        name: 'World rules',
                        desc: 'World-building rules the editor follows when writing or editing prose in review-discuss. Describe how your world works so edits use the right vocabulary and details. Example: "Magic is visible as blue light. Swords are called blades regardless of shape. The setting is a tropical archipelago."',
                        control: { type: 'textarea', key: 'reviewWorldRules', rows: 5 }
                    },
                    {
                        name: 'Run queued jobs automatically',
                        desc: 'Run queued jobs automatically while Obsidian is open. Turn off to queue jobs without running them until you trigger one manually. Default: on.',
                        control: { type: 'toggle', key: 'feedbackQueueAutoRun' }
                    },
                    {
                        name: 'Auto-save feedback reports',
                        desc: 'Save every completed feedback report (async queue + interactive Review) to the vault as dated markdown. When off, no report is written anywhere — the report is held in-memory for the session only. Default: on.',
                        control: { type: 'toggle', key: 'autoSaveFeedbackReports' }
                    },
                    {
                        name: 'Feedback report folder',
                        desc: 'Vault folder for auto-saved feedback reports. Created on first write.',
                        control: {
                            type: 'text',
                            key: 'feedbackReportFolder',
                            placeholder: DEFAULT_SETTINGS.feedbackReportFolder
                        }
                    },
                    {
                        name: 'Feedback queue limit',
                        desc: 'Maximum number of queue jobs retained on disk. Older completed jobs are removed first. Default: 20.',
                        control: {
                            type: 'number',
                            key: 'feedbackQueueLimit',
                            min: 1,
                            validate: (v) => (v >= 1 ? undefined : 'Value must be a number >= 1')
                        }
                    }
                ]
            },
            {
                type: 'group',
                heading: 'Embeddings',
                items: [
                    {
                        name: 'Embedding top-k chunks',
                        desc: 'Number of chunks (paragraphs) retrieved from embedded folders. Higher = more context but more tokens; lower = tighter focus, less window pressure. Recommended: 8–12 for most use cases. 3–5 keeps overhead minimal. 15+ may crowd the context window.',
                        control: {
                            type: 'number',
                            key: 'embeddingsTopKChunks',
                            min: 1,
                            max: 100,
                            validate: (v) =>
                                v >= 1 && v <= 100 ? undefined : 'Value must be a number between 1 and 100'
                        }
                    },
                    {
                        name: 'Embedding cache warming',
                        desc: 'Automatically pre-compute and cache embeddings for each folder containing Markdown files (cast notes, lore, outlines, manuscript chapters). Enables instant semantic retrieval. Root folder is excluded.',
                        control: { type: 'toggle', key: 'enableEmbeddingWarming' }
                    },
                    {
                        name: 'Embedding warming debounce (seconds)',
                        desc: 'How long to wait after the last file save before warming embeddings. Higher reduces API calls during active writing; lower keeps caches fresher. Default: 30.',
                        control: {
                            type: 'number',
                            key: 'embeddingWarmingDebounceSeconds',
                            min: 5,
                            max: 600,
                            validate: (v) => (v >= 5 && v <= 600 ? undefined : 'Value must be between 5 and 600')
                        }
                    },
                    {
                        name: 'Build embeddings now',
                        desc: 'Immediately pre-compute and cache embeddings for all folders with Markdown files. Useful after adding new material or when warming is turned off.',
                        action: (el: HTMLElement) => {
                            void this.plugin
                                .warmAllEmbeddingCaches()
                                .then(() => new Notice('Quill: Embedding caches rebuilt.'))
                                .catch((err: unknown) => {
                                    const msg = err instanceof Error ? err.message : String(err);
                                    new Notice(`Quill: Embedding build failed. ${msg}`);
                                });
                        }
                    },
                    {
                        name: 'Embedding chunk size (tokens)',
                        desc: "Target tokens per chunk when embedding. Must not exceed your embedding model's context window. Many local embedding models (e.g. Nomic-embed-text) support 512; cloud models may support more. Default: 512.",
                        control: {
                            type: 'number',
                            key: 'embeddingChunkTokenSize',
                            min: 128,
                            max: 8192,
                            validate: (v) => (v >= 128 && v <= 8192 ? undefined : 'Value must be between 128 and 8192')
                        }
                    },
                    {
                        name: 'Show full embed in file picker',
                        desc: 'When enabled, file pickers show a "{Folder name} full embed" option alongside "{Folder name} embedded" (top-K). Full embed sends all chunk texts from the folder; top-K sends only the most relevant. Default: off.',
                        control: { type: 'toggle', key: 'enableFullEmbedPickerOption' }
                    },
                    {
                        name: 'Folder-specific chunk overrides',
                        desc: 'Set a custom top-k chunk count for specific embedded folders. Use a higher number for folders that are more important to your writing (e.g., plot maps), and a lower number for auxiliary lore. Folders without an override use the global setting above.',
                        render: (setting) => this.renderFolderOverridesDefinition(setting)
                    }
                ]
            },
            {
                type: 'group',
                heading: 'Context engine',
                ...restore('Restore context engine defaults', () => this.restoreContextEngineDefaults()),
                items: [
                    {
                        name: 'Token budget',
                        desc: 'Maximum tokens for assembled context. Higher values use more context window.',
                        control: {
                            type: 'dropdown',
                            key: 'contextTokenBudget',
                            options: Object.fromEntries([4096, 8192, 16384, 32768].map((n) => [String(n), String(n)]))
                        }
                    },
                    {
                        name: 'Compaction threshold',
                        desc: 'Percentage of token budget at which context is compacted (50-95).',
                        control: {
                            type: 'number',
                            key: 'contextCompactAtPercent',
                            min: 50,
                            max: 95,
                            validate: (v) => (v >= 50 && v <= 95 ? undefined : 'Value must be between 50 and 95')
                        }
                    },
                    {
                        name: 'Compact summary length',
                        desc: 'Number of sentences in the AI-generated compaction summary (1-20).',
                        control: {
                            type: 'number',
                            key: 'compactSummarySentences',
                            min: 1,
                            max: 20,
                            validate: (v) => (v >= 1 && v <= 20 ? undefined : 'Value must be between 1 and 20')
                        }
                    },
                    {
                        name: 'Refine accepted edits out of context',
                        desc: 'Before AI-compacting, surgically compress bulky or now-stale tool content in the model’s history: accepted/discarded lore drafts become compact outcome markers, stale vault reads are marked for re-lookup, and big reads are trimmed oldest-first when nearing the threshold. Cheaper and more faithful than a full AI summary (the model can always re-look-up current text), and stops a long-context model from re-outputting an entry it already drafted. Rewind still works. Default: on.',
                        control: { type: 'toggle', key: 'contextRefinementEnabled' }
                    },
                    {
                        name: 'Include vault context',
                        desc: 'Search the vault for related notes when assembling context.',
                        control: { type: 'toggle', key: 'contextIncludeVaultContext' }
                    },
                    {
                        name: 'Max vault files',
                        desc: 'Maximum number of vault files to examine for context (1-100).',
                        control: {
                            type: 'number',
                            key: 'contextMaxVaultFiles',
                            min: 1,
                            max: 100,
                            validate: (v) => (v >= 1 && v <= 100 ? undefined : 'Value must be between 1 and 100')
                        }
                    },
                    {
                        name: 'Max chars per file',
                        desc: 'Maximum characters to read from each vault file (500-10000).',
                        control: {
                            type: 'number',
                            key: 'contextMaxCharsPerFile',
                            min: 500,
                            max: 10000,
                            validate: (v) =>
                                v >= 500 && v <= 10000 ? undefined : 'Value must be between 500 and 10000'
                        }
                    },
                    {
                        name: 'Auto-scan on open',
                        desc: 'Automatically scan documents for context when opened.',
                        control: { type: 'toggle', key: 'contextAutoScan' }
                    }
                ]
            },
            {
                type: 'group',
                heading: 'Linter AI',
                ...restore('Restore linter AI defaults', () => this.restoreLinterAiDefaults()),
                items: [
                    {
                        name: 'Enable AI-powered lint fixes',
                        desc: 'Show "fix with AI" buttons in the linter sidebar and editor tooltips for intelligent fixes.',
                        control: { type: 'toggle', key: 'enableLinterAiFixes' }
                    },
                    {
                        name: 'Linter AI temperature',
                        desc: 'Lower values produce more conservative, precise fixes. Range: 0.0 – 2.0.',
                        control: {
                            type: 'number',
                            key: 'linterTemperature',
                            min: 0,
                            max: 2,
                            step: 0.1,
                            validate: (v) => (v >= 0 && v <= 2 ? undefined : 'Value must be between 0.0 and 2.0')
                        }
                    },
                    {
                        name: 'Linter AI max output tokens',
                        desc: 'Maximum tokens per AI lint fix response.',
                        control: {
                            type: 'number',
                            key: 'linterMaxOutputTokens',
                            min: 1,
                            validate: (v) => (v >= 1 ? undefined : 'Value must be a number >= 1')
                        }
                    }
                ]
            },
            {
                name: 'Restore defaults',
                desc: 'Reset every setting on this tab. Use the per-section reset buttons above for targeted resets.',
                action: () => {
                    new ConfirmModal(
                        this.app,
                        'Restore all defaults?',
                        'This resets every setting across General, Lorebook, and Model behaviors to their defaults. This cannot be undone.',
                        () => void this.restoreGeneralDefaults(),
                        'Restore'
                    ).open();
                }
            }
        ];
    }

    /**
     * Render the folder-specific chunk overrides inside a single declarative
     * setting row: the existing override rows plus an add-folder affordance.
     * Returns a cleanup that re-renders after add/remove via update().
     */
    private renderFolderOverridesDefinition(setting: Setting): void {
        const wrap = setting.controlEl.createDiv({ cls: 'quill-folder-overrides-list' });
        /** (Re)render the override rows plus the add-folder affordance. */
        const draw = () => {
            wrap.empty();
            this.renderFolderOverrides(wrap);
            const addBtn = wrap.createEl('button', { text: '+ add folder', cls: 'quill-folder-override-row__add' });
            addBtn.addEventListener('click', () => {
                const folders = this.getVaultFolders();
                new FolderSuggestModal(this.app, folders, (folder) => {
                    if (this.plugin.settings.folderTopKOverrides[folder]) {
                        new Notice('Folder already has an override.');
                        return;
                    }
                    this.plugin.settings.folderTopKOverrides[folder] = this.plugin.settings.embeddingsTopKChunks;
                    void this.plugin.saveSettings().then(() => this.update());
                }).open();
            });
        };
        draw();
    }

    /** Reset selection-transformation settings (narrative voice, temperature, context, wiki links) to defaults. */
    private async restoreTransformDefaults(): Promise<void> {
        const s = this.plugin.settings;
        const d = DEFAULT_SETTINGS;
        s.narrativeVoicePreset = d.narrativeVoicePreset;
        s.customNarrativeVoiceRules = d.customNarrativeVoiceRules;
        s.transformTemperature = d.transformTemperature;
        s.transformVaultContext = d.transformVaultContext;
        s.transformMaxOutputTokens = d.transformMaxOutputTokens;
        s.wikiLinkBehavior = d.wikiLinkBehavior;
        await this.plugin.saveSettings();
        this.update();
    }

    /** Reset co-writer settings (temperature, tokens, context, thought, voice match) to defaults. */
    private async restoreCoWriterDefaults(): Promise<void> {
        const s = this.plugin.settings;
        const d = DEFAULT_SETTINGS;
        s.coWriterTemperature = d.coWriterTemperature;
        s.coWriterMaxOutputTokens = d.coWriterMaxOutputTokens;
        s.coWriterMaxToolRounds = d.coWriterMaxToolRounds;
        s.coWriterSessionHistoryLimit = d.coWriterSessionHistoryLimit;
        s.coWriterAutoSavePerTurn = d.coWriterAutoSavePerTurn;
        s.coWriterVaultContext = d.coWriterVaultContext;
        s.coWriterAppendNewline = d.coWriterAppendNewline;
        s.enableCoWriterThought = d.enableCoWriterThought;
        s.coWriterVoiceMatch = d.coWriterVoiceMatch;
        s.enableInlineDirectives = d.enableInlineDirectives;
        await this.plugin.saveSettings();
        this.update();
    }

    /** Reset critical-analysis settings (temperature, max output tokens) to defaults. */
    private async restoreAnalysisDefaults(): Promise<void> {
        this.plugin.settings.analysisTemperature = DEFAULT_SETTINGS.analysisTemperature;
        this.plugin.settings.analysisMaxOutputTokens = DEFAULT_SETTINGS.analysisMaxOutputTokens;
        await this.plugin.saveSettings();
        this.update();
    }

    /** Reset feedback-queue + review settings (queue toggles, report folder, review-discuss) to defaults. */
    private async restoreFeedbackQueueDefaults(): Promise<void> {
        const s = this.plugin.settings;
        const d = DEFAULT_SETTINGS;
        s.enableFeedbackQueue = d.enableFeedbackQueue;
        s.feedbackQueueLimit = d.feedbackQueueLimit;
        s.feedbackQueueAutoRun = d.feedbackQueueAutoRun;
        s.autoSaveFeedbackReports = d.autoSaveFeedbackReports;
        s.feedbackReportFolder = d.feedbackReportFolder;
        s.reviewSuggestedEditsEnabled = d.reviewSuggestedEditsEnabled;
        s.reviewWorldRules = d.reviewWorldRules;
        await this.plugin.saveSettings();
        this.update();
    }

    /** Reset context-engine settings (budget, compaction threshold, vault-context switches) to defaults. */
    private async restoreContextEngineDefaults(): Promise<void> {
        const s = this.plugin.settings;
        const d = DEFAULT_SETTINGS;
        s.contextTokenBudget = d.contextTokenBudget;
        s.contextCompactAtPercent = d.contextCompactAtPercent;
        s.compactSummarySentences = d.compactSummarySentences;
        s.contextRefinementEnabled = d.contextRefinementEnabled;
        s.contextIncludeVaultContext = d.contextIncludeVaultContext;
        s.contextMaxVaultFiles = d.contextMaxVaultFiles;
        s.contextMaxCharsPerFile = d.contextMaxCharsPerFile;
        s.contextAutoScan = d.contextAutoScan;
        await this.plugin.saveSettings();
        this.update();
    }

    /** Reset linter-AI settings (AI fixes toggle, temperature, max output tokens) to defaults. */
    private async restoreLinterAiDefaults(): Promise<void> {
        this.plugin.settings.enableLinterAiFixes = DEFAULT_SETTINGS.enableLinterAiFixes;
        this.plugin.settings.linterTemperature = DEFAULT_SETTINGS.linterTemperature;
        this.plugin.settings.linterMaxOutputTokens = DEFAULT_SETTINGS.linterMaxOutputTokens;
        await this.plugin.saveSettings();
        this.update();
    }

    /** Restore-defaults action for the Model behaviors page (every field on the tab). */
    private async restoreModelBehaviorsDefaults(): Promise<void> {
        const s = this.plugin.settings;
        const d = DEFAULT_SETTINGS;
        s.transformTemperature = d.transformTemperature;
        s.transformVaultContext = d.transformVaultContext;
        s.transformMaxOutputTokens = d.transformMaxOutputTokens;
        s.wikiLinkBehavior = d.wikiLinkBehavior;
        s.narrativeVoicePreset = d.narrativeVoicePreset;
        s.customNarrativeVoiceRules = d.customNarrativeVoiceRules;
        s.analysisTemperature = d.analysisTemperature;
        s.analysisMaxOutputTokens = d.analysisMaxOutputTokens;
        s.linterTemperature = d.linterTemperature;
        s.linterMaxOutputTokens = d.linterMaxOutputTokens;
        s.enableLinterAiFixes = d.enableLinterAiFixes;
        s.contextTokenBudget = d.contextTokenBudget;
        s.contextCompactAtPercent = d.contextCompactAtPercent;
        s.contextRefinementEnabled = d.contextRefinementEnabled;
        s.compactSummarySentences = d.compactSummarySentences;
        s.contextIncludeVaultContext = d.contextIncludeVaultContext;
        s.contextMaxVaultFiles = d.contextMaxVaultFiles;
        s.contextMaxCharsPerFile = d.contextMaxCharsPerFile;
        s.contextAutoScan = d.contextAutoScan;
        s.coWriterTemperature = d.coWriterTemperature;
        s.coWriterMaxOutputTokens = d.coWriterMaxOutputTokens;
        s.coWriterMaxToolRounds = d.coWriterMaxToolRounds;
        s.coWriterAutoSavePerTurn = d.coWriterAutoSavePerTurn;
        s.coWriterVaultContext = d.coWriterVaultContext;
        s.coWriterAppendNewline = d.coWriterAppendNewline;
        s.enableCoWriterThought = d.enableCoWriterThought;
        s.coWriterVoiceMatch = d.coWriterVoiceMatch;
        s.enableInlineDirectives = d.enableInlineDirectives;
        s.enableFeedbackQueue = d.enableFeedbackQueue;
        s.feedbackQueueLimit = d.feedbackQueueLimit;
        s.feedbackQueueAutoRun = d.feedbackQueueAutoRun;
        s.autoSaveFeedbackReports = d.autoSaveFeedbackReports;
        s.feedbackReportFolder = d.feedbackReportFolder;
        s.reviewSuggestedEditsEnabled = d.reviewSuggestedEditsEnabled;
        s.reviewWorldRules = d.reviewWorldRules;
        s.embeddingsTopKChunks = d.embeddingsTopKChunks;
        s.embeddingChunkTokenSize = d.embeddingChunkTokenSize;
        s.enableEmbeddingWarming = d.enableEmbeddingWarming;
        s.enableFullEmbedPickerOption = d.enableFullEmbedPickerOption;
        s.folderTopKOverrides = { ...d.folderTopKOverrides };
        s.embeddingWarmingDebounceSeconds = d.embeddingWarmingDebounceSeconds;
        await this.plugin.saveSettings();
        this.update();
    }

    /** Fetch models from the provider endpoint and show a suggester. */
    private async fetchAndSuggestModels(provider: ProviderConfig, modelConfig: { model: string }): Promise<void> {
        try {
            const ai = createProvider(provider);
            const models = await ai.listModels();

            if (models.length === 0) {
                new Notice(
                    'Could not fetch models from this endpoint. ' +
                        'Make sure your endpoint URL includes the full base path ' +
                        '(e.g. http://localhost:1234/v1). You can still enter the model ID manually.'
                );
                return;
            }

            new ModelFetchModal(this.app, models, (modelId) => {
                modelConfig.model = modelId;
                void this.plugin.saveSettings().then(() => this.refreshBridge());
            }).open();
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            new Notice(`Failed to fetch models: ${msg}`);
        }
    }

    /**
     * Ensure aiDefaultChatProvider, aiDefaultEmbedProvider, and aiDefaultImageProvider still reference
     * valid provider+model keys whose role still satisfies the slot's
     * capability. Clears any key whose provider or model has been removed, and
     * also clears a key whose model's role no longer fits (e.g., the model was
     * switched from "chat" to "embed"). Call after mutating aiProviders and
     * before saveSettings().
     */
    private validateDefaultProviders(): void {
        const { aiProviders } = this.plugin.settings;

        /** True when the `providerId/modelId` composite key resolves to a provider whose model satisfies the capability. */
        const satisfies = (key: string, capability: ModelCapability): boolean => {
            const parts = key.split('/', 2);
            if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
            const provider = aiProviders.find((p) => p.id === parts[0]);
            if (!provider) return false;
            const model = provider.models.find((m) => m.id === parts[1]);
            if (!model) return false;
            return roleSatisfies(model.role, capability);
        };

        if (
            this.plugin.settings.aiDefaultChatProvider &&
            !satisfies(this.plugin.settings.aiDefaultChatProvider, 'chat')
        ) {
            this.plugin.settings.aiDefaultChatProvider = '';
        }
        if (
            this.plugin.settings.aiDefaultEmbedProvider &&
            !satisfies(this.plugin.settings.aiDefaultEmbedProvider, 'embed')
        ) {
            this.plugin.settings.aiDefaultEmbedProvider = '';
        }
        if (
            this.plugin.settings.aiDefaultImageProvider &&
            !satisfies(this.plugin.settings.aiDefaultImageProvider, 'image')
        ) {
            this.plugin.settings.aiDefaultImageProvider = '';
        }
    }

    /** Add a new provider with the given type and default endpoint. */
    private addProvider(type: ProviderType, defaultEndpoint: string): void {
        // Anthropic's content-policy warning fires before the provider is
        // created. If the writer hasn't acknowledged it yet, route through the
        // confirmation modal; the provider only lands if they confirm.
        if (type === 'anthropic' && !this.plugin.settings.anthropicBanRiskAcknowledged) {
            this.openAnthropicBanRiskWarning(() => this.createProviderOfType(type, defaultEndpoint));
            return;
        }
        this.createProviderOfType(type, defaultEndpoint);
    }

    /** Build and persist a new provider of the given type. Split out so the
     *  Anthropic warning modal can call it after the writer confirms. */
    private createProviderOfType(type: ProviderType, defaultEndpoint: string): void {
        const name =
            type === 'ollama'
                ? 'Ollama local'
                : type === 'anthropic'
                  ? 'New Anthropic provider'
                  : type === 'gemini'
                    ? 'New Gemini provider'
                    : 'New OpenAI-compatible';
        const newProvider: ProviderConfig = {
            id: generateProviderId(name),
            name,
            type,
            endpoint: defaultEndpoint,
            apiKey: '',
            models: [],
            maxContextTokens: 32768,
            maxOutputTokens: 4096
        };
        this.plugin.settings.aiProviders.push(newProvider);
        void this.plugin.saveSettings().then(() => this.refreshBridge());
    }

    /**
     * One-time confirmation modal that fires when the writer first selects the
     * Anthropic provider type. Anthropic's Usage Policy prohibits sexually
     * explicit content and graphic violence — including for API access and
     * including content submitted *for analysis*. Repeated violations lead to
     * account-level bans (forfeiting any remaining API credit). This modal
     * makes the risk explicit before the writer commits.
     *
     * On confirmation the `anthropicBanRiskAcknowledged` setting flips true
     * permanently so the modal does not reappear on subsequent Anthropic
     * selections in this vault. There is intentionally no UI to revoke the
     * acknowledgment — once a writer has read and accepted the risk, repeating
     * the modal on every Anthropic add would be hostile.
     */
    private openAnthropicBanRiskWarning(onConfirm: () => void): void {
        new AnthropicBanRiskModal(this.app, async () => {
            this.plugin.settings.anthropicBanRiskAcknowledged = true;
            await this.plugin.saveSettings();
            onConfirm();
        }).open();
    }
}

/**
 * Navigable detail page for one AI provider (Phase 6). Renders the provider's
 * fields, model list, and test buttons via {@link EventideQuillSettingTab.renderProviderPage},
 * and registers with the bridge machinery so mutation handlers that call
 * refreshBridge() (type cascades, model add/remove/role changes, custom
 * context) re-render this page in place.
 */
class ProviderSettingPage extends SettingPage {
    private readonly tab: EventideQuillSettingTab;
    private readonly provider: ProviderConfig;

    /** Capture the tab and provider this page renders. */
    constructor(tab: EventideQuillSettingTab, provider: ProviderConfig) {
        super();
        this.tab = tab;
        this.provider = provider;
        this.title = provider.name || 'Unnamed provider';
    }

    /** Open the page: register it as the active bridge page and render the provider UI into its container. */
    display(): void {
        this.tab.enterBridgePage(this.containerEl, (el) => this.tab.renderProviderPage(el, this.provider));
    }

    /** Unregister this page from the bridge machinery before closing. */
    hide(): void {
        this.tab.exitBridgePage(this.containerEl);
        super.hide();
    }
}

/**
 * Navigable page for the default chat/embed/image model pickers. Renders via
 * {@link EventideQuillSettingTab.renderDefaultModelSettings} (the embed picker
 * has a cache-invalidation confirmation modal that doesn't need a re-render).
 */
class DefaultModelsSettingPage extends SettingPage {
    private readonly tab: EventideQuillSettingTab;

    /** Capture the tab this page renders. */
    constructor(tab: EventideQuillSettingTab) {
        super();
        this.tab = tab;
        this.title = 'Default models';
    }

    /** Open the page: register it as the active bridge page and render the default-model pickers. */
    display(): void {
        this.tab.enterBridgePage(this.containerEl, (el) => this.tab.renderDefaultModelSettings(el));
    }

    /** Unregister this page from the bridge machinery before closing. */
    hide(): void {
        this.tab.exitBridgePage(this.containerEl);
        super.hide();
    }
}

/** Modal for picking a vault folder from the list of markdown-containing folders. */
class FolderSuggestModal extends SuggestModal<string> {
    /** Store the folder list and the pick callback. */
    constructor(
        app: App,
        private folders: string[],
        private onPick: (folder: string) => void
    ) {
        super(app);
    }

    /** Filter the folder list by query. */
    getSuggestions(query: string): string[] {
        const q = query.toLowerCase();
        return this.folders.filter((f) => f.toLowerCase().includes(q));
    }

    /** Render each folder row. */
    renderSuggestion(folder: string, el: HTMLElement): void {
        el.createSpan({ text: folder });
    }

    /** Fire the pick callback with the chosen folder. */
    onChooseSuggestion(folder: string): void {
        this.onPick(folder);
    }
}
