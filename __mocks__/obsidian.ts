/**
 * Minimal `obsidian` module stub for Vitest. Picked up automatically via
 * Vitest's `<rootDir>/__mocks__` resolution when a test (or a module it
 * imports) has a runtime import from 'obsidian'. Type-only imports
 * (`import type { TFile } from 'obsidian'`) are erased by esbuild at
 * transpile time and never hit this file.
 *
 * Extend this file as new test surfaces require more of the Obsidian API.
 * Keep stubs minimal — classes are no-op shells, functions return empty
 * shapes. The goal is import resolution, not behavior simulation.
 */

export function normalizePath(path: string): string {
    return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');
}

/** No-op Notice — tests don't render UI. */
export class Notice {
    constructor(_message: string, _duration?: number) {}
}

/** Stub Platform — desktop defaults. */
 export const Platform = {
    isMobile: false,
    isDesktopApp: true,
    isMacOS: false,
    isWin: false,
    isLinux: true
};

/** No-op requestUrl — network-dependent tests should stub this per-test. */
export async function requestUrl(_opts: unknown): Promise<{
    status: number;
    headers: Record<string, string>;
    text: string;
    json: unknown;
    arrayBuffer: ArrayBuffer;
}> {
    return { status: 200, headers: {}, text: '', json: null, arrayBuffer: new ArrayBuffer(0) };
}

/** No-op setIcon — tests don't render icons. */
export function setIcon(_el: HTMLElement, _iconId: string): void {}

/** No-op addIcon. */
export function addIcon(_iconId: string, _svg: string): void {}

/** No-op stringifyYaml — returns a placeholder. */
export function stringifyYaml(_obj: unknown): string {
    return '';
}

// Class stubs — minimal shells so `instanceof` and field access compile.
// These are only the classes referenced as runtime values in src/ (not type-only).
export class TFile {
    path = '';
    name = '';
    basename = '';
    extension = '';
    stat = { mtime: 0, ctime: 0, size: 0 };
    parent: TFolder | null = null;
}

export class TFolder {
    path = '';
    name = '';
    parent: TFolder | null = null;
    children: unknown[] = [];
}

export class Vault {
    adapter = {
        async exists(_path: string): Promise<boolean> {
            return false;
        },
        async read(_path: string): Promise<string> {
            return '';
        },
        async write(_path: string, _data: string): Promise<void> {},
        async remove(_path: string): Promise<void> {},
        async mkdir(_path: string): Promise<void> {},
        async list(_path: string): Promise<{ files: string[]; folders: string[] }> {
            return { files: [], folders: [] };
        }
    };
}

export class App {
    vault = new Vault();
    workspace = {
        getActiveFile(): TFile | null {
            return null;
        },
        getLeaf(): { openFile(_f: TFile): Promise<void> } {
            return { async openFile() {} };
        }
    };
    metadataCache = {
        getFileCache(_file: TFile): unknown {
            return null;
        },
        getFirstLinkpathDest(_link: string, _path: string): TFile | null {
            return null;
        },
        getCache(_path: string): unknown {
            return null;
        }
    };
    fileManager = {
        generateMarkdownLink(_file: TFile, _sourcePath: string): string {
            return '';
        }
    };
}

/**
 * Component lifecycle. Tracks registered events/intervals/callbacks and
 * cleans them up on `unload()`. `registerDomEvent` uses `addEventListener`
 * when the element supports it (happy-dom), and no-ops otherwise (node-env
 * tests that don't touch real DOM).
 */
export class Component {
    private _cleanups: (() => void)[] = [];

    register(cb: () => any): this {
        this._cleanups.push(cb);
        return this;
    }

    registerDomEvent(
        el: {
            addEventListener?: (event: string, cb: EventListenerOrEventListenerObject) => void;
            removeEventListener?: (event: string, cb: EventListenerOrEventListenerObject) => void;
        },
        event: string,
        cb: EventListenerOrEventListenerObject
    ): this {
        if (el && typeof el.addEventListener === 'function') {
            el.addEventListener(event, cb);
            this._cleanups.push(() => el.removeEventListener?.(event, cb));
        }
        return this;
    }

    registerInterval(id: number): number {
        this._cleanups.push(() => clearInterval(id));
        return id;
    }

    unload(): void {
        for (const cb of this._cleanups) {
            try {
                cb();
            } catch {
                /* best-effort cleanup */
            }
        }
        this._cleanups = [];
    }
}

/**
 * Functional Setting mock. Creates a real `.setting-item` DOM row (in
 * happy-dom) so UI tests can assert on structure, text, and controls.
 * Only instantiated in jsdom/happy-dom tests (needs `document`).
 */
export class Setting {
    settingEl: HTMLElement;
    infoEl: HTMLElement;
    nameEl: HTMLElement;
    descEl: HTMLElement;
    controlEl: HTMLElement;
    components: Component[] = [];

    constructor(containerEl: HTMLElement) {
        this.settingEl = containerEl.createEl('div', { cls: 'setting-item' });
        this.infoEl = this.settingEl.createDiv({ cls: 'setting-item-info' });
        this.nameEl = this.infoEl.createDiv({ cls: 'setting-item-name' });
        this.descEl = this.infoEl.createDiv({ cls: 'setting-item-description' });
        this.controlEl = this.settingEl.createDiv({ cls: 'setting-item-control' });
    }

    setName(name: string | DocumentFragment): this {
        this.nameEl.textContent = typeof name === 'string' ? name : name.textContent ?? '';
        return this;
    }

    setDesc(desc: string | DocumentFragment): this {
        this.descEl.textContent = typeof desc === 'string' ? desc : desc.textContent ?? '';
        return this;
    }

    setClass(cls: string): this {
        this.settingEl.addClass(cls);
        return this;
    }

    setHeading(): this {
        this.settingEl.addClass('setting-item-heading');
        return this;
    }

    setTooltip(tooltip: string): this {
        this.settingEl.setAttr('aria-label', tooltip);
        return this;
    }

    then(cb: (setting: this) => void): this {
        cb(this);
        return this;
    }

    addToggle(cb?: (toggle: ToggleComponent) => any): this {
        const toggle = new ToggleComponent(this.controlEl);
        this.components.push(toggle);
        if (cb) cb(toggle);
        return this;
    }

    addText(cb?: (text: TextComponent) => any): this {
        const text = new TextComponent(this.controlEl);
        this.components.push(text);
        if (cb) cb(text);
        return this;
    }

    addTextArea(cb?: (text: TextAreaComponent) => any): this {
        const text = new TextAreaComponent(this.controlEl);
        this.components.push(text);
        if (cb) cb(text);
        return this;
    }

    addDropdown(cb?: (dropdown: DropdownComponent) => any): this {
        const dropdown = new DropdownComponent(this.controlEl);
        this.components.push(dropdown);
        if (cb) cb(dropdown);
        return this;
    }

    addButton(cb?: (button: ButtonComponent) => any): this {
        const button = new ButtonComponent(this.controlEl);
        this.components.push(button);
        if (cb) cb(button);
        return this;
    }

    addExtraButton(cb?: (button: ExtraButtonComponent) => any): this {
        const button = new ExtraButtonComponent(this.controlEl);
        this.components.push(button);
        if (cb) cb(button);
        return this;
    }
}

/** Base for input-style components. Has `inputEl` (the DOM input). */
export abstract class ValueComponent<T> extends Component {
    inputEl: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

    constructor(containerEl: HTMLElement) {
        super();
        this.inputEl = containerEl.createEl('input') as HTMLInputElement;
    }

    getValue(): T {
        return (this.inputEl as HTMLInputElement).value as unknown as T;
    }

    setValue(value: T): this {
        (this.inputEl as HTMLInputElement).value = String(value);
        return this;
    }

    setPlaceholder(p: string): this {
        (this.inputEl as HTMLInputElement).placeholder = p;
        return this;
    }

    setDisabled(d: boolean): this {
        (this.inputEl as HTMLInputElement).disabled = d;
        return this;
    }
}

export class ToggleComponent extends ValueComponent<boolean> {
    toggleEl: HTMLElement;
    private _onChange?: (value: boolean) => void;

    constructor(containerEl: HTMLElement) {
        super(containerEl);
        this.inputEl.type = 'checkbox';
        this.toggleEl = containerEl.createDiv({ cls: 'checkbox-container' });
        containerEl.removeChild(this.inputEl);
        this.toggleEl.appendChild(this.inputEl);
        this.registerDomEvent(this.toggleEl, 'click', () => {
            const enabled = !this.toggleEl.hasClass('is-enabled');
            this.toggleEl.toggleClass('is-enabled', enabled);
            if (this._onChange) this._onChange(enabled);
        });
    }

    setValue(value: boolean): this {
        this.toggleEl.toggleClass('is-enabled', value);
        return this;
    }

    getValue(): boolean {
        return this.toggleEl.hasClass('is-enabled');
    }

    onChange(cb: (value: boolean) => any): this {
        this._onChange = cb;
        return this;
    }
}

export class TextComponent extends ValueComponent<string> {
    private _onChange?: (value: string) => void;

    constructor(containerEl: HTMLElement) {
        super(containerEl);
        this.registerDomEvent(this.inputEl, 'input', () => {
            if (this._onChange) this._onChange(this.inputEl.value);
        });
    }

    onChange(cb: (value: string) => any): this {
        this._onChange = cb;
        return this;
    }
}

export class TextAreaComponent extends ValueComponent<string> {
    inputEl: HTMLTextAreaElement;

    constructor(containerEl: HTMLElement) {
        super(containerEl);
        // Replace the input with a textarea.
        containerEl.removeChild(this.inputEl);
        this.inputEl = containerEl.createEl('textarea') as HTMLTextAreaElement;
    }

    onChange(cb: (value: string) => any): this {
        this.registerDomEvent(this.inputEl, 'input', () => cb(this.inputEl.value));
        return this;
    }
}

export class DropdownComponent extends ValueComponent<string> {
    selectEl: HTMLSelectElement;
    private _options: Record<string, string> = {};
    private _onChange?: (value: string) => void;

    constructor(containerEl: HTMLElement) {
        super(containerEl);
        containerEl.removeChild(this.inputEl);
        this.selectEl = containerEl.createEl('select') as HTMLSelectElement;
        this.inputEl = this.selectEl;
        this.registerDomEvent(this.selectEl, 'change', () => {
            if (this._onChange) this._onChange(this.selectEl.value);
        });
    }

    addOption(value: string, label: string): this {
        this._options[value] = label;
        this.selectEl.createEl('option', { attr: { value }, text: label });
        return this;
    }

    addOptions(options: Record<string, string>): this {
        for (const [v, l] of Object.entries(options)) this.addOption(v, l);
        return this;
    }

    setValue(value: string): this {
        this.selectEl.value = value;
        return this;
    }

    getValue(): string {
        return this.selectEl.value;
    }

    onChange(cb: (value: string) => any): this {
        this._onChange = cb;
        return this;
    }
}

export class ButtonComponent extends Component {
    buttonEl: HTMLButtonElement;

    constructor(containerEl: HTMLElement) {
        super();
        this.buttonEl = containerEl.createEl('button') as HTMLButtonElement;
    }

    setButtonText(text: string): this {
        this.buttonEl.textContent = text;
        return this;
    }

    setIcon(_icon: string): this {
        return this;
    }

    setTooltip(tooltip: string): this {
        this.buttonEl.setAttribute('aria-label', tooltip);
        return this;
    }

    setDisabled(d: boolean): this {
        this.buttonEl.disabled = d;
        return this;
    }

    setWarning(): this {
        this.buttonEl.addClass('mod-warning');
        return this;
    }

    setDestructive(): this {
        this.buttonEl.addClass('mod-destructive');
        return this;
    }

    setCta(): this {
        this.buttonEl.addClass('mod-cta');
        return this;
    }

    onClick(cb: () => any): this {
        this.registerDomEvent(this.buttonEl, 'click', cb);
        return this;
    }
}

export class ExtraButtonComponent extends Component {
    extraSettingsEl: HTMLElement;

    constructor(containerEl: HTMLElement) {
        super();
        this.extraSettingsEl = containerEl.createDiv({ cls: 'extra-setting-button' });
    }

    setIcon(_icon: string): this {
        return this;
    }

    setTooltip(tooltip: string): this {
        this.extraSettingsEl.setAttribute('aria-label', tooltip);
        return this;
    }

    setDisabled(d: boolean): this {
        if (d) this.extraSettingsEl.addClass('is-disabled');
        else this.extraSettingsEl.removeClass('is-disabled');
        return this;
    }

    onClick(cb: () => any): this {
        this.registerDomEvent(this.extraSettingsEl, 'click', cb);
        return this;
    }
}

export class Modal {
    contentEl: HTMLElement;
    titleEl: HTMLElement;
    modalEl: HTMLElement;

    constructor(_app: App) {
        this.modalEl = document.createElement('div');
        this.contentEl = this.modalEl.createDiv({ cls: 'modal-content' });
        this.titleEl = this.contentEl.createDiv({ cls: 'modal-title' });
    }

    open(): void {}
    close(): void {}
    onOpen(): void {}
    onClose(): void {}
}

/** Minimal SuggestModal stub — enough for subclasses to compile + instantiate. */
export class SuggestModal<T> {
    limit = Infinity;
    setPlaceholder(_p: string): this {
        return this;
    }
    getSuggestions(_query: string): T[] {
        return [];
    }
    renderSuggestion(_item: T, _el: HTMLElement): void {}
    onChooseSuggestion(_item: T): void {}
    constructor(_app?: App) {}
    open(): void {}
    close(): void {}
}

/** Minimal FuzzySuggestModal stub. */
export class FuzzySuggestModal<T> {
    getItems(): T[] {
        return [];
    }
    getItemText(_item: T): string {
        return '';
    }
    onChooseItem(_item: T, _evt: MouseEvent | KeyboardEvent): void {}
    constructor(_app?: App) {}
    open(): void {}
    close(): void {}
    setPlaceholder(_p: string): this {
        return this;
    }
}
