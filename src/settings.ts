import { App, PluginSettingTab, Setting } from 'obsidian';
import EventideQuillPlugin from './main';

export interface EventideQuillSettings {
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
}

export const DEFAULT_SETTINGS: EventideQuillSettings = {
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
    maxSyllablesPerWord: 4,
    enableAiCliches: true,
    enableAiEmDashes: true,
    enableAiNegation: true,
    enableAiFillerAdverbs: true,
    enableAiHedging: true,
    enableAiWrapUps: true,
    lintOnSave: false,
};

export class EventideQuillSettingTab extends PluginSettingTab {
    plugin: EventideQuillPlugin;

    constructor(app: App, plugin: EventideQuillPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;

        containerEl.empty();

        new Setting(containerEl)
            .setName('Prose linter')
            .setHeading();

        new Setting(containerEl)
            .setName('Lint on save')
            .setDesc('Automatically run the prose linter when the document is saved.')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.lintOnSave)
                    .onChange(async (value) => {
                        this.plugin.settings.lintOnSave = value;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName('Long sentences')
            .setDesc('Flag sentences exceeding the word limit below.')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.enableLongSentences)
                    .onChange(async (value) => {
                        this.plugin.settings.enableLongSentences = value;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName('Max words per sentence')
            .setDesc('Sentences longer than this many words will be flagged.')
            .addText((text) =>
                text
                    .setValue(String(this.plugin.settings.maxSentenceWords))
                    .onChange(async (value) => {
                        const n = parseInt(value, 10);
                        if (!isNaN(n) && n >= 1) {
                            this.plugin.settings.maxSentenceWords = n;
                            await this.plugin.saveSettings();
                        }
                    }),
            );

        new Setting(containerEl)
            .setName('Passive voice')
            .setDesc('Flag instances of passive voice. Disabled by default — it is often a valid stylistic choice in fiction.')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.enablePassiveVoice)
                    .onChange(async (value) => {
                        this.plugin.settings.enablePassiveVoice = value;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName('Adverbs')
            .setDesc('Flag adverbs (e.g. Quickly, slowly, very). Enabled by default — a common teaching tool for new writers.')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.enableAdverbCheck)
                    .onChange(async (value) => {
                        this.plugin.settings.enableAdverbCheck = value;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName('Qualifiers')
            .setDesc('Flag weak qualifiers (very, really, quite, etc.).')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.enableQualifierCheck)
                    .onChange(async (value) => {
                        this.plugin.settings.enableQualifierCheck = value;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName('Repeated words')
            .setDesc('Flag words repeated 3+ times in a single line.')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.enableRepeatedWords)
                    .onChange(async (value) => {
                        this.plugin.settings.enableRepeatedWords = value;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName('Min word length for repeats')
            .setDesc('Words shorter than this are ignored by the repeated-words rule.')
            .addText((text) =>
                text
                    .setValue(String(this.plugin.settings.minRepeatedWordLength))
                    .onChange(async (value) => {
                        const n = parseInt(value, 10);
                        if (!isNaN(n) && n >= 1) {
                            this.plugin.settings.minRepeatedWordLength = n;
                            await this.plugin.saveSettings();
                        }
                    }),
            );

        new Setting(containerEl)
            .setName('Echoes')
            .setDesc('Flag sentences in a paragraph that start with the same two words.')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.enableEchoes)
                    .onChange(async (value) => {
                        this.plugin.settings.enableEchoes = value;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName('Telling vs showing')
            .setDesc('Flag emotional tells (e.g. He felt angry) that could be shown instead.')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.enableTellingVsShowing)
                    .onChange(async (value) => {
                        this.plugin.settings.enableTellingVsShowing = value;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName('Dialogue tags')
            .setDesc('Flag overused or repetitive dialogue tags.')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.enableDialogueTags)
                    .onChange(async (value) => {
                        this.plugin.settings.enableDialogueTags = value;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName('Complex words')
            .setDesc('Flag words with many syllables that may be hard to read.')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.enableComplexWords)
                    .onChange(async (value) => {
                        this.plugin.settings.enableComplexWords = value;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName('Max syllables per word')
            .setDesc('Words with at least this many syllables are flagged by the complex-words rule.')
            .addText((text) =>
                text
                    .setValue(String(this.plugin.settings.maxSyllablesPerWord))
                    .onChange(async (value) => {
                        const n = parseInt(value, 10);
                        if (!isNaN(n) && n >= 1) {
                            this.plugin.settings.maxSyllablesPerWord = n;
                            await this.plugin.saveSettings();
                        }
                    }),
            );

        new Setting(containerEl)
            .setName('AI detection')
            .setHeading();

        new Setting(containerEl)
            .setName('AI clichés')
            .setDesc('Flag overused AI words (tapestry, testament, delve, vibrant, realm, etc.).')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.enableAiCliches)
                    .onChange(async (value) => {
                        this.plugin.settings.enableAiCliches = value;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName('Em dashes')
            .setDesc('Flag em dashes (—). Common AI overuse — consider commas, colons, or sentence breaks.')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.enableAiEmDashes)
                    .onChange(async (value) => {
                        this.plugin.settings.enableAiEmDashes = value;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName('Negation patterns')
            .setDesc('Flag "it\'s not X, it\'s y" constructions. State what things are directly.')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.enableAiNegation)
                    .onChange(async (value) => {
                        this.plugin.settings.enableAiNegation = value;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName('Filler adverbs')
            .setDesc('Flag strategy adverbs common in AI prose (quietly, deliberately, gently, etc.).')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.enableAiFillerAdverbs)
                    .onChange(async (value) => {
                        this.plugin.settings.enableAiFillerAdverbs = value;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName('Hedging language')
            .setDesc('Flag hedging words (might, could, perhaps, maybe) that weaken prose.')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.enableAiHedging)
                    .onChange(async (value) => {
                        this.plugin.settings.enableAiHedging = value;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName('Wrap-up phrases')
            .setDesc('Flag concluding phrases (in conclusion, to summarize, ultimately, etc.).')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.enableAiWrapUps)
                    .onChange(async (value) => {
                        this.plugin.settings.enableAiWrapUps = value;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName('Restore defaults')
            .setDesc('Reset all linter settings to their default values.')
            .addButton((button) =>
                button
                    .setButtonText('Restore defaults')
                    .onClick(async () => {
                        this.plugin.settings = { ...DEFAULT_SETTINGS };
                        await this.plugin.saveSettings();
                        this.display();
                    }),
            );
    }
}
