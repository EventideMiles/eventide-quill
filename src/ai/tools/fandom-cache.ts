/**
 * Local cache for Fandom wiki content — the persistence layer for the
 * `fandom_*` tools' cache-first lookup (PR 2, `.planning/pr-local-fandom-cache.md`).
 *
 * Stages: write-through on live fetches (Stage 1, `putPage`/`putImage`),
 * cache-first reads (Stage 2, `getPage`/`getImage`), and the privacy posture
 * where a populated cache answers even with `lorebookNetworkTools` off (Stage 3,
 * gated via `hasWiki`/`hasAnyEntries` + the `fandomReachability` helper in
 * `index.ts`). This file also backs the local search index used when the
 * network is off (Stage 6, `search`) and the per-wiki management UI
 * (Stage 4, `getWikiStats`/`clearWiki`).
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

/** Aggregate stats for one wiki's cache — drives the per-wiki management row in settings (Stage 4). */
export interface WikiStats {
    /** Number of cached page entries (alias keys collapse to one). */
    pages: number;
    /** Number of cached image entries. */
    images: number;
    /** Total bytes on disk (pages.json + images.json + img/ binaries). */
    sizeBytes: number;
    /** Most recent `retrievedAt` across cached pages, in epoch ms (0 if none). */
    lastSynced: number;
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

/** One row of the in-memory search index (Stage 6). Title is the normalized cache key (already lowercase); body is the first ~500 chars, lowercased for case-insensitive matching. */
interface SearchEntry {
    titleLower: string;
    bodyLower: string;
    page: CachedFandomPage;
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

/**
 * Format an epoch-ms timestamp as a local `YYYY-MM-DD` date string. Uses the
 * Date's LOCAL getters (getFullYear/getMonth/getDate), NOT `toISOString()`
 * (which renders UTC) — so a writer west of UTC doesn't see "tomorrow's" date
 * on a cache they just synced this afternoon. Shared by the settings "Last
 * synced" row and the `[cached YYYY-MM-DD]` markers in the fandom tools.
 */
export function formatLocalDate(ms: number): string {
    const d = new Date(ms);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
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
    /** Wikis known to have ≥1 cached entry. Populated eagerly by {@link init} (stat-only), maintained on every mutation. Drives the cache-only registration gate (Stage 3) — kept synchronous so `createToolRegistry` doesn't need to await. */
    private readonly wikisWithEntries = new Set<string>();
    /** Per-wiki tokenized search index (Stage 6). Built lazily on first {@link search} call for a wiki, invalidated on any mutation of that wiki's pages. */
    private readonly searchIndices = new Map<string, SearchEntry[]>();

    private constructor(vault: Vault, dataDir: string) {
        this.vault = vault;
        this.cacheDir = normalizePath(`${dataDir}/${CACHE_FOLDER}`);
    }

    /** Construct a cache rooted at `<dataDir>/fandom-cache/`. No I/O. */
    static create(vault: Vault, dataDir: string): FandomCache {
        return new FandomCache(vault, dataDir);
    }

    /**
     * One-time load: scan the cache directory and populate {@link wikisWithEntries}.
     * Stat-only (no JSON parse) so a giant-wiki vault doesn't pay parse cost at
     * Obsidian startup — the search index is built lazily on first use. Best-effort;
     * a failure leaves the set empty (cache-only registration stays off until a
     * live fetch populates the cache and flips the set via {@link putPage}).
     * Call once from plugin onload right after {@link create}.
     */
    async init(): Promise<void> {
        try {
            if (!(await this.vault.adapter.exists(this.cacheDir))) return;
            const listing = await this.vault.adapter.list(this.cacheDir);
            for (const folder of listing.folders) {
                const wiki = this.basename(folder);
                if (wiki && (await this.wikiHasContent(wiki))) {
                    this.wikisWithEntries.add(wiki);
                }
            }
        } catch {
            // Best-effort — empty set means cache-only registration stays off.
        }
    }

    /** Synchronous presence checks for the registration gate (Stage 3). */
    hasWiki(wiki: string): boolean {
        return this.wikisWithEntries.has(wiki);
    }

    /** True if ANY wiki has cached content. */
    hasAnyEntries(): boolean {
        return this.wikisWithEntries.size > 0;
    }

    /**
     * Drop all cached content for `wiki` (pages, images, binaries) and remove it
     * from the presence set. Idempotent — a no-op if the wiki has no cache dir.
     * Best-effort; never throws.
     */
    async clearWiki(wiki: string): Promise<void> {
        try {
            const dir = this.wikiDir(wiki);
            if (await this.vault.adapter.exists(dir)) {
                await this.vault.adapter.rmdir(dir, true);
            }
        } catch {
            // Best-effort.
        }
        this.wikisWithEntries.delete(wiki);
        this.searchIndices.delete(wiki);
    }

    /**
     * Aggregate stats for `wiki` — counts + on-disk size + freshest retrievedAt.
     * Renders into the per-wiki management row in settings (Stage 4). All-zero
     * for a wiki with no cache dir. Reads + parses the sidecars once per call
     * (settings-render-time only, so acceptable).
     */
    async getWikiStats(wiki: string): Promise<WikiStats> {
        const pages = await this.loadPages(wiki);
        const images = await this.loadImages(wiki);
        const pageList = pages ? Object.values(pages) : [];
        let lastSynced = 0;
        for (const p of pageList) {
            if (p.retrievedAt > lastSynced) lastSynced = p.retrievedAt;
        }
        return {
            pages: pageList.length,
            images: images ? Object.keys(images).length : 0,
            sizeBytes: await this.computeWikiSize(wiki),
            lastSynced
        };
    }

    /**
     * Local search over cached pages for `wiki` (Stage 6). Used by `fandom_lookup`
     * so a vague/repeat query can cache-hit (and answer under cache-only mode)
     * instead of always going live. Tokenized AND-match over title + first ~500
     * body chars; ranked title-exact → title-prefix → all-tokens-in-title →
     * body-match (earliest position wins). Top 8 results. Empty for a wiki with
     * no indexable pages.
     */
    async search(wiki: string, query: string): Promise<CachedFandomPage[]> {
        const q = query.trim().toLowerCase();
        if (!q) return [];
        const index = await this.getSearchIndex(wiki);
        if (index.length === 0) return [];
        const tokens = q.split(/\s+/);
        type Scored = { page: CachedFandomPage; score: number; tieBreak: number };
        const scored: Scored[] = [];
        for (const entry of index) {
            const title = entry.titleLower;
            const hay = title + ' ' + entry.bodyLower;
            // Every token must appear somewhere in title or body.
            if (!tokens.every((t) => hay.includes(t))) continue;
            let score: number;
            if (title === q) {
                score = 1000;
            } else if (title.startsWith(q)) {
                score = 800;
            } else if (tokens.every((t) => title.includes(t))) {
                score = 600;
            } else {
                // Body match — rank by earliest position of the full phrase, else
                // earliest first-token position.
                const pos = entry.bodyLower.indexOf(q);
                score =
                    pos >= 0
                        ? 400 - Math.min(pos, 300)
                        : 100 - Math.min(this.earliestToken(entry.bodyLower, tokens), 100);
            }
            scored.push({ page: entry.page, score, tieBreak: title.length });
        }
        scored.sort((a, b) => b.score - a.score || a.tieBreak - b.tieBreak);
        return scored.slice(0, 8).map((s) => s.page);
    }

    /** Build (or return cached) tokenized index for `wiki`. Empty + cached if the wiki has no pages. */
    private async getSearchIndex(wiki: string): Promise<SearchEntry[]> {
        const cached = this.searchIndices.get(wiki);
        if (cached) return cached;
        const pages = await this.loadPages(wiki);
        const entries: SearchEntry[] = [];
        if (pages) {
            for (const [key, page] of Object.entries(pages)) {
                entries.push({
                    titleLower: key,
                    bodyLower: page.text.slice(0, 500).toLowerCase(),
                    page
                });
            }
        }
        this.searchIndices.set(wiki, entries);
        return entries;
    }

    /** Index of the earliest-occurring token in `body`, or `body.length` if none. */
    private earliestToken(body: string, tokens: string[]): number {
        let earliest = body.length;
        for (const t of tokens) {
            const pos = body.indexOf(t);
            if (pos >= 0 && pos < earliest) earliest = pos;
        }
        return earliest;
    }

    /** Stat-only presence check: a populated sidecar is always >80 bytes (one entry adds ~200+; the bare empty wrapper is ~50). Avoids parsing large files at load. */
    private async wikiHasContent(wiki: string): Promise<boolean> {
        return (await this.fileHasEntries(this.pagesPath(wiki))) || (await this.fileHasEntries(this.imagesPath(wiki)));
    }

    private async fileHasEntries(path: string): Promise<boolean> {
        try {
            if (!(await this.vault.adapter.exists(path))) return false;
            const stat = await this.vault.adapter.stat(path);
            return !!stat && stat.size > 80;
        } catch {
            return false;
        }
    }

    /** Last path segment of a normalized path (the wiki name from a listed folder). */
    private basename(path: string): string {
        const parts = normalizePath(path).split('/');
        return parts[parts.length - 1] ?? '';
    }

    /** Sum file sizes under the wiki dir (pages.json + images.json + img/ binaries). The cache nests only one level, so a two-pass walk covers it. */
    private async computeWikiSize(wiki: string): Promise<number> {
        try {
            const dir = this.wikiDir(wiki);
            if (!(await this.vault.adapter.exists(dir))) return 0;
            let total = 0;
            const top = await this.vault.adapter.list(dir);
            for (const f of top.files) {
                const stat = await this.vault.adapter.stat(f);
                if (stat) total += stat.size;
            }
            for (const folder of top.folders) {
                const sub = await this.vault.adapter.list(folder);
                for (const f of sub.files) {
                    const stat = await this.vault.adapter.stat(f);
                    if (stat) total += stat.size;
                }
            }
            return total;
        } catch {
            return 0;
        }
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
            this.wikisWithEntries.add(wiki);
            this.searchIndices.delete(wiki);
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
            this.wikisWithEntries.add(wiki);
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
                this.wikisWithEntries.add(wiki);
                this.searchIndices.delete(wiki);
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

/**
 * Fandom tool reachability — the single source of truth both
 * `createToolRegistry` (registration) and `buildNetworkToolsMessage` (prompt
 * advertisement) call so the two-place gating mirror can't drift (Stage 3).
 *
 * - `'live'`        — allowlist active AND network tools on. Tools register;
 *                     misses fall through to a live fetch + write-through.
 * - `'cache-only'`  — allowlist active, network tools off, but the cache holds
 *                     entries for an allowlisted wiki. Tools STILL register;
 *                     hits answer from cache, misses return "not cached" (no
 *                     live call). The maximal privacy posture: consent was at
 *                     sync time, so the network toggle no longer hides cached data.
 * - `'none'`        — allowlist empty (and allow-all off), or network off with
 *                     no cached entries / cache disabled. Tools do NOT register.
 *
 * The allowlist still gates per-call (`validateWiki` in fandom-lookup.ts is
 * unchanged) — a cached wiki removed from the allowlist goes dormant until
 * re-listed. `cacheEnabled` (the master `lorebookFandomCacheEnabled` toggle)
 * folds in here: when off, the cache subsystem is inert, so cache-only never
 * activates even if sidecar files exist on disk.
 */
export type FandomReachability = 'live' | 'cache-only' | 'none';

/**
 * Structural subset of the plugin the reachability check reads. Declared locally
 * (not imported from main.ts) to avoid a circular import; `EventideQuillPlugin`
 * satisfies this structurally, so callers just pass `plugin`.
 */
interface FandomReachabilityHost {
    settings: {
        lorebookNetworkTools: boolean;
        lorebookFandomWikis: string[];
        lorebookFandomAllowAllWikis: boolean;
        lorebookFandomCacheEnabled: boolean;
    };
    fandomCache: FandomCache | null;
}

export function fandomReachability(plugin: FandomReachabilityHost): FandomReachability {
    const { lorebookNetworkTools, lorebookFandomWikis, lorebookFandomAllowAllWikis, lorebookFandomCacheEnabled } =
        plugin.settings;
    const allowlistActive = lorebookFandomAllowAllWikis || lorebookFandomWikis.length > 0;
    if (!allowlistActive) return 'none';
    if (lorebookNetworkTools) return 'live';
    // Network off — only cache-only if the cache subsystem is on AND holds an
    // entry for a currently-allowlisted wiki (any entry when allow-all is on).
    if (!lorebookFandomCacheEnabled || !plugin.fandomCache) return 'none';
    const cached = lorebookFandomAllowAllWikis
        ? plugin.fandomCache.hasAnyEntries()
        : lorebookFandomWikis.some((w) => plugin.fandomCache!.hasWiki(w));
    return cached ? 'cache-only' : 'none';
}
