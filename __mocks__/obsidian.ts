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

// Component-lifecycle stubs — the UI-layer tests (future) need these to compile.
export class Component {
    register(): this {
        return this;
    }
    registerDomEvent(): this {
        return this;
    }
    registerInterval(): this {
        return this;
    }
    unload(): void {}
}

export class Modal {
    contentEl = {} as HTMLElement;
    constructor(_app: App) {}
    open(): void {}
    close(): void {}
    onOpen(): void {}
    onClose(): void {}
}
