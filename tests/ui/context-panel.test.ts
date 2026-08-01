// @vitest-environment happy-dom
import '../helpers/ui-setup';
import { describe, expect, it } from 'vitest';
import { Component } from 'obsidian';
import { renderContextTab } from '../../src/ui/context-panel';
import type { ContextAssembly } from '../../src/core/context-engine/types';
import type EventideQuillPlugin from '../../src/main';

/** Build a default `ContextAssembly` fixture with the given overrides. */
function makeAssembly(overrides: Partial<ContextAssembly> = {}): ContextAssembly {
    return {
        entities: [],
        voice: { pov: 'third-person', tense: 'past', avgSentenceLength: 22, dialogueRatio: 0.35, descriptionRatio: 0.65 },
        contextItems: [],
        totalTokens: 500,
        tokenBudget: 32000,
        budgetExceeded: false,
        compacted: false,
        ...overrides
    };
}

describe('context-panel — renderContextTab', () => {
    it('shows an open-manuscript hint when no document is active and no assembly exists', () => {
        const container = createDiv();
        renderContextTab(
            container,
            null,
            { app: { workspace: { getActiveFile: () => null } } } as unknown as EventideQuillPlugin,
            new Component()
        );
        expect(container.textContent).to.include('Open a manuscript');
    });

    it('shows a not-assembled hint + Scan button when a doc is open but no assembly', () => {
        const container = createDiv();
        renderContextTab(
            container,
            null,
            {
                app: {
                    workspace: {
                        getActiveFile: () => ({
                            path: 'ch1.md',
                            basename: 'Chapter 1',
                            extension: 'md'
                        })
                    }
                }
            } as unknown as EventideQuillPlugin,
            new Component()
        );
        expect(container.textContent).to.include('Context not yet assembled');
        expect(container.textContent).to.include('Chapter 1');
        const scanBtn = container.querySelector('button');
        expect(scanBtn?.textContent).to.include('Scan context');
    });

    it('renders the narrative voice section from a populated assembly', () => {
        const container = createDiv();
        const plugin = {
            app: { workspace: {} },
            removedContextPaths: new Set<string>(),
            contextActiveFile: null,
            hasRemovedItems: () => false,
            toggleEntityPin: () => {},
            removeEntity: () => {},
            restoreRemovedItems: () => {},
            toggleContextItemPin: () => {},
            removeContextItem: () => {},
            addManualContextItem: () => {},
            addFolderContextItem: () => {},
            settings: {}
        } as unknown as EventideQuillPlugin;
        renderContextTab(container, makeAssembly(), plugin, new Component());
        expect(container.textContent).to.include('Narrative voice');
        expect(container.textContent).to.include('Third'); // capitalize('third-person')
        expect(container.textContent).to.include('past tense');
        expect(container.textContent).to.include('22 words');
        expect(container.textContent).to.include('35%');
    });
});
