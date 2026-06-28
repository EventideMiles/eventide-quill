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
| `npm run prettier:check` | `prettier --check 'src/**/*.ts'` |
| `npm run prettier:fix` | `prettier --write 'src/**/*.ts'` |
| `npm run sass` | `sass styles/main.scss styles.css` (one-shot build of styles.css from SCSS sources) |
| `npm run sass:watch` | `sass --watch styles/main.scss styles.css` (rebuild on SCSS change during dev) |
| `npm run version` | `node version-bump.mjs && git add manifest.json versions.json` (run via `npm version`) |

There is **no standalone `typecheck` script** — `tsc` runs inside `build`. There is **no `test` script and no test framework** (see Verification below).

## Verification

No automated test framework exists in this project (no jest/vitest/mocha, no `*.test.ts`). Verify changes by:

1. `npm run build` (sass + Prettier + `tsc` + esbuild), and
2. `npm run lint`, and
3. Manual smoke test in Obsidian (especially on mobile) for UI or provider changes.
4. For release builds, also run `npm run build:release` to verify minification and `__DEV__` tree-shaking work correctly.

CI (`.github/workflows/lint.yml`) runs `build` + `lint` on every push and PR across Node 20/22/24. CI for releases (`.github/workflows/release.yml`) runs `build:release` instead.

## `__DEV__` compile-time constant

`__DEV__` is a boolean injected at build time via esbuild's `define`:
- **Dev builds** (`npm run build`, `npm run dev`): `__DEV__ = true`
- **Release builds** (`npm run build:release`): `__DEV__ = false`

Use it to gate debug-only code (console logging, dev-only settings, etc.). In release builds esbuild tree-shakes the dead branches, eliminating the code entirely.

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
  _cowriter-panel.scss   ← Co-writer panel
  _change-review.scss    ← shared change-review cards + inline diff decorations
  _option-picker.scss    ← shared BEM picker block (personas, modes)
  _form.scss             ← shared BEM form block (sections, labels, textareas, submits)
  _chat-shared.scss      ← shared BEM chat-panel block (bubbles, bottom area, indicator)
  _modals.scss           ← shared modal chrome (input/save/confirm modals)
  _settings.scss         ← settings UI (tabs, provider cards, narrative rules)
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
6. **Tools on by default for discoverability.** Internal vault tools, network research tools (`fetch_url`, `fandom_*`, `wikipedia_*`), and image tools (`fetch_image_url`) are enabled by default so writers don't have to hunt for them; each can be turned off in settings to restrict outbound requests. Fandom additionally requires a non-empty allowlist (`lorebookFandomWikis`).

## Source layout

Several files are large and intentionally monolithic; match the surrounding pattern rather than refactoring on first touch.

```text
src/
  main.ts              # Plugin lifecycle + default-provider getters (~4.4k lines)
  settings.ts          # Settings schema + UI (single source of truth, ~2.6k lines)
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
      lorebook-scanner.ts, lorebook-types.ts (LORE_ENTRY_TYPES, coverage)
    linter/               # Prose linter (Novelist Edition)
      apply-fix.ts, decorations.ts (CodeMirror decorations + debounced timers),
      fixes.ts, linter.ts, rules.ts, types.ts, word-lists.json (data asset)
  ai/                  # Provider architecture, streaming, prompts, tools, vision
    provider.ts (ModelRole, ModelCapability, roleSatisfies, resolveModel, ProviderError),
    provider-registry.ts (createProvider, getProvider, parseProviderKey, generateModelId),
    openai-provider.ts, ollama-provider.ts,
    streaming.ts, transport.ts (HttpError, StreamingUnavailableError, the one fetch exception),
    compaction.ts, embedding-cache.ts,
    feedback.ts, linter-ai.ts, analysis.ts, batch-fix.ts,
    manuscript-analysis.ts, manuscript-compaction.ts,
    modes.ts, prompts.ts, transform.ts,
    vision.ts (resolveImageInjection — two-regime image routing),
    image-utils.ts (decode → downscale → JPEG base64),
    co-writer.ts (~3.3k lines, largest file in repo — discuss/coach/fulfill/lorebook-coach
                  modes, each with its own tool loop; NOT streamWithTools),
    tools/                # Tool-calling layer (see "Tool-calling architecture")
      tool.ts (Tool, ToolRegistry, ToolResult, ToolContext, DuplicateToolError),
      tool-loop.ts (streamWithTools — exported but currently unused; co-writer inlines),
      index.ts (registries + factory wiring + createToolRegistry gating),
      context-helpers.ts, lore-edit-helpers.ts,
      manuscript-mentions.ts, lore-siblings.ts, vault-lookup.ts, grep-notes.ts,
      measure-folder.ts, calculate-file-sizes.ts, edit-note.ts, append-to-note.ts,
      propose-entry.ts, fetch-url.ts, fetch-image-url.ts,
      fandom-lookup.ts, wikipedia-lookup.ts, mediawiki.ts (shared MediaWiki client)
  ui/                  # Views, modals, panels
    quill-sidebar.ts (~1.3k lines — tabs: linter/context/review/cowriter/dashboard/lorebook),
    co-writer-panel.ts (~1.5k lines), context-panel.ts, review-panel.ts,
    dashboard-panel.ts, lorebook-panel.ts, lore-entry-review.ts,
    chat-panel.ts, chat-context-files.ts, document-header.ts,
    change-card.ts, change-diff-extension.ts, token-indicator.ts,
    confirm-modal.ts, transform-modal.ts, fix-with-ai-modal.ts,
    filename-modal.ts, vault-file-suggest-modal.ts, file-mention-suggest.ts
  utils/               # Helpers, constants
    directives.ts, find-editor.ts, frontmatter.ts, text-analysis.ts,
    tokens.ts, vault-files.ts
```

## Tool-calling architecture

The co-writer can call tools mid-conversation via the provider's native tool-calling API (OpenAI/Ollama `tools` + `tool_calls`). Two execution paths exist — both are vision-aware:

- **`streamWithTools`** (`src/ai/tools/tool-loop.ts`) — a generic wrapper exported for reuse; currently has **no callers**.
- **The co-writer's own loop** (`src/ai/co-writer.ts`) — discuss, coach, fulfill, and lorebook-coach modes each inline their own tool execution (`executeToolCallSafely`) so they can render tool rounds in the chat UI and track token growth round-by-round. **This is the active path.**

Key contracts:

- `Tool` (`tools/tool.ts`) — `id`, `description`, `parameters` (JSON Schema), `maxResultTokens`, `requiresNetwork`, and `execute()` returning `Promise<string | ToolResult>`. `ToolResult` adds optional `images` (base64, for the vision layer).
- `ToolRegistry` — unique-by-id registry (duplicate ids throw `DuplicateToolError`); `toToolDefinitions()` serializes to the provider's `tools` field.
- `createToolRegistry(plugin, includeProposeEntry)` (`tools/index.ts`) — the single gating point. Returns `null` when `coWriterToolsEnabled` is off; otherwise registers the internal tools, adds `propose_entry` for the lorebook coach, and adds network/image tools when their toggles are on.

Tool tiers (gating):

| Tier | Tools | Gate setting |
|------|-------|--------------|
| Internal (default on) | `manuscript_mentions`, `lore_siblings`, `vault_lookup`, `grep_notes`, `measure_folder`, `calculate_file_sizes`, `edit_note`, `append_to_note` | `coWriterToolsEnabled` |
| Lorebook coach only | `propose_entry` (surfaces a lore draft to the UI) | `createLoreCoachToolRegistry` |
| Network (default on) | `fetch_url`, `fandom_lookup` / `fandom_page`, `wikipedia_lookup` / `wikipedia_page` | `lorebookNetworkTools` |
| Image (default on) | `fetch_image_url` | `lorebookImageTools` |

Fandom requires a non-empty allowlist (`lorebookFandomWikis`); an empty list disables Fandom everywhere. `mediawiki.ts` is the shared MediaWiki client with per-host rate limiting. Convention: tool ids are `snake_case` verbs/nouns (`manuscript_mentions`, `fetch_url`).

## Vision & image support

Images (character art, maps, reference photos) reach a model through three entry points (tool result, co-writer paste — planned, lorebook entry — planned), all funneled through `resolveImageInjection(plugin, images, opts)` in `src/ai/vision.ts`. Two regimes, picked at runtime from the configured models:

- **Regime A (vision-native):** the default chat model has role `chat-image`. Images attach to the message as image content; the model sees pixels directly.
- **Regime B (vision-proxy):** the chat model is text-only and a default image model is configured. The image model makes one isolated call (image + proxy prompt → caption text) and the caption is spliced into the conversation. The chat model never switches and never receives pixels — so a small local text model can pair with a cloud vision model.

Regime B's proxy call is fully self-contained, so the image model may live on a **different provider** than chat (chosen via the Default image model picker, `aiDefaultImageProvider`). Regime A must stay on the chat provider — images ride on chat messages serialized by that provider.

Provider serialization:

- **OpenAI-compatible** (LM Studio, primary): `ChatMessage.images` → content array of `{type:'text'}` + `{type:'image_url', image_url:{url}}` parts.
- **Ollama:** sibling `images: [base64]` field on the message.

Images are base64 strings with no `data:` prefix, normalized to JPEG and downscaled (≤ `lorebookImageMaxDimension`, default 512) by `image-utils.ts` before they reach a provider, to protect local-model context budgets. The proxy prompt is customizable (`lorebookImageProxyPrompt`).

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

- Use typed error classes (extend `Error`) rather than throwing raw strings or generic `Error`. Four currently exist:
    - `ProviderError` — `src/ai/provider.ts`
    - `HttpError` — `src/ai/transport.ts`
    - `StreamingUnavailableError` — `src/ai/transport.ts`
    - `DuplicateToolError` — `src/ai/tools/tool.ts`
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
- No raw DOM listeners. Prefer Obsidian's `registerDomEvent()` on a `Component` — often a child `Component` stored on a local field (e.g. `this.renderEvents.registerDomEvent(...)` in `quill-sidebar.ts`, `co-writer-panel.ts`; `component.registerDomEvent(...)` in `context-panel.ts`). Raw `addEventListener` is currently used in 12 files (`settings.ts`, `core/linter/decorations.ts`, and `ui/` {`change-diff-extension`, `chat-context-files`, `chat-panel`, `confirm-modal`, `co-writer-panel`, `dashboard-panel`, `file-mention-suggest`, `filename-modal`, `fix-with-ai-modal`, `transform-modal`}.ts); the heaviest is `settings.ts` via the `.inputEl.addEventListener('blur', ...)` idiom for reading values out of `TextComponent`. Prefer `registerDomEvent()` for new code; if `addEventListener` is unavoidable, leave an inline comment.
- No raw timers. Prefer teardown via the `Component` lifecycle (`register()` / child components). Raw `window.setTimeout` is currently used in 6 files — `core/linter/decorations.ts` and `ui/co-writer-panel.ts` (defer-to-next-frame paints), `ai/tools/mediawiki.ts` and `ai/tools/lore-edit-helpers.ts` (rate-limit sleeps), `main.ts`, and `ui/file-mention-suggest.ts`. `Plugin#registerInterval` is not currently used anywhere in the codebase; when a raw timer is unavoidable, add an inline comment explaining why.
- No `fetch`. Use `requestUrl()` for HTTP (mobile-compatible). Sole exception: `fetch` in `src/ai/transport.ts` for SSE streaming, guarded by `isStreamingSupported()` with an inline `eslint-disable-next-line` comment.
- Use `Component` lifecycle + `register()` for proper teardown.
- All UI text is sentence-case.
- No telemetry. Never send vault contents without explicit opt-in.
- No hardcoded secrets or API keys. Use Obsidian's `pluginDataDir` for persistent files.
- **Always `normalizePath()` on user-defined or constructed file paths.** The Obsidian automated plugin review flags any path passed to `getAbstractFileByPath()`, `vault.create()`, `vault.adapter.*`, or similar that is not wrapped in `normalizePath()`. This includes user-typed paths (e.g. `FilenameModal`), paths loaded from sidecar JSON / frontmatter YAML, and any manual regex cleanup (`replace(/^\/+|\/+$/g, '')` — always replace with `normalizePath()`). The eslint-plugin-obsidianmd does NOT have a rule for this; the server-side review catches it independently. Import via `import { normalizePath } from 'obsidian'`.

## Commands & settings

- Use stable command IDs; never rename after release.
- Persist settings via `loadData()` / `saveData()`.
- `src/settings.ts` is the single source of truth for the settings schema.

## Key feature areas

1. **Manuscript Context Engine** — auto-builds working context from open document.
2. **Manuscript Dashboard** — chapter word counts, pacing analysis, dialogue ratios, readability.
3. **Prose Linter (Novelist Edition)** — deterministic rules for narrative prose.
4. **AI Feedback Engine** — reads like a thoughtful editor, not a text generator.
5. **Async Feedback Queue** — submit chapters, get reports when ready.
6. **Collaborative Drafting (Co-writer)** — writer leads, AI extends, turn by turn (discuss / coach / fulfill modes).
7. **Co-writer Tool-calling** — the model can call internal vault tools and network research tools (Fandom, Wikipedia, fetch_url) mid-conversation. On by default; restrict in settings.
8. **Lorebook + Lorebook Coach** — typed lore entries with coverage-gap detection, plus a coach mode that drafts entries from the manuscript.
9. **Selection Transformations** — rewrite selected passages in place.
10. **Critical Analysis / Continuity Engine** — plot logic, character consistency.
11. **Vision / Image Support** — images (character art, maps, reference photos) reach a vision-capable chat model directly, or are translated to text by a separate image model when chat is text-only. See "Vision & image support".
12. **Writer Guidance Layers** — inline directives (`<!-- quill: -->`) + plot map.
13. **AI Generation Style Constraints** — 18 rules + 6 narrative perspective presets (`NARRATIVE_VOICE_PRESETS`).

## Version management

Before pushing a feature branch to origin for the first time, bump the version in `package.json`, `manifest.json`, and `versions.json` according to these rules:

- **Major** (x.0.0): Only after the 1.0.0 release. For any event requiring a `minAppVersion` update in `manifest.json` (e.g., adopting a new Obsidian API that drops older versions). _Before 1.0.0, major bumps are NOT used — breaking changes use minor instead._
- **Minor** (0.x.0): New features or feature-complete milestones (e.g., 0.2.0, 0.5.0).
- **Patch** (0.0.x): Bugfixes when neither major nor minor applies.

When bumping, always update all three files together:
- `package.json` — `"version"`
- `manifest.json` — `"version"` (keep `"minAppVersion"` unchanged unless a major bump adds new API requirements)
- `versions.json` — add `"<new-version>": "<minAppVersion>"` entry

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
