import { App, Menu, Modal, Notice, PluginSettingTab, Setting, SuggestModal } from 'obsidian';
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
export type SettingsTab = 'welcome' | 'general' | 'lorebook' | 'linter' | 'ai-providers' | 'model-behaviors';
/** Which sidebar tab opens by default. Mirrors the dropdown options in the General settings. */
export type DefaultTab = 'linter' | 'context' | 'review' | 'cowriter' | 'dashboard' | 'lorebook';

/**
 * Below this settings-pane width (px), the six top-level tab buttons collapse
 * into a single "active tab" button that opens a native Obsidian {@link Menu}
 * listing all tabs. Six text-only tabs (the longest label is "Model behaviors")
 * need ~520px to sit comfortably without truncation; phones in portrait (~360
 * dp) and narrow tablets fall under this threshold. Mirrors the ResizeObserver
 * hamburger pattern in the sidebar (`quill-sidebar.ts`) and co-writer panel.
 */
const COMPACT_TABS_THRESHOLD = 520;

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
     * (the pre-1.4.0 behavior). See `src/ai/context-refinement.ts`.
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
     * create (the pre-1.4.0 behavior) — escape hatch.
     */
    lorePreferEditOverCreate: boolean;
    /**
     * When on, follow-up discussion of a review report runs through the
     * co-writer session machinery with editing tools enabled, so the editor
     * can propose specific, reviewable inline-diff edits (not just advisory
     * prose). Off preserves the pre-1.4.0 text-only chat behavior. Default:
     * on (flipped in v1.4.0); Phase 2 of the rollout ships it off to keep
     * the mount infrastructure dormant until seeding + prompts land.
     */
    reviewSuggestedEditsEnabled: boolean;
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

    constructor(
        app: App,
        private title: string,
        private placeholder: string,
        private onSubmit: (value: string) => void
    ) {
        super(app);
    }

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

    constructor(app: App, onConfirm: () => void | Promise<void>) {
        super(app);
        this.titleEl.setText('Before you add Anthropic Claude');
        this.onConfirm = onConfirm;
    }

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

export class EventideQuillSettingTab extends PluginSettingTab {
    plugin: EventideQuillPlugin;
    private activeTab: SettingsTab = 'welcome';

    /**
     * Single source of truth for the six top-level tabs and their labels.
     * Consumed by {@link renderTabBar} (button text + compact menu items),
     * {@link showActiveTab} (compact-mode label sync), and the ResizeObserver
     * compact-mode toggle. Add a tab here and it propagates everywhere.
     */
    private static readonly TABS: { id: SettingsTab; label: string }[] = [
        { id: 'welcome', label: 'Welcome' },
        { id: 'general', label: 'General' },
        { id: 'lorebook', label: 'Lorebook' },
        { id: 'linter', label: 'Linter' },
        { id: 'ai-providers', label: 'AI providers' },
        { id: 'model-behaviors', label: 'Model behaviors' }
    ];

    /**
     * Whether the settings pane is narrow enough that the tab bar has
     * collapsed into the compact dropdown. Toggled by {@link resizeObserver}
     * and read by CSS via the `quill-settings-root--compact-tabs` modifier
     * on the root element (no full re-render — avoids scroll disruption).
     */
    private compactTabs = false;

    /** Observes the settings pane width to toggle {@link compactTabs}. */
    private resizeObserver: ResizeObserver | null = null;

    constructor(app: App, plugin: EventideQuillPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    /**
     * Clean up the {@link resizeObserver} when the settings tab is hidden.
     *
     * `SettingTab` is not a `Component`, so the observer can't be registered
     * via `register()`. Obsidian calls `hide()` when the writer navigates away
     * from the plugin's settings (closes settings, switches to another plugin's
     * tab, etc.), making it the right teardown point. `display()` also
     * disconnects defensively at the top of each redraw in case Obsidian
     * re-renders without first calling `hide()`.
     */
    hide(): void {
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        super.hide();
    }

    /**
     * Build and display the full settings UI.
     *
     * Called on initial open AND on every save that needs a structural
     * redraw (provider add/remove, toggle reveal/hide, slash-command
     * add/remove, etc.). To preserve scroll position across in-tab
     * redraws, the scroll area's scrollTop is captured before the DOM is
     * torn down and restored after rebuild. Tab switches reset to the top
     * (the tab-bar click handler passes no `scrollTop` arg, defaulting
     * to 0; the initial open path finds no previous scroll area and
     * falls back to 0 too).
     */
    display(): void {
        const { containerEl } = this;

        // Disconnect any prior observer before re-observing. Obsidian may call
        // display() multiple times (provider add/remove, toggle redraws) without
        // first calling hide(); without this, stale observers would pile up.
        this.resizeObserver?.disconnect();

        // Capture scroll position before teardown so we can restore it after
        // a redraw triggered by an in-tab action (toggle, add/remove row,
        // card field edit). Without this, `showActiveTab()` resets to 0 on
        // every redraw and the writer is bounced back to the top after
        // clicking anything inside the tab. Only tab switches should reset.
        const prevScrollArea = containerEl.querySelector('.quill-settings__scroll-area');
        const savedScrollTop = prevScrollArea instanceof HTMLElement ? prevScrollArea.scrollTop : 0;

        containerEl.empty();
        containerEl.addClass('quill-settings-root');
        // Re-apply the compact modifier if a prior observer measurement set it
        // (containerEl.empty() preserves classes on the root itself, but this
        // is defensive in case a future change clears them).
        containerEl.toggleClass('quill-settings-root--compact-tabs', this.compactTabs);

        this.renderTabBar(containerEl);

        // All tab content lives inside a scrollable wrapper so that only
        // the area between the tab bar (header) and the footer scrolls.
        const scrollArea = containerEl.createDiv({ cls: 'quill-settings__scroll-area' });
        this.renderWelcomeTab(scrollArea);
        this.renderGeneralTab(scrollArea);
        this.renderLorebookTab(scrollArea);
        this.renderLinterTab(scrollArea);
        this.renderAiProvidersTab(scrollArea);
        this.renderModelBehaviorsTab(scrollArea);

        // Wrap runs of settings under each heading into visually distinct
        // groups (background + border) so tabs don't read as a flat list.
        const tabContents = scrollArea.querySelectorAll<HTMLElement>('[class*="quill-settings-content-"]');
        tabContents.forEach((c) => this.groupSettingsByHeading(c));

        this.renderFooter(containerEl);

        this.showActiveTab(savedScrollTop);

        // Toggle compact mode when the settings pane narrows. Below the
        // threshold the horizontal tab bar hides and a single "active tab"
        // dropdown button takes its place. Mirrors the sidebar's own
        // ResizeObserver at quill-sidebar.ts:101 (the only other responsive
        // tab pattern in the repo).
        this.resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const compact = entry.contentRect.width < COMPACT_TABS_THRESHOLD;
                if (compact !== this.compactTabs) {
                    this.compactTabs = compact;
                    containerEl.toggleClass('quill-settings-root--compact-tabs', compact);
                }
            }
        });
        this.resizeObserver.observe(containerEl);
    }

    /**
     * Render the tab bar at the top of the settings panel.
     *
     * Two sibling bars are built on every render; CSS toggles which one is
     * visible based on the `quill-settings-root--compact-tabs` modifier
     * (flipped by {@link resizeObserver}). Building both up front avoids a
     * full re-render when crossing the width threshold mid-session — only a
     * class flips, so the writer's scroll position and form inputs survive.
     */
    private renderTabBar(containerEl: HTMLElement): void {
        const tabs = EventideQuillSettingTab.TABS;

        // --- Standard horizontal tab bar (hidden under compact mode) ---
        const tabBar = containerEl.createDiv({ cls: 'quill-settings__tab-bar' });
        for (const tab of tabs) {
            const btn = tabBar.createEl('button', {
                cls: `quill-settings__tab${this.activeTab === tab.id ? ' quill-settings__tab--active' : ''}`,
                text: tab.label,
                attr: { 'data-tab': tab.id }
            });
            btn.addEventListener('click', () => {
                this.activeTab = tab.id;
                this.showActiveTab();
            });
        }

        // --- Compact dropdown bar (shown under compact mode) ---
        // A single button echoes the active tab's label with a caret; clicking
        // opens a native Obsidian Menu listing all tabs with a checkmark on the
        // active one. Same pattern as the co-writer panel's overflow hamburger
        // (co-writer-panel.ts:2127).
        const compactBar = containerEl.createDiv({ cls: 'quill-settings__compact-bar' });
        const compactBtn = compactBar.createEl('button', {
            cls: `quill-settings__compact-tab${' quill-settings__compact-tab--active'}`,
            attr: { type: 'button', 'aria-label': 'Switch settings tab' }
        });
        const compactLabel = compactBtn.createSpan({ cls: 'quill-settings__compact-tab-label' });
        compactLabel.textContent = tabs.find((t) => t.id === this.activeTab)?.label ?? '';
        compactBtn.createSpan({ cls: 'quill-settings__compact-tab-caret' });
        compactBtn.addEventListener('click', (e: MouseEvent) => {
            const menu = new Menu();
            for (const tab of tabs) {
                menu.addItem((item) =>
                    item
                        .setTitle(tab.label)
                        .setChecked(this.activeTab === tab.id)
                        .onClick(() => {
                            this.activeTab = tab.id;
                            this.showActiveTab();
                        })
                );
            }
            menu.showAtMouseEvent(e);
        });
    }

    /**
     * Toggle visibility of tab content sections and scroll the panel.
     *
     * @param scrollTop  Scroll position to restore after redraw. The
     *                   tab-bar click handler passes nothing (default 0) so
     *                   switching tabs starts at the top; {@link display}
     *                   passes the previously captured scrollTop so an
     *                   in-tab redraw (add/remove/field edit) preserves the
     *                   writer's place. The initial-open path finds no
     *                   previous scroll area and also falls back to 0.
     */
    private showActiveTab(scrollTop = 0): void {
        const tabIds = EventideQuillSettingTab.TABS.map((t) => t.id);
        const tabs = this.containerEl.querySelectorAll('.quill-settings__tab');

        for (const id of tabIds) {
            const content = this.containerEl.querySelector(`.quill-settings-content-${id}`);
            if (content) {
                content.toggleClass('is-hidden', this.activeTab !== id);
            }
        }

        tabs.forEach((tab) => {
            const el = tab as HTMLElement;
            if (el.dataset.tab === this.activeTab) {
                el.addClass('quill-settings__tab--active');
            } else {
                el.removeClass('quill-settings__tab--active');
            }
        });

        // Reflect the new active tab in the compact-mode dropdown button label.
        // The compact bar is rebuilt on every display(), so a querySelector is
        // sufficient — no cached reference to invalidate across redraws.
        const compactLabel = this.containerEl.querySelector('.quill-settings__compact-tab-label');
        if (compactLabel instanceof HTMLElement) {
            const match = EventideQuillSettingTab.TABS.find((t) => t.id === this.activeTab);
            if (match) compactLabel.textContent = match.label;
        }

        const scrollArea = this.containerEl.querySelector('.quill-settings__scroll-area');
        if (scrollArea instanceof HTMLElement) {
            // 0 (tab switch or first open) starts at the top; a preserved
            // scrollTop (in-tab redraw) restores the writer's place.
            scrollArea.scrollTop = scrollTop;
        }
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
                void this.plugin.saveSettings();
                this.renderLorebookFolders(container);
            });
        }
    }

    /**
     * Render the per-card editor for user-defined slash commands. Each
     * card carries Name (kebab-case-validated, lowercase + trim on blur,
     * uniqueness-checked via Notice), Description (one-line, optional),
     * and Body (multi-line textarea). Per-field edits mutate the object
     * in place and save; structural changes (add/remove) do a full
     * `this.display()` redraw, mirroring the `aiProviders` card pattern.
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
                this.display();
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
                        this.display();
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
    private renderWelcomeTab(containerEl: HTMLElement): void {
        const content = containerEl.createDiv({ cls: 'quill-settings-content-welcome' });

        // --- Hero ---

        const hero = content.createDiv({ cls: 'quill-settings__welcome-hero' });
        hero.createDiv({ cls: 'quill-settings__welcome-title', text: 'Eventide quill' });
        hero.createDiv({
            cls: 'quill-settings__welcome-tagline',
            text: 'A feedback-first writing assistant for novelists.'
        });

        // --- Getting started ---

        new Setting(content).setName('Getting started').setHeading();

        const steps = content.createDiv({ cls: 'quill-settings__welcome-steps' });
        const stepItems = [
            {
                num: '1',
                title: 'Configure an AI provider',
                desc: 'Go to the "AI providers" tab and set up Ollama, LM Studio, or an OpenAI-compatible endpoint.'
            },
            {
                num: '2',
                title: 'Open the sidebar',
                desc: 'Click the feather icon in the left ribbon to open the Quill sidebar.'
            },
            {
                num: '3',
                title: 'Configure your manuscript',
                desc: 'Open the Dashboard tab in the sidebar, click Settings, and pick your manuscript type.'
            },
            {
                num: '4',
                title: 'Start writing',
                desc: 'Use the linter, co-writer, feedback engine, and dashboard as you draft.'
            }
        ];
        for (const step of stepItems) {
            const row = steps.createDiv({ cls: 'quill-settings__welcome-step' });
            row.createDiv({ cls: 'quill-settings__welcome-step-num', text: step.num });
            const body = row.createDiv({ cls: 'quill-settings__welcome-step-body' });
            body.createDiv({ cls: 'quill-settings__welcome-step-title', text: step.title });
            body.createDiv({ cls: 'quill-settings__welcome-step-desc', text: step.desc });
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
                    this.display();
                })
            );

        new Setting(content)
            .setName('Network research tools')
            .setDesc('Sends requests to external websites when the co-writer researches references.')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.lorebookNetworkTools).onChange(async (value) => {
                    this.plugin.settings.lorebookNetworkTools = value;
                    await this.plugin.saveSettings();
                    this.display();
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
                    this.display();
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
                    this.display();
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
    private renderGeneralTab(containerEl: HTMLElement): void {
        const content = containerEl.createDiv({ cls: 'quill-settings-content-general' });

        new Setting(content).setName('Sidebar').setHeading();

        new Setting(content)
            .setName('Default tab')
            .setDesc('Which sidebar tab opens by default.')
            .addDropdown((dropdown) => {
                dropdown.addOption('dashboard', 'Dashboard');
                dropdown.addOption('linter', 'Linter');
                dropdown.addOption('context', 'Context');
                dropdown.addOption('review', 'Review');
                dropdown.addOption('cowriter', 'Co-writer');
                dropdown.addOption('lorebook', 'Lorebook');
                dropdown.setValue(this.plugin.settings.defaultTab).onChange(async (value) => {
                    this.plugin.settings.defaultTab = value as DefaultTab;
                    await this.plugin.saveSettings();
                });
            });

        new Setting(content).setName('Feature toggles').setHeading();

        new Setting(content)
            .setName('Enable dashboard')
            .setDesc('Show the dashboard tab in the sidebar with per-manuscript analytics.')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.enableDashboard).onChange(async (value) => {
                    this.plugin.settings.enableDashboard = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(content)
            .setName('Critical analysis')
            .setDesc('Show the analysis engine in the review tab and the right-click analyze command.')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.enableCriticalAnalysis).onChange((value) => {
                    this.plugin.settings.enableCriticalAnalysis = value;
                    void this.plugin.saveSettings();
                })
            );

        new Setting(content)
            .setName('Manuscript analysis')
            .setDesc(
                'Show the manuscript analysis engine in the review tab for full-manuscript structural diagnostics.'
            )
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.enableManuscriptAnalysis).onChange((value) => {
                    this.plugin.settings.enableManuscriptAnalysis = value;
                    void this.plugin.saveSettings();
                })
            );

        // --- Analysis settings ---
        new Setting(content).setName('Manuscript analysis engine').setHeading();

        new Setting(content)
            .setName('Compression chunk size (tokens)')
            .setDesc(
                'Target tokens per chunk when using compress compaction (chat model summarization). The embedding chunk size is configured separately below. Default: 1024.'
            )
            .addText((text) =>
                text
                    .setValue(String(this.plugin.settings.manuscriptAnalysisChunkTokenSize))
                    // settings.ts - no Component lifecycle available; raw addEventListener is required
                    .inputEl.addEventListener('blur', () => {
                        const n = parseInt(text.inputEl.value, 10);
                        if (!isNaN(n) && n >= 256 && n <= 8192) {
                            this.plugin.settings.manuscriptAnalysisChunkTokenSize = n;
                            void this.plugin.saveSettings();
                        } else {
                            text.setValue(String(this.plugin.settings.manuscriptAnalysisChunkTokenSize));
                            new Notice('Value must be a number between 256 and 8192');
                        }
                    })
            );

        new Setting(content)
            .setName('Manuscript analysis temperature')
            .setDesc(
                'Temperature for manuscript analysis AI responses. Higher values produce more varied output; lower values are more deterministic. Range: 0.0 – 2.0. Default: 0.5.'
            )
            .addText((text) =>
                text
                    .setValue(String(this.plugin.settings.manuscriptAnalysisTemperature))
                    .inputEl.addEventListener('blur', () => {
                        const n = parseFloat(text.inputEl.value);
                        if (!isNaN(n) && n >= 0 && n <= 2) {
                            this.plugin.settings.manuscriptAnalysisTemperature = n;
                            void this.plugin.saveSettings();
                        } else {
                            text.setValue(String(this.plugin.settings.manuscriptAnalysisTemperature));
                            new Notice('Value must be a number between 0.0 and 2.0');
                        }
                    })
            );

        new Setting(content)
            .setName('Manuscript analysis max output tokens')
            .setDesc(
                'Maximum tokens per manuscript analysis response. Higher allows more detailed reports but uses more quota. Default: 3072.'
            )
            .addText((text) =>
                text
                    .setValue(String(this.plugin.settings.manuscriptAnalysisMaxOutputTokens))
                    .inputEl.addEventListener('blur', () => {
                        const n = parseInt(text.inputEl.value, 10);
                        if (!isNaN(n) && n >= 1 && n <= 65536) {
                            this.plugin.settings.manuscriptAnalysisMaxOutputTokens = n;
                            void this.plugin.saveSettings();
                        } else {
                            text.setValue(String(this.plugin.settings.manuscriptAnalysisMaxOutputTokens));
                            new Notice('Value must be a number between 1 and 65536');
                        }
                    })
            );

        // --- Embedding settings ---
        // --- Debug logging (dev-only) ---
        if (__DEV__) {
            new Setting(content).setName('Debug').setHeading();

            new Setting(content)
                .setName('Enable debug logging')
                .setDesc(
                    'When enabled, logs AI payload context to the browser console (console.warn). Useful for inspecting the actual data sent to providers.'
                )
                .addToggle((toggle) =>
                    toggle.setValue(this.plugin.settings.enableDebugLogging).onChange(async (value) => {
                        this.plugin.settings.enableDebugLogging = value;
                        await this.plugin.saveSettings();
                    })
                );
        }

        // --- Dashboard settings ---
        new Setting(content).setName('Dashboard').setHeading();

        new Setting(content)
            .setName('Readability formula')
            .setDesc('Which readability formula to display in the dashboard.')
            .addDropdown((dropdown) => {
                dropdown.addOption('reweighted-flesch', 'Reweighted flesch');
                dropdown.addOption('flesch-kincaid', 'Flesch-kincaid');
                dropdown.addOption('ari', 'Automated readability index');
                dropdown.addOption('custom-composite', 'Custom composite');
                dropdown.addOption('dale-chall', 'Dale-chall');
                dropdown.setValue(this.plugin.settings.readabilityFormula).onChange(async (value) => {
                    this.plugin.settings.readabilityFormula = value as ReadabilityFormula;
                    await this.plugin.saveSettings();
                });
            });

        new Setting(content)
            .setName('Auto-refresh interval')
            .setDesc('Refresh the dashboard every n minutes when the tab is active (0 disables).')
            .addText((text) =>
                text
                    .setValue(String(this.plugin.settings.dashboardAutoRefreshMinutes))
                    .inputEl.addEventListener('blur', () => {
                        const n = parseInt(text.inputEl.value, 10);
                        if (!isNaN(n) && n >= 0 && n <= 60) {
                            this.plugin.settings.dashboardAutoRefreshMinutes = n;
                            void this.plugin.saveSettings();
                        } else {
                            text.setValue(String(this.plugin.settings.dashboardAutoRefreshMinutes));
                            new Notice('Value must be between 0 and 60');
                        }
                    })
            );

        new Setting(content)
            .setName('Auto-snapshot on save')
            .setDesc('Record a word-count snapshot whenever a chapter file is saved.')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.dashboardAutoSnapshotOnSave).onChange(async (value) => {
                    this.plugin.settings.dashboardAutoSnapshotOnSave = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(content)
            .setName('Max snapshots retained')
            .setDesc(
                'Maximum number of historical snapshots to keep per manuscript (10-1000). Oldest are pruned first.'
            )
            .addText((text) =>
                text
                    .setValue(String(this.plugin.settings.dashboardMaxSnapshots))
                    .inputEl.addEventListener('blur', () => {
                        const n = parseInt(text.inputEl.value, 10);
                        if (!isNaN(n) && n >= 10 && n <= 1000) {
                            this.plugin.settings.dashboardMaxSnapshots = n;
                            void this.plugin.saveSettings();
                        } else {
                            text.setValue(String(this.plugin.settings.dashboardMaxSnapshots));
                            new Notice('Value must be between 10 and 1000');
                        }
                    })
            );

        // --- Restore defaults ---
        new Setting(content)
            .setName('Restore defaults')
            .setDesc('Reset all general settings to their default values.')
            .addButton((button) =>
                button.setButtonText('Restore defaults').onClick(async () => {
                    this.plugin.settings.defaultTab = DEFAULT_SETTINGS.defaultTab;
                    this.plugin.settings.enableDashboard = DEFAULT_SETTINGS.enableDashboard;
                    this.plugin.settings.enableCriticalAnalysis = DEFAULT_SETTINGS.enableCriticalAnalysis;
                    this.plugin.settings.enableManuscriptAnalysis = DEFAULT_SETTINGS.enableManuscriptAnalysis;
                    this.plugin.settings.manuscriptAnalysisTemperature = DEFAULT_SETTINGS.manuscriptAnalysisTemperature;
                    this.plugin.settings.manuscriptAnalysisMaxOutputTokens =
                        DEFAULT_SETTINGS.manuscriptAnalysisMaxOutputTokens;
                    this.plugin.settings.manuscriptAnalysisChunkTokenSize =
                        DEFAULT_SETTINGS.manuscriptAnalysisChunkTokenSize;
                    this.plugin.settings.embeddingsTopKChunks = DEFAULT_SETTINGS.embeddingsTopKChunks;
                    this.plugin.settings.embeddingChunkTokenSize = DEFAULT_SETTINGS.embeddingChunkTokenSize;
                    this.plugin.settings.enableEmbeddingWarming = DEFAULT_SETTINGS.enableEmbeddingWarming;
                    this.plugin.settings.enableFullEmbedPickerOption = DEFAULT_SETTINGS.enableFullEmbedPickerOption;
                    this.plugin.settings.folderTopKOverrides = { ...DEFAULT_SETTINGS.folderTopKOverrides };
                    this.plugin.settings.enableDebugLogging = DEFAULT_SETTINGS.enableDebugLogging;
                    this.plugin.settings.embeddingWarmingDebounceSeconds =
                        DEFAULT_SETTINGS.embeddingWarmingDebounceSeconds;
                    this.plugin.settings.dashboardAutoRefreshMinutes = DEFAULT_SETTINGS.dashboardAutoRefreshMinutes;
                    this.plugin.settings.dashboardAutoSnapshotOnSave = DEFAULT_SETTINGS.dashboardAutoSnapshotOnSave;
                    this.plugin.settings.dashboardMaxSnapshots = DEFAULT_SETTINGS.dashboardMaxSnapshots;
                    this.plugin.settings.readabilityFormula = DEFAULT_SETTINGS.readabilityFormula;
                    this.plugin.settings.lorebookFolders = [...DEFAULT_SETTINGS.lorebookFolders];
                    this.plugin.settings.lorebookFolderTypes = { ...DEFAULT_SETTINGS.lorebookFolderTypes };
                    this.plugin.settings.coWriterLoreContext = DEFAULT_SETTINGS.coWriterLoreContext;
                    this.plugin.settings.reviewLoreContext = DEFAULT_SETTINGS.reviewLoreContext;
                    this.plugin.settings.coWriterToolsEnabled = DEFAULT_SETTINGS.coWriterToolsEnabled;
                    this.plugin.settings.lorebookNetworkTools = DEFAULT_SETTINGS.lorebookNetworkTools;
                    this.plugin.settings.lorebookFandomWikis = [...DEFAULT_SETTINGS.lorebookFandomWikis];
                    this.plugin.settings.lorebookFandomAllowAllWikis = DEFAULT_SETTINGS.lorebookFandomAllowAllWikis;
                    this.plugin.settings.lorebookFandomCacheEnabled = DEFAULT_SETTINGS.lorebookFandomCacheEnabled;
                    this.plugin.settings.lorebookWikipediaLang = DEFAULT_SETTINGS.lorebookWikipediaLang;
                    this.plugin.settings.lorebookToolMaxTokens = DEFAULT_SETTINGS.lorebookToolMaxTokens;
                    this.plugin.settings.lorebookImageTools = DEFAULT_SETTINGS.lorebookImageTools;
                    this.plugin.settings.lorebookImageMaxDimension = DEFAULT_SETTINGS.lorebookImageMaxDimension;
                    this.plugin.settings.lorebookImageMaxDescriptionTokens =
                        DEFAULT_SETTINGS.lorebookImageMaxDescriptionTokens;
                    this.plugin.settings.lorebookImageProxyPrompt = DEFAULT_SETTINGS.lorebookImageProxyPrompt;
                    this.plugin.settings.lorebookImageTwoPassDescription =
                        DEFAULT_SETTINGS.lorebookImageTwoPassDescription;
                    this.plugin.settings.loreEntryImageSectionHeaders = [
                        ...DEFAULT_SETTINGS.loreEntryImageSectionHeaders
                    ];
                    this.plugin.settings.loreEntryImageMaxPerEntry = DEFAULT_SETTINGS.loreEntryImageMaxPerEntry;
                    this.plugin.settings.loreEntryImageAttachments = DEFAULT_SETTINGS.loreEntryImageAttachments;
                    this.plugin.settings.loreEntryImageAttachmentFolder =
                        DEFAULT_SETTINGS.loreEntryImageAttachmentFolder;
                    this.plugin.settings.slashCommands = [...DEFAULT_SETTINGS.slashCommands];
                    await this.plugin.saveSettings();
                    this.display();
                })
            );
    }

    /**
     * Render the footer area. Currently empty and collapsed to 0 height in
     * `_settings.scss` so it occupies no space. Reserved for a future donation /
     * support ask — restore the footer sizing there (rules are commented out)
     * when adding content here.
     */
    private renderFooter(containerEl: HTMLElement): void {
        containerEl.createDiv({ cls: 'quill-settings__footer' });
    }

    /** Render the Embeddings settings block into `content` (retrieval index config). */
    private renderEmbeddingsSettings(content: HTMLElement): void {
        new Setting(content).setName('Embeddings').setHeading();

        new Setting(content)
            .setName('Embedding top-k chunks')
            .setDesc(
                'Number of chunks (paragraphs) retrieved from embedded folders. Higher = more context but more tokens; lower = tighter focus, less window pressure. Recommended: 8–12 for most use cases. 3–5 keeps overhead minimal. 15+ may crowd the context window.'
            )
            .addText((text) =>
                text
                    .setValue(String(this.plugin.settings.embeddingsTopKChunks))
                    // settings.ts - no Component lifecycle available; raw addEventListener is required
                    .inputEl.addEventListener('blur', () => {
                        const n = parseInt(text.inputEl.value, 10);
                        if (!isNaN(n) && n >= 1 && n <= 100) {
                            this.plugin.settings.embeddingsTopKChunks = n;
                            void this.plugin.saveSettings();
                        } else {
                            text.setValue(String(this.plugin.settings.embeddingsTopKChunks));
                            new Notice('Value must be a number between 1 and 100');
                        }
                    })
            );

        new Setting(content)
            .setName('Embedding cache warming')
            .setDesc(
                'Automatically pre-compute and cache embeddings for each folder containing Markdown files (cast notes, lore, outlines, manuscript chapters). Enables instant semantic retrieval. Root folder is excluded.'
            )
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.enableEmbeddingWarming).onChange((value) => {
                    this.plugin.settings.enableEmbeddingWarming = value;
                    void this.plugin.saveSettings();
                    if (value) {
                        void this.plugin.warmAllEmbeddingCaches();
                    }
                })
            );

        new Setting(content)
            .setName('Embedding warming debounce (seconds)')
            .setDesc(
                'How long to wait after the last file save before warming embeddings. Higher reduces API calls during active writing; lower keeps caches fresher. Default: 30.'
            )
            .addText((text) =>
                text
                    .setValue(String(this.plugin.settings.embeddingWarmingDebounceSeconds))
                    // settings.ts - no Component lifecycle available; raw addEventListener is required
                    .inputEl.addEventListener('blur', () => {
                        const n = parseInt(text.inputEl.value, 10);
                        if (!isNaN(n) && n >= 5 && n <= 600) {
                            this.plugin.settings.embeddingWarmingDebounceSeconds = n;
                            void this.plugin.saveSettings();
                        } else {
                            text.setValue(String(this.plugin.settings.embeddingWarmingDebounceSeconds));
                            new Notice('Value must be a number between 5 and 600');
                        }
                    })
            );

        new Setting(content)
            .setName('Build embeddings now')
            .setDesc(
                'Immediately pre-compute and cache embeddings for all folders with Markdown files. ' +
                    'Useful after adding new material or when warming is turned off.'
            )
            .addButton((button) =>
                button.setButtonText('Build').onClick(() => {
                    button.setDisabled(true);
                    button.setButtonText('Building\u2026');
                    void this.plugin
                        .warmAllEmbeddingCaches()
                        .then(() => {
                            new Notice('Quill: Embedding caches rebuilt.');
                        })
                        .catch((err: unknown) => {
                            const msg = err instanceof Error ? err.message : String(err);
                            new Notice(`Quill: Embedding build failed. ${msg}`);
                        })
                        .finally(() => {
                            button.setDisabled(false);
                            button.setButtonText('Build');
                        });
                })
            );

        new Setting(content)
            .setName('Embedding chunk size (tokens)')
            .setDesc(
                "Target tokens per chunk when embedding. Must not exceed your embedding model's context window. Many local embedding models (e.g. Nomic-embed-text) support 512; cloud models may support more. Default: 512."
            )
            .addText((text) =>
                text
                    .setValue(String(this.plugin.settings.embeddingChunkTokenSize))
                    // settings.ts - no Component lifecycle available; raw addEventListener is required
                    .inputEl.addEventListener('blur', () => {
                        const n = parseInt(text.inputEl.value, 10);
                        if (!isNaN(n) && n >= 128 && n <= 8192) {
                            this.plugin.settings.embeddingChunkTokenSize = n;
                            void this.plugin.saveSettings();
                        } else {
                            text.setValue(String(this.plugin.settings.embeddingChunkTokenSize));
                            new Notice('Value must be a number between 128 and 8192');
                        }
                    })
            );

        new Setting(content)
            .setName('Show full embed in file picker')
            .setDesc(
                'When enabled, file pickers show a "{Folder name} full embed" option alongside "{Folder name} embedded" (top-K). Full embed sends all chunk texts from the folder; top-K sends only the most relevant. Default: off.'
            )
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.enableFullEmbedPickerOption).onChange((value) => {
                    this.plugin.settings.enableFullEmbedPickerOption = value;
                    void this.plugin.saveSettings();
                })
            );

        // --- Folder-specific top-K overrides ---
        new Setting(content)
            .setName('Folder-specific chunk overrides')
            .setDesc(
                'Set a custom top-k chunk count for specific embedded folders. Use a higher number for folders that are more important to your writing (e.g., plot maps), and a lower number for auxiliary lore. Folders without an override use the global setting above.'
            )
            .setHeading();

        const overridesContainer = content.createDiv({ cls: 'quill-folder-overrides-list' });

        this.renderFolderOverrides(overridesContainer);

        new Setting(content).addButton((button) =>
            button.setButtonText('+ add folder').onClick(() => {
                const folders = this.getVaultFolders();
                new FolderSuggestModal(this.app, folders, (folder) => {
                    if (this.plugin.settings.folderTopKOverrides[folder]) {
                        new Notice('Folder already has an override.');
                        return;
                    }
                    this.plugin.settings.folderTopKOverrides[folder] = this.plugin.settings.embeddingsTopKChunks;
                    void this.plugin.saveSettings();
                    this.renderFolderOverrides(overridesContainer);
                }).open();
            })
        );

        // --- Lorebook ---
    }

    /** Render the Lorebook tab — lorebook config, cached wikis, lore entry images, lore folders. */
    private renderLorebookTab(containerEl: HTMLElement): void {
        const content = containerEl.createDiv({ cls: 'quill-settings-content-lorebook' });
        this.renderLorebookSettings(content);
    }

    /** Render the lorebook settings block into `content`. */
    private renderLorebookSettings(content: HTMLElement): void {
        new Setting(content).setName('Lorebook').setHeading();

        new Setting(content)
            .setName('Feed lore into co-writer')
            .setDesc(
                'Automatically include relevant lore entries as context when generating with the co-writer. Retrieved via the embedding cache. Default: on.'
            )
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.coWriterLoreContext).onChange(async (value) => {
                    this.plugin.settings.coWriterLoreContext = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(content)
            .setName('Feed lore into review engines')
            .setDesc(
                'Automatically include relevant lore entries as context for editorial feedback, critical analysis, and manuscript analysis. Default: on.'
            )
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.reviewLoreContext).onChange(async (value) => {
                    this.plugin.settings.reviewLoreContext = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(content)
            .setName('Co-writer tool use')
            .setDesc(
                'Let the co-writer (discuss, coach, and lorebook modes) call tools ' +
                    '(manuscript mentions, lore siblings, vault lookup) via the model\u2019s native ' +
                    'tool-calling API so it can look up details mid-conversation. Turn off if your ' +
                    'model doesn\u2019t support tool calling or to avoid the extra turn consumption. Default: on.'
            )
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.coWriterToolsEnabled).onChange(async (value) => {
                    this.plugin.settings.coWriterToolsEnabled = value;
                    await this.plugin.saveSettings();
                    this.display();
                })
            );

        new Setting(content)
            .setName('Network tools')
            .setDesc(
                'Allow the co-writer to call network tools (fetch_url, fandom_lookup, ' +
                    'wikipedia_lookup). These send requests to external sites — disable only ' +
                    'if you want to restrict the AI from researching canon, references, or web ' +
                    'pages. Default: on.'
            )
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.lorebookNetworkTools).onChange(async (value) => {
                    this.plugin.settings.lorebookNetworkTools = value;
                    await this.plugin.saveSettings();
                    this.display();
                })
            );

        new Setting(content)
            .setName('Fandom wikis')
            .setDesc(
                'Comma-separated Fandom wiki subdomains the AI may query ' +
                    '(e.g., "starwars, memory-alpha, lotr"). Leave empty to disable Fandom lookups.'
            )
            .addText((text) =>
                text
                    .setValue(this.plugin.settings.lorebookFandomWikis.join(', '))
                    .inputEl.addEventListener('blur', () => {
                        const wikis = text.inputEl.value
                            .split(',')
                            .map((s) => s.trim().toLowerCase())
                            .filter((s) => s.length > 0);
                        this.plugin.settings.lorebookFandomWikis = wikis;
                        void this.plugin.saveSettings();
                    })
            );

        new Setting(content)
            .setName('Allow any wiki')
            .setDesc(
                'Caution: lets the co-writer query ANY Fandom wiki subdomain it chooses, ' +
                    'not just the allowlist above. Prefer the allowlist unless you specifically need this.'
            )
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.lorebookFandomAllowAllWikis).onChange(async (value) => {
                    this.plugin.settings.lorebookFandomAllowAllWikis = value;
                    await this.plugin.saveSettings();
                    if (value) {
                        new Notice('Quill: Fandom is now unrestricted — the co-writer can query any wiki it chooses.');
                    }
                })
            );

        new Setting(content)
            .setName('Fandom page cache')
            .setDesc(
                'Save lookups to a local cache so repeats skip the network — more private, and works offline once cached. ' +
                    'Once populated, cached pages answer even with network tools off (consent is at sync time). ' +
                    'Lives in the plugin data folder, not your vault.'
            )
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.lorebookFandomCacheEnabled).onChange(async (value) => {
                    this.plugin.settings.lorebookFandomCacheEnabled = value;
                    await this.plugin.saveSettings();
                    this.display();
                })
            );

        new Setting(content)
            .setName('Sync fandom wiki cache')
            .setDesc(
                'Download every page from an allowlisted wiki into the local cache. Fair-rate and cancelable (via the cancel command). Useful before going offline.'
            )
            .addButton((btn) =>
                btn.setButtonText('Sync now').onClick(() => {
                    this.plugin.pickFandomWikiForSync();
                })
            );

        // Per-wiki cache management (Stage 4) — size/pages/images/last-synced +
        // Clear. Rendered only when the cache is enabled; stats load async.
        if (this.plugin.settings.lorebookFandomCacheEnabled) {
            new Setting(content).setName('Cached wikis').setHeading();
            const cachedWikis = this.plugin.settings.lorebookFandomWikis;
            if (cachedWikis.length === 0) {
                new Setting(content).setDesc(
                    'No allowlisted wikis to show. Add a wiki subdomain above to manage its cache.'
                );
            } else {
                for (const wiki of cachedWikis) {
                    const row = new Setting(content).setName(wiki).setDesc('Loading cache stats…');
                    row.addButton((btn) =>
                        btn
                            .setButtonText('Clear')
                            .setWarning()
                            .onClick(async () => {
                                btn.setButtonText('Clearing…').setDisabled(true);
                                await this.plugin.clearFandomWikiCache(wiki);
                                this.display();
                            })
                    );
                    void this.plugin.fandomCache?.getWikiStats(wiki).then((stats) => {
                        row.setDesc(formatFandomCacheStats(stats));
                    });
                }
            }
        }

        new Setting(content)
            .setName('Wikipedia language')
            .setDesc('Wikipedia language subdomain (e.g., "en", "fr", "de", "simple"). Default: en.')
            .addText((text) =>
                text.setValue(this.plugin.settings.lorebookWikipediaLang).inputEl.addEventListener('blur', () => {
                    const lang = text.inputEl.value.trim().toLowerCase();
                    if (!lang) {
                        this.plugin.settings.lorebookWikipediaLang = 'en';
                        void this.plugin.saveSettings();
                        // Keep the visible field in sync with the reverted default.
                        text.inputEl.value = 'en';
                        return;
                    }
                    if (!isValidWikipediaLang(lang)) {
                        new Notice(
                            `Quill: "${lang}" is not a valid Wikipedia language code (use a subdomain like "en", "fr", or "simple").`
                        );
                        text.inputEl.value = this.plugin.settings.lorebookWikipediaLang;
                        return;
                    }
                    this.plugin.settings.lorebookWikipediaLang = lang;
                    void this.plugin.saveSettings();
                })
            );

        new Setting(content)
            .setName('Network tool result limit (tokens)')
            .setDesc('Maximum tokens returned per network tool call. Default: 2000.')
            .addText((text) =>
                text
                    .setValue(String(this.plugin.settings.lorebookToolMaxTokens))
                    .inputEl.addEventListener('blur', () => {
                        const n = parseInt(text.inputEl.value, 10);
                        if (!isNaN(n) && n >= 100) {
                            this.plugin.settings.lorebookToolMaxTokens = n;
                            void this.plugin.saveSettings();
                        } else {
                            text.setValue(String(this.plugin.settings.lorebookToolMaxTokens));
                            new Notice('Value must be a number ≥ 100');
                        }
                    })
            );

        new Setting(content)
            .setName('Image tools')
            .setDesc(
                'Allow the co-writer to call image-fetching tools — fetch_image_url (download any ' +
                    'image URL), fandom_image (Fandom lead/gallery images), and wikipedia_image ' +
                    '(Wikipedia lead portraits). Images are downscaled before delivery. Requires a ' +
                    'vision-capable chat model (role "Chat + image") or a dedicated image model ' +
                    '(role "Image") to have any effect. Default: on.'
            )
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.lorebookImageTools).onChange(async (value) => {
                    this.plugin.settings.lorebookImageTools = value;
                    await this.plugin.saveSettings();
                    this.display();
                })
            );

        new Setting(content)
            .setName('Image max dimension (px)')
            .setDesc('Longest-side cap before downscale. Smaller values save context budget. Default: 512.')
            .addText((text) =>
                text
                    .setValue(String(this.plugin.settings.lorebookImageMaxDimension))
                    .inputEl.addEventListener('blur', () => {
                        const n = parseInt(text.inputEl.value, 10);
                        if (!isNaN(n) && n >= 64 && n <= 2048) {
                            this.plugin.settings.lorebookImageMaxDimension = n;
                            void this.plugin.saveSettings();
                        } else {
                            text.setValue(String(this.plugin.settings.lorebookImageMaxDimension));
                            new Notice('Value must be a number between 64 and 2048');
                        }
                    })
            );

        new Setting(content)
            .setName('Image description token budget')
            .setDesc(
                'Max output tokens for the Regime B image-description call. Higher values let the model ' +
                    'describe every character in a group image; lower values are faster on local hardware. ' +
                    'The model stops early when it finishes — this is a ceiling, not a target. Default: 2048.'
            )
            .addText((text) =>
                text
                    .setValue(String(this.plugin.settings.lorebookImageMaxDescriptionTokens))
                    .inputEl.addEventListener('blur', () => {
                        const n = parseInt(text.inputEl.value, 10);
                        if (!isNaN(n) && n >= 256 && n <= 8192) {
                            this.plugin.settings.lorebookImageMaxDescriptionTokens = n;
                            void this.plugin.saveSettings();
                        } else {
                            text.setValue(String(this.plugin.settings.lorebookImageMaxDescriptionTokens));
                            new Notice('Value must be a number between 256 and 8192');
                        }
                    })
            );

        new Setting(content)
            .setName('Image proxy prompt')
            .setDesc(
                'When your chat model is text-only and a separate image model is configured, ' +
                    'this tells the image model how to describe images into text. Edit to focus ' +
                    'on what matters for your fiction (clothing, architecture, mood, etc.).'
            )
            .addTextArea((text) =>
                text.setValue(this.plugin.settings.lorebookImageProxyPrompt).inputEl.addEventListener('blur', () => {
                    const value = text.inputEl.value.trim();
                    if (value.length > 0) {
                        this.plugin.settings.lorebookImageProxyPrompt = value;
                    } else {
                        // Restore the default and keep the visible input in
                        // sync so the displayed text matches the saved setting.
                        this.plugin.settings.lorebookImageProxyPrompt = DEFAULT_IMAGE_PROXY_PROMPT;
                        text.inputEl.value = DEFAULT_IMAGE_PROXY_PROMPT;
                    }
                    void this.plugin.saveSettings();
                })
            );

        new Setting(content)
            .setName('Two-pass image description')
            .setDesc(
                'When your chat model is text-only and a separate image model is configured, describe ' +
                    'multi-image batches in two passes: the image model first counts and labels each ' +
                    'visible character, then describes each with that list as grounding. Helps weaker ' +
                    'vision models keep per-character descriptions coherent across a group. Only ' +
                    'applies when more than one image is attached — single images skip the count pass.'
            )
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.lorebookImageTwoPassDescription).onChange((value) => {
                    this.plugin.settings.lorebookImageTwoPassDescription = value;
                    void this.plugin.saveSettings();
                })
            );

        new Setting(content).setName('Lore entry images').setHeading();
        new Setting(content)
            .setName('Image gallery section headings')
            .setDesc(
                "Comma-separated headings that mark a lore entry's image-gallery section (case-insensitive). " +
                    'The scanner parses image embeds (e.g., `![[file.png]]`) under any matching heading and ' +
                    'surfaces them to the AI via the get_lore_image tool. Subheadings within the gallery ' +
                    'section become per-image labels (useful for multi-form characters). Example headings: ' +
                    "'Reference', 'Gallery', 'Forms', 'Appearance'."
            )
            .addText((text) =>
                text
                    .setValue(this.plugin.settings.loreEntryImageSectionHeaders.join(', '))
                    .inputEl.addEventListener('blur', () => {
                        const value = text.inputEl.value
                            .split(',')
                            .map((s) => s.trim())
                            .filter((s) => s.length > 0);
                        this.plugin.settings.loreEntryImageSectionHeaders = value;
                        void this.plugin.saveSettings();
                    })
            );

        new Setting(content)
            .setName('Max images per lore entry')
            .setDesc(
                'Soft cap on the number of images the scanner extracts per entry. Overflow is silently ' +
                    'dropped — the cap is a budget tool, not a content rule. The writer can still place ' +
                    'more embeds in the note body. Default: 4.'
            )
            .addText((text) =>
                text
                    .setValue(String(this.plugin.settings.loreEntryImageMaxPerEntry))
                    .inputEl.addEventListener('blur', () => {
                        const n = parseInt(text.inputEl.value, 10);
                        if (!isNaN(n) && n >= 1 && n <= 20) {
                            this.plugin.settings.loreEntryImageMaxPerEntry = n;
                            void this.plugin.saveSettings();
                        } else {
                            text.setValue(String(this.plugin.settings.loreEntryImageMaxPerEntry));
                            new Notice('Value must be a number between 1 and 20');
                        }
                    })
            );

        new Setting(content)
            .setName('Agent image attachments')
            .setDesc(
                'Allow the lorebook coach and batch tools to propose image attachments for your review. ' +
                    'On: the coach can attach images when drafting an entry, and the batch tool can attach ' +
                    'images to existing entries. Every attachment flows through the review queue — nothing ' +
                    'is written without your approval. Off: the agent cannot attach images, but you can ' +
                    'still add them manually via ![[file]] embeds. Does not affect other tools. Default: on.'
            )
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.loreEntryImageAttachments).onChange(async (value) => {
                    this.plugin.settings.loreEntryImageAttachments = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(content)
            .setName('Attachment folder')
            .setDesc(
                'Where agent-attached images are written on approval. Empty uses Obsidian’s configured ' +
                    'attachment folder. Vault-relative path (e.g., "Attachments/Lore").'
            )
            .addText((text) =>
                text
                    .setValue(this.plugin.settings.loreEntryImageAttachmentFolder)
                    .inputEl.addEventListener('blur', () => {
                        const value = text.inputEl.value.trim();
                        this.plugin.settings.loreEntryImageAttachmentFolder = value;
                        void this.plugin.saveSettings();
                    })
            );

        new Setting(content)
            .setName('Prefer editing existing lore')
            .setDesc(
                'When the lorebook coach drafts a new entry whose exact name already matches a note in ' +
                    'your vault, refuse the draft and point it at edit_note / insert_note / append_to_note ' +
                    'instead. Avoids duplicate notes that strand [[wikilinks]] pointing at the original. ' +
                    'Off = allow unconditional creation. Default: on.'
            )
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.lorePreferEditOverCreate).onChange(async (value) => {
                    this.plugin.settings.lorePreferEditOverCreate = value;
                    await this.plugin.saveSettings();
                })
            );

        // --- Slash commands (co-writer input shortcuts) ---
        new Setting(content)
            .setName('Slash commands')
            .setDesc(
                'Shortcut snippets for the co-writer chat input. Typing "/" at the start of a line ' +
                    'opens a picker listing matching commands; choosing one inserts the body into ' +
                    'the input, fully editable before sending. Empty list (the default) disables ' +
                    'the picker. Names must be kebab-case (lowercase letters, digits, hyphens; ' +
                    'must start with a letter).'
            )
            .setHeading();

        const slashCmdContainer = content.createDiv({ cls: 'quill-slash-command-list' });
        this.renderSlashCommands(slashCmdContainer);

        new Setting(content).addButton((button) =>
            button.setButtonText('+ add command').onClick(() => {
                this.plugin.settings.slashCommands.push({ name: '', description: '', body: '' });
                void this.plugin.saveSettings().then(() => this.display());
            })
        );

        new Setting(content)
            .setName('Lorebook folders')
            .setDesc(
                'Folders scanned for lore entries. Any Markdown file under one of these folders is treated as a lore entry. Set a per-folder type default so every file inherits it without frontmatter; leave as mixed to type files individually via the quill-type key.'
            )
            .setHeading();

        const loreFoldersContainer = content.createDiv({ cls: 'quill-folder-overrides-list' });
        this.renderLorebookFolders(loreFoldersContainer);

        new Setting(content).addButton((button) =>
            button.setButtonText('+ add folder').onClick(() => {
                const folders = this.getVaultFolders().filter((f) => !this.plugin.settings.lorebookFolders.includes(f));
                new FolderSuggestModal(this.app, folders, (folder) => {
                    if (this.plugin.settings.lorebookFolders.includes(folder)) {
                        new Notice('Folder already in lorebook.');
                        return;
                    }
                    this.plugin.settings.lorebookFolders.push(folder);
                    this.plugin.settings.lorebookFolders.sort((a, b) => a.localeCompare(b));
                    void this.plugin.saveSettings();
                    this.renderLorebookFolders(loreFoldersContainer);
                }).open();
            })
        );
    }

    private renderLinterTab(containerEl: HTMLElement): void {
        const content = containerEl.createDiv({ cls: 'quill-settings-content-linter' });

        new Setting(content).setName('Prose linter').setHeading();

        new Setting(content)
            .setName('Linter mode')
            .setDesc('Choose which rule sets are active.')
            .addDropdown((dropdown) =>
                dropdown
                    .addOption('all', 'All rules')
                    .addOption('prose', 'Prose rules only')
                    .addOption('ai', 'AI detection only')
                    .setValue(this.plugin.settings.linterMode)
                    .onChange(async (value) => {
                        this.plugin.settings.linterMode = value as LinterMode;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(content)
            .setName('Lint on save')
            .setDesc('Automatically run the prose linter when the document is saved.')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.lintOnSave).onChange(async (value) => {
                    this.plugin.settings.lintOnSave = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(content)
            .setName('Long sentences')
            .setDesc('Flag sentences exceeding the word limit below.')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.enableLongSentences).onChange(async (value) => {
                    this.plugin.settings.enableLongSentences = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(content)
            .setName('Max words per sentence')
            .setDesc('Sentences longer than this many words will be flagged.')
            .addText((text) =>
                text.setValue(String(this.plugin.settings.maxSentenceWords)).inputEl.addEventListener('blur', () => {
                    const n = parseInt(text.inputEl.value, 10);
                    if (!isNaN(n) && n >= 1) {
                        this.plugin.settings.maxSentenceWords = n;
                        void this.plugin.saveSettings();
                    } else {
                        text.setValue(String(this.plugin.settings.maxSentenceWords));
                        new Notice('Value must be a number ≥ 1');
                    }
                })
            );

        new Setting(content)
            .setName('Passive voice')
            .setDesc(
                'Flag instances of passive voice. Disabled by default — it is often a valid stylistic choice in fiction.'
            )
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.enablePassiveVoice).onChange(async (value) => {
                    this.plugin.settings.enablePassiveVoice = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(content)
            .setName('Adverbs')
            .setDesc(
                'Flag adverbs (e.g. Quickly, slowly, very). Enabled by default — a common teaching tool for new writers.'
            )
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.enableAdverbCheck).onChange(async (value) => {
                    this.plugin.settings.enableAdverbCheck = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(content)
            .setName('Qualifiers')
            .setDesc('Flag weak qualifiers (very, really, quite, etc.).')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.enableQualifierCheck).onChange(async (value) => {
                    this.plugin.settings.enableQualifierCheck = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(content)
            .setName('Repeated words')
            .setDesc('Flag words repeated 3+ times in a single line.')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.enableRepeatedWords).onChange(async (value) => {
                    this.plugin.settings.enableRepeatedWords = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(content)
            .setName('Min word length for repeats')
            .setDesc('Words shorter than this are ignored by the repeated-words rule.')
            .addText((text) =>
                text
                    .setValue(String(this.plugin.settings.minRepeatedWordLength))
                    .inputEl.addEventListener('blur', () => {
                        const n = parseInt(text.inputEl.value, 10);
                        if (!isNaN(n) && n >= 1) {
                            this.plugin.settings.minRepeatedWordLength = n;
                            void this.plugin.saveSettings();
                        } else {
                            text.setValue(String(this.plugin.settings.minRepeatedWordLength));
                            new Notice('Value must be a number ≥ 1');
                        }
                    })
            );

        new Setting(content)
            .setName('Echoes')
            .setDesc('Flag sentences in a paragraph that start with the same two words.')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.enableEchoes).onChange(async (value) => {
                    this.plugin.settings.enableEchoes = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(content)
            .setName('Telling vs showing')
            .setDesc('Flag emotional tells (e.g. He felt angry) that could be shown instead.')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.enableTellingVsShowing).onChange(async (value) => {
                    this.plugin.settings.enableTellingVsShowing = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(content)
            .setName('Dialogue tags')
            .setDesc('Flag overused or repetitive dialogue tags.')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.enableDialogueTags).onChange(async (value) => {
                    this.plugin.settings.enableDialogueTags = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(content)
            .setName('Complex words')
            .setDesc('Flag words with many syllables that may be hard to read.')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.enableComplexWords).onChange(async (value) => {
                    this.plugin.settings.enableComplexWords = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(content)
            .setName('Max syllables per word')
            .setDesc('Words with at least this many syllables are flagged by the complex-words rule.')
            .addText((text) =>
                text.setValue(String(this.plugin.settings.maxSyllablesPerWord)).inputEl.addEventListener('blur', () => {
                    const n = parseInt(text.inputEl.value, 10);
                    if (!isNaN(n) && n >= 1) {
                        this.plugin.settings.maxSyllablesPerWord = n;
                        void this.plugin.saveSettings();
                    } else {
                        text.setValue(String(this.plugin.settings.maxSyllablesPerWord));
                        new Notice('Value must be a number ≥ 1');
                    }
                })
            );

        new Setting(content).setName('AI detection').setHeading();

        new Setting(content)
            .setName('AI clichés')
            .setDesc('Flag overused AI words (tapestry, testament, delve, vibrant, realm, etc.).')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.enableAiCliches).onChange(async (value) => {
                    this.plugin.settings.enableAiCliches = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(content)
            .setName('Em dashes')
            .setDesc('Flag em dashes (—). Common AI overuse — consider commas, colons, or sentence breaks.')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.enableAiEmDashes).onChange(async (value) => {
                    this.plugin.settings.enableAiEmDashes = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(content)
            .setName('Negation patterns')
            .setDesc('Flag "it\'s not X, it\'s y" constructions. State what things are directly.')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.enableAiNegation).onChange(async (value) => {
                    this.plugin.settings.enableAiNegation = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(content)
            .setName('Filler adverbs')
            .setDesc('Flag strategy adverbs common in AI prose (quietly, deliberately, gently, etc.).')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.enableAiFillerAdverbs).onChange(async (value) => {
                    this.plugin.settings.enableAiFillerAdverbs = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(content)
            .setName('Hedging language')
            .setDesc('Flag hedging words (might, could, perhaps, maybe) that weaken prose.')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.enableAiHedging).onChange(async (value) => {
                    this.plugin.settings.enableAiHedging = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(content)
            .setName('Wrap-up phrases')
            .setDesc('Flag concluding phrases (in conclusion, to summarize, ultimately, etc.).')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.enableAiWrapUps).onChange(async (value) => {
                    this.plugin.settings.enableAiWrapUps = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(content).setName('Gremlins').setHeading();

        new Setting(content)
            .setName('Invisible character detection')
            .setDesc(
                'Flag invisible / zero-width / non-printing unicode characters (formatting controls, soft hyphens, variation selectors, etc.) that may be AI watermarks or copy-paste artifacts.'
            )
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.enableGremlins).onChange(async (value) => {
                    this.plugin.settings.enableGremlins = value;
                    if (!value) this.plugin.settings.enableAggressiveGremlins = false;
                    await this.plugin.saveSettings();
                    this.display();
                })
            );

        new Setting(content)
            .setName('Aggressive scanning')
            .setDesc(
                'Scan for every unicode format character, including those legitimately used in emoji (keycaps, zwj sequences, variation selectors, tag characters, etc.). Recommended for security audits.'
            )
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.enableAggressiveGremlins)
                    .setDisabled(!this.plugin.settings.enableGremlins)
                    .onChange(async (value) => {
                        this.plugin.settings.enableAggressiveGremlins = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(content)
            .setName('Restore defaults')
            .setDesc('Reset all linter settings to their default values.')
            .addButton((button) =>
                button.setButtonText('Restore defaults').onClick(async () => {
                    // Only reset linter-related fields, not AI provider settings
                    this.plugin.settings.linterMode = DEFAULT_SETTINGS.linterMode;
                    this.plugin.settings.lintOnSave = DEFAULT_SETTINGS.lintOnSave;
                    this.plugin.settings.enableLongSentences = DEFAULT_SETTINGS.enableLongSentences;
                    this.plugin.settings.maxSentenceWords = DEFAULT_SETTINGS.maxSentenceWords;
                    this.plugin.settings.enablePassiveVoice = DEFAULT_SETTINGS.enablePassiveVoice;
                    this.plugin.settings.enableAdverbCheck = DEFAULT_SETTINGS.enableAdverbCheck;
                    this.plugin.settings.enableQualifierCheck = DEFAULT_SETTINGS.enableQualifierCheck;
                    this.plugin.settings.enableRepeatedWords = DEFAULT_SETTINGS.enableRepeatedWords;
                    this.plugin.settings.minRepeatedWordLength = DEFAULT_SETTINGS.minRepeatedWordLength;
                    this.plugin.settings.enableEchoes = DEFAULT_SETTINGS.enableEchoes;
                    this.plugin.settings.enableTellingVsShowing = DEFAULT_SETTINGS.enableTellingVsShowing;
                    this.plugin.settings.enableDialogueTags = DEFAULT_SETTINGS.enableDialogueTags;
                    this.plugin.settings.enableComplexWords = DEFAULT_SETTINGS.enableComplexWords;
                    this.plugin.settings.maxSyllablesPerWord = DEFAULT_SETTINGS.maxSyllablesPerWord;
                    this.plugin.settings.enableAiCliches = DEFAULT_SETTINGS.enableAiCliches;
                    this.plugin.settings.enableAiEmDashes = DEFAULT_SETTINGS.enableAiEmDashes;
                    this.plugin.settings.enableAiNegation = DEFAULT_SETTINGS.enableAiNegation;
                    this.plugin.settings.enableAiFillerAdverbs = DEFAULT_SETTINGS.enableAiFillerAdverbs;
                    this.plugin.settings.enableAiHedging = DEFAULT_SETTINGS.enableAiHedging;
                    this.plugin.settings.enableAiWrapUps = DEFAULT_SETTINGS.enableAiWrapUps;
                    this.plugin.settings.enableGremlins = DEFAULT_SETTINGS.enableGremlins;
                    this.plugin.settings.enableAggressiveGremlins = DEFAULT_SETTINGS.enableAggressiveGremlins;
                    await this.plugin.saveSettings();
                    this.display();
                })
            );
    }

    /** Render the AI providers configuration section. */
    private renderAiProvidersTab(containerEl: HTMLElement): void {
        const content = containerEl.createDiv({ cls: 'quill-settings-content-ai-providers' });

        new Setting(content).setName('AI providers').setHeading();

        // Render each provider card
        const providers = this.plugin.settings.aiProviders;
        for (const [pIdx, provider] of providers.entries()) {
            this.renderProviderCard(content, provider, pIdx);
        }

        // Add provider button
        new Setting(content)
            .setName('Add provider')
            .setDesc('Add a new AI provider endpoint.')
            .addButton((button) =>
                button.setButtonText('Add provider').onClick(() => {
                    new AddProviderModal(this.app, (type, defaultEndpoint) => {
                        this.addProvider(type, defaultEndpoint);
                    }).open();
                })
            );

        // Default model dropdowns
        this.renderDefaultModelSettings(content);
    }

    /** Render a single provider card. */
    private renderProviderCard(containerEl: HTMLElement, provider: ProviderConfig, index: number): void {
        const card = containerEl.createDiv({ cls: 'quill-provider-card' });

        // Provider heading row
        const headingRow = card.createDiv({ cls: 'quill-provider-card__heading' });

        new Setting(headingRow).setName(provider.name || 'Unnamed provider').addButton((button) =>
            button.setButtonText('Remove').onClick(async () => {
                this.plugin.settings.aiProviders.splice(index, 1);
                this.validateDefaultProviders();
                await this.plugin.saveSettings();
                this.display();
            })
        );

        // Name
        new Setting(card)
            .setName('Name')
            .setDesc('A display name for this provider.')
            .addText((text) =>
                text.setValue(provider.name).onChange(async (value) => {
                    provider.name = value;
                    await this.plugin.saveSettings();
                })
            );

        // Type
        new Setting(card)
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
                                void this.plugin.saveSettings().then(() => this.display());
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
                        this.display();
                    })
            );

        // Endpoint URL
        new Setting(card)
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
            new Setting(card)
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
        new Setting(card)
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
                    card.createDiv({
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
                                void this.plugin.saveSettings().then(() => this.display());
                            } else {
                                new Notice('Value must be a positive number');
                            }
                        }).open();
                        return;
                    }
                    provider.maxContextTokens = parseInt(value, 10);
                    await this.plugin.saveSettings();
                });
            });

        // Max output tokens
        new Setting(card)
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

        // Models sub-list
        this.renderModelList(card, provider);

        // Test buttons
        this.renderTestButtons(card, provider);
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
                            this.display();
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
                        this.display();
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
                this.display();
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

    /** Render the default chat/embed/image model dropdowns. */
    private renderDefaultModelSettings(containerEl: HTMLElement): void {
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
    private renderModelBehaviorsTab(containerEl: HTMLElement): void {
        const content = containerEl.createDiv({ cls: 'quill-settings-content-model-behaviors' });
        this.renderModelBehaviorsSettings(content);
    }

    /** Render model behavior settings. */
    private renderModelBehaviorsSettings(containerEl: HTMLElement): void {
        new Setting(containerEl)
            .setName('Selection transformations')
            .setHeading()
            .addExtraButton((btn) =>
                btn
                    .setIcon('rotate-ccw')
                    .setTooltip('Restore transformation defaults')
                    .onClick(async () => {
                        this.plugin.settings.narrativeVoicePreset = DEFAULT_SETTINGS.narrativeVoicePreset;
                        this.plugin.settings.customNarrativeVoiceRules = DEFAULT_SETTINGS.customNarrativeVoiceRules;
                        this.plugin.settings.transformTemperature = DEFAULT_SETTINGS.transformTemperature;
                        this.plugin.settings.transformVaultContext = DEFAULT_SETTINGS.transformVaultContext;
                        this.plugin.settings.transformMaxOutputTokens = DEFAULT_SETTINGS.transformMaxOutputTokens;
                        this.plugin.settings.wikiLinkBehavior = DEFAULT_SETTINGS.wikiLinkBehavior;
                        await this.plugin.saveSettings();
                        this.display();
                    })
            );

        new Setting(containerEl)
            .setName('Narrative voice')
            .setDesc('The narrative perspective and tense used when generating text.')
            .addDropdown((dropdown) => {
                for (const preset of NARRATIVE_VOICE_PRESETS) {
                    dropdown.addOption(preset.id, preset.label);
                }
                dropdown.setValue(this.plugin.settings.narrativeVoicePreset).onChange(async (value) => {
                    this.plugin.settings.narrativeVoicePreset = value as NarrativeVoicePreset;
                    await this.plugin.saveSettings();
                    this.updateNarrativeVoiceRulesDisplay(value as NarrativeVoicePreset, rulesArea);
                });
            });

        const rulesArea = containerEl.createDiv({ cls: 'quill-narrative-rules' });
        this.renderNarrativeVoiceRules(containerEl, rulesArea);

        new Setting(containerEl)
            .setName('Temperature')
            .setDesc('Higher values produce more creative output. Range: 0.0 – 2.0.')
            .addText((text) =>
                text
                    .setValue(String(this.plugin.settings.transformTemperature))
                    .inputEl.addEventListener('blur', () => {
                        const n = parseFloat(text.inputEl.value);
                        if (!isNaN(n) && n >= 0 && n <= 2) {
                            this.plugin.settings.transformTemperature = n;
                            void this.plugin.saveSettings();
                        } else {
                            text.setValue(String(this.plugin.settings.transformTemperature));
                            new Notice('Value must be a number between 0.0 and 2.0');
                        }
                    })
            );

        new Setting(containerEl)
            .setName('Vault context')
            .setDesc(
                'Include cross-document vault context (character notes, worldbuilding, etc.) in transformation prompts.'
            )
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.transformVaultContext).onChange(async (value) => {
                    this.plugin.settings.transformVaultContext = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('Max output tokens')
            .setDesc('Maximum tokens per transformation response. Higher values allow longer rewrites.')
            .addText((text) =>
                text
                    .setValue(String(this.plugin.settings.transformMaxOutputTokens))
                    .inputEl.addEventListener('blur', () => {
                        const n = parseInt(text.inputEl.value, 10);
                        if (!isNaN(n) && n >= 1) {
                            this.plugin.settings.transformMaxOutputTokens = n;
                            void this.plugin.saveSettings();
                        } else {
                            text.setValue(String(this.plugin.settings.transformMaxOutputTokens));
                            new Notice('Value must be a number ≥ 1');
                        }
                    })
            );

        new Setting(containerEl)
            .setName('Wiki link handling')
            .setDesc(
                'How AI should handle Obsidian wiki links ([[...]]) when rewriting or generating prose. "preserve" keeps them exactly as-is. "adaptive" allows the AI to adapt the display text after the pipe (|) to fit the prose while keeping the page name and heading intact.'
            )
            .addDropdown((dropdown) =>
                dropdown
                    .addOption('preserve', 'Preserve exactly')
                    .addOption('adaptive', 'Adaptive (smart display text)')
                    .setValue(this.plugin.settings.wikiLinkBehavior)
                    .onChange(async (value) => {
                        this.plugin.settings.wikiLinkBehavior = value as WikiLinkBehavior;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName('Co-writer')
            .setHeading()
            .addExtraButton((btn) =>
                btn
                    .setIcon('rotate-ccw')
                    .setTooltip('Restore co-writer defaults')
                    .onClick(async () => {
                        this.plugin.settings.coWriterTemperature = DEFAULT_SETTINGS.coWriterTemperature;
                        this.plugin.settings.coWriterMaxOutputTokens = DEFAULT_SETTINGS.coWriterMaxOutputTokens;
                        this.plugin.settings.coWriterMaxToolRounds = DEFAULT_SETTINGS.coWriterMaxToolRounds;
                        this.plugin.settings.coWriterSessionHistoryLimit = DEFAULT_SETTINGS.coWriterSessionHistoryLimit;
                        this.plugin.settings.coWriterAutoSavePerTurn = DEFAULT_SETTINGS.coWriterAutoSavePerTurn;
                        this.plugin.settings.coWriterVaultContext = DEFAULT_SETTINGS.coWriterVaultContext;
                        this.plugin.settings.coWriterAppendNewline = DEFAULT_SETTINGS.coWriterAppendNewline;
                        this.plugin.settings.enableCoWriterThought = DEFAULT_SETTINGS.enableCoWriterThought;
                        this.plugin.settings.coWriterVoiceMatch = DEFAULT_SETTINGS.coWriterVoiceMatch;
                        this.plugin.settings.enableInlineDirectives = DEFAULT_SETTINGS.enableInlineDirectives;
                        await this.plugin.saveSettings();
                        this.display();
                    })
            );

        new Setting(containerEl)
            .setName('Temperature')
            .setDesc('Higher values produce more creative continuations. Range: 0.0 – 2.0.')
            .addText((text) =>
                text.setValue(String(this.plugin.settings.coWriterTemperature)).inputEl.addEventListener('blur', () => {
                    const n = parseFloat(text.inputEl.value);
                    if (!isNaN(n) && n >= 0 && n <= 2) {
                        this.plugin.settings.coWriterTemperature = n;
                        void this.plugin.saveSettings();
                    } else {
                        text.setValue(String(this.plugin.settings.coWriterTemperature));
                        new Notice('Value must be a number between 0.0 and 2.0');
                    }
                })
            );

        new Setting(containerEl)
            .setName('Max output tokens')
            .setDesc('Maximum tokens per continuation. Higher values allow longer passages.')
            .addText((text) =>
                text
                    .setValue(String(this.plugin.settings.coWriterMaxOutputTokens))
                    .inputEl.addEventListener('blur', () => {
                        const n = parseInt(text.inputEl.value, 10);
                        if (!isNaN(n) && n >= 1) {
                            this.plugin.settings.coWriterMaxOutputTokens = n;
                            void this.plugin.saveSettings();
                        } else {
                            text.setValue(String(this.plugin.settings.coWriterMaxOutputTokens));
                            new Notice('Value must be a number ≥ 1');
                        }
                    })
            );

        new Setting(containerEl)
            .setName('Max tool rounds')
            .setDesc(
                'Maximum number of tool-calling rounds per response. Set to 0 for unlimited — the model ' +
                    'will call as many rounds as it needs (use Stop to cancel). Set a specific number to ' +
                    'cap turn consumption. Default: 0 (unlimited).'
            )
            .addText((text) =>
                text
                    .setValue(String(this.plugin.settings.coWriterMaxToolRounds))
                    .inputEl.addEventListener('blur', () => {
                        const n = parseInt(text.inputEl.value, 10);
                        if (!isNaN(n) && n >= 0) {
                            this.plugin.settings.coWriterMaxToolRounds = n;
                            void this.plugin.saveSettings();
                        } else {
                            text.setValue(String(this.plugin.settings.coWriterMaxToolRounds));
                            new Notice('Value must be a number ≥ 0');
                        }
                    })
            );

        new Setting(containerEl)
            .setName('Saved conversation limit')
            .setDesc(
                'How many co-writer conversations to keep on disk. Starting a new chat saves the current one; ' +
                    'older sessions are deleted (newest-first) once this limit is exceeded. Set to 0 to keep all. ' +
                    'Default: 25.'
            )
            .addText((text) =>
                text
                    .setValue(String(this.plugin.settings.coWriterSessionHistoryLimit))
                    .inputEl.addEventListener('blur', () => {
                        const n = parseInt(text.inputEl.value, 10);
                        if (!isNaN(n) && n >= 0) {
                            this.plugin.settings.coWriterSessionHistoryLimit = n;
                            void this.plugin.saveSettings();
                        } else {
                            text.setValue(String(this.plugin.settings.coWriterSessionHistoryLimit));
                            new Notice('Value must be a number ≥ 0');
                        }
                    })
            );

        new Setting(containerEl)
            .setName('Auto-save after each turn')
            .setDesc(
                'Snapshot the active conversation to its saved-session file after every completed turn, so it ' +
                    'survives a crash or restart without an explicit save. Off by default — the snapshot copies ' +
                    'the full conversation state, so it adds some overhead on long sessions. De-bounced so a ' +
                    'turn followed immediately by auto-options collapses to one write.'
            )
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.coWriterAutoSavePerTurn).onChange((value) => {
                    this.plugin.settings.coWriterAutoSavePerTurn = value;
                    void this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('Vault context')
            .setDesc(
                'Include cross-document vault context (character notes, worldbuilding, etc.) in co-writer prompts.'
            )
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.coWriterVaultContext).onChange(async (value) => {
                    this.plugin.settings.coWriterVaultContext = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('Append trailing newline')
            .setDesc('Add a blank line after the continuation so you can keep writing without pressing enter twice.')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.coWriterAppendNewline).onChange(async (value) => {
                    this.plugin.settings.coWriterAppendNewline = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('Show AI reasoning')
            .setDesc("Display the AI's thought process in the co-writer panel. Disable for a cleaner interface.")
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.enableCoWriterThought).onChange(async (value) => {
                    this.plugin.settings.enableCoWriterThought = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('Voice matching')
            .setDesc(
                'Analyze the voice of your prose before generating to produce more consistent continuations. Adds a small delay before generation starts.'
            )
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.coWriterVoiceMatch).onChange(async (value) => {
                    this.plugin.settings.coWriterVoiceMatch = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('Inline directives')
            .setDesc(
                'Parse `<!-- quill: ... -->` comments immediately preceding the cursor and feed them to the co-writer as steering. Disable to ignore directives entirely.'
            )
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.enableInlineDirectives).onChange(async (value) => {
                    this.plugin.settings.enableInlineDirectives = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('Analysis')
            .setHeading()
            .addExtraButton((btn) =>
                btn
                    .setIcon('rotate-ccw')
                    .setTooltip('Restore analysis defaults')
                    .onClick(async () => {
                        this.plugin.settings.analysisTemperature = DEFAULT_SETTINGS.analysisTemperature;
                        this.plugin.settings.analysisMaxOutputTokens = DEFAULT_SETTINGS.analysisMaxOutputTokens;
                        await this.plugin.saveSettings();
                        this.display();
                    })
            );

        new Setting(containerEl)
            .setName('Analysis temperature')
            .setDesc('Temperature for AI analysis and feedback responses (companion mode). Range: 0.0 – 2.0.')
            .addText((text) =>
                text.setValue(String(this.plugin.settings.analysisTemperature)).inputEl.addEventListener('blur', () => {
                    const n = parseFloat(text.inputEl.value);
                    if (!isNaN(n) && n >= 0 && n <= 2) {
                        this.plugin.settings.analysisTemperature = n;
                        void this.plugin.saveSettings();
                    } else {
                        text.setValue(String(this.plugin.settings.analysisTemperature));
                        new Notice('Value must be a number between 0.0 and 2.0');
                    }
                })
            );

        new Setting(containerEl)
            .setName('Analysis max output tokens')
            .setDesc('Maximum tokens per analysis response.')
            .addText((text) =>
                text
                    .setValue(String(this.plugin.settings.analysisMaxOutputTokens))
                    .inputEl.addEventListener('blur', () => {
                        const n = parseInt(text.inputEl.value, 10);
                        if (!isNaN(n) && n >= 1) {
                            this.plugin.settings.analysisMaxOutputTokens = n;
                            void this.plugin.saveSettings();
                        } else {
                            text.setValue(String(this.plugin.settings.analysisMaxOutputTokens));
                            new Notice('Value must be a number ≥ 1');
                        }
                    })
            );

        new Setting(containerEl)
            .setName('Feedback queue')
            .setHeading()
            .addExtraButton((btn) =>
                btn
                    .setIcon('rotate-ccw')
                    .setTooltip('Restore feedback queue defaults')
                    .onClick(async () => {
                        this.plugin.settings.enableFeedbackQueue = DEFAULT_SETTINGS.enableFeedbackQueue;
                        this.plugin.settings.feedbackQueueLimit = DEFAULT_SETTINGS.feedbackQueueLimit;
                        this.plugin.settings.feedbackQueueAutoRun = DEFAULT_SETTINGS.feedbackQueueAutoRun;
                        this.plugin.settings.autoSaveFeedbackReports = DEFAULT_SETTINGS.autoSaveFeedbackReports;
                        this.plugin.settings.feedbackReportFolder = DEFAULT_SETTINGS.feedbackReportFolder;
                        this.plugin.settings.reviewSuggestedEditsEnabled = DEFAULT_SETTINGS.reviewSuggestedEditsEnabled;
                        await this.plugin.saveSettings();
                        this.display();
                    })
            );

        new Setting(containerEl)
            .setName('Enable feedback queue')
            .setDesc('Show the queue sub-tab and allow queueing reviews to run unattended. Default: on.')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.enableFeedbackQueue).onChange(async (value) => {
                    this.plugin.settings.enableFeedbackQueue = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('Proactive editor chat')
            .setDesc(
                'After a report finishes, the follow-up discussion runs through the co-writer session ' +
                    'with editing tools enabled, so the editor can propose specific, reviewable inline-diff ' +
                    'edits (not just advisory prose). Every proposed edit still requires your approval before ' +
                    'it reaches the vault. Turn off to keep the pre-1.4.0 text-only chat behavior. Default: on.'
            )
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.reviewSuggestedEditsEnabled).onChange(async (value) => {
                    this.plugin.settings.reviewSuggestedEditsEnabled = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('Run queued jobs automatically')
            .setDesc(
                'Run queued jobs automatically while Obsidian is open. Turn off to queue jobs without running them until you trigger one manually. Default: on.'
            )
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.feedbackQueueAutoRun).onChange(async (value) => {
                    this.plugin.settings.feedbackQueueAutoRun = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('Auto-save feedback reports')
            .setDesc(
                'Save every completed feedback report (async queue + interactive Review) to the vault as dated markdown. ' +
                    'When off, no report is written anywhere — the report is held in-memory for the session only. Default: on.'
            )
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.autoSaveFeedbackReports).onChange(async (value) => {
                    this.plugin.settings.autoSaveFeedbackReports = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('Feedback report folder')
            .setDesc('Vault folder for auto-saved feedback reports. Created on first write.')
            .addText((text) =>
                text.setValue(this.plugin.settings.feedbackReportFolder).inputEl.addEventListener('blur', () => {
                    const v = text.inputEl.value.trim();
                    this.plugin.settings.feedbackReportFolder = v || DEFAULT_SETTINGS.feedbackReportFolder;
                    text.setValue(this.plugin.settings.feedbackReportFolder);
                    void this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('Feedback queue limit')
            .setDesc(
                'Maximum number of queue jobs retained on disk. Older completed jobs are removed first. Default: 20.'
            )
            .addText((text) =>
                text.setValue(String(this.plugin.settings.feedbackQueueLimit)).inputEl.addEventListener('blur', () => {
                    const n = parseInt(text.inputEl.value, 10);
                    if (!isNaN(n) && n >= 1) {
                        this.plugin.settings.feedbackQueueLimit = n;
                        void this.plugin.saveSettings();
                    } else {
                        text.setValue(String(this.plugin.settings.feedbackQueueLimit));
                        new Notice('Value must be a number ≥ 1');
                    }
                })
            );

        // Embeddings are the retrieval index that feeds the context assembler —
        // kept next to the Context engine section for that reason.
        this.renderEmbeddingsSettings(containerEl);

        new Setting(containerEl)
            .setName('Context engine')
            .setHeading()
            .addExtraButton((btn) =>
                btn
                    .setIcon('rotate-ccw')
                    .setTooltip('Restore context engine defaults')
                    .onClick(async () => {
                        this.plugin.settings.contextTokenBudget = DEFAULT_SETTINGS.contextTokenBudget;
                        this.plugin.settings.contextCompactAtPercent = DEFAULT_SETTINGS.contextCompactAtPercent;
                        this.plugin.settings.compactSummarySentences = DEFAULT_SETTINGS.compactSummarySentences;
                        this.plugin.settings.contextRefinementEnabled = DEFAULT_SETTINGS.contextRefinementEnabled;
                        this.plugin.settings.contextIncludeVaultContext = DEFAULT_SETTINGS.contextIncludeVaultContext;
                        this.plugin.settings.contextMaxVaultFiles = DEFAULT_SETTINGS.contextMaxVaultFiles;
                        this.plugin.settings.contextMaxCharsPerFile = DEFAULT_SETTINGS.contextMaxCharsPerFile;
                        this.plugin.settings.contextAutoScan = DEFAULT_SETTINGS.contextAutoScan;
                        await this.plugin.saveSettings();
                        this.display();
                    })
            );

        new Setting(containerEl)
            .setName('Token budget')
            .setDesc('Maximum tokens for assembled context. Higher values use more context window.')
            .addDropdown((dropdown) => {
                for (const opt of [4096, 8192, 16384, 32768]) {
                    dropdown.addOption(String(opt), String(opt));
                }
                dropdown.setValue(String(this.plugin.settings.contextTokenBudget)).onChange(async (value) => {
                    this.plugin.settings.contextTokenBudget = parseInt(value, 10);
                    await this.plugin.saveSettings();
                });
            });

        new Setting(containerEl)
            .setName('Compaction threshold')
            .setDesc('Percentage of token budget at which context is compacted (50-95).')
            .addText((text) => {
                text.setValue(String(this.plugin.settings.contextCompactAtPercent)).inputEl.addEventListener(
                    'blur',
                    () => {
                        const raw = text.inputEl.value;
                        const n = parseInt(raw, 10);
                        if (!isNaN(n) && n >= 50 && n <= 95) {
                            this.plugin.settings.contextCompactAtPercent = n;
                            void this.plugin.saveSettings();
                        } else {
                            text.setValue(String(this.plugin.settings.contextCompactAtPercent));
                            new Notice('Value must be between 50 and 95');
                        }
                    }
                );
            });

        new Setting(containerEl)
            .setName('Compact summary length')
            .setDesc('Number of sentences in the AI-generated compaction summary (1-20).')
            .addText((text) => {
                text.setValue(String(this.plugin.settings.compactSummarySentences)).inputEl.addEventListener(
                    'blur',
                    () => {
                        const raw = text.inputEl.value;
                        const n = parseInt(raw, 10);
                        if (!isNaN(n) && n >= 1 && n <= 20) {
                            this.plugin.settings.compactSummarySentences = n;
                            void this.plugin.saveSettings();
                        } else {
                            text.setValue(String(this.plugin.settings.compactSummarySentences));
                            new Notice('Value must be between 1 and 20');
                        }
                    }
                );
            });

        new Setting(containerEl)
            .setName('Refine accepted edits out of context')
            .setDesc(
                'Before AI-compacting, surgically compress bulky or now-stale tool content in the ' +
                    'model\u2019s history: accepted/discarded lore drafts become compact outcome markers, ' +
                    'stale vault reads are marked for re-lookup, and big reads are trimmed oldest-first ' +
                    'when nearing the threshold. Cheaper and more faithful than a full AI summary (the ' +
                    'model can always re-look-up current text), and stops a long-context model from ' +
                    're-outputting an entry it already drafted. Rewind still works. Default: on.'
            )
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.contextRefinementEnabled).onChange(async (value) => {
                    this.plugin.settings.contextRefinementEnabled = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('Include vault context')
            .setDesc('Search the vault for related notes when assembling context.')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.contextIncludeVaultContext).onChange(async (value) => {
                    this.plugin.settings.contextIncludeVaultContext = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('Max vault files')
            .setDesc('Maximum number of vault files to examine for context (1-100).')
            .addText((text) =>
                text
                    .setValue(String(this.plugin.settings.contextMaxVaultFiles))
                    .inputEl.addEventListener('blur', () => {
                        const n = parseInt(text.inputEl.value, 10);
                        if (!isNaN(n) && n >= 1 && n <= 100) {
                            this.plugin.settings.contextMaxVaultFiles = n;
                            void this.plugin.saveSettings();
                        } else {
                            text.setValue(String(this.plugin.settings.contextMaxVaultFiles));
                            new Notice('Value must be between 1 and 100');
                        }
                    })
            );

        new Setting(containerEl)
            .setName('Max chars per file')
            .setDesc('Maximum characters to read from each vault file (500-10000).')
            .addText((text) =>
                text
                    .setValue(String(this.plugin.settings.contextMaxCharsPerFile))
                    .inputEl.addEventListener('blur', () => {
                        const n = parseInt(text.inputEl.value, 10);
                        if (!isNaN(n) && n >= 500 && n <= 10000) {
                            this.plugin.settings.contextMaxCharsPerFile = n;
                            void this.plugin.saveSettings();
                        } else {
                            text.setValue(String(this.plugin.settings.contextMaxCharsPerFile));
                            new Notice('Value must be between 500 and 10000');
                        }
                    })
            );

        new Setting(containerEl)
            .setName('Auto-scan on open')
            .setDesc('Automatically scan documents for context when opened.')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.contextAutoScan).onChange(async (value) => {
                    this.plugin.settings.contextAutoScan = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('Linter AI')
            .setHeading()
            .addExtraButton((btn) =>
                btn
                    .setIcon('rotate-ccw')
                    .setTooltip('Restore linter AI defaults')
                    .onClick(async () => {
                        this.plugin.settings.enableLinterAiFixes = DEFAULT_SETTINGS.enableLinterAiFixes;
                        this.plugin.settings.linterTemperature = DEFAULT_SETTINGS.linterTemperature;
                        this.plugin.settings.linterMaxOutputTokens = DEFAULT_SETTINGS.linterMaxOutputTokens;
                        this.plugin.settings.wikiLinkBehavior = DEFAULT_SETTINGS.wikiLinkBehavior;
                        await this.plugin.saveSettings();
                        this.display();
                    })
            );

        new Setting(containerEl)
            .setName('Enable AI-powered lint fixes')
            .setDesc('Show "fix with AI" buttons in the linter sidebar and editor tooltips for intelligent fixes.')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.enableLinterAiFixes).onChange(async (value) => {
                    this.plugin.settings.enableLinterAiFixes = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('Linter AI temperature')
            .setDesc('Lower values produce more conservative, precise fixes. Range: 0.0 – 2.0.')
            .addText((text) =>
                text.setValue(String(this.plugin.settings.linterTemperature)).inputEl.addEventListener('blur', () => {
                    const n = parseFloat(text.inputEl.value);
                    if (!isNaN(n) && n >= 0 && n <= 2) {
                        this.plugin.settings.linterTemperature = n;
                        void this.plugin.saveSettings();
                    } else {
                        text.setValue(String(this.plugin.settings.linterTemperature));
                        new Notice('Value must be a number between 0.0 and 2.0');
                    }
                })
            );

        new Setting(containerEl)
            .setName('Linter AI max output tokens')
            .setDesc('Maximum tokens per AI lint fix response.')
            .addText((text) =>
                text
                    .setValue(String(this.plugin.settings.linterMaxOutputTokens))
                    .inputEl.addEventListener('blur', () => {
                        const n = parseInt(text.inputEl.value, 10);
                        if (!isNaN(n) && n >= 1) {
                            this.plugin.settings.linterMaxOutputTokens = n;
                            void this.plugin.saveSettings();
                        } else {
                            text.setValue(String(this.plugin.settings.linterMaxOutputTokens));
                            new Notice('Value must be a number ≥ 1');
                        }
                    })
            );

        new Setting(containerEl)
            .setName('Restore defaults')
            .setDesc('Reset every setting on this tab. Use the per-section reset buttons above for targeted resets.')
            .addButton((button) =>
                button.setButtonText('Restore defaults').onClick(async () => {
                    this.plugin.settings.transformTemperature = DEFAULT_SETTINGS.transformTemperature;
                    this.plugin.settings.transformVaultContext = DEFAULT_SETTINGS.transformVaultContext;
                    this.plugin.settings.transformMaxOutputTokens = DEFAULT_SETTINGS.transformMaxOutputTokens;
                    this.plugin.settings.wikiLinkBehavior = DEFAULT_SETTINGS.wikiLinkBehavior;
                    this.plugin.settings.narrativeVoicePreset = DEFAULT_SETTINGS.narrativeVoicePreset;
                    this.plugin.settings.customNarrativeVoiceRules = DEFAULT_SETTINGS.customNarrativeVoiceRules;
                    this.plugin.settings.analysisTemperature = DEFAULT_SETTINGS.analysisTemperature;
                    this.plugin.settings.analysisMaxOutputTokens = DEFAULT_SETTINGS.analysisMaxOutputTokens;
                    this.plugin.settings.linterTemperature = DEFAULT_SETTINGS.linterTemperature;
                    this.plugin.settings.linterMaxOutputTokens = DEFAULT_SETTINGS.linterMaxOutputTokens;
                    this.plugin.settings.enableLinterAiFixes = DEFAULT_SETTINGS.enableLinterAiFixes;
                    this.plugin.settings.contextTokenBudget = DEFAULT_SETTINGS.contextTokenBudget;
                    this.plugin.settings.contextCompactAtPercent = DEFAULT_SETTINGS.contextCompactAtPercent;
                    this.plugin.settings.contextRefinementEnabled = DEFAULT_SETTINGS.contextRefinementEnabled;
                    this.plugin.settings.compactSummarySentences = DEFAULT_SETTINGS.compactSummarySentences;
                    this.plugin.settings.contextIncludeVaultContext = DEFAULT_SETTINGS.contextIncludeVaultContext;
                    this.plugin.settings.contextMaxVaultFiles = DEFAULT_SETTINGS.contextMaxVaultFiles;
                    this.plugin.settings.contextMaxCharsPerFile = DEFAULT_SETTINGS.contextMaxCharsPerFile;
                    this.plugin.settings.contextAutoScan = DEFAULT_SETTINGS.contextAutoScan;
                    this.plugin.settings.coWriterTemperature = DEFAULT_SETTINGS.coWriterTemperature;
                    this.plugin.settings.coWriterMaxOutputTokens = DEFAULT_SETTINGS.coWriterMaxOutputTokens;
                    this.plugin.settings.coWriterMaxToolRounds = DEFAULT_SETTINGS.coWriterMaxToolRounds;
                    this.plugin.settings.coWriterAutoSavePerTurn = DEFAULT_SETTINGS.coWriterAutoSavePerTurn;
                    this.plugin.settings.coWriterVaultContext = DEFAULT_SETTINGS.coWriterVaultContext;
                    this.plugin.settings.coWriterLoreContext = DEFAULT_SETTINGS.coWriterLoreContext;
                    this.plugin.settings.reviewLoreContext = DEFAULT_SETTINGS.reviewLoreContext;
                    this.plugin.settings.lorebookNetworkTools = DEFAULT_SETTINGS.lorebookNetworkTools;
                    this.plugin.settings.lorebookFandomWikis = [...DEFAULT_SETTINGS.lorebookFandomWikis];
                    this.plugin.settings.lorebookFandomAllowAllWikis = DEFAULT_SETTINGS.lorebookFandomAllowAllWikis;
                    this.plugin.settings.lorebookFandomCacheEnabled = DEFAULT_SETTINGS.lorebookFandomCacheEnabled;
                    this.plugin.settings.lorebookWikipediaLang = DEFAULT_SETTINGS.lorebookWikipediaLang;
                    this.plugin.settings.lorebookToolMaxTokens = DEFAULT_SETTINGS.lorebookToolMaxTokens;
                    this.plugin.settings.lorebookImageTools = DEFAULT_SETTINGS.lorebookImageTools;
                    this.plugin.settings.lorebookImageMaxDimension = DEFAULT_SETTINGS.lorebookImageMaxDimension;
                    this.plugin.settings.lorebookImageMaxDescriptionTokens =
                        DEFAULT_SETTINGS.lorebookImageMaxDescriptionTokens;
                    this.plugin.settings.lorebookImageProxyPrompt = DEFAULT_SETTINGS.lorebookImageProxyPrompt;
                    this.plugin.settings.lorebookImageTwoPassDescription =
                        DEFAULT_SETTINGS.lorebookImageTwoPassDescription;
                    this.plugin.settings.loreEntryImageSectionHeaders = [
                        ...DEFAULT_SETTINGS.loreEntryImageSectionHeaders
                    ];
                    this.plugin.settings.loreEntryImageMaxPerEntry = DEFAULT_SETTINGS.loreEntryImageMaxPerEntry;
                    this.plugin.settings.loreEntryImageAttachments = DEFAULT_SETTINGS.loreEntryImageAttachments;
                    this.plugin.settings.loreEntryImageAttachmentFolder =
                        DEFAULT_SETTINGS.loreEntryImageAttachmentFolder;
                    this.plugin.settings.lorePreferEditOverCreate = DEFAULT_SETTINGS.lorePreferEditOverCreate;
                    this.plugin.settings.coWriterAppendNewline = DEFAULT_SETTINGS.coWriterAppendNewline;
                    this.plugin.settings.slashCommands = [...DEFAULT_SETTINGS.slashCommands];
                    this.plugin.settings.enableCoWriterThought = DEFAULT_SETTINGS.enableCoWriterThought;
                    this.plugin.settings.coWriterVoiceMatch = DEFAULT_SETTINGS.coWriterVoiceMatch;
                    this.plugin.settings.enableInlineDirectives = DEFAULT_SETTINGS.enableInlineDirectives;
                    this.plugin.settings.enableFeedbackQueue = DEFAULT_SETTINGS.enableFeedbackQueue;
                    this.plugin.settings.feedbackQueueLimit = DEFAULT_SETTINGS.feedbackQueueLimit;
                    this.plugin.settings.feedbackQueueAutoRun = DEFAULT_SETTINGS.feedbackQueueAutoRun;
                    this.plugin.settings.autoSaveFeedbackReports = DEFAULT_SETTINGS.autoSaveFeedbackReports;
                    this.plugin.settings.feedbackReportFolder = DEFAULT_SETTINGS.feedbackReportFolder;
                    await this.plugin.saveSettings();
                    this.display();
                })
            );
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
                void this.plugin.saveSettings().then(() => this.display());
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

    /** Render the narrative voice rules textarea and wire its change handler. */
    private renderNarrativeVoiceRules(containerEl: HTMLElement, rulesArea: HTMLElement): void {
        const textarea = rulesArea.createEl('textarea', {
            cls: 'quill-narrative-rules__textarea',
            attr: {
                rows: '6',
                placeholder: 'Rules for the custom narrative voice...'
            }
        });
        this.updateNarrativeVoiceRulesDisplay(this.plugin.settings.narrativeVoicePreset, rulesArea);

        textarea.addEventListener('input', () => {
            if (this.plugin.settings.narrativeVoicePreset === 'custom') {
                this.plugin.settings.customNarrativeVoiceRules = textarea.value;
                void this.plugin.saveSettings();
            }
        });
    }

    /** Sync the narrative voice rules textarea with the active preset. */
    private updateNarrativeVoiceRulesDisplay(preset: NarrativeVoicePreset, rulesArea: HTMLElement): void {
        const textarea = rulesArea.querySelector('textarea');
        if (!textarea) return;

        const isCustom = preset === 'custom';
        textarea.readOnly = !isCustom;

        if (isCustom) {
            textarea.value = this.plugin.settings.customNarrativeVoiceRules;
        } else {
            const def = NARRATIVE_VOICE_PRESETS.find((p) => p.id === preset) ?? NARRATIVE_VOICE_PRESETS[0];
            if (!def) return;
            textarea.value = def.rules.join('\n');
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
        void this.plugin.saveSettings().then(() => this.display());
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

/** Modal for picking a vault folder from the list of markdown-containing folders. */
class FolderSuggestModal extends SuggestModal<string> {
    constructor(
        app: App,
        private folders: string[],
        private onPick: (folder: string) => void
    ) {
        super(app);
    }

    getSuggestions(query: string): string[] {
        const q = query.toLowerCase();
        return this.folders.filter((f) => f.toLowerCase().includes(q));
    }

    renderSuggestion(folder: string, el: HTMLElement): void {
        el.createSpan({ text: folder });
    }

    onChooseSuggestion(folder: string): void {
        this.onPick(folder);
    }
}
