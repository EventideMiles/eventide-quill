/**
 * Polyfills Obsidian's DOM helper extensions for UI lifecycle tests running
 * under happy-dom. Obsidian's `app.js` adds these methods to HTMLElement
 * (and DocumentFragment) at runtime; in the test environment they don't
 * exist unless we add them.
 *
 * Import this file at the top of any UI test that uses `// @vitest-environment
 * happy-dom`. It is a side-effecting module — the import runs the polyfill.
 *
 * Methods polyfilled on HTMLElement.prototype:
 *   createEl, createDiv, createSpan, createSvg, createFragment — create +
 *     append + return (the method form; the global form below doesn't append).
 *   addClass, removeClass, toggleClass, hasClass, empty, detach, show, hide.
 *   setText, appendText, setAttr, find, findAll, on.
 *
 * Global functions (create without appending):
 *   createEl, createDiv, createSpan, createFragment, setIcon, setTooltip.
 */

type DomOpts = Record<string, unknown> | ((el: HTMLElement) => void) | undefined;

function applyOpts(el: HTMLElement, o: DomOpts): void {
    if (!o) return;
    if (typeof o === 'function') {
        o(el);
        return;
    }
    const opts = o as Record<string, unknown>;
    if (opts.cls) el.className = String(opts.cls);
    if (opts.text != null) el.textContent = String(opts.text);
    if (opts.attr && typeof opts.attr === 'object') {
        for (const [k, v] of Object.entries(opts.attr)) el.setAttribute(k, String(v));
    }
    if (opts.value != null) (el as HTMLInputElement).value = String(opts.value);
    if (opts.type) (el as HTMLInputElement).type = String(opts.type);
    if (opts.placeholder) (el as HTMLInputElement).placeholder = String(opts.placeholder);
    if (opts.href) (el as HTMLAnchorElement).href = String(opts.href);
    if (opts.title) el.setAttribute('title', String(opts.title));
    if (typeof opts.callback === 'function') (opts.callback as (el: HTMLElement) => void)(el);
}

function makeCreateEl(append: boolean) {
    return function (this: HTMLElement, tag: string, o?: DomOpts): HTMLElement {
        const el = document.createElement(tag);
        applyOpts(el, o);
        if (append) this.appendChild(el);
        return el;
    };
}

function makeCreateDiv(append: boolean) {
    return function (this: HTMLElement, o?: DomOpts): HTMLDivElement {
        return makeCreateEl(append).call(this, 'div', o) as HTMLDivElement;
    };
}

function makeCreateSpan(append: boolean) {
    return function (this: HTMLElement, o?: DomOpts): HTMLSpanElement {
        return makeCreateEl(append).call(this, 'span', o) as HTMLSpanElement;
    };
}

function createFragmentFn(this: HTMLElement, o?: DomOpts): DocumentFragment {
    const frag = document.createDocumentFragment();
    if (o) applyOpts(frag as unknown as HTMLElement, o);
    return frag;
}

/** Apply the polyfill to a prototype (HTMLElement or DocumentFragment). */
function polyfillProto(proto: typeof HTMLElement.prototype): void {
    proto.createEl = makeCreateEl(true) as any;
    proto.createDiv = makeCreateDiv(true) as any;
    proto.createSpan = makeCreateSpan(true) as any;
    proto.createFragment = createFragmentFn as any;
    proto.createSvg = function (this: HTMLElement): SVGElement {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        this.appendChild(svg);
        return svg;
    } as any;
    proto.addClass = function (this: HTMLElement, ...cls: string[]): HTMLElement {
        this.classList.add(...cls);
        return this;
    };
    proto.removeClass = function (this: HTMLElement, ...cls: string[]): HTMLElement {
        this.classList.remove(...cls);
        return this;
    };
    proto.toggleClass = function (this: HTMLElement, cls: string, value?: boolean): HTMLElement {
        this.classList.toggle(cls, value);
        return this;
    };
    proto.hasClass = function (this: HTMLElement, cls: string): boolean {
        return this.classList.contains(cls);
    };
    proto.empty = function (this: HTMLElement): HTMLElement {
        this.innerHTML = '';
        return this;
    };
    proto.detach = function (this: HTMLElement): void {
        this.remove();
    };
    proto.show = function (this: HTMLElement): HTMLElement {
        this.style.display = '';
        return this;
    };
    proto.hide = function (this: HTMLElement): HTMLElement {
        this.style.display = 'none';
        return this;
    };
    proto.setText = function (this: HTMLElement, text: string | DocumentFragment): HTMLElement {
        this.textContent = typeof text === 'string' ? text : text.textContent ?? '';
        return this;
    };
    proto.appendText = function (this: HTMLElement, text: string): HTMLElement {
        this.appendChild(document.createTextNode(text));
        return this;
    };
    proto.setAttr = function (this: HTMLElement, attr: string, value: string): HTMLElement {
        this.setAttribute(attr, value);
        return this;
    };
    proto.find = function (this: HTMLElement, selector: string): HTMLElement | null {
        return this.querySelector(selector);
    };
    proto.findAll = function (this: HTMLElement, selector: string): HTMLElement[] {
        return Array.from(this.querySelectorAll(selector));
    };
    proto.on = function (this: HTMLElement, event: string, _selector: string | null, cb: EventListenerOrEventListenerObject): HTMLElement {
        this.addEventListener(event, cb);
        return this;
    } as any;
}

// Apply to both HTMLElement and DocumentFragment.
polyfillProto(HTMLElement.prototype);
polyfillProto(DocumentFragment.prototype as typeof HTMLElement.prototype);

// Global functions (create without appending — the caller appends).
const g = globalThis as Record<string, unknown>;
g.createEl = (tag: string, o?: DomOpts) => {
    const el = document.createElement(tag);
    applyOpts(el, o);
    return el;
};
g.createDiv = (o?: DomOpts) => (g.createEl as (t: string, o?: DomOpts) => HTMLElement)('div', o);
g.createSpan = (o?: DomOpts) => (g.createEl as (t: string, o?: DomOpts) => HTMLElement)('span', o);
g.createFragment = (o?: ((el: DocumentFragment) => void) | undefined) => {
    const frag = document.createDocumentFragment();
    if (typeof o === 'function') o(frag);
    return frag;
};
g.setIcon = (_el: HTMLElement, _icon: string): void => {
    /* no-op — icon rendering is visual; tests assert on text/classes */
};
g.setTooltip = (_el: HTMLElement, _tooltip: string): void => {
    /* no-op */
};
// ResizeObserver polyfill — happy-dom doesn't provide it.
(g as Record<string, unknown>).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
};

export {};
