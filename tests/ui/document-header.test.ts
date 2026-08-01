// @vitest-environment happy-dom
import '../helpers/ui-setup';
import { describe, expect, it } from 'vitest';
import { renderDocumentHeader, type ActiveDocument } from '../../src/ui/document-header';

describe('document-header — renderDocumentHeader', () => {
    it('renders the filename + formatted word count when a doc is provided', () => {
        const container = createDiv();
        const doc: ActiveDocument = {
            file: { path: 'manuscript/ch1.md', basename: 'Chapter 1', extension: 'md' } as ActiveDocument['file'],
            wordCount: 5000
        };
        renderDocumentHeader(container, doc);
        expect(container.textContent).to.include('Chapter 1');
        expect(container.textContent).to.include('5,000');
        expect(container.querySelector('.quill-document__name')).to.exist;
        expect(container.querySelector('.quill-document__meta')).to.exist;
    });

    it('renders nothing when no doc is provided', () => {
        const container = createDiv();
        renderDocumentHeader(container, null);
        expect(container.children.length).to.equal(0);
    });
});
