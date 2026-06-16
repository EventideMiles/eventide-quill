import { App, Modal, Notice, PluginSettingTab, Setting, SuggestModal } from 'obsidian';
import EventideQuillPlugin from './main';
import { ModelInfo, ProviderConfig, ProviderType } from './ai/provider';
import { createProvider, generateModelId, generateProviderId } from './ai/provider-registry';
import { NarrativeVoicePreset, NARRATIVE_VOICE_PRESETS } from './types';

export type LinterMode = 'all' | 'prose' | 'ai';

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
    lintOnSave: boolean;
    aiProviders: ProviderConfig[];
    aiDefaultChatProvider: string;
    aiDefaultEmbedProvider: string;
    transformTemperature: number;
    transformAppendNewline: boolean;
    transformVaultContext: boolean;
    transformMaxOutputTokens: number;
    narrativeVoicePreset: NarrativeVoicePreset;
    customNarrativeVoiceRules: string;
    analysisTemperature: number;
    analysisMaxOutputTokens: number;
    linterTemperature: number;
    linterMaxOutputTokens: number;
    enableLinterAiFixes: boolean;
    contextTokenBudget: number;
    contextCompactAtPercent: number;
    compactSummarySentences: number;
    contextIncludeVaultContext: boolean;
    contextMaxVaultFiles: number;
    contextMaxCharsPerFile: number;
    contextAutoScan: boolean;
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
    transformTemperature: 1.0,
    transformAppendNewline: true,
    transformVaultContext: true,
    transformMaxOutputTokens: 4096,
    narrativeVoicePreset: 'third-limited',
    customNarrativeVoiceRules: 'No genre-specific or context-specific rules configured.',
    analysisTemperature: 0.7,
    analysisMaxOutputTokens: 2048,
    linterTemperature: 0.3,
    linterMaxOutputTokens: 512,
    enableLinterAiFixes: true,
    contextTokenBudget: 8192,
    contextCompactAtPercent: 80,
    compactSummarySentences: 3,
    contextIncludeVaultContext: true,
    contextMaxVaultFiles: 20,
    contextMaxCharsPerFile: 2000,
    contextAutoScan: true
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
            cls: 'quill-input-modal-input',
            attr: { placeholder: this.placeholder }
        });

        const buttonRow = contentEl.createEl('div', { cls: 'quill-input-modal-actions' });

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
        el.createEl('div', { text: model.id });
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
        { type: 'ollama', label: 'Ollama', defaultEndpoint: 'http://localhost:11434' }
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
        el.createEl('div', { text: option.label });
    }

    /** When user selects a type, invoke the callback. */
    onChooseSuggestion(option: { type: ProviderType; label: string; defaultEndpoint: string }): void {
        this.onChoose(option.type, option.defaultEndpoint);
    }
}

export class EventideQuillSettingTab extends PluginSettingTab {
    plugin: EventideQuillPlugin;
    private activeTab: 'linter' | 'ai-providers' | 'model-behaviors' = 'linter';

    constructor(app: App, plugin: EventideQuillPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    /** Build and display the full settings UI. */
    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        this.renderTabBar(containerEl);
        this.renderLinterTab(containerEl);
        this.renderAiProvidersTab(containerEl);
        this.renderModelBehaviorsTab(containerEl);

        this.showActiveTab();
    }

    /** Render the tab bar at the top of the settings panel. */
    private renderTabBar(containerEl: HTMLElement): void {
        const tabBar = containerEl.createEl('div', { cls: 'quill-settings-tab-bar' });

        const tabs: { id: 'linter' | 'ai-providers' | 'model-behaviors'; label: string }[] = [
            { id: 'linter', label: 'Linter' },
            { id: 'ai-providers', label: 'AI providers' },
            { id: 'model-behaviors', label: 'Model behaviors' }
        ];

        for (const tab of tabs) {
            const btn = tabBar.createEl('button', {
                cls: `quill-settings-tab${this.activeTab === tab.id ? ' quill-settings-tab-active' : ''}`,
                text: tab.label,
                attr: { 'data-tab': tab.id }
            });
            btn.addEventListener('click', () => {
                this.activeTab = tab.id;
                this.showActiveTab();
            });
        }
    }

    /** Toggle visibility of tab content sections. */
    private showActiveTab(): void {
        const linterContent = this.containerEl.querySelector('.quill-settings-content-linter') as HTMLElement;
        const aiContent = this.containerEl.querySelector('.quill-settings-content-ai') as HTMLElement;
        const modelBehaviorsContent = this.containerEl.querySelector(
            '.quill-settings-content-model-behaviors'
        ) as HTMLElement;
        const tabs = this.containerEl.querySelectorAll('.quill-settings-tab');

        if (linterContent) linterContent.style.display = this.activeTab === 'linter' ? 'block' : 'none';
        if (aiContent) aiContent.style.display = this.activeTab === 'ai-providers' ? 'block' : 'none';
        if (modelBehaviorsContent)
            modelBehaviorsContent.style.display = this.activeTab === 'model-behaviors' ? 'block' : 'none';

        tabs.forEach((tab) => {
            const el = tab as HTMLElement;
            if (el.dataset.tab === this.activeTab) {
                el.addClass('quill-settings-tab-active');
            } else {
                el.removeClass('quill-settings-tab-active');
            }
        });
    }

    /** Render the linter configuration section. */
    private renderLinterTab(containerEl: HTMLElement): void {
        const content = containerEl.createEl('div', { cls: 'quill-settings-content-linter' });

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
                    await this.plugin.saveSettings();
                    this.display();
                })
            );
    }

    /** Render the AI providers configuration section. */
    private renderAiProvidersTab(containerEl: HTMLElement): void {
        const content = containerEl.createEl('div', { cls: 'quill-settings-content-ai' });

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
        const card = containerEl.createEl('div', { cls: 'quill-provider-card' });

        // Provider heading row
        const headingRow = card.createEl('div', { cls: 'quill-provider-heading' });

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
                    .setValue(provider.type)
                    .onChange(async (value) => {
                        const newType = value as ProviderType;
                        provider.type = newType;
                        if (newType === 'ollama') {
                            provider.endpoint = 'http://localhost:11434';
                            provider.apiKey = '';
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
                    // eslint-disable-next-line obsidianmd/ui/sentence-case
                    .setPlaceholder('http://localhost:1234/v1')
                    .onChange(async (value) => {
                        provider.endpoint = value;
                        await this.plugin.saveSettings();
                    })
            );

        // API Key — only show for OpenAI-compatible
        if (provider.type === 'openai-compatible') {
            new Setting(card)
                .setName('API key')
                .setDesc('Optional. Leave blank for local providers.')
                .addText((text) =>
                    text
                        .setValue(provider.apiKey)
                        // eslint-disable-next-line obsidianmd/ui/sentence-case
                        .setPlaceholder('sk-...')
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
                    card.createEl('div', {
                        cls: 'quill-provider-setting-extra',
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
        containerEl.createEl('div', {
            cls: 'quill-provider-models-heading',
            text: 'Models'
        });

        for (const [mIdx, model] of provider.models.entries()) {
            const modelCard = containerEl.createEl('div', { cls: 'quill-provider-model-card' });

            new Setting(modelCard).setName(`Model ${mIdx + 1}`).addDropdown((dropdown) =>
                dropdown
                    .addOption('chat', 'Chat')
                    .addOption('embed', 'Embed')
                    .addOption('both', 'Both')
                    .setValue(model.role)
                    .onChange(async (value) => {
                        model.role = value as 'chat' | 'embed' | 'both';
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
                        // eslint-disable-next-line obsidianmd/ui/sentence-case
                        .setPlaceholder('llama-3.3-70b')
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
        const testRow = containerEl.createEl('div', { cls: 'quill-provider-test-row' });

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

    /** Render the default chat/embed model dropdowns. */
    private renderDefaultModelSettings(containerEl: HTMLElement): void {
        // Collect all chat-capable and embed-capable models
        const chatModels: { key: string; name: string }[] = [];
        const embedModels: { key: string; name: string }[] = [];

        for (const provider of this.plugin.settings.aiProviders) {
            for (const model of provider.models) {
                const key = `${provider.id}/${model.id}`;
                const name = `${provider.name} — ${model.model}`;
                if (model.role === 'chat' || model.role === 'both') {
                    chatModels.push({ key, name });
                }
                if (model.role === 'embed' || model.role === 'both') {
                    embedModels.push({ key, name });
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
                    this.plugin.settings.aiDefaultEmbedProvider = value;
                    await this.plugin.saveSettings();
                });
            });
    }

    /** Render the Model behaviors settings tab. */
    private renderModelBehaviorsTab(containerEl: HTMLElement): void {
        const content = containerEl.createEl('div', { cls: 'quill-settings-content-model-behaviors' });
        this.renderModelBehaviorsSettings(content);
    }

    /** Render model behavior settings. */
    private renderModelBehaviorsSettings(containerEl: HTMLElement): void {
        new Setting(containerEl).setName('Selection transformations').setHeading();

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

        const rulesArea = containerEl.createEl('div', { cls: 'quill-narrative-rules-area' });
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
            .setName('Append trailing blank line')
            .setDesc(
                'Add a blank line after the transformed text so you can continue writing without pressing enter twice.'
            )
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.transformAppendNewline).onChange(async (value) => {
                    this.plugin.settings.transformAppendNewline = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl).setName('Analysis').setHeading();

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

        new Setting(containerEl).setName('Context engine').setHeading();

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

        new Setting(containerEl).setName('Linter AI').setHeading();

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
            .setDesc('Reset all AI behavior settings to their default values.')
            .addButton((button) =>
                button.setButtonText('Restore defaults').onClick(async () => {
                    this.plugin.settings.transformTemperature = DEFAULT_SETTINGS.transformTemperature;
                    this.plugin.settings.transformAppendNewline = DEFAULT_SETTINGS.transformAppendNewline;
                    this.plugin.settings.transformVaultContext = DEFAULT_SETTINGS.transformVaultContext;
                    this.plugin.settings.transformMaxOutputTokens = DEFAULT_SETTINGS.transformMaxOutputTokens;
                    this.plugin.settings.narrativeVoicePreset = DEFAULT_SETTINGS.narrativeVoicePreset;
                    this.plugin.settings.customNarrativeVoiceRules = DEFAULT_SETTINGS.customNarrativeVoiceRules;
                    this.plugin.settings.analysisTemperature = DEFAULT_SETTINGS.analysisTemperature;
                    this.plugin.settings.analysisMaxOutputTokens = DEFAULT_SETTINGS.analysisMaxOutputTokens;
                    this.plugin.settings.linterTemperature = DEFAULT_SETTINGS.linterTemperature;
                    this.plugin.settings.linterMaxOutputTokens = DEFAULT_SETTINGS.linterMaxOutputTokens;
                    this.plugin.settings.enableLinterAiFixes = DEFAULT_SETTINGS.enableLinterAiFixes;
                    this.plugin.settings.contextTokenBudget = DEFAULT_SETTINGS.contextTokenBudget;
                    this.plugin.settings.contextCompactAtPercent = DEFAULT_SETTINGS.contextCompactAtPercent;
                    this.plugin.settings.compactSummarySentences = DEFAULT_SETTINGS.compactSummarySentences;
                    this.plugin.settings.contextIncludeVaultContext = DEFAULT_SETTINGS.contextIncludeVaultContext;
                    this.plugin.settings.contextMaxVaultFiles = DEFAULT_SETTINGS.contextMaxVaultFiles;
                    this.plugin.settings.contextMaxCharsPerFile = DEFAULT_SETTINGS.contextMaxCharsPerFile;
                    this.plugin.settings.contextAutoScan = DEFAULT_SETTINGS.contextAutoScan;
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
     * Ensure aiDefaultChatProvider and aiDefaultEmbedProvider still reference
     * valid provider+model keys. Clears any key whose provider or model has
     * been removed. Call after mutating aiProviders and before saveSettings().
     */
    private validateDefaultProviders(): void {
        const { aiProviders } = this.plugin.settings;

        const isValid = (key: string): boolean => {
            const parts = key.split('/', 2);
            if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
            const provider = aiProviders.find((p) => p.id === parts[0]);
            if (!provider) return false;
            return provider.models.some((m) => m.id === parts[1]);
        };

        if (this.plugin.settings.aiDefaultChatProvider && !isValid(this.plugin.settings.aiDefaultChatProvider)) {
            this.plugin.settings.aiDefaultChatProvider = '';
        }
        if (this.plugin.settings.aiDefaultEmbedProvider && !isValid(this.plugin.settings.aiDefaultEmbedProvider)) {
            this.plugin.settings.aiDefaultEmbedProvider = '';
        }
    }

    /** Render the narrative voice rules textarea and wire its change handler. */
    private renderNarrativeVoiceRules(containerEl: HTMLElement, rulesArea: HTMLElement): void {
        const textarea = rulesArea.createEl('textarea', {
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
        const name = type === 'ollama' ? 'Ollama local' : 'New OpenAI-compatible';
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
}
