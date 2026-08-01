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

/** Forward-slash + single-slash normalization (matches Obsidian's path handling). */
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

/** Minimal MarkdownRenderer — sets textContent (no real markdown rendering). */
export const MarkdownRenderer = {
    /** Render markdown by setting `el.textContent` (no real parsing). */
    render(_app: unknown, markdown: string, el: HTMLElement, _sourcePath: string, _component: unknown): Promise<void> {
        el.textContent = markdown;
        return Promise.resolve();
    }
};

/** No-op addIcon. */
export function addIcon(_iconId: string, _svg: string): void {}

/** No-op stringifyYaml — returns a placeholder. */
export function stringifyYaml(_obj: unknown): string {
    return '';
}

// Class stubs — minimal shells so `instanceof` and field access compile.
// These are only the classes referenced as runtime values in src/ (not type-only).
/** Stub file entry — plain data fields only. */
export class TFile {
    path = '';
    name = '';
    basename = '';
    extension = '';
    stat = { mtime: 0, ctime: 0, size: 0 };
    parent: TFolder | null = null;
}

/** Stub folder entry — plain data fields only. */
export class TFolder {
    path = '';
    name = '';
    parent: TFolder | null = null;
    children: unknown[] = [];
}

/** Stub Vault — returns empty shapes for every file operation. */
export class Vault {
    adapter = {
        /** True if the path exists (always false). */
        async exists(_path: string): Promise<boolean> {
            return false;
        },
        /** Read the file (always empty string). */
        async read(_path: string): Promise<string> {
            return '';
        },
        /** Write the file (no-op). */
        async write(_path: string, _data: string): Promise<void> {},
        /** Remove the file (no-op). */
        async remove(_path: string): Promise<void> {},
        /** Create the directory (no-op). */
        async mkdir(_path: string): Promise<void> {},
        /** List the directory (always empty). */
        async list(_path: string): Promise<{ files: string[]; folders: string[] }> {
            return { files: [], folders: [] };
        }
    };
    /** All files in the vault (always empty). */
    getFiles(): TFile[] {
        return [];
    }
    /** Markdown files in the vault (always empty). */
    getMarkdownFiles(): TFile[] {
        return [];
    }
}

/** Stub App — empty workspace, metadata cache, and file manager. */
export class App {
    vault = new Vault();
    workspace = {
        /** The active file (always null). */
        getActiveFile(): TFile | null {
            return null;
        },
        /** The active view of the given type (always null). */
        getActiveViewOfType(): unknown {
            return null;
        },
        /** All leaves of the given type (always empty). */
        getLeavesOfType(): unknown[] {
            return [];
        },
        /** A leaf that resolves files (no-op openFile). */
        getLeaf(): { openFile(_f: TFile): Promise<void> } {
            return { async openFile() {} };
        },
        /** Subscribe to a workspace event (returns a detachable ref). */
        on(_event: string, _cb: (...args: unknown[]) => void): unknown {
            return { detach: () => {} };
        },
        /** Unsubscribe from a workspace event (no-op). */
        offref(_ref: unknown): void {}
    };
    metadataCache = {
        /** The file cache entry (always null). */
        getFileCache(_file: TFile): unknown {
            return null;
        },
        /** The resolved link target (always null). */
        getFirstLinkpathDest(_link: string, _path: string): TFile | null {
            return null;
        },
        /** The raw cache for a path (always null). */
        getCache(_path: string): unknown {
            return null;
        }
    };
    fileManager = {
        /** Generate a markdown link for a file (always empty string). */
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

    /** Record a cleanup callback to run on `unload()`. */
    register(cb: () => any): this {
        this._cleanups.push(cb);
        return this;
    }

    /** Attach a DOM listener and record its removal for `unload()` (no-op for non-DOM elements). */
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

    /** Record an interval id for cleanup on `unload()`. */
    registerInterval(id: number): number {
        this._cleanups.push(() => clearInterval(id));
        return id;
    }

    /** Record an event ref (no-op — nothing to clean up in the stub). */
    registerEvent(_eventRef: unknown): this {
        return this;
    }

    /** Adopt a child component: fire its `onload()`, clean it up on `unload()`. */
    addChild(child: Component): Component {
        const c = child as unknown as { onload?: () => void; onunload?: () => void };
        if (typeof c.onload === 'function') c.onload();
        this._cleanups.push(() => {
            if (typeof c.onunload === 'function') c.onunload();
        });
        return child;
    }

    /** Run every registered cleanup (best-effort) and reset the list. */
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

    /** Build the `.setting-item` DOM row (name/description/control cells). */
    constructor(containerEl: HTMLElement) {
        this.settingEl = containerEl.createEl('div', { cls: 'setting-item' });
        this.infoEl = this.settingEl.createDiv({ cls: 'setting-item-info' });
        this.nameEl = this.infoEl.createDiv({ cls: 'setting-item-name' });
        this.descEl = this.infoEl.createDiv({ cls: 'setting-item-description' });
        this.controlEl = this.settingEl.createDiv({ cls: 'setting-item-control' });
    }

    /** Set the row's name text. */
    setName(name: string | DocumentFragment): this {
        this.nameEl.textContent = typeof name === 'string' ? name : name.textContent ?? '';
        return this;
    }

    /** Set the row's description text. */
    setDesc(desc: string | DocumentFragment): this {
        this.descEl.textContent = typeof desc === 'string' ? desc : desc.textContent ?? '';
        return this;
    }

    /** Add a class to the row element. */
    setClass(cls: string): this {
        this.settingEl.addClass(cls);
        return this;
    }

    /** Mark the row as a heading. */
    setHeading(): this {
        this.settingEl.addClass('setting-item-heading');
        return this;
    }

    /** Set an `aria-label` tooltip on the row. */
    setTooltip(tooltip: string): this {
        this.settingEl.setAttr('aria-label', tooltip);
        return this;
    }

    /** Run `cb` with this setting (chainable). */
    then(cb: (setting: this) => void): this {
        cb(this);
        return this;
    }

    /** Add a ToggleComponent to the control cell. */
    addToggle(cb?: (toggle: ToggleComponent) => any): this {
        const toggle = new ToggleComponent(this.controlEl);
        this.components.push(toggle);
        if (cb) cb(toggle);
        return this;
    }

    /** Add a TextComponent to the control cell. */
    addText(cb?: (text: TextComponent) => any): this {
        const text = new TextComponent(this.controlEl);
        this.components.push(text);
        if (cb) cb(text);
        return this;
    }

    /** Add a TextAreaComponent to the control cell. */
    addTextArea(cb?: (text: TextAreaComponent) => any): this {
        const text = new TextAreaComponent(this.controlEl);
        this.components.push(text);
        if (cb) cb(text);
        return this;
    }

    /** Add a DropdownComponent to the control cell. */
    addDropdown(cb?: (dropdown: DropdownComponent) => any): this {
        const dropdown = new DropdownComponent(this.controlEl);
        this.components.push(dropdown);
        if (cb) cb(dropdown);
        return this;
    }

    /** Add a ButtonComponent to the control cell. */
    addButton(cb?: (button: ButtonComponent) => any): this {
        const button = new ButtonComponent(this.controlEl);
        this.components.push(button);
        if (cb) cb(button);
        return this;
    }

    /** Add an ExtraButtonComponent to the control cell. */
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

    /** Create the underlying `<input>` element. */
    constructor(containerEl: HTMLElement) {
        super();
        this.inputEl = containerEl.createEl('input') as HTMLInputElement;
    }

    /** Read the input's current value. */
    getValue(): T {
        return (this.inputEl as HTMLInputElement).value as unknown as T;
    }

    /** Set the input's value (stringified). */
    setValue(value: T): this {
        (this.inputEl as HTMLInputElement).value = String(value);
        return this;
    }

    /** Set the input's placeholder text. */
    setPlaceholder(p: string): this {
        (this.inputEl as HTMLInputElement).placeholder = p;
        return this;
    }

    /** Disable/enable the input. */
    setDisabled(d: boolean): this {
        (this.inputEl as HTMLInputElement).disabled = d;
        return this;
    }
}

/** Stub toggle — flips a CSS class and fires `onChange` on click. */
export class ToggleComponent extends ValueComponent<boolean> {
    toggleEl: HTMLElement;
    private _onChange?: (value: boolean) => void;

    /** Build a checkbox-style toggle and wire click-to-change. */
    constructor(containerEl: HTMLElement) {
        super(containerEl);
        (this.inputEl as HTMLInputElement).type = 'checkbox';
        this.toggleEl = containerEl.createDiv({ cls: 'checkbox-container' });
        containerEl.removeChild(this.inputEl);
        this.toggleEl.appendChild(this.inputEl);
        this.registerDomEvent(this.toggleEl, 'click', () => {
            const enabled = !this.toggleEl.hasClass('is-enabled');
            this.toggleEl.toggleClass('is-enabled', enabled);
            if (this._onChange) this._onChange(enabled);
        });
    }

    /** Set the toggle's on/off visual state. */
    setValue(value: boolean): this {
        this.toggleEl.toggleClass('is-enabled', value);
        return this;
    }

    /** Read the toggle's on/off state. */
    getValue(): boolean {
        return this.toggleEl.hasClass('is-enabled');
    }

    /** Register a change callback. */
    onChange(cb: (value: boolean) => any): this {
        this._onChange = cb;
        return this;
    }
}

/** Stub text input — fires `onChange` on each `input` event. */
export class TextComponent extends ValueComponent<string> {
    private _onChange?: (value: string) => void;

    /** Wire the input event to the registered callback. */
    constructor(containerEl: HTMLElement) {
        super(containerEl);
        this.registerDomEvent(this.inputEl, 'input', () => {
            if (this._onChange) this._onChange(this.inputEl.value);
        });
    }

    /** Register a change callback. */
    onChange(cb: (value: string) => any): this {
        this._onChange = cb;
        return this;
    }
}

/** Stub textarea — fires `onChange` on each `input` event. */
export class TextAreaComponent extends ValueComponent<string> {
    inputEl!: HTMLTextAreaElement;

    /** Swap the base input for a `<textarea>`. */
    constructor(containerEl: HTMLElement) {
        super(containerEl);
        // Replace the input with a textarea.
        containerEl.removeChild(this.inputEl);
        this.inputEl = containerEl.createEl('textarea') as HTMLTextAreaElement;
    }

    /** Register a change callback. */
    onChange(cb: (value: string) => any): this {
        this.registerDomEvent(this.inputEl, 'input', () => cb(this.inputEl.value));
        return this;
    }
}

/** Stub dropdown — renders `<option>`s and fires `onChange` on `change`. */
export class DropdownComponent extends ValueComponent<string> {
    selectEl: HTMLSelectElement;
    private _options: Record<string, string> = {};
    private _onChange?: (value: string) => void;

    /** Build a `<select>` and wire the change event. */
    constructor(containerEl: HTMLElement) {
        super(containerEl);
        containerEl.removeChild(this.inputEl);
        this.selectEl = containerEl.createEl('select') as HTMLSelectElement;
        this.inputEl = this.selectEl;
        this.registerDomEvent(this.selectEl, 'change', () => {
            if (this._onChange) this._onChange(this.selectEl.value);
        });
    }

    /** Add one option (value + label). */
    addOption(value: string, label: string): this {
        this._options[value] = label;
        this.selectEl.createEl('option', { attr: { value }, text: label });
        return this;
    }

    /** Add several options at once. */
    addOptions(options: Record<string, string>): this {
        for (const [v, l] of Object.entries(options)) this.addOption(v, l);
        return this;
    }

    /** Set the selected value. */
    setValue(value: string): this {
        this.selectEl.value = value;
        return this;
    }

    /** Read the selected value. */
    getValue(): string {
        return this.selectEl.value;
    }

    /** Register a change callback. */
    onChange(cb: (value: string) => any): this {
        this._onChange = cb;
        return this;
    }
}

/** Stub button — a real `<button>` element with chainable setters. */
export class ButtonComponent extends Component {
    buttonEl: HTMLButtonElement;

    /** Create the `<button>` element. */
    constructor(containerEl: HTMLElement) {
        super();
        this.buttonEl = containerEl.createEl('button') as HTMLButtonElement;
    }

    /** Set the button's label text. */
    setButtonText(text: string): this {
        this.buttonEl.textContent = text;
        return this;
    }

    /** Set the button's icon (no-op in tests). */
    setIcon(_icon: string): this {
        return this;
    }

    /** Set an `aria-label` tooltip. */
    setTooltip(tooltip: string): this {
        this.buttonEl.setAttribute('aria-label', tooltip);
        return this;
    }

    /** Disable/enable the button. */
    setDisabled(d: boolean): this {
        this.buttonEl.disabled = d;
        return this;
    }

    /** Add the `mod-warning` class. */
    setWarning(): this {
        this.buttonEl.addClass('mod-warning');
        return this;
    }

    /** Add the `mod-destructive` class. */
    setDestructive(): this {
        this.buttonEl.addClass('mod-destructive');
        return this;
    }

    /** Add the `mod-cta` class. */
    setCta(): this {
        this.buttonEl.addClass('mod-cta');
        return this;
    }

    /** Register a click handler. */
    onClick(cb: () => any): this {
        this.registerDomEvent(this.buttonEl, 'click', cb);
        return this;
    }
}

/** Stub icon-button — a `.extra-setting-button` div with chainable setters. */
export class ExtraButtonComponent extends Component {
    extraSettingsEl: HTMLElement;

    /** Create the icon-button element. */
    constructor(containerEl: HTMLElement) {
        super();
        this.extraSettingsEl = containerEl.createDiv({ cls: 'extra-setting-button' });
    }

    /** Set the icon (no-op in tests). */
    setIcon(_icon: string): this {
        return this;
    }

    /** Set an `aria-label` tooltip. */
    setTooltip(tooltip: string): this {
        this.extraSettingsEl.setAttribute('aria-label', tooltip);
        return this;
    }

    /** Disable/enable via the `is-disabled` class. */
    setDisabled(d: boolean): this {
        if (d) this.extraSettingsEl.addClass('is-disabled');
        else this.extraSettingsEl.removeClass('is-disabled');
        return this;
    }

    /** Register a click handler. */
    onClick(cb: () => any): this {
        this.registerDomEvent(this.extraSettingsEl, 'click', cb);
        return this;
    }
}

/** Stub Modal — builds a DOM shell; open/close lifecycle is no-op. */
export class Modal {
    contentEl: HTMLElement;
    titleEl: HTMLElement;
    modalEl: HTMLElement;

    /** Build the modal DOM shell. */
    constructor(_app: App) {
        this.modalEl = document.createElement('div');
        this.contentEl = this.modalEl.createDiv({ cls: 'modal-content' });
        this.titleEl = this.contentEl.createDiv({ cls: 'modal-title' });
    }

    /** Open the modal (no-op). */
    open(): void {}
    /** Close the modal (no-op). */
    close(): void {}
    /** Lifecycle hook (no-op). */
    onOpen(): void {}
    /** Lifecycle hook (no-op). */
    onClose(): void {}
}

/** Minimal SuggestModal stub — enough for subclasses to compile + instantiate. */
export class SuggestModal<T> {
    limit = Infinity;
    /** Set the placeholder text (no-op). */
    setPlaceholder(_p: string): this {
        return this;
    }
    /** Suggestion list (always empty). */
    getSuggestions(_query: string): T[] {
        return [];
    }
    /** Render one suggestion (no-op). */
    renderSuggestion(_item: T, _el: HTMLElement): void {}
    /** Invoke on selection (no-op). */
    onChooseSuggestion(_item: T): void {}
    constructor(_app?: App) {}
    /** Open the modal (no-op). */
    open(): void {}
    /** Close the modal (no-op). */
    close(): void {}
}

/** Minimal FuzzySuggestModal stub. */
export class FuzzySuggestModal<T> {
    /** Item list (always empty). */
    getItems(): T[] {
        return [];
    }
    /** Display text for an item (always empty string). */
    getItemText(_item: T): string {
        return '';
    }
    /** Invoke on selection (no-op). */
    onChooseItem(_item: T, _evt: MouseEvent | KeyboardEvent): void {}
    constructor(_app?: App) {}
    /** Open the modal (no-op). */
    open(): void {}
    /** Close the modal (no-op). */
    close(): void {}
    /** Set the placeholder text (no-op). */
    setPlaceholder(_p: string): this {
        return this;
    }
}

/** Stub WorkspaceLeaf — the container Obsidian places views into. */
export class WorkspaceLeaf {
    containerEl: HTMLElement;
    view: unknown = null;
    app: App;
    /** Build a leaf with an empty DOM container. */
    constructor(app?: App) {
        this.app = app ?? new App();
        this.containerEl = document.createElement('div');
    }
}

/** Stub View base — extends Component with containerEl + app from the leaf. */
export abstract class View extends Component {
    app: App;
    containerEl: HTMLElement;
    contentEl: HTMLElement;
    icon = '';
    /** Bind the view to its leaf's app + container. */
    constructor(leaf: WorkspaceLeaf) {
        super();
        this.app = leaf.app;
        this.containerEl = leaf.containerEl;
        this.contentEl = this.containerEl.createDiv({ cls: 'view-content' });
    }
    /** Lifecycle hook (no-op). */
    onload(): void {}
    /** Lifecycle hook (no-op). */
    onunload(): void {}
    /** Open lifecycle hook (implemented by subclasses). */
    abstract onOpen(): void;
    /** Close lifecycle hook (implemented by subclasses). */
    abstract onClose(): void;
}

/** Stub ItemView — the base for sidebar/plugin views. */
export abstract class ItemView extends View {
    /** View type string (implemented by subclasses). */
    abstract getViewType(): string;
    /** Display text (implemented by subclasses). */
    abstract getDisplayText(): string;
    /** Icon id (always empty). */
    getIcon(): string {
        return '';
    }
}

/** Stub MarkdownView — used only for instanceof checks. */
export class MarkdownView {
    editor = {
        getValue: () => '',
        getCursor: () => ({ line: 0, ch: 0 }),
        setCursor: () => {},
        getSelection: () => '',
        replaceRange: () => {},
        posToOffset: () => 0,
        offsetToPos: () => ({ line: 0, ch: 0 })
    };
    file: TFile | null = null;
}

/** Stub PluginSettingTab — base for the enriched EventideQuillSettingTab. */
export class PluginSettingTab {
    app: App;
    plugin: { settings: Record<string, unknown>; saveSettings(): Promise<void> };
    containerEl: HTMLElement;
    settingItems: unknown[] = [];

    /** Build the tab shell from the app + plugin. */
    constructor(app: App, plugin: unknown) {
        this.app = app;
        this.plugin = plugin as PluginSettingTab['plugin'];
        this.containerEl = document.createElement('div');
    }

    /** Read a setting value by key. */
    getControlValue(key: string): unknown {
        return this.plugin.settings?.[key];
    }

    /** Write a setting value by key. */
    setControlValue(key: string, value: unknown): void | Promise<void> {
        if (this.plugin.settings) this.plugin.settings[key] = value;
    }

    /** Re-render (no-op). */
    update(): void {}
    /** Re-evaluate control state (no-op). */
    refreshDomState(): void {}
    /** Render the tab (no-op). */
    display(): void {}
    /** Hide the tab (no-op). */
    hide(): void {}
}

/** Stub SettingPage — abstract base for imperative sub-pages (provider pages, etc). */
export abstract class SettingPage {
    rootEl: HTMLElement;
    titlebarEl: HTMLElement;
    containerEl: HTMLElement;
    title = '';

    /** Build the page's DOM shell. */
    constructor() {
        this.rootEl = document.createElement('div');
        this.titlebarEl = document.createElement('div');
        this.containerEl = document.createElement('div');
    }

    /** Render the page (implemented by subclasses). */
    abstract display(): void;
    /** Hide the page (no-op). */
    hide(): void {}
}
