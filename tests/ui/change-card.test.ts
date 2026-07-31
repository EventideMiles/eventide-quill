// @vitest-environment happy-dom
import '../helpers/ui-setup';
import { describe, expect, it } from 'vitest';
import { App, Component } from 'obsidian';
import { renderChangeBulkBar, renderChangeCard } from '../../src/ui/change-card';
import type { ProposedEdit } from '../../src/core/change-set';

function makeEdit(overrides: Partial<ProposedEdit> = {}): ProposedEdit {
    return { id: 1, newText: 'new prose', state: 'pending', ...overrides } as ProposedEdit;
}

describe('change-card — renderChangeBulkBar', () => {
    it('renders Approve all + Reject all when there are pending edits', () => {
        const container = createDiv();
        renderChangeBulkBar(container, 3, new Component(), {});
        const texts = Array.from(container.querySelectorAll('button')).map((b) => b.textContent?.trim());
        expect(texts).to.include('Approve all (3)');
        expect(texts).to.include('Reject all');
    });

    it('renders nothing when pendingCount is 0', () => {
        const container = createDiv();
        renderChangeBulkBar(container, 0, new Component(), {});
        expect(container.children.length).to.equal(0);
    });

    it('fires onApproveAll when the button is clicked', () => {
        const container = createDiv();
        let approved = false;
        renderChangeBulkBar(container, 1, new Component(), { onApproveAll: () => {
            approved = true;
        } });
        (container.querySelector('button.mod-cta') as HTMLButtonElement).click();
        expect(approved).to.equal(true);
    });
});

describe('change-card — renderChangeCard', () => {
    it('renders removed (red) + added (green) + Approve/Reject for a pending edit', async () => {
        const container = createDiv();
        const edit = makeEdit({ id: 5, newText: 'brave new prose', state: 'pending' });
        await renderChangeCard(container, edit, 'old text', new App(), new Component(), {});

        expect(container.querySelector('.quill-change-card--pending')).to.exist;
        expect(container.querySelector('.quill-change-card__removed')?.textContent).to.include('old text');
        expect(container.querySelector('.quill-change-card__added')?.textContent).to.include('brave new prose');
        const texts = Array.from(container.querySelectorAll('button')).map((b) => b.textContent?.trim());
        expect(texts).to.include('Approve');
        expect(texts).to.include('Reject');
    });

    it('shows an Approved status and no buttons for an approved edit', async () => {
        const container = createDiv();
        await renderChangeCard(container, makeEdit({ state: 'approved' }), 'old', new App(), new Component(), {});
        expect(container.textContent).to.include('Approved');
        expect(container.querySelectorAll('button').length).to.equal(0);
    });

    it('shows a Generating status for a generating edit', async () => {
        const container = createDiv();
        await renderChangeCard(container, makeEdit({ state: 'generating' }), null, new App(), new Component(), {});
        expect(container.textContent).to.include('Generating');
        expect(container.querySelectorAll('button').length).to.equal(0);
    });

    it('omits the removed block for a pure insertion (oldText null)', async () => {
        const container = createDiv();
        await renderChangeCard(container, makeEdit({ state: 'pending' }), null, new App(), new Component(), {});
        expect(container.querySelector('.quill-change-card__removed')).to.not.exist;
        expect(container.querySelector('.quill-change-card__added')).to.exist;
    });

    it('fires onApprove when the Approve button is clicked', async () => {
        const container = createDiv();
        let approvedId = -1;
        await renderChangeCard(
            container,
            makeEdit({ id: 7, state: 'pending' }),
            'old',
            new App(),
            new Component(),
            { onApprove: (id) => {
                approvedId = id;
            } }
        );
        const approveBtn = Array.from(container.querySelectorAll('button')).find(
            (b) => b.textContent?.trim() === 'Approve'
        ) as HTMLButtonElement;
        approveBtn.click();
        expect(approvedId).to.equal(7);
    });
});
