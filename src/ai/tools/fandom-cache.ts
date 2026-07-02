/**
 * Local cache for Fandom wiki content — the persistence layer for the
 * `fandom_*` tools' cache-first lookup (PR 2, `.planning/pr-local-fandom-cache.md`).
 *
 * Stage 1 (this file): write-through only. `fandom_page` / `fandom_image`
 * call {@link FandomCache.putPage} / {@link FandomCache.putImage} after a
 * successful live fetch, so the cache fills silently as the writer works.
 * No reads happen here yet (Stage 2 adds cache-first `get`; Stage 3 adds
 * the "answers when network tools off" gating).
 *
 * Storage mirrors the `conversation-store.ts` / `embedding-cache.ts` sidecar
 * convention (NOT `loadData()`/`saveData()`): `vault.adapter` I/O,
 * `normalizePath()` everywhere, mkdir-on-first-write, best-effort (a cache
 * write failure is swallowed — the live result still returns to the model).
 *
 * Layout under `<pluginDataDir>/fandom-cache/`:
 *   <wiki>/pages.json   — { schemaVersion, wiki, pages: { [title]: CachedFandomPage } }
 *   <wiki>/images.json  — { schemaVersion, wiki, images: { [key]: CachedFandomImage } }
 *   <wiki>/img/<key>.jpg — image binaries (siblings, not base64-in-JSON)
 *
 * Attribution (source URL + license + retrievedAt) travels with every cached
 * item — CC-BY-SA requires it, and the Welcome privacy tab tells the writer
 * the cache is a separate consent surface from the network toggle.
 */
import { normalizePath, type Vault } from 'obsidian';
import { mediawikiAllPages, mediawikiExtract } from './mediawiki';

const SCHEMA_VERSION = 1;
const CACHE_FOLDER = 'fandom-cache';
const PAGES_FILENAME = 'pages.json';
const IMAGES_FILENAME = 'images.json';
const IMG_FOLDER = 'img';
/** Fandom content is CC-BY-SA by default; surfaced per cached item for compliance. */
export const FANDOM_DEFAULT_LICENSE = 'CC-BY-SA';

/** A cached page's text + attribution. */
export interface CachedFandomPage {
    /** Page body text (the extract returned to the model). */
    text: string;
    /** Canonical source URL, e.g. `https://starwars.fandom.com/wiki/Luke_Skywalker`. */
    sourceUrl: string;
    /** License string (default CC-BY-SA for Fandom). */
    license: string;
    /** Epoch milliseconds when the page was fetched. */
    retrievedAt: number;
}

/** Attribution metadata for a cached image (the bytes live in `img/<key>.jpg`). */
export interface CachedFandomImage {
    /** Canonical source URL of the fetched thumbnail. */
    sourceUrl: string;
    /** Original filename on the wiki (e.g. `File:Frodo.jpg`). */
    originalFilename: string;
    /** Image MIME after downscale (always JPEG). */
    contentType: string;
    /** License string (CC-BY-SA default; refined if extractable). */
    license: string;
    /** Epoch milliseconds when the image was fetched. */
    retrievedAt: number;
}

interface FandomPagesFile {
    schemaVersion: number;
    wiki: string;
    pages: Record<string, CachedFandomPage>;
}

interface FandomImagesFile {
    schemaVersion: number;
    wiki: string;
    images: Record<string, CachedFandomImage>;
}

/** Ensure a single directory exists (parent must already exist). Mirrors conversation-store's ensureDir — does NOT walk path segments from the root, which would either pollute the vault root (if the path is absolute) or redundantly check every ancestor. Call incrementally for nested dirs. */
async function ensureDir(vault: Vault, dir: string): Promise<void> {
    const clean = normalizePath(dir);
    if (clean.length === 0) return;
    const exists = await vault.adapter.exists(clean);
    if (!exists) await vault.adapter.mkdir(clean);
}

/** Normalize a title/filename into a cache key so casing/spacing/underscore variants collapse to one entry ("Freddy Lupin", "freddy lupin", "Freddy_Lupin" → "freddy lupin"). */
function normalizeKey(key: string): string {
    return key.toLowerCase().replace(/_/g, ' ').trim().replace(/\s+/g, ' ');
}

/** Build the canonical source URL for a wiki page (used for attribution). */
export function fandomPageSourceUrl(wiki: string, title: string): string {
    // MediaWiki title URLs space-encode as underscores.
    const titlePath = title.replace(/ /g, '_');
    return `https://${wiki}.fandom.com/wiki/${encodeURIComponent(titlePath).replace(/%2F/gi, '/')}`;
}

/** Convert a base64 string to an ArrayBuffer for `vault.adapter.writeBinary`. */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
}

/** Convert an ArrayBuffer back to a base64 string (inverse of {@link base64ToArrayBuffer}). */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]!);
    }
    return btoa(binary);
}

/**
 * Local Fandom cache. Construct once on plugin load; the fandom tools reach it
 * via {@link ToolContext.plugin}. All methods are best-effort — a cache write
 * failure is swallowed so the live tool result still returns to the model.
 */
export class FandomCache {
    private readonly vault: Vault;
    private readonly cacheDir: string;

    private constructor(vault: Vault, dataDir: string) {
        this.vault = vault;
        this.cacheDir = normalizePath(`${dataDir}/${CACHE_FOLDER}`);
    }

    /** Construct a cache rooted at `<dataDir>/fandom-cache/`. No I/O. */
    static create(vault: Vault, dataDir: string): FandomCache {
        return new FandomCache(vault, dataDir);
    }

    /** Per-wiki directory. `wiki` is already validated (alphanumeric + hyphens). */
    private wikiDir(wiki: string): string {
        return normalizePath(`${this.cacheDir}/${wiki}`);
    }

    private pagesPath(wiki: string): string {
        return normalizePath(`${this.wikiDir(wiki)}/${PAGES_FILENAME}`);
    }

    private imagesPath(wiki: string): string {
        return normalizePath(`${this.wikiDir(wiki)}/${IMAGES_FILENAME}`);
    }

    private imgDir(wiki: string): string {
        return normalizePath(`${this.wikiDir(wiki)}/${IMG_FOLDER}`);
    }

    /**
     * Write (or overwrite) a cached page for `wiki` keyed by `title` (normalized),
     * plus any `aliases` (also normalized) — so a page fetched via a partial or
     * differently-cased title is reachable on a repeat of either form. One
     * read-modify-write of pages.json per call. Best-effort.
     *
     * Cross-call atomicity is NOT guaranteed: concurrent `putPage` calls for the
     * same wiki can interleave their read-modify-write and clobber each other's
     * entry. This is an acceptable best-effort cache (a lost write just means a
     * later lookup re-fetches live); callers needing serialization must queue.
     */
    async putPage(wiki: string, title: string, page: CachedFandomPage, aliases: string[] = []): Promise<void> {
        try {
            const path = this.pagesPath(wiki);
            await ensureDir(this.vault, this.cacheDir);
            await ensureDir(this.vault, this.wikiDir(wiki));
            const existing = await this.readJson<FandomPagesFile>(path);
            const pages = existing?.pages ?? {};
            pages[normalizeKey(title)] = page;
            for (const alias of aliases) {
                const k = normalizeKey(alias);
                if (k) pages[k] = page;
            }
            const file: FandomPagesFile = {
                schemaVersion: SCHEMA_VERSION,
                wiki,
                pages
            };
            await this.vault.adapter.write(path, JSON.stringify(file));
        } catch {
            // Best-effort — cache write failure must not fail the tool call.
        }
    }

    /**
     * Write (or overwrite) a cached image for `wiki` keyed by `key` (page title
     * or filename). Stores the bytes as a binary sibling under `img/` and the
     * attribution in `images.json`. Best-effort; never throws.
     *
     * Atomicity: the metadata record is written BEFORE the binary, so a
     * mid-write failure leaves a meta entry pointing at a not-yet-written image
     * (which `getImage` treats as a cache miss) rather than an orphaned JPEG
     * with no attribution that nothing reclaims. Cross-call atomicity is NOT
     * guaranteed — concurrent `putImage` calls for the same wiki can interleave
     * their read-modify-write of `images.json` (best-effort cache by design; a
     * lost write just means a later lookup re-fetches live).
     */
    async putImage(
        wiki: string,
        key: string,
        base64: string,
        meta: Omit<CachedFandomImage, 'retrievedAt'>
    ): Promise<void> {
        try {
            await ensureDir(this.vault, this.cacheDir);
            await ensureDir(this.vault, this.wikiDir(wiki));
            // Metadata first — see the atomicity note above.
            const idxPath = this.imagesPath(wiki);
            const existing = await this.readJson<FandomImagesFile>(idxPath);
            const images = existing?.images ?? {};
            images[normalizeKey(key)] = { ...meta, retrievedAt: Date.now() };
            const file: FandomImagesFile = {
                schemaVersion: SCHEMA_VERSION,
                wiki,
                images
            };
            await this.vault.adapter.write(idxPath, JSON.stringify(file));
            // Only persist the binary once the metadata update succeeded.
            await ensureDir(this.vault, this.imgDir(wiki));
            const safeKey = sanitizeImageKey(key);
            const binaryPath = normalizePath(`${this.imgDir(wiki)}/${safeKey}.jpg`);
            await this.vault.adapter.writeBinary(binaryPath, base64ToArrayBuffer(base64));
        } catch {
            // Best-effort.
        }
    }

    /**
     * Read a cached page for `wiki` keyed by `title`. Returns undefined on miss,
     * missing file, or parse failure — the caller (fandom_page cache-first)
     * falls through to a live fetch. Stage 2.
     */
    async getPage(wiki: string, title: string): Promise<CachedFandomPage | undefined> {
        const pages = await this.loadPages(wiki);
        return pages?.[normalizeKey(title)];
    }

    /**
     * Read a cached image for `wiki` keyed by `key` (page title or filename).
     * Returns the base64 bytes + attribution, or undefined on miss, missing
     * binary, or read failure — the caller falls through to live. Stage 2.
     */
    async getImage(wiki: string, key: string): Promise<{ base64: string; meta: CachedFandomImage } | undefined> {
        const images = await this.loadImages(wiki);
        const meta = images?.[normalizeKey(key)];
        if (!meta) return undefined;
        const binaryPath = normalizePath(`${this.imgDir(wiki)}/${sanitizeImageKey(key)}.jpg`);
        try {
            const exists = await this.vault.adapter.exists(binaryPath);
            if (!exists) return undefined;
            const buffer = await this.vault.adapter.readBinary(binaryPath);
            return { base64: arrayBufferToBase64(buffer), meta };
        } catch {
            return undefined;
        }
    }

    /**
     * Bulk-sync (index) an entire wiki: enumerate every Main-namespace page and
     * cache its extract. For the on-the-go author who wants the whole wiki
     * available offline/private. Fair practices: reuses the mediawiki.ts
     * per-host rate limiter (500ms) + descriptive UA; checks `signal` between
     * pages so the writer can cancel. Best-effort — a failed extract for one
     * page is skipped, not fatal. Returns { cached, total }.
     *
     * Batching: accumulates all extracts in memory and flushes pages.json once
     * at the end instead of calling `putPage` per title (which would re-read +
     * re-write the whole file per page — quadratic I/O on large wikis). A
     * partial run (cancelled mid-way) still flushes whatever was gathered.
     */
    async bulkSyncWiki(
        wiki: string,
        opts: { onProgress?: (done: number, total: number) => void; signal?: AbortSignal } = {}
    ): Promise<{ cached: number; total: number }> {
        const host = `${wiki}.fandom.com`;
        const titles = await mediawikiAllPages(host, opts.signal);
        // Load pages.json once and batch updates in memory; flush once at the end.
        await ensureDir(this.vault, this.cacheDir);
        await ensureDir(this.vault, this.wikiDir(wiki));
        const path = this.pagesPath(wiki);
        const existing = await this.readJson<FandomPagesFile>(path);
        const pages: Record<string, CachedFandomPage> = existing?.pages ?? {};
        let cached = 0;
        for (let i = 0; i < titles.length; i++) {
            if (opts.signal?.aborted) break;
            const title = titles[i]!;
            try {
                const extract = await mediawikiExtract(host, title);
                if (extract && extract.extract) {
                    const page: CachedFandomPage = {
                        text: extract.extract,
                        sourceUrl: fandomPageSourceUrl(wiki, extract.title),
                        license: FANDOM_DEFAULT_LICENSE,
                        retrievedAt: Date.now()
                    };
                    pages[normalizeKey(extract.title)] = page;
                    const aliasKey = normalizeKey(title);
                    if (aliasKey) pages[aliasKey] = page;
                    cached++;
                }
            } catch {
                // Skip failed extracts — best-effort.
            }
            opts.onProgress?.(i + 1, titles.length);
        }
        if (cached > 0) {
            try {
                const file: FandomPagesFile = { schemaVersion: SCHEMA_VERSION, wiki, pages };
                await this.vault.adapter.write(path, JSON.stringify(file));
            } catch {
                // Best-effort — a failed flush just means a re-sync later.
            }
        }
        return { cached, total: titles.length };
    }

    /** Load the per-wiki pages record (title → page), or undefined. */
    private async loadPages(wiki: string): Promise<Record<string, CachedFandomPage> | undefined> {
        return (await this.readJson<FandomPagesFile>(this.pagesPath(wiki)))?.pages;
    }

    /** Load the per-wiki images record (key → meta), or undefined. */
    private async loadImages(wiki: string): Promise<Record<string, CachedFandomImage> | undefined> {
        return (await this.readJson<FandomImagesFile>(this.imagesPath(wiki)))?.images;
    }

    /** Read + parse a JSON sidecar; returns undefined if missing or unparseable. */
    private async readJson<T>(path: string): Promise<T | undefined> {
        try {
            const exists = await this.vault.adapter.exists(path);
            if (!exists) return undefined;
            const raw = await this.vault.adapter.read(path);
            return JSON.parse(raw) as T;
        } catch {
            return undefined;
        }
    }
}

/** Filesystem-safe key for an image (page title or filename → ASCII-ish slug). */
function sanitizeImageKey(key: string): string {
    // Strip a leading "File:" namespace, drop extension, collapse anything that
    // isn't alphanumeric/dash/underscore. Keeps the cache directory flat + safe.
    const stripped = key.replace(/^File:/i, '').replace(/\.[a-z0-9]+$/i, '');
    const slug = stripped
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return slug.length > 0 ? slug : 'image';
}
