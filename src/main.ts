import { Notice, Plugin } from 'obsidian';
import {
    DEFAULT_SETTINGS,
    EventideQuillSettings,
    EventideQuillSettingTab,
} from './settings';
import { lint } from './core/linter/linter';

export default class EventideQuillPlugin extends Plugin {
    settings!: EventideQuillSettings;

    async onload() {
        await this.loadSettings();

        this.addCommand({
            id: 'lint-active-document',
            name: 'Lint active document',
            editorCallback: (editor) => {
                const text = editor.getValue();
                const results = lint(text);

                if (results.length === 0) {
                    new Notice('Prose linter: no issues found');
                    return;
                }

                const bySeverity = {
                    error: 0,
                    warning: 0,
                    info: 0,
                };

                for (const r of results) {
                    bySeverity[r.severity]++;
                }

                new Notice(
                    `Prose linter: ${results.length} issues found ` +
                    `(${bySeverity.error} errors, ${bySeverity.warning} warnings, ${bySeverity.info} info)`,
                );
            },
        });

        this.addSettingTab(new EventideQuillSettingTab(this.app, this));
    }

    onunload() {}

    async loadSettings() {
        this.settings = Object.assign(
            {},
            DEFAULT_SETTINGS,
            (await this.loadData()) as Partial<EventideQuillSettings>,
        );
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}
