import { Plugin } from 'obsidian';
import {
	DEFAULT_SETTINGS,
	EventideQuillSettings,
	EventideQuillSettingTab,
} from './settings';

export default class EventideQuillPlugin extends Plugin {
	settings!: EventideQuillSettings;

	async onload() {
		await this.loadSettings();

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
