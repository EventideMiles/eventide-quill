// @vitest-environment happy-dom
import '../helpers/ui-setup';
import { describe, expect, it } from 'vitest';
import { Component, Setting } from 'obsidian';

describe('Obsidian mock + DOM polyfill (UI foundation)', () => {
    it('createDiv produces a real DOM element with applied options', () => {
        const el = createDiv({ cls: 'test', text: 'hello' });
        expect(el.tagName).to.equal('DIV');
        expect(el.className).to.equal('test');
        expect(el.textContent).to.equal('hello');
    });

    it('parent.createDiv appends to the parent', () => {
        const parent = createDiv();
        const child = parent.createDiv({ cls: 'child' });
        expect(parent.children.length).to.equal(1);
        expect(child.parentElement).to.equal(parent);
    });

    it('Setting creates a proper DOM row with name, desc, and control areas', () => {
        const container = createDiv();
        const s = new Setting(container).setName('Test setting').setDesc('A description');
        expect(s.settingEl.className).to.include('setting-item');
        expect(s.nameEl.textContent).to.equal('Test setting');
        expect(s.descEl.textContent).to.equal('A description');
        expect(container.querySelectorAll('.setting-item').length).to.equal(1);
    });

    it('addToggle renders a checkbox-container and fires onChange on click', () => {
        const container = createDiv();
        let value = false;
        const s = new Setting(container).addToggle((t) => {
            t.setValue(false).onChange((v) => {
                value = v;
            });
        });
        const toggle = s.controlEl.querySelector('.checkbox-container') as HTMLElement;
        expect(toggle).to.exist;
        toggle.click();
        expect(value).to.equal(true);
        toggle.click();
        expect(value).to.equal(false);
    });

    it('addText wires onChange to fire on input events', () => {
        const container = createDiv();
        let typed = '';
        new Setting(container).addText((text) => {
            text.onChange((v) => {
                typed = v;
            });
        });
        const input = container.querySelector('input') as HTMLInputElement;
        input.value = 'hello';
        input.dispatchEvent(new Event('input'));
        expect(typed).to.equal('hello');
    });

    it('addDropdown wires onChange + options', () => {
        const container = createDiv();
        let selected = '';
        const s = new Setting(container).addDropdown((dd) => {
            dd.addOption('a', 'Alpha').addOption('b', 'Beta').onChange((v) => {
                selected = v;
            });
        });
        const select = s.controlEl.querySelector('select') as HTMLSelectElement;
        expect(select.children.length).to.equal(2);
        select.value = 'b';
        select.dispatchEvent(new Event('change'));
        expect(selected).to.equal('b');
    });

    it('Component.registerDomEvent wires + unload cleans up', () => {
        const container = createDiv();
        const component = new Component();
        let clicks = 0;
        component.registerDomEvent(container, 'click', () => {
            clicks++;
        });
        container.click();
        expect(clicks).to.equal(1);
        component.unload();
        container.click();
        expect(clicks).to.equal(1); // no additional click after unload
    });

    it('empty() clears children', () => {
        const el = createDiv();
        el.createSpan({ text: 'child1' });
        el.createSpan({ text: 'child2' });
        expect(el.children.length).to.equal(2);
        el.empty();
        expect(el.children.length).to.equal(0);
    });
});
