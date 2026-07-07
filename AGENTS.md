# Eventide Quill

A feedback-first, novelist-focused writing assistant for Obsidian.
MIT license. Built from scratch. Mobile-ready. Local-model first.

> **Local overrides:** If `.local/AGENTS.md` exists (gitignored), read it at the start of each session and apply its guidance on top of this file. It holds per-developer, environment-specific rules that are never committed. See `AGENTS.local.example.md` for a template.

## Project overview

- Target: Obsidian Community Plugin (TypeScript → bundled JavaScript via esbuild).
- Entry point: `src/main.ts` compiled to `main.js` and loaded by Obsidian.
- Plugin id: `eventide-quill` (`manifest.json`); `minAppVersion` 1.7.2; `isDesktopOnly: false` (mobile-supported).
- Required release artifacts: `main.js`, `manifest.json`, and `styles.css`. The `styles.css` is built from `styles/main.scss` (and its `_*.scss` partials) by `sass` — see "Styling" below.

## Environment & tooling

- **Package manager: npm**
- **Bundler: esbuild** (configured in `esbuild.config.mjs`)
- **Styles: Sass / SCSS** — source under `styles/` (entry `styles/main.scss` + `_*.scss` partials), compiled to `styles.css` by the `sass` package. See "Styling" below.
- **Formatter: Prettier** (`prettier.config.mjs`: `singleQuote`, `tabWidth: 4`, `printWidth: 120`, `trailingComma: 'none'`, `semi: true`)
- **Linting: ESLint** with `eslint-plugin-obsidianmd` (configured in `eslint.config.mts`)
- **Style linting: stylelint** + `stylelint-scss` on `styles/**/*.scss` (configured in `.stylelintrc.json`). Lenient, color-focused: enforces `color-no-hex` (use Obsidian CSS vars / `rgba(var(--color-*-rgb), …)` instead) and a few safety nets. `scss/comment-no-empty` is deliberately disabled — the bare `//` dividers inside block comments are intentional.
- **Duplication: jscpd v5** (Rust engine; dev-only, never bundled into `main.js`) — copy-paste detector gated in CI via `npm run lint:dup`. Configured in `.jscpd.json`: `minLines` 6, `minTokens` 70, `mode: weak` (skip comment tokens so JSDoc doesn't inflate the count), `threshold: 5` over duplicated **lines** (baseline 2.49%; **ratchet down** as duplication is extracted — the number should only ever decrease). `src/ui/slash-command-suggest.ts` is excluded via `ignore` as a known transitional mirror of `FileMentionSuggest`; a shared `SuggestBase` extraction is tracked in `.planning/road-to-1.0.1.md` PR 6 — remove the ignore entry when the base lands. The v5 Rust engine dropped v4's inline `jscpd:ignore-file` directive, so file-level exclusion lives in `.jscpd.json`, not at the code site.
- **Types: `obsidian`** type definitions (configured in `tsconfig.json`)
- **Editor config: `.editorconfig`** (also declares `quote_type = single`)

Scripts (see `package.json`):

| Script | What it does |
|--------|--------------|
| `npm run dev` | esbuild watch mode (`__DEV__ = true`, sourcemaps inline) |
| `npm run build` | **Four stages:** `sass` → `prettier --write` → `tsc -noEmit -skipLibCheck` (typecheck, no emit) → esbuild dev build (`__DEV__ = true`, sourcemaps inline, no minify) |
| `npm run build:release` | Same four stages as `build` but with esbuild production mode (`__DEV__ = false`, no sourcemaps, minified). Used by release CI. |
| `npm run lint` | `eslint .` then `stylelint 'styles/**/*.scss'` |
| `npm run lint:styles` | `stylelint 'styles/**/*.scss'` (SCSS only) |
| `npm run lint:fix` | `eslint . --fix` then `prettier --write 'src/**/*.ts'` then `stylelint --fix 'styles/**/*.scss'` |
| `npm run lint:dup` | `jscpd -c .jscpd.json -r threshold` — copy-paste duplication gate; exits non-zero when duplication exceeds the `.jscpd.json` threshold. Ratchet the threshold down as duplication is extracted. |
| `npm run lint:dup:report` | `jscpd -c .jscpd.json -r console,html -o jscpd-report` — local detail: console clone list + browsable HTML report at `jscpd-report/jscpd-report.html` (gitignored). |
| `npm run prettier:check` | `prettier --check 'src/**/*.ts'` |
| `npm run prettier:fix` | `prettier --write 'src/**/*.ts'` |
| `npm run sass` | `sass styles/main.scss styles.css` (one-shot build of styles.css from SCSS sources) |
| `npm run sass:watch` | `sass --watch styles/main.scss styles.css` (rebuild on SCSS change during dev) |
| `npm test` | `vitest run` — runs the test suite once and exits non-zero on failure. Used by CI. |
| `npm run test:watch` | `vitest` — watch mode, re-runs on file change during development. |
| `npm run test:coverage` | `vitest run --coverage` — test suite with V8 coverage report. |
| `npm run version` | `node version-bump.mjs && git add manifest.json versions.json` (run via `npm version`) |
| `npm run set-version -- <v>` | Chore: rewrite the version string everywhere it appears (release files + embedded copies like the MediaWiki User-Agent). Adds a new `versions.json` key without dropping history. Does **not** tag/commit/push. Supports `--dry-run`. |

There is **no standalone `typecheck` script** — `tsc` runs inside `build`. The test suite lives under `tests/` (see "Testing" below).

## Verification

The test suite covers the deterministic core (text analysis, linter rules, readability formulas, change-set logic, provider resolution, HTTP retry parsing). Verify changes by:

1. `npm run build` (sass + Prettier + `tsc` + esbuild), and
2. `npm test` (Vitest — pure-logic unit tests; runs in ~200ms), and
3. `npm run lint`, and
4. `npm run lint:dup` (jscpd duplication gate — fails if the duplicated-lines % exceeds the `.jscpd.json` threshold), and
5. Manual smoke test in Obsidian (especially on mobile) for UI or provider changes.
6. For release builds, also run `npm run build:release` to verify minification and `__DEV__` tree-shaking work correctly.

CI (`.github/workflows/lint.yml`) runs `build` + `test` + `lint` + `lint:dup` on every push and PR across Node 20/22/24. CI for releases (`.github/workflows/release.yml`) runs `build:release` instead.

## Testing

Tests run on **Vitest** (native ESM, esbuild-based transform matching the project's bundler). The suite targets the deterministic core — pure-logic modules with no Obsidian coupling — so most tests need zero mocking.

### Layout

- Tests live under `tests/` at the repo root (NOT `src/__tests__/`), so the jscpd duplication gate (which scans `src/` only) keeps its baseline pristine.
- `tests/**/*.ts` is included in `tsconfig.json`, so `tsc -noEmit` type-checks tests alongside source.
- `__mocks__/obsidian.ts` at the repo root is a minimal stub of the `obsidian` module (no-op `Notice`, `requestUrl`, `normalizePath` with the real implementation, class shells for `TFile`/`Vault`/`App`/`Component`/`Modal`). Vitest auto-resolves it for any module with a runtime `import ... from 'obsidian'`. Type-only imports (`import type`) are erased by esbuild and never hit the stub.
- `vitest.config.ts` defines `__DEV__: true` (matching dev builds), uses `environment: 'node'`, and includes `tests/**/*.test.ts`.

### What's covered vs. deferred

**Covered:** `src/utils/text-analysis`, `src/core/linter/rules`, `src/core/dashboard/readability`, `src/core/change-set`, `src/ai/provider` (role/capability resolution), `src/ai/tools/http-retry` (429 / Retry-After parsing), `src/core/linter/linter` (orchestrator + enableX toggles), `src/core/dashboard/metrics` (word/sentence counts), `src/ai/streaming` (SSE/NDJSON parsing, thought extraction), `src/utils/tokens`, `src/utils/directives`, `src/core/dashboard/lorebook-scanner` (pure subset: type/alias parsing, gallery stripping), `src/ai/conversation-store` (sidecar persistence + LRU), `src/ai/feedback-queue` (sidecar persistence + running→queued restore). Most are pure-logic — zero mocks; the two sidecar stores use an in-memory `Vault` adapter stub. Additional coverage: `src/core/context-engine/voice-analyzer` (POV/tense/dialogue detection), `src/core/context-engine/entity-extractor` (character/location/plot-thread extraction), `src/ai/provider-registry` (parseProviderKey, generateModelId), `src/ai/transport` (HttpError, throwOnNonOk, error formatting), `src/ai/tools/tool` (ToolRegistry, executeToolCall), `src/ai/embedding-cache` (hashString), `src/ai/compaction` (compactConversation with mock provider), `src/ai/feedback` (personas, buildFeedbackMessages), `src/ai/tools/fandom-cache` (URL/date helpers, fandomReachability), `src/types` (NARRATIVE_VOICE_PRESETS), `src/ai/modes` (AI_MODE_CONFIGS), `src/core/dashboard/presets` (MANUSCRIPT_PRESETS), `src/core/dashboard/manuscript-file` (manuscriptDataPath), `src/core/linter/fixes` (FIXABLE_RULES coverage).

**Deferred (post-1.0.1):** UI tests (`src/ui/*`, `main.ts`, `settings.ts`), CodeMirror decoration tests, provider integration tests (`openai-provider.ts` / `ollama-provider.ts` end-to-end), and the heavy AI pipelines (`co-writer.ts`, `runFeedbackJob`). These need jsdom + lifecycle simulation or real HTTP fixtures — a separate, larger effort.

### Conventions

- Test files mirror the source path: `src/utils/text-analysis.ts` → `tests/utils/text-analysis.test.ts`.
- Use `import { describe, it, expect } from 'vitest'` (explicit imports — `globals: false` in the vitest config).
- Prefer table-style tests for multi-case functions (e.g., `roleSatisfies` over all role/capability pairs).
- For modules that import from `'obsidian'` at runtime, the `__mocks__/obsidian.ts` stub resolves automatically. Override per-test with `vi.mock('obsidian', ...)` when you need controlled `requestUrl` or `Vault.adapter` behavior.

## `__DEV__` compile-time constant

`__DEV__` is a boolean injected at build time via esbuild's `define`:
- **Dev builds** (`npm run build`, `npm run dev`): `__DEV__ = true`
- **Release builds** (`npm run build:release`): `__DEV__ = false`

Use it to gate debug-only code (console logging, dev-only settings, etc.). In release builds esbuild tree-shakes the dead branches, eliminating the code entirely.

The runtime complement is the `enableDebugLogging` setting (`src/settings.ts`, default `false`). For debug logging that should also be toggleable by writers in dev builds, use the idiom `__DEV__ && plugin.settings.enableDebugLogging && console.log(...)`. `__DEV__` strips the call entirely from release builds; `enableDebugLogging` lets writers opt in to diagnostic output in dev builds without code changes.

To add a new global that ESLint knows about, edit `eslint.config.mts` globals and `src/global.d.ts` for TypeScript.

## Styling

Styles are authored in SCSS and compiled to `styles.css` by the `sass` package. The hand-maintained artifact is `styles/main.scss`; **never edit `styles.css` directly** — it is a gitignored build output (same release-artifact pattern as `main.js`).

### File layout

```
styles/
  main.scss              ← entry, contains only `@use` statements in cascade order
  _base.scss             ← SCSS design tokens ($space-*, $radius-*, $transition-*)
  _sidebar.scss          ← sidebar shell (tabs, subtabs, content containers)
  _linter.scss           ← linter panel + tooltip + details view + Fix-with-AI modal
  _context-panel.scss    ← Context tab
  _review-panel.scss     ← Review panel (editorial feedback + critical analysis)
  _feedback-queue.scss   ← Queue sub-tab (job cards, status dots, badge, queue-mode toggle)
  _cowriter-panel.scss   ← Co-writer panel
  _dashboard-panel.scss  ← Dashboard panel (metrics, flow score, readability, chapters)
  _lorebook-panel.scss   ← Lorebook panel (entries, coverage, relationships)
  _change-review.scss    ← shared change-review cards + inline diff decorations
  _lore-entry-review.scss ← lore-entry review cards (propose/approve/reject, image thumbnails)
  _option-picker.scss    ← shared BEM picker block (personas, modes)
  _form.scss             ← shared BEM form block (sections, labels, textareas, submits)
  _chat-shared.scss      ← shared BEM chat-panel block (bubbles, bottom area, indicator)
  _file-mention.scss     ← @-mention suggest dropdown (chat input)
  _slash-command.scss    ← slash-command picker dropdown (co-writer chat input)
  _active-document.scss  ← active document header (shared BEM block, rendered by document-header.ts)
  _modals.scss           ← shared modal chrome (input/save/confirm modals)
  _settings.scss         ← settings UI (tabs, provider cards, narrative rules, slash-command editor)
```

`main.scss` `@use`s the partials in cascade order: shared chrome first (`base`, `option-picker`, `form`, `chat-shared`), then panel-specific blocks, then modals + settings last.

### Naming convention: BEM

All classes follow BEM with a `quill-` vendor prefix:

- **Block:** `quill-{name}` (e.g., `quill-feedback-panel`, `quill-option-picker`, `quill-chat-panel`)
- **Element:** `quill-{block}__{element}` (e.g., `quill-feedback-panel__header`, `quill-chat-panel__bubble`)
- **Modifier:** `quill-{block}__{element}--{state}` (e.g., `quill-chat-panel__bubble--user`, `quill-option-picker__option--active`)
- **Pseudo-classes** (`:hover`, `:focus`, `:active`) are NOT modifiers — keep them as native CSS.

When adding new classes, pick the most specific existing block they belong to. If they're shared across panels, add a new shared block file under `styles/` rather than duplicating under panel prefixes.

### SCSS variables vs CSS variables

- **SCSS variables** (`$space-md`, `$radius-sm`, `$transition-fast`) — defined in `_base.scss`. Compile-time substitutions for static design tokens. Use these for spacing/radii/transitions that don't change per theme.
- **CSS variables** (`var(--text-muted)`, `var(--background-modifier-border)`) — Obsidian theme tokens. Resolved at runtime, change per theme. Use these for all colors and theme-aware values.

Both coexist cleanly. SCSS doesn't touch `var(--...)` — it passes through to the output CSS.

### `@use` namespaces

Partials that consume design tokens must `@use 'base' as *;` (the `as *` brings tokens into local scope without a prefix). Without `as *`, you'd have to write `base.$space-md`, which is verbose for design tokens used throughout.

## Architecture principles

1. **Deterministic first, AI second.** Prose linter, character extraction, and metrics run locally without AI cost.
2. **Async by default.** No operation blocks the editor.
3. **Pluggable providers.** Ollama and OpenAI-compatible are both first-class. LM Studio (OpenAI-compatible) is the primary local test target.
4. **Mobile as a first-class target.** Test on phone before shipping desktop.
5. **Capability-based model roles.** Models declare a `ModelRole` (`chat`/`embed`/`both`/`chat-image`/`image`); callers request a `ModelCapability` and `roleSatisfies()` resolves. No model-name sniffing — a non-vision model never receives pixels.
6. **Tools on by default for discoverability.** Internal vault tools, network research tools (`fetch_url`, `fandom_*`, `wikipedia_*`), and image tools (`fetch_image_url`) are enabled by default so writers don't have to hunt for them; each can be turned off in settings to restrict outbound requests. Fandom additionally requires a non-empty allowlist (`lorebookFandomWikis`) — or the `lorebookFandomAllowAllWikis` "danger" toggle to allow any wiki.

## Source layout

Several files are large and intentionally monolithic; match the surrounding pattern rather than refactoring on first touch.

```text
src/
  main.ts              # Plugin lifecycle + default-provider getters (~5.9k lines)
  settings.ts          # Settings schema + UI (single source of truth, ~3.5k lines)
  types.ts             # Shared TypeScript interfaces (NARRATIVE_VOICE_PRESETS)
  core/
    change-set.ts
    context-engine.ts     # barrel re-export — import from here
    context-engine/       # Manuscript context engine
      context-assembler.ts, context-cache.ts, entity-extractor.ts,
      voice-analyzer.ts, types.ts
    dashboard/            # Manuscript dashboard + lorebook
      index.ts (barrel), manuscript-file.ts, metrics.ts, readability.ts,
      presets.ts, types.ts, dale-chall-words.json (data asset),
      lorebook-scanner.ts (gallery-section image extraction + relationship computation), lorebook-types.ts (LORE_ENTRY_TYPES, LoreEntryImage, coverage, relationships)
    linter/               # Prose linter (Novelist Edition)
      apply-fix.ts, decorations.ts (CodeMirror decorations + debounced timers),
      fixes.ts, linter.ts, rules.ts, types.ts, word-lists.json (data asset)
  ai/                  # Provider architecture, streaming, prompts, tools, vision
    provider.ts (ModelRole, ModelCapability, roleSatisfies, resolveModel, ProviderError),
    provider-registry.ts (createProvider, getProvider, parseProviderKey, generateModelId),
    openai-provider.ts, ollama-provider.ts,
    streaming.ts, transport.ts (HttpError, StreamingUnavailableError, the one `window.fetch` exception),
    compaction.ts, embedding-cache.ts, conversation-store.ts (saved co-writer sessions sidecar),
    feedback.ts, feedback-queue.ts (async feedback queue — job model + runner + sidecar persistence; see "Async feedback queue"), feedback-archive.ts (shared report archive helper),
    linter-ai.ts, analysis.ts, batch-fix.ts,
    manuscript-analysis.ts, manuscript-compaction.ts,
    modes.ts, prompts.ts, transform.ts,
    vision.ts (resolveImageInjection — two-regime image routing),
    image-utils.ts (decode → downscale → JPEG base64),
    co-writer.ts (~4.8k lines, largest file in repo — discuss/coach/fulfill/lorebook-coach
                  modes, each with its own tool loop; NOT streamWithTools),
    subagent-session.ts (SubagentSession — isolated-context lorebook batch runner
                         spawned by the run_lorebook_batch tool; see "Subagents"),
    tools/                # Tool-calling layer (see "Tool-calling architecture")
      tool.ts (Tool, ToolRegistry, ToolResult, ToolContext, DuplicateToolError),
      tool-loop.ts (streamWithTools — generic tool-loop runner; first real caller is critical analysis),
      http-retry.ts (RateLimitError, parseRetryAfter, assertNotRateLimited, toolErrorMessage — 429/Retry-After handling for network tools),
      index.ts (registries + factory wiring + createToolRegistry gating),
      context-helpers.ts, lore-edit-helpers.ts,
      manuscript-mentions.ts, lore-siblings.ts, vault-lookup.ts, grep-notes.ts,
      measure-folder.ts, calculate-file-sizes.ts, edit-note.ts, insert-note.ts, append-to-note.ts, revise-edit.ts,
      run-lorebook-batch.ts, research.ts (subagent spawners → SubagentSession),
      propose-entry.ts, attach-lore-image.ts (lorebook coach + batch image attachment), fetch-url.ts, fetch-image-url.ts, get-lore-image.ts,
      fandom-lookup.ts, wikipedia-lookup.ts, mediawiki.ts (shared MediaWiki client),
      fandom-cache.ts (local Fandom cache sidecar — write-through + cache-first + bulk indexer + Stage 3 cache-answers-when-network-off (`fandomReachability`) + Stage 4 stats/clear + Stage 6 search index),
      refresh-dashboard.ts (dashboard recompute invoked by the co-writer `refresh_dashboard` tool)
  ui/                  # Views, modals, panels
    quill-sidebar.ts (~1.4k lines — tabs: linter/context/review/cowriter/dashboard/lorebook),
    co-writer-panel.ts (~2.5k lines), context-panel.ts, review-panel.ts,
    dashboard-panel.ts, lorebook-panel.ts, lore-entry-review.ts,
    feedback-queue-panel.ts (encapsulated Queue sub-tab renderer),
    chat-panel.ts, chat-context-files.ts, document-header.ts,
    change-card.ts, change-diff-extension.ts, token-indicator.ts,
    confirm-modal.ts, transform-modal.ts, fix-with-ai-modal.ts,
    filename-modal.ts, vault-file-suggest-modal.ts (vault markdown file + embedded-folder picker for context files), report-suggest-modal.ts (saved-report picker for follow-up discussion), file-mention-suggest.ts,
    session-list-modal.ts (saved-conversation switcher), slash-command-suggest.ts
  utils/               # Helpers, constants
    directives.ts, find-editor.ts, frontmatter.ts, text-analysis.ts,
    tokens.ts, vault-files.ts
```

## Tool-calling architecture

The co-writer can call tools mid-conversation via the provider's native tool-calling API (OpenAI/Ollama `tools` + `tool_calls`). Two execution paths exist — both are vision-aware:

- **`streamWithTools`** (`src/ai/tools/tool-loop.ts`) — a generic tool-loop runner: streams text/thought chunks to the consumer while executing tool calls internally. First real caller: **critical analysis** (`analysis.ts` → `getAnalysis` routes through it when a tool registry is supplied, so the Review tab's critical engine can verify findings against the vault). The co-writer modes still inline their own loops (mode-specific behavior); migrating them onto `streamWithTools` is a future DRY consolidation.
- **The co-writer's own loop** (`src/ai/co-writer.ts`) — discuss, coach, fulfill, and lorebook-coach modes each inline their own tool execution (`executeToolCall`) so they can render tool rounds in the chat UI and track token growth round-by-round. **This is the active path.**

Key contracts:

- `Tool` (`tools/tool.ts`) — `id`, `description`, `parameters` (JSON Schema), `maxResultTokens`, `requiresNetwork`, and `execute()` returning `Promise<string | ToolResult>`. `ToolResult` adds optional `images` (base64, for the vision layer).
- `ToolRegistry` — unique-by-id registry (duplicate ids throw `DuplicateToolError`); `toToolDefinitions()` serializes to the provider's `tools` field.
- `createToolRegistry(plugin, includeProposeEntry)` (`tools/index.ts`) — the single gating point. Returns `null` when `coWriterToolsEnabled` is off; otherwise registers the internal tools, adds `propose_entry` for the lorebook coach, and adds network/image tools when their toggles are on.

Tool tiers (gating):

| Tier | Tools | Gate setting |
|------|-------|--------------|
| Internal (default on) | `manuscript_mentions`, `lore_siblings`, `vault_lookup`, `grep_notes`, `measure_folder`, `calculate_file_sizes`, `edit_note`, `insert_note`, `append_to_note`, `revise_edit`, `get_lore_image`, `refresh_dashboard` | `coWriterToolsEnabled` (mode-aware: the lorebook coach drops `manuscript_mentions` / `grep_notes` / `refresh_dashboard` via `createInternalToolRegistry({ manuscript, grep, dashboard })` since its prompt never advertises them — ~464 token cut per coach request; the lore-batch subagent keeps the full set) |
| Lorebook coach only | `propose_entry` (surfaces a lore draft to the UI; accepts an optional `images` parameter when `loreEntryImageAttachments` is on) | `createLoreCoachToolRegistry` |
| Parent modes only | `run_lorebook_batch` (lore edits), `run_research` (vault Q&A) — each spawns a `SubagentSession`, see "Subagents" | `allowSubagents` (all parent modes: discuss/coach/lorebook; subagents pass `false` so they can't nest) |
| Network (default on) | `fetch_url`, `wikipedia_lookup` / `wikipedia_page` | `lorebookNetworkTools` |
| Fandom (cache-aware) | `fandom_lookup` / `fandom_page` | `lorebookNetworkTools` OR a populated local cache for an allowlisted wiki (Stage 3 `fandomReachability`); allowlist still gates per-call |
| Image (default on) | `fetch_image_url`, `fandom_image`, `wikipedia_image` | `lorebookImageTools` |
| Agent image attach (default on) | optional `images` parameter on `propose_entry`; `attach_lore_image` (lorebook coach + batch only) | `loreEntryImageAttachments` |

`fandom_image` (Fandom image lookup: lead image via `prop=pageimages`, gallery browsing via `prop=images` + `imageinfo`, with captions parsed from `<gallery>` wikitext) needs both `lorebookImageTools` and Fandom reachability (`lorebookNetworkTools` OR cache populated), plus the Fandom allowlist gate. `wikipedia_image` (Wikipedia lead portraits via the same `prop=pageimages`) follows the cross-toggle pattern — needs `lorebookNetworkTools` (no cache) and `lorebookImageTools`, no gallery-listing path (Wikipedia biographies don't follow Fandom's `<title>/Gallery` convention). All `wikipedia_*` tools build their host from the `lorebookWikipediaLang` setting (`${lang}.wikipedia.org`, default `en`); settings input is validated by `isValidWikipediaLang` (`src/ai/tools/wikipedia-lookup.ts`). Wikipedia is not cached (Fandom-only).

Fandom requires a non-empty allowlist (`lorebookFandomWikis`), or the `lorebookFandomAllowAllWikis` "danger" toggle to allow any wiki; an empty allowlist with that toggle off disables Fandom everywhere. **Stage 3 privacy posture:** a populated local cache answers even with `lorebookNetworkTools` off — consent is at sync time, so the network toggle no longer hides cached data. The single source of truth for both registration (`createToolRegistry`) and prompt advertisement (`buildNetworkToolsMessage`) is `fandomReachability(plugin)` (`src/ai/tools/fandom-cache.ts`) → `'live' | 'cache-only' | 'none'`; the two mirror sites must agree, so any gating change goes through that helper. Cache misses in cache-only mode return `"not cached"` and never fall through to a live call. `mediawiki.ts` is the shared MediaWiki client with per-host rate limiting. Convention: tool ids are `snake_case` verbs/nouns (`manuscript_mentions`, `fetch_url`).

## Subagents

A **subagent** is a self-contained batch worker that runs in its OWN fresh context, isolated from the parent conversation, so a long, context-heavy task (a full lorebook edit, a vault-wide search) doesn't pile into the user's chat and bloat it permanently. Two kinds share one runner:

- **`SubagentSession`** (`src/ai/subagent-session.ts`) — the generic runner, config-driven via `SubagentConfig` (`{ kind, goal, paths?, systemPrompt, brief, registry }`). Holds its own `messages` (fresh: the mode's system prompt + the task brief), its own `chatHistory` display buffer, a `status` (`running | succeeded | failed | interrupted`), and a `summary`. It runs the tool loop (stream → assemble tool calls → execute → compact) without disturbing the working parent loops. State is plain serializable data (no live editor/abort handles mixed in); `SubagentView` snapshots are persisted as part of a saved conversation and restored as dormant views (`running` → `interrupted`).
- **Two spawners, all parent-modes-only** (registered when `createToolRegistry(plugin, includeProposeEntry, allowSubagents=true)`; subagents pass `false`, so **subagents cannot spawn sub-subagents** — single-level nesting by construction):
  - `run_lorebook_batch { goal, paths }` (`src/ai/tools/run-lorebook-batch.ts`) — edits existing lore notes. Internal+editing tools; edits flow to the shared review queue.
  - `run_research { question }` (`src/ai/tools/research.ts`) — read-only vault Q&A; returns a cited findings report. Compares entries against external media (Wikipedia / Fandom / `fetch_url`) when `lorebookNetworkTools` is on.
  - Both use `createReadOnlyToolRegistry(plugin, includeExternal)` (read-only vault tools; research passes `includeExternal=true` to also get the network/image tools via the shared `registerExternalTools` helper).
- **Sizing lives where the context is.** `run_lorebook_batch` chunks the file list against the subagent's own fresh window (≈ the full context, since it starts from ~zero) — `CoWriterSession.runLorebookBatch` measures + chunks, one `SubagentSession` per chunk. Research runs as a single subagent (no file list). `measure_folder` / `calculate_file_sizes` still report against the PARENT's remaining context — for the parent's WHEN decision (subagent vs inline), not the subagent's internal sizing.
- **Edits are NOT isolated; the conversation IS.** A lore subagent's edits flow through `plugin.coWriterSession.loreEdits` (the shared review queue) via the tools' side effects — a subagent-produced diff reviews exactly like an inline one and **persists after the subagent closes** (removed only by the writer's approve/reject/new-chat). Research produces no edits (read-only). Every subagent's `messages`/`chatHistory` are per-subagent and ephemeral.
- **The parent is blocked while a subagent runs** — intentional and required for local models (one inference at a time). The subagent is the same model on the same provider, serialized as a synchronous tool call; it is NOT a concurrent process. Cancellation propagates via the parent's abort signal.

Landed: the runner + registry + both spawners, plus the drill-down UX — status cards (labeled by kind: Batch edit / Research; running/succeeded/failed) rendered **inline in the parent chat flow beneath the assistant turn that spawned them** (anchored via `CoWriterChatMessage.subagentIds`), and a "View/Watch" action that drills into the subagent's internal conversation (with a `← Back` that returns to the parent chat, preserved intact). Pending lore-edit and proposed-lore-image cards render inline the same way (anchored via each entry's `anchorMessageId`, latest-touch re-anchor on each edit). Navigation state lives on the session (`activeSubagentId`); the panel switches views via `setSubagents`/`setActiveSubagent` pushed on `onChatUpdate`. **Subagents are cleared on new-chat (`resetChat` → `clearSubagents`) and on every co-writer mode switch** (`setMode` → `onModeSwitch` → `plugin.clearCoWriterSubagents()`), since a subagent queued for one mode shouldn't follow the writer into another. `clearSubagents` also strips now-dangling `subagentIds` from chat messages. An in-flight subagent is aborted by the parent's `cancelGeneration` (already called by both reset paths) before the map is cleared. `CoWriterChatMessage` carries a stable per-session `id` (minted by `CoWriterSession.pushChatMessage`) so cards can anchor to a turn; use `pushChatMessage` rather than `chatHistory.push` directly.

## Conversation persistence

Saved / resumable co-writer conversations live as per-session JSON sidecars under `<pluginDataDir>/co-writer-sessions/<id>.json` plus a lightweight `index.json` (id, title, mode, timestamps, message count, size), managed by `src/ai/conversation-store.ts`. Mirrors the `manuscript-file.ts` / `embedding-cache.ts` sidecar convention (`vault.adapter` read/write, `normalizePath()` everywhere, mkdir-on-first-write, a serialized index write-lock, Notice-on-error) — NOT Obsidian's `loadData()`/`saveData()` (settings-only).

- **Snapshot triggers:** auto-snapshot before `resetChat` (new chat) and on `onunload` (best-effort, sync), plus an explicit "Save snapshot" action. When `coWriterAutoSavePerTurn` is on, `scheduleCoWriterAutoSave()` also fires a trailing-debounced (~1.5s) snapshot after each completed discuss/coach/lorebook turn via the `onDiscussFinished` hook (cancelled on new-chat so the outgoing conversation doesn't re-snapshot). `snapshotCoWriterSession()` skips empty chats; when a restored session's id is current it overwrites in place, else it creates a new sidecar. LRU-pruned to `coWriterSessionHistoryLimit` (default 25, configurable in settings).
- **What persists:** the `SerializedCoWriterState` blob (`CoWriterSession.snapshotState`) — `chatHistory` (with per-message `id` + `subagentIds`), the two API arrays (`discussCurrentMessages`, `loreCoachMessages`), review queues (`fulfillChanges`/`directChanges`/`loreEdits`/`proposedLoreImages` as `ChangeSet.toJSON`), `recentImages` (base64), `voiceProfile`, mode-session phase objects, and `subagents` as flat `SubagentView`s. Ephemeral runtime concerns (AbortController, callbacks, editor locks, write queues) are absent and rebind on restore via `wireCoWriterPanel()`.
- **Restore** (`CoWriterSession.restoreState`) overwrites the data fields WITHOUT invoking the reset/clear methods (which have CM-diff / tab-close / abort side effects), restarts the message-id counter above the highest restored id, stubs a "result unavailable" `tool` message after any assistant turn saved mid-tool-round (so the provider isn't fed a malformed history), and restores subagents as dormant views (`running` → `interrupted`, browseable read-only). `main.ts` then re-applies the stored mode and calls `syncCoWriterPanel()` to repaint.
- **Listing:** the "History" button (icon in the co-writer button row; also in the overflow menu under compact width) opens `SessionListModal` (Open / Delete).

`ChangeSet`/`ChangeSetJSON` round-trip via `ChangeSet.toJSON`/`ChangeSet.fromJSON` (the class is pure logic but has private fields + a `nextId` counter).

## Chat rewind

Right-click a user message in the co-writer chat → "Rewind to here" discards that message and everything after it (display + the model's API array), then pre-fills the input with the discarded text so the writer can edit and resend. Works in discuss / coach / lorebook modes.

- **Reliable API truncation via `quillAnchorId`:** every message pushed to `discussCurrentMessages` / `loreCoachMessages` is stamped with `quillAnchorId` = the originating `CoWriterChatMessage.id` (the user message's id; during a tool round, the assistant placeholder's id, so the whole round — assistant + tool results — shares one id). Both providers build their payload by picking known fields, so `quillAnchorId` is dropped on the wire (never sent to the model) but round-trips through the persistence sidecar. Rewind keeps API messages with no `quillAnchorId` (system prompt / context heads) + any whose anchor is a surviving display message; the rest drop. The model genuinely forgets.
- **Compaction guard:** `isRewindableMessage(id, mode)` returns true iff the id still appears as a `quillAnchorId` in the active mode's API array. Turns folded into a compaction summary lose their anchor id, so the menu item is disabled on them ("Part of the summarized context — can't rewind"). The options flow (`generateOptions`, display-only) never touches the API array, so its messages are non-rewindable too (correct: never in the model's memory).
- **Anchored-artifact cleanup:** a rewind drops subagents / pending lore edits / proposed lore images anchored to discarded messages (reuses the inline-card anchors), and re-derives `currentLoreDraft` from the last surviving message that carries one.
- **Phase re-evaluation:** coach / lorebook mode-session phase is restored authoritatively from the latest surviving assistant turn's `phaseSnapshot` field (`applyPhaseSnapshot` — stamped live at the end of each turn), with `reevaluateModePhase` as a lossy fallback for pre-snapshot sidecars / user-only histories. The heuristic still runs first to rebuild the surrounding session fields (response, summary, clarifyRound, scope, rounds); only the phase value is overridden from the snapshot. The snapshot eliminates the live/rewind phase-machine sync hazard: the live advance path is authoritative, the coach clarify-round replay and the lorebook draft-presence inference no longer need to track it exactly.

## Async feedback queue

The Review tab's "Queue instead of running" toggle submits any review (editorial / critical / manuscript) to run unattended instead of streaming interactively. Jobs run single-slot FIFO while Obsidian is open; completed reports auto-save to the vault as dated markdown.

- **Job model + sidecar persistence** (`src/ai/feedback-queue.ts`): `FeedbackJob` (id, engine, status, timestamps, `reportNotePath`) + a `SerializedContext` snapshot discriminated by `kind` (`editorial` | `critical` | `manuscript`). Sidecars live under `<pluginDataDir>/feedback-queue/<id>.json` + an `index.json`, mirroring `conversation-store.ts` exactly (schemaVersion, serialized index write-lock, `normalizePath`, mkdir-on-first-write, LRU prune to `feedbackQueueLimit` that protects active jobs, `running → queued` restore on load). Id namespace is `fq_`.
- **Content-canonical-in-vault:** the sidecar holds status + the snapshot + a `reportNotePath` pointer — NEVER the report markdown. The transient `FeedbackJob.reportMarkdown` is in-memory only (session cache) and stripped at persist time. The vault note is the single canonical home of the report; deleting it leaves a dangling pointer the UI detects ("report note moved or deleted — re-run to regenerate").
- **Runner dispatch** (`runFeedbackJob`): narrows on `snapshot.kind`. Editorial wraps `getFeedback`; critical wraps `getAnalysis` (with a read-only tool registry, routed through `streamWithTools`); manuscript calls the shared `prepareManuscriptAnalysisPayload` (the embed/compress/full compaction pipeline, also used by interactive `requestManuscriptAnalysis`) then `getManuscriptAnalysis`. The orchestrator (`executeFeedbackJob`) owns the `queued → running` transition + persists on every status change.
- **Scheduler:** single-slot FIFO *within the queue*. `plugin.feedbackQueueAbort` is a peer of `feedbackAbort` / `analysisAbort` (NOT a child of a global latch) — no cross-surface coordination (a local model serializes server-side, as today). A `registerInterval` tick (5s) is the resume path after a vault reopen + safety net; submit + FIFO chaining handle the steady state without waiting for the tick. Gated by `feedbackQueueAutoRun`.
- **Submit stays cheap; compaction runs at run time.** The manuscript snapshot captures the resolved chapters **with their text** at submit, so a manuscript job is fully isolated from live edits — the writer can keep writing or open other files between submit and run without affecting the report.
- **Archive (both surfaces):** `saveReportArchive` (`src/ai/feedback-archive.ts`) writes a dated `{YYYY-MM-DD_HH-MM-SS}_{label}.md` to `feedbackReportFolder` with `quill-report-*` frontmatter, collision-suffixed, gated on `autoSaveFeedbackReports`. Called from both the queue runner (`source: 'queue'`) and the interactive `requestFeedback` / `requestAnalysis` / `requestManuscriptAnalysis` completion handlers (`source: 'review'`) — so every report lands in the vault regardless of which surface produced it. Off = no vault writes AND no silent sidecar fallback (sovereignty principle).
- **UI:** a "Queue" sub-tab under Review (with a live count badge that updates without disturbing the Create textarea), rendered by an encapsulated `feedback-queue-panel.ts`. Cards show status (queued/running/succeeded/failed/cancelled) with cancel / delete / open-report / clear-completed actions. `feedbackQueueChanged()` on the sidebar refreshes the list (when the sub-tab is active) or just the badge.

## Vision & image support

Images (character art, maps, reference photos) reach a model through three entry points (tool result, co-writer paste, lorebook entry), all funneled through `resolveImageInjection(plugin, images, opts)` in `src/ai/vision.ts`. Two regimes, picked at runtime from the configured models:

- **Regime A (vision-native):** the default chat model has role `chat-image`. Images attach to the message as image content; the model sees pixels directly.
- **Regime B (vision-proxy):** the chat model is text-only and a default image model is configured. The image model makes one isolated call (image + proxy prompt → caption text) and the caption is spliced into the conversation. The chat model never switches and never receives pixels — so a small local text model can pair with a cloud vision model.

Regime B's proxy call is fully self-contained, so the image model may live on a **different provider** than chat (chosen via the Default image model picker, `aiDefaultImageProvider`). Regime A must stay on the chat provider — images ride on chat messages serialized by that provider.

**Co-writer paste** (landed): the writer can paste, drag-and-drop, or paperclip-attach images into the discuss / coach / lorebook chat input (direct / fulfill stay text-only). All three paths funnel through a shared `addImageFiles()` helper on `CoWriterPanel` that downscales via `downscaleToJpegBase64`, enforces a 4-image cap (`MAX_PENDING_IMAGES`), and rejects files above a 50MB raw-byte ceiling (`MAX_IMAGE_BYTES`) to guard against OOM before decode. A thumbnail preview row sits above the textarea; thumbnails also render under the user bubble for sent messages. The send path threads `images?` through `panel → sidebar → main → session.sendDiscussion/sendCoach/sendLoreCoach`, each of which routes through a `prepareImageMessage` wrapper that calls `prepareUserMessageWithImages(plugin, text, images, signal)` (in `src/ai/vision.ts`) to apply the regime: native → attach pixels to the user message; described → fold the proxy caption into the text; unsupported → append a placeholder note. Under Regime B (text-only chat + image model), the wrapper fires `onDescribingImages(true/false)` so the panel can show a "Describing…" button label during the proxy round-trip. The analogue of `injectImagesIntoMessages` (tool-output path) for the user's own message. Synchronous `isVisionConfigured(plugin)` and `getImageRegime(plugin)` helpers (in `src/ai/vision.ts`) let the panel warn via Notice at capture time when neither regime is available. The co-writer button row also collapses responsively below 420px width (ResizeObserver on the panel container, mirroring the sidebar's pattern): Add-context / Refresh fold into a hamburger overflow (native Obsidian `Menu`); Mode + Attach + Send stay visible. The session actions (New chat / Compact / Save snapshot / History) live in a pinned chat-header toolbar at the top of the conversation, always visible (they don't collapse). @-file mentions are resolved per-message and passed explicitly through the send (`mentionPaths`) as additional context, so every referenced file is included deterministically; they're also promoted to the persistent ±-context list (pills) for reuse.

**Lorebook entry images** (landed): the writer attaches reference images to a lore entry by placing `![[file.png]]` embeds under a recognized gallery section heading (defaults: Reference / Gallery / Forms / Appearance / Art; configurable via `loreEntryImageSectionHeaders`). The scanner (`extractEntryImages` in `lorebook-scanner.ts`) parses image embeds purely from `metadataCache.getFileCache()` (headings + embeds) — no file reads, fully synchronous. Subheadings within the gallery section become per-image labels (e.g., a multi-form character can carry separate "Default form" / "Alternate form" subheadings, each with its own embed). `LoreEntry.images` carries `{ filename, label, caption?, file? }`; the resolved `TFile` is `undefined` for missing attachments (the dashboard badge still counts them). The AI reaches these images on-demand via the `get_lore_image` tool (pass the entry name + optional label), which reads the bytes, downscales, and returns a `ToolResult` whose `images` flow through the standard tool-loop image routing. `lore_siblings` surfaces available labels per entry so the model knows what it can request. Per-entry cap is `loreEntryImageMaxPerEntry` (default 4).

**Agent image attachment** (landed, gated by `loreEntryImageAttachments` — default on): the lorebook coach and `run_lorebook_batch` subagents can attach images to entries via two paths that both flow through the existing review queue — nothing reaches the vault without the writer's approval. Path A: `propose_entry` accepts an optional `images` array (factory `createProposeEntryTool(allowImages)` — when the toggle is off, the parameter is removed from the JSON Schema entirely so the model cannot attempt it). Path B: `attach_lore_image` (separate tool, registered only when the toggle is on) attaches images to existing entries. Both tools stage proposals in the session; the review UI (`lore-entry-review.ts`) renders thumbnails and writes the bytes via `vault.createBinary(normalizePath(...))` plus embed insertion on the writer's approval.

**Reference-based attachment via `from_recent`** (landed): the model cannot pass `base64` bytes itself in most flows — bytes it has seen (from `fandom_image` / `wikipedia_image` / `fetch_image_url` / `get_lore_image`, or pasted by the writer) enter the conversation as image content blocks (Regime A) or proxy captions (Regime B), never as base64 strings. So both `propose_entry.images[]` and `attach_lore_image` accept an alternative `from_recent: { index }` parameter that references `CoWriterSession.recentImages` — a FIFO ring buffer (cap 12, most-recent first) of every image-bearing tool result and paste. `executeToolCall` (`src/ai/tools/tool.ts`) auto-pushes image-bearing results to the buffer; `prepareImageMessage` (`src/ai/co-writer.ts`) pushes pasted bytes before regime routing. Buffer is cleared on reset / resetChat.

**Gallery-section stripping at retrieval time only** (landed): `![[file.png]]` embed syntax in lore entries would waste tokens and prime hallucination if it leaked into auto-injected context. `stripGallerySections` in `lorebook-scanner.ts` replaces each gallery section with a one-line marker like `[Gallery section "Gallery": 3 images available — use get_lore_image with entry + label to view. Labels: Default form, Alternate form, Third form.]`. Applied at two **retrieval** sites only: the embedding chunker (`warmEmbeddingsForFolder`) and top-K injection (both `resolveEmbedPathsToMessages` paths). NOT applied to `vault_lookup` or active-file `proseForContext` — those are **editing** contexts where the model needs a verbatim view to construct anchors for `insert_note` / `edit_note`. Stripping at the editing view breaks anchors (the model quotes marker text that doesn't exist in the actual file); the marker preserves heading/label names so the model knows what's fetchable via `get_lore_image` without dumping useless syntax.

**Lorebook relationships** (landed): the Relationships subtab renders a list/matrix view of relationships between lore entries, sourced from body `[[wikilinks]]` parsed via `metadataCache.getCache(path).links` (previously an unused cache field) and resolved with `getFirstLinkpathDest`. `computeRelationships` in `lorebook-scanner.ts` builds a symmetric, deduped adjacency (`LoreRelationships` in `lorebook-types.ts`); direction collapses (A→B and B→A become one edge), self-links drop, and unresolved links surface as "dangling" (likely unwritten entries). This is a **narrow, additive reversal** of the foundation PR's "no wikilinks anywhere in the flow" principle: detection, context fuel, and coverage stay link-free and untouched — relationships are an opt-in, writer-authored layer (the same body-syntax-over-frontmatter choice the image gallery makes, for the same rename-safety reason). View-only; relationship data does NOT flow into AI context fuel. Plugin state `currentLoreRelationships` + `refreshLorebookRelationships()` (peer of the coverage methods); matrix hidden above 50 connected entries in favor of the list view.

Provider serialization:

- **OpenAI-compatible** (LM Studio, primary): `ChatMessage.images` → content array of `{type:'text'}` + `{type:'image_url', image_url:{url}}` parts.
- **Ollama:** sibling `images: [base64]` field on the message.

Images are base64 strings with no `data:` prefix, normalized to JPEG and downscaled (≤ `lorebookImageMaxDimension`, default 512) by `image-utils.ts` before they reach a provider, to protect local-model context budgets. The proxy prompt is customizable (`lorebookImageProxyPrompt`). When `lorebookImageTwoPassDescription` is on (default off) and a Regime-B batch has more than one image, the proxy runs two calls: a cheap count pass (label each visible character across the batch) then the descriptive pass with that list folded in as grounding — helps weak vision models keep per-character descriptions coherent across a group.

Default-provider resolution (`main.ts`): `getDefaultChatProvider()` / `getDefaultEmbedProvider()` / `getDefaultImageProvider()` resolve a composite `"providerId/modelId"` setting key to `{ provider, modelId }`.

## Coding conventions

### Naming

- **kebab-case.ts** for module files (e.g., `feedback-panel.ts`).
- **PascalCase** for interfaces, types, and type aliases (no `I` prefix).
- **camelCase** for functions, variables, parameters, and private fields.
- **camelCase** for local `const` declarations inside functions (e.g., `const doc = view.state.doc`).
- **UPPER_SNAKE_CASE** for module-level exported constants (e.g., `DEFAULT_SETTINGS` in `settings.ts`, `FEEDBACK_PERSONAS` in `ai/feedback.ts`, `NARRATIVE_VOICE_PRESETS` in `types.ts`).
- **camelCase** for settings object properties; the settings object itself is UPPER_SNAKE_CASE (e.g., `DEFAULT_SETTINGS` with properties like `linterMode`, `enableLongSentences`).
- **Boolean variables:** predicates (functions returning boolean) use `is-`/`has-`/`needs-` prefixes (e.g., `isBlank`, `hasContent`, `needsSpaceBetween`). Class state properties use descriptive names without prefixes (e.g., `chatLoading`, `userScrolledUp`).
- **Event handlers:** use `on<EventName>` pattern (e.g., `onChoose`, `onSubmit`, `onGenerate`).
- **Feature/rule-toggle settings booleans** use the `enable<RuleName>` prefix (e.g., `enableLongSentences`, `enablePassiveVoice`, `enableCoWriterThought`). This applies to *toggles*, not all settings booleans — behavioral flags like `lintOnSave`, `coWriterVaultContext`, `contextAutoScan`, `coWriterAppendNewline` are plain camelCase.

### Code style

- **Spaces, not tabs.** Indent size: 4.
- **Single quotes, 120-col width, no trailing commas, semicolons required** — all **enforced by Prettier** (`prettier.config.mjs`), run by `build`, `lint:fix`, `prettier:check`, and CI.
- Imports: roughly external → internal. `type` imports are mixed in with regular imports in practice (e.g., `main.ts`); Prettier does not reorder imports, so this is a loose convention, not a rule.
- **JSDoc coverage is partial.** Add `/** ... */` docstrings to public functions and methods where they aid readers; do not block a change solely to add JSDoc. Some modules (e.g., `core/linter/linter.ts`) currently have low coverage.

### Error handling

- Use typed error classes (extend `Error`) rather than throwing raw strings or generic `Error`. Five are exported:
    - `ProviderError` — `src/ai/provider.ts`
    - `HttpError` — `src/ai/transport.ts`
    - `StreamingUnavailableError` — `src/ai/transport.ts`
    - `DuplicateToolError` — `src/ai/tools/tool.ts`
    - `RateLimitError` — `src/ai/tools/http-retry.ts` (HTTP 429 from a network tool; carries the parsed `Retry-After` in seconds so the tool surfaces an actionable "wait N seconds" message to the model rather than a bare status code)
    - Two additional internal (non-exported) classes follow the same pattern: `InvalidJobIdError` (`src/ai/feedback-queue.ts`) and `InvalidSessionIdError` (`src/ai/conversation-store.ts`) — thrown by their respective sidecar persistence layers on malformed ids.
- Propagate errors with `throw` rather than returning error objects, unless the function signature explicitly supports `Result<T, E>` or similar patterns.

## Coding rules — enforced vs. convention

| Rule | Enforced by | Notes |
|------|-------------|-------|
| Spaces (4), UTF-8, LF, trailing newline | `.editorconfig` | Auto-applied by editors |
| Single quotes, 120-col, no trailing comma, semicolons | Prettier via `build` / `lint:fix` / `prettier:check` + CI | `prettier.config.mjs` |
| `strict`, `noImplicitReturns`, `noUncheckedIndexedAccess`, `forceConsistentCasingInFileNames`, `noFallthroughCasesInSwitch` | `tsconfig.json` | TypeScript compiler (runs inside `build`) |
| Obsidian-specific lint rules | `eslint.config.mts` + `eslint-plugin-obsidianmd` | |
| No hex color literals in SCSS (use theme-aware CSS vars) | stylelint `color-no-hex` via `lint` + CI | `.stylelintrc.json`; note stock stylelint can't distinguish numeric `rgba(255,0,0,…)` from `rgba(var(--…-rgb), …)`, so that stays review-enforced |
| Naming conventions (case, prefixes) | **Code review only** | No ESLint rules for naming |
| JSDoc coverage | **Code review only** | Aim for 100%, currently partial |
| Import ordering | **Not enforced** | Loose convention only |

The project does not use `eslint-config-prettier`. The obsidianmd ESLint rules and Prettier do not currently conflict stylistically; if you add an ESLint rule that overlaps with Prettier, add `eslint-config-prettier` at the same time.

## Branch strategy

- `main` is write-protected. Never commit directly to it.
- All work happens on feature branches pushed to GitHub, then merged via pull request.
- Branch naming:
    - `feature/<short-description>` — new features
    - `bugfix/<short-description>` — bug fixes
- Example: `feature/prose-linter`, `bugfix/settings-crash`
- Open a PR to `main` when the feature is ready. CodeRabbit will review automatically (`.github/coderabbit.yaml`, profile `chill`).
- Releases are cut by pushing a tag; `.github/workflows/release.yml` builds and creates a draft GitHub release attaching `main.js`, `manifest.json`, and `styles.css`.

## Security & compliance

- No `innerHTML`. Use `createEl()` + `textContent`. (Currently zero uses in `src/`.)
- No raw DOM listeners. Prefer Obsidian's `registerDomEvent()` on a `Component` — often a child `Component` stored on a local field (e.g. `this.renderEvents.registerDomEvent(...)` in `quill-sidebar.ts`, `co-writer-panel.ts`; `component.registerDomEvent(...)` in `context-panel.ts`). Raw `addEventListener` is currently used in 14 files (`settings.ts`, `core/linter/decorations.ts`, and `ui/` {`change-diff-extension`, `chat-context-files`, `chat-panel`, `confirm-modal`, `co-writer-panel`, `dashboard-panel`, `file-mention-suggest`, `filename-modal`, `fix-with-ai-modal`, `session-list-modal`, `slash-command-suggest`, `transform-modal`}.ts); the heaviest is `settings.ts` via the `.inputEl.addEventListener('blur', ...)` idiom for reading values out of `TextComponent`. Prefer `registerDomEvent()` for new code; if `addEventListener` is unavoidable, leave an inline comment.
- No raw timers. Prefer `Plugin#registerInterval` / `Component#registerInterval` for recurring ticks and the `Component` lifecycle (`register()` / child components) for one-shot deferrals. `registerInterval` is currently used in 2 files (`main.ts`: feedback-queue 5s tick, dashboard auto-refresh, startup embedding-warming delay; `ui/dashboard-panel.ts`: 60s timestamp tick). Raw `window.setTimeout` / `window.setInterval` is still used in 9 files where the registered patterns don't fit — `core/linter/decorations.ts` (per-view debounce cleared via the CodeMirror view lifecycle), `ui/co-writer-panel.ts` and `ai/tools/refresh-dashboard.ts` (defer-to-next-frame paints + bounded leaf-ready poll), `ai/tools/mediawiki.ts` and `ai/tools/lore-edit-helpers.ts` (one-shot rate-limit sleeps — `registerInterval` is for recurring ticks), `main.ts` (per-folder embedding-warming debounce + in-flight-warming poll), `ui/dashboard-panel.ts` (alongside its registered interval), `ui/file-mention-suggest.ts` and `ui/slash-command-suggest.ts` (blur-deferred close). When a raw timer is unavoidable, add an inline comment explaining why.
- No `fetch`. Use `requestUrl()` for HTTP (mobile-compatible). Sole exception: `window.fetch` in `src/ai/transport.ts` for SSE streaming (`requestUrl` doesn't expose a `ReadableStream`), guarded by `isStreamingSupported()`. It is accessed as `window.fetch` (a member expression, not the bare global) so it complies with the `no-restricted-globals` rule rather than disabling it; an inline comment explains why.
- Use `Component` lifecycle + `register()` for proper teardown.
- All UI text is sentence-case.
- No telemetry. Never send vault contents without explicit opt-in.
- No hardcoded secrets or API keys. Use Obsidian's `pluginDataDir` for persistent files.
- **Always `normalizePath()` on user-defined or constructed file paths.** The Obsidian automated plugin review flags any path passed to `getAbstractFileByPath()`, `vault.create()`, `vault.adapter.*`, or similar that is not wrapped in `normalizePath()`. This includes user-typed paths (e.g. `FilenameModal`), paths loaded from sidecar JSON / frontmatter YAML, and any manual regex cleanup (`replace(/^\/+|\/+$/g, '')` — always replace with `normalizePath()`). The eslint-plugin-obsidianmd does NOT have a rule for this; the server-side review catches it independently. Import via `import { normalizePath } from 'obsidian'`.

## Commands & settings

- Use stable command IDs; never rename after release.
- Persist settings via `loadData()` / `saveData()`.
- `src/settings.ts` is the single source of truth for the settings schema.

### Tool-gating toggles — descriptions live in three places

The three tool-gating settings each gate **more than one tool**, and each has its user-facing description duplicated across **three locations** that must be kept in sync: the schema-field JSDoc, the Welcome/privacy-tab toggle, and the General-tab toggle. When you change one copy, update all three and make sure every tool the gate covers is named — incomplete copies have been flagged in review before. The two tab labels are not even identical, so locate them by the setting field name, not by label string.

| Setting field (`src/settings.ts`) | Gates | Welcome/privacy-tab `.setName` | General-tab `.setName` |
|------|-------|------|------|
| `coWriterToolsEnabled` | all internal tools (`manuscript_mentions`, `lore_siblings`, `vault_lookup`, `grep_notes`, `measure_folder`, `calculate_file_sizes`, `edit_note`, `insert_note`, `append_to_note`, `revise_edit`, `get_lore_image`) | `Co-writer tools` | `Co-writer tool use` |
| `loreEntryImageAttachments` | the `images` parameter on `propose_entry`; the `attach_lore_image` tool (lorebook coach + batch only) | `Agent image attachments` | `Agent image attachments` |
| `lorebookNetworkTools` | `fetch_url`, `wikipedia_lookup` / `wikipedia_page`; the **live** path of `fandom_lookup` / `fandom_page` (cached Fandom pages still answer with this off — gate is `fandomReachability`, see `lorebookFandomCacheEnabled`) | `Network research tools` | `Network tools` |
| `lorebookImageTools` | `fetch_image_url`, `fandom_image`, `wikipedia_image` | `Image tool` | `Image tools` |

Each row = one JSDoc + two `setDesc(...)` copies to keep aligned. The authoritative gate logic is `createToolRegistry()` in `src/ai/tools/index.ts` — if you add or move a tool between tiers, also update the gating table in "Tool-calling architecture" and every description for the affected toggle(s). `fandom_image` and `wikipedia_image` are the cross-toggle cases: each needs both `lorebookNetworkTools` **and** `lorebookImageTools` (plus the Fandom allowlist, for `fandom_image`), so its gate spans two rows. The Fandom tools additionally register in cache-only mode (network off + `lorebookFandomCacheEnabled` on + populated cache for an allowlisted wiki) via `fandomReachability` — that gate is mirrored between `createToolRegistry` and `buildNetworkToolsMessage`.

## Key feature areas

1. **Manuscript Context Engine** — auto-builds working context from open document.
2. **Manuscript Dashboard** — chapter word counts, pacing analysis, dialogue ratios, readability, and a deterministic narrative-flow score (0-100 composite of sentence-length variety, paragraph-length rhythm, pacing-flag density, and dialogue balance).
3. **Prose Linter (Novelist Edition)** — deterministic rules for narrative prose.
4. **AI Feedback Engine** — reads like a thoughtful editor, not a text generator.
5. **Async Feedback Queue** — submit any review (editorial / critical / manuscript) to run unattended via the Review tab's "Queue instead of running" toggle; single-slot FIFO scheduler, per-job snapshots (isolated from live edits), and a durable vault archive of every report. See "Async feedback queue".
6. **Collaborative Drafting (Co-writer)** — writer leads, AI extends, turn by turn (discuss / coach / fulfill modes).
7. **Co-writer Tool-calling** — the model can call internal vault tools and network research tools (Fandom, Wikipedia, fetch_url) mid-conversation. On by default; restrict in settings.
8. **User-defined Slash Commands** — saved snippets in settings; typing `/` at the start of a line in the co-writer chat input opens a picker of matching commands. Choosing one inserts the body into the input, fully editable before sending. Names are kebab-case-only. Empty list (the default) disables the picker — no separate enable toggle, so the description stays single-sourced.
9. **Lorebook + Lorebook Coach** — typed lore entries with coverage-gap detection, a relationship-mapping view (list/matrix from body `[[wikilinks]]`), plus a coach mode that drafts entries from the manuscript.
10. **Selection Transformations** — rewrite selected passages in place.
11. **Critical Analysis / Continuity Engine** — plot logic, character consistency.
12. **Vision / Image Support** — images (character art, maps, reference photos) reach a vision-capable chat model directly, or are translated to text by a separate image model when chat is text-only. See "Vision & image support".
13. **Writer Guidance Layers** — inline directives (`<!-- quill: -->`) + plot map.
14. **AI Generation Style Constraints** — 18 rules + 6 narrative perspective presets (`NARRATIVE_VOICE_PRESETS`).

## Version management

Before pushing a feature branch to origin for the first time, bump the version in `package.json`, `manifest.json`, and `versions.json` according to these rules:

- **Major** (x.0.0): Only after the 1.0.1 release. For any event requiring a `minAppVersion` update in `manifest.json` (e.g., adopting a new Obsidian API that drops older versions). _Before 1.0.1, major bumps are NOT used — breaking changes use minor instead._
- **Minor** (0.x.0): New features or feature-complete milestones (e.g., 0.2.0, 0.5.0).
- **Patch** (0.0.x): Bugfixes when neither major nor minor applies.

The version string lives in more than the three release files — it's also embedded in agent strings (e.g. `MEDIAWIKI_UA` in `src/ai/tools/mediawiki.ts`) so outbound requests identify the plugin. To bump it everywhere consistently, prefer the chore tool over hand-editing:

```bash
npm run set-version -- <new-version>      # writes
npm run set-version -- <new-version> --dry-run   # preview only
```

This rewrites every literal occurrence of the current version across the repo (`package.json`, `manifest.json`, and any source file embedding it) and adds a new `versions.json` entry without dropping release history. In one run it updates all three release files **plus** the embedded copies. It does **not** tag, commit, or push — review with `git diff` and commit the chore yourself. (The legacy `npm version` / `version-bump.mjs` path is the release lifecycle hook and tags.)

The files it updates, for reference:
- `package.json` — `"version"`
- `manifest.json` — `"version"` (keep `"minAppVersion"` unchanged unless a major bump adds new API requirements)
- `versions.json` — add `"<new-version>": "<minAppVersion>"` entry (history preserved)
- every embedded copy (User-Agents, etc.)

> **If you introduce the version string in a new place**, extend `update-version.mjs` so the next bump catches it. The tool finds occurrences via a literal scan over `SCAN_EXT` (currently `.ts/.mts/.mjs/.js/.json/.md/.scss`) minus the `SKIP_*` sets (build outputs, lockfiles, `versions.json` which is special-cased). If you embed the version in a new file type or a skipped path, add it to that scope. Always embed the version as a single literal token (never split across string concatenation) so the replace stays safe.

After bumping, run `npm run build` and `npm run lint` to verify.

Releases are cut by pushing an annotated tag matching the new version. The existing `.github/workflows/release.yml` handles the rest.

## Committing

- **Committing** is allowed at reasonable checkpoints (after a feature lands, a bug is fixed, or a logical unit of work completes). Always build and lint before committing to verify your work.
- **Pushing** to a remote is NOT allowed without explicit permission each time. The user will say "push" or "push to origin" when they want a push.
- Write concise commit messages that match the repo's conventional-commit style (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`).
- Never force-push, amend another developer's commit, or rewrite published history.

## Planning files

- `.planning/` is gitignored and local-only. Never force-add (`git add -f`) or commit planning files.
- Naming patterns used in `.planning/`:
    - `pr-<feature>.md` — PR scope documents (scope, rules, fixes, known issues, data flow)
    - `pr-merge-<feature>.md` — merge records (what landed, follow-ups)
    - `eventide-quill-features.md` — master feature catalog
    - `issue-<n>.md` — issue investigation notes

## Keeping this file current

AGENTS.md is the entry brief for any agent (human or AI) working in this repo, and it drifts fast. When you land a change that does any of the following, update this file in the same PR:

- **Adds or removes a source file** → update the "Source layout" tree (and the line-count callouts for the monolithic files: `main.ts`, `settings.ts`, `co-writer.ts`, `co-writer-panel.ts`, `quill-sidebar.ts`).
- **Adds a new subsystem** (e.g., `tools/`, `dashboard/`, vision) → add a short architecture section describing the contracts and where they live.
- **Adds, removes, or renames a setting** → reflect it under "Key feature areas" or the relevant subsystem section; `src/settings.ts` is the source of truth, but AGENTS.md should mention major settings surfaces and their defaults.
- **Changes the enforced tooling** (new ESLint/stylelint rule, new script, new typed `Error` class, a new global in `global.d.ts`) → update the relevant tables (Coding rules, Error handling, `__DEV__`).
- **Changes security-relevant counts** (`addEventListener` / `setTimeout` / `fetch` call sites) → re-grep and update "Security & compliance".

Treat AGENTS.md like a test: if you shipped the feature but didn't update this file, the change isn't done. Keep claims verifiable — counts and file lists should be re-grepped, not guessed.

## When in doubt

- Prefer the existing code's pattern over any convention described here.
- If a convention conflicts with an enforced config rule (e.g., `.editorconfig` or `prettier.config.mjs` vs. AGENTS.md), the config file wins.

## References

- Obsidian API docs: https://docs.obsidian.md
- Obsidian plugin guidelines: https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines
