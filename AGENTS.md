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
| `npm run dev` | esbuild watch mode |
| `npm run build` | **Four stages:** `sass` → `prettier --write` → `tsc -noEmit -skipLibCheck` (typecheck, no emit) → esbuild production |
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

CI (`.github/workflows/lint.yml`) runs `build` + `lint` on every push and PR across Node 20/22/24.

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

## Source layout

Several files are large and intentionally monolithic; match the surrounding pattern rather than refactoring on first touch.

```text
src/
  main.ts              # Plugin lifecycle (~1.7k lines)
  settings.ts          # Settings schema + UI (~1.4k lines)
  types.ts             # Shared TypeScript interfaces (NARRATIVE_VOICE_PRESETS)
  core/
    change-set.ts
    context-engine.ts     # barrel re-export — import from here
    context-engine/       # Manuscript context engine
      context-assembler.ts, context-cache.ts, entity-extractor.ts,
      voice-analyzer.ts, types.ts
    linter/               # Prose linter (Novelist Edition)
      apply-fix.ts, decorations.ts (CodeMirror decorations + debounced timers),
      fixes.ts, linter.ts, rules.ts, types.ts, word-lists.json (data asset)
  ai/                  # Provider architecture, streaming, prompts
    compaction.ts, co-writer.ts (~2k lines, largest file in repo),
    feedback.ts, linter-ai.ts, modes.ts, ollama-provider.ts,
    openai-provider.ts, prompts.ts, provider-registry.ts,
    provider.ts (ProviderError), streaming.ts, transform.ts,
    transport.ts (HttpError, StreamingUnavailableError, fetch exception)
  ui/                  # Views, modals, panels
    change-card.ts, change-diff-extension.ts, chat-panel.ts, confirm-modal.ts,
    context-panel.ts, co-writer-panel.ts (~1k lines), feedback-panel.ts,
    fix-with-ai-modal.ts, quill-sidebar.ts (~800 lines), token-indicator.ts,
    transform-modal.ts, vault-file-suggest-modal.ts
  utils/               # Helpers, constants
    directives.ts, find-editor.ts, frontmatter.ts, text-analysis.ts,
    tokens.ts, vault-files.ts
```

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

- Use typed error classes (extend `Error`) rather than throwing raw strings or generic `Error`. Three currently exist:
    - `ProviderError` — `src/ai/provider.ts`
    - `HttpError` — `src/ai/transport.ts`
    - `StreamingUnavailableError` — `src/ai/transport.ts`
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
- No raw DOM listeners. Prefer Obsidian's `registerDomEvent()` on a `Component` — often a child `Component` stored on a local field (e.g. `this.renderEvents.registerDomEvent(...)` in `quill-sidebar.ts`, `co-writer-panel.ts`; `component.registerDomEvent(...)` in `context-panel.ts`). Raw `addEventListener` is currently used in 9 files (`settings.ts`, `ui/feedback-panel.ts`, `ui/fix-with-ai-modal.ts`, `core/linter/decorations.ts`, `ui/confirm-modal.ts`, `ui/change-diff-extension.ts`, `ui/transform-modal.ts`, `ui/chat-panel.ts`, `ui/co-writer-panel.ts`); the heaviest is `settings.ts` via the `.inputEl.addEventListener('blur', ...)` idiom for reading values out of `TextComponent`. Prefer `registerDomEvent()` for new code; if `addEventListener` is unavoidable, leave an inline comment.
- No raw timers. Prefer teardown via the `Component` lifecycle (`register()` / child components). Raw `window.setTimeout` is currently used in `core/linter/decorations.ts` and `ui/co-writer-panel.ts` (defer-to-next-frame paints), each with an inline justification comment. `Plugin#registerInterval` is not currently used anywhere in the codebase; follow the same pattern — add a comment explaining why a raw timer is necessary.
- No `fetch`. Use `requestUrl()` for HTTP (mobile-compatible). Sole exception: `fetch` in `src/ai/transport.ts` for SSE streaming, guarded by `isStreamingSupported()` with an inline `eslint-disable-next-line` comment.
- Use `Component` lifecycle + `register()` for proper teardown.
- All UI text is sentence-case.
- No telemetry. Never send vault contents without explicit opt-in.
- No hardcoded secrets or API keys. Use Obsidian's `pluginDataDir` for persistent files.

## Commands & settings

- Use stable command IDs; never rename after release.
- Persist settings via `loadData()` / `saveData()`.
- `src/settings.ts` is the single source of truth for the settings schema.

## Key feature areas

1. **Manuscript Context Engine** — auto-builds working context from open document.
2. **Manuscript Dashboard** — chapter word counts, pacing analysis, dialogue ratios.
3. **Prose Linter (Novelist Edition)** — deterministic rules for narrative prose.
4. **AI Feedback Engine** — reads like a thoughtful editor, not a text generator.
5. **Async Feedback Queue** — submit chapters, get reports when ready.
6. **Collaborative Drafting** — writer leads, AI extends, turn by turn.
7. **Selection Transformations** — rewrite selected passages in place.
8. **Critical Analysis / Continuity Engine** — plot logic, character consistency.
9. **Writer Guidance Layers** — inline directives (`<!-- quill: -->`) + plot map.
10. **AI Generation Style Constraints** — 18 rules + 6 narrative perspective presets (`NARRATIVE_VOICE_PRESETS`).

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

## When in doubt

- Prefer the existing code's pattern over any convention described here.
- If a convention conflicts with an enforced config rule (e.g., `.editorconfig` or `prettier.config.mjs` vs. AGENTS.md), the config file wins.

## References

- Obsidian API docs: https://docs.obsidian.md
- Obsidian plugin guidelines: https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines
