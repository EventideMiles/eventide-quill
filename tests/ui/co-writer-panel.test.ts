// @vitest-environment happy-dom
import '../helpers/ui-setup';
import { describe, expect, it } from 'vitest';
import { App } from 'obsidian';
import { CoWriterPanel } from '../../src/ui/co-writer-panel';
import type EventideQuillPlugin from '../../src/main';

function makePlugin(): EventideQuillPlugin {
    return {
        app: new App(),
        settings: {
            coWriterTemperature: 0.7,
            coWriterMaxOutputTokens: 2048,
            coWriterAppendNewline: true,
            enableCoWriterThought: false,
            coWriterVoiceMatch: false,
            coWriterVaultContext: true,
            coWriterToolsEnabled: true,
            coWriterSessionHistoryLimit: 25,
            coWriterAutoSavePerTurn: false,
            enableInlineDirectives: true,
            defaultTab: 'cowriter',
            writingDailyGoal: 0
        } as EventideQuillPlugin['settings'],
        coWriterSession: null,
        getDefaultChatProvider: () => ({ provider: null, modelId: '' }),
        getDefaultImageProvider: () => ({ provider: null, modelId: '' }),
        isVisionConfigured: () => false,
        getImageRegime: () => 'none',
        listChatModels: () => []
    } as unknown as EventideQuillPlugin;
}

describe('CoWriterPanel', () => {
    it('constructs without crashing', () => {
        const panel = new CoWriterPanel(new App(), makePlugin());
        expect(panel).to.exist;
    });

    it('renders an empty-state prompt in discuss mode when no session is active', () => {
        const container = createDiv();
        const panel = new CoWriterPanel(new App(), makePlugin());
        panel.setContainer(container);
        // With no session, the panel should render *something* (an empty-state
        // hint or the mode picker) without crashing.
        expect(container.children.length).to.be.greaterThan(0);
    });
});
