import { App, PluginSettingTab, Setting } from 'obsidian';
import EventideQuillPlugin from './main';

export interface EventideQuillSettings {
	mySetting: string;
}

export const DEFAULT_SETTINGS: EventideQuillSettings = {
	mySetting: 'default',
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
			.setName('Settings #1')
			.setDesc("It's a secret")
			.addText((text) =>
				text
					.setPlaceholder('Enter your secret')
					.setValue(this.plugin.settings.mySetting)
					.onChange(async (value) => {
						this.plugin.settings.mySetting = value;
						await this.plugin.saveSettings();
					}),
			);
	}
}
