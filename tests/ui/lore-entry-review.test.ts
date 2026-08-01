import { describe, expect, it } from 'vitest';
import { ensureGallerySectionInContent, rewriteImageEmbeds } from '../../src/ui/lore-entry-review';

describe('lore-entry-review — rewriteImageEmbeds', () => {
    it('replaces wiki-link embed targets with resolved filenames', () => {
        const content = 'Here is art:\n![[old-name.png]]\nDone.';
        const result = rewriteImageEmbeds(content, [{ original: 'old-name.png', resolved: 'path/new-name.png' }]);
        expect(result).to.include('![[new-name.png]]');
        expect(result).to.not.include('old-name');
    });

    it('preserves captions in the | suffix', () => {
        const content = '![[old.png|Default form]]';
        const result = rewriteImageEmbeds(content, [{ original: 'old.png', resolved: 'dir/new.png' }]);
        expect(result).to.equal('![[new.png|Default form]]');
    });

    it('skips entries where original equals resolved', () => {
        const content = '![[same.png]]';
        const result = rewriteImageEmbeds(content, [{ original: 'same.png', resolved: 'same.png' }]);
        expect(result).to.equal(content);
    });

    it('handles multiple replacements in one pass', () => {
        const content = '![[alpha.png]] and ![[beta.png]]';
        const result = rewriteImageEmbeds(content, [
            { original: 'alpha.png', resolved: 'x/renamed-alpha.png' },
            { original: 'beta.png', resolved: 'y/renamed-beta.png' }
        ]);
        expect(result).to.include('![[renamed-alpha.png]]');
        expect(result).to.include('![[renamed-beta.png]]');
        expect(result).to.not.include('![[alpha.png]]');
        expect(result).to.not.include('![[beta.png]]');
    });
});

describe('lore-entry-review — ensureGallerySectionInContent', () => {
    const headers = ['Reference', 'Gallery'];

    it('returns content unchanged when all images are already embedded', () => {
        const content = '## Reference\n\n![[art.png]]\n';
        const result = ensureGallerySectionInContent(content, [{ suggestedFilename: 'art.png', label: '', base64: '' }], headers);
        expect(result).to.equal(content);
    });

    it('appends a fresh gallery section when no recognized heading exists', () => {
        const content = 'Some lore text.';
        const result = ensureGallerySectionInContent(content, [{ suggestedFilename: 'portrait.png', label: '', base64: '' }], headers);
        expect(result).to.include('## Reference');
        expect(result).to.include('![[portrait.png]]');
    });

    it('tops up an existing gallery section without adding a second heading', () => {
        const content = '## Gallery\n\n![[existing.png]]\n';
        const result = ensureGallerySectionInContent(
            content,
            [{ suggestedFilename: 'new.png', label: 'Alternate form', base64: '' }],
            headers
        );
        expect(result).to.include('![[new.png]]');
        expect(result).to.include('### Alternate form');
        // Only one Gallery heading.
        expect((result.match(/## Gallery/g) ?? []).length).to.equal(1);
    });

    it('includes captions in the | suffix when present', () => {
        const content = 'Lore text.';
        const result = ensureGallerySectionInContent(
            content,
            [{ suggestedFilename: 'art.png', caption: 'The hero', label: '', base64: '' }],
            headers
        );
        expect(result).to.include('![[art.png|The hero]]');
    });

    it('does nothing when the image list is empty', () => {
        const content = 'Just text.';
        expect(ensureGallerySectionInContent(content, [], headers)).to.equal(content);
    });
});
