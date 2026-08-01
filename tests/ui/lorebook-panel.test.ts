// @vitest-environment happy-dom
import '../helpers/ui-setup';
import { describe, expect, it } from 'vitest';
import { App, Component } from 'obsidian';
import { renderLorebookTab } from '../../src/ui/lorebook-panel';
import type EventideQuillPlugin from '../../src/main';

function makePlugin(): EventideQuillPlugin {
    return {
        app: new App(),
        settings: {
            lorebookFolders: ['lore'],
            loreEntryImageSectionHeaders: ['Reference', 'Gallery']
        } as EventideQuillPlugin['settings'],
        currentManuscriptFolder: '',
        currentLoreDocumentCoverage: null,
        currentLoreManuscriptCoverage: null,
        currentLoreRelationships: null,
        pendingLoreEntryType: null,
        refreshLorebookDocumentCoverage: async () => {},
        refreshLorebookManuscriptCoverage: async () => {},
        refreshLorebookRelationships: () => {},
        setLoreEntryType: () => {},
        dismissDashboardEntity: () => {},
        jumpToLoreLink: () => {}
    } as unknown as EventideQuillPlugin;
}

describe('lorebook-panel — renderLorebookTab', () => {
    it('renders the Document subtab without crashing', () => {
        const container = createDiv();
        renderLorebookTab(container, makePlugin(), new Component(), 'document');
        expect(container.children.length).to.be.greaterThan(0);
    });

    it('renders the Manuscript subtab without crashing', () => {
        const container = createDiv();
        renderLorebookTab(container, makePlugin(), new Component(), 'manuscript');
        expect(container.children.length).to.be.greaterThan(0);
    });

    it('renders the Relationships subtab with an empty state when no relationships exist', () => {
        const container = createDiv();
        renderLorebookTab(container, makePlugin(), new Component(), 'relationships');
        expect(container.children.length).to.be.greaterThan(0);
        // With null relationships, should show some empty/placeholder content.
        expect(container.textContent?.length).to.be.greaterThan(0);
    });
});
