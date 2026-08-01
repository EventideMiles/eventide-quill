import { describe, expect, it } from 'vitest';
import type { ModelRole } from '../../src/ai/provider';
import type EventideQuillPlugin from '../../src/main';
import { getImageRegime, isVisionConfigured, resolveImageInjection } from '../../src/ai/vision';

/** Minimal plugin stub: only getDefaultChatProvider / getDefaultImageProvider are read. */
function makePlugin(opts: {
    chatRole?: ModelRole | null;
    chatModelId?: string;
    hasImageModel?: boolean;
}): EventideQuillPlugin {
    const chatModelId = opts.chatModelId ?? 'chat-m';
    const hasChat = Boolean(opts.chatRole);
    return {
        getDefaultChatProvider: () => ({
            provider: hasChat ? { config: { models: [{ id: chatModelId, role: opts.chatRole as ModelRole }] } } : null,
            modelId: hasChat ? chatModelId : ''
        }),
        getDefaultImageProvider: () => ({
            provider: opts.hasImageModel ? { config: { models: [] } } : null,
            modelId: opts.hasImageModel ? 'img-m' : ''
        })
    } as unknown as EventideQuillPlugin;
}

describe('vision — getImageRegime', () => {
    it('returns native when the default chat model role is chat-image', () => {
        expect(getImageRegime(makePlugin({ chatRole: 'chat-image' }))).to.equal('native');
    });
    it('returns proxy when chat is text-only and a default image model is configured', () => {
        expect(getImageRegime(makePlugin({ chatRole: 'chat', hasImageModel: true }))).to.equal('proxy');
    });
    it('returns none when chat is text-only and no image model is configured', () => {
        expect(getImageRegime(makePlugin({ chatRole: 'chat', hasImageModel: false }))).to.equal('none');
    });
    it('returns proxy when no chat model is configured but an image model is', () => {
        expect(getImageRegime(makePlugin({ chatRole: null, hasImageModel: true }))).to.equal('proxy');
    });
    it('returns none when neither a chat-image model nor an image model is configured', () => {
        expect(getImageRegime(makePlugin({ chatRole: null, hasImageModel: false }))).to.equal('none');
    });
    it('does not treat a plain image-role chat model as native (image-only models are not chat)', () => {
        expect(getImageRegime(makePlugin({ chatRole: 'image', hasImageModel: false }))).to.equal('none');
    });
});

describe('vision — isVisionConfigured', () => {
    it('is true for native or proxy regimes, false for none', () => {
        expect(isVisionConfigured(makePlugin({ chatRole: 'chat-image' }))).to.equal(true);
        expect(isVisionConfigured(makePlugin({ chatRole: 'chat', hasImageModel: true }))).to.equal(true);
        expect(isVisionConfigured(makePlugin({ chatRole: 'chat', hasImageModel: false }))).to.equal(false);
    });
});

describe('vision — resolveImageInjection (non-network branches)', () => {
    it('is a no-op (native, empty) when there are no images', async () => {
        const result = await resolveImageInjection(makePlugin({ chatRole: 'chat' }), []);
        expect(result).to.deep.equal({ kind: 'native', images: [] });
    });
    it('attaches images directly under the native regime', async () => {
        const result = await resolveImageInjection(makePlugin({ chatRole: 'chat-image' }), ['a', 'b']);
        expect(result).to.deep.equal({ kind: 'native', images: ['a', 'b'] });
    });
    it('returns an unsupported result with a setup hint when no vision regime is available', async () => {
        const result = await resolveImageInjection(makePlugin({ chatRole: 'chat', hasImageModel: false }), ['a']);
        expect(result.kind).to.equal('unsupported');
        if (result.kind === 'unsupported') {
            expect(result.reason).to.include('image model');
        }
    });
});
