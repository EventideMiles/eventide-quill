# Eventide Quill

A feedback-first, novelist-focused writing assistant for Obsidian.
MIT license. Built from scratch. Mobile-ready. Local-model first.

## Project overview

- Target: Obsidian Community Plugin (TypeScript → bundled JavaScript via esbuild).
- Entry point: `src/main.ts` compiled to `main.js` and loaded by Obsidian.
- Required release artifacts: `main.js`, `manifest.json`, and `styles.css`.

## Environment & tooling

- **Package manager: npm**
- **Bundler: esbuild** (configured in `esbuild.config.mjs`)
- **Linting: ESLint** with `eslint-plugin-obsidianmd` (configured in `eslint.config.mts`)
- **Types: `obsidian`** type definitions (configured in `tsconfig.json`)
- **Editor config: `.editorconfig`**
- Run `npm run dev` for watch mode, `npm run build` for production.
- Run `npm run lint` to lint.

## Architecture principles

1. **Deterministic first, AI second.** Prose linter, character extraction, and metrics run locally without AI cost.
2. **Async by default.** No operation blocks the editor.
3. **Pluggable providers.** Ollama default, OpenAI-compatible as fallback.
4. **Mobile as a first-class target.** Test on phone before shipping desktop.

## Source layout

```
src/
  main.ts           # Plugin lifecycle (onload, onunload, addCommand)
  settings.ts       # Settings interface and defaults
  core/             # Domain logic (linter, context engine, etc.)
  ai/               # Provider architecture, streaming, prompts
  ui/               # Views, modals, panels
  utils/            # Helpers, constants
  types.ts          # Shared TypeScript interfaces
```

## Coding conventions

### Naming

- **kebab-case.ts** for module files (e.g., `feedback-panel.ts`).
- **PascalCase** for interfaces, types, and type aliases (no `I` prefix).
- **camelCase** for functions, variables, parameters, and private fields.
- **UPPER_SNAKE_CASE** for module-level exported constants (e.g., `DEFAULT_SETTINGS`, `FEEDBACK_PERSONAS`).
- **camelCase** for local `const` declarations inside functions (e.g., `const doc = view.state.doc`).
- **camelCase** for settings object properties; the settings object itself is UPPER_SNAKE_CASE (e.g., `DEFAULT_SETTINGS` with properties like `linterMode`, `enableLongSentences`).
- **Boolean variables:** predicates (functions returning boolean) use `is-`/`has-`/`needs-` prefixes (e.g., `isBlank`, `hasContent`, `needsSpaceBetween`). Class state properties use descriptive names without prefixes (e.g., `chatLoading`, `userScrolledUp`).
- **Event handlers:** use `on<EventName>` pattern (e.g., `onChoose`, `onSubmit`, `onGenerate`).
- **Settings booleans:** use `enable<RuleName>` prefix (e.g., `enableLongSentences`, `enablePassiveVoice`).

### Code style

- **Spaces, not tabs.** Indent size: 4 (enforced in `.editorconfig`).
- Keep imports sorted: external → internal, `type` imports last.
- **JSDoc on every function.** All functions and methods must have a `/** ... */` docstring.

### Error handling

- Use typed error classes (extend `Error`) rather than throwing raw strings or generic `Error`.
- Example: `ProviderError` in `src/ai/provider.ts`, `HttpError` in `src/ai/transport.ts`.
- Propagate errors with `throw` rather than returning error objects, unless the function signature explicitly supports `Result<T, E>` or similar patterns.

## Coding rules — enforced vs. convention

| Rule | Enforced by | Notes |
|------|-------------|-------|
| Spaces (4), UTF-8, LF, trailing newline, single quotes | `.editorconfig` | Auto-applied by editors |
| `strict`, `noImplicitReturns`, `noUncheckedIndexedAccess`, `forceConsistentCasingInFileNames` | `tsconfig.json` | TypeScript compiler |
| Obsidian-specific lint rules | `eslint.config.mts` + `eslint-plugin-obsidianmd` | |
| Naming conventions (case, prefixes) | **Code review only** | No ESLint rules for naming yet |
| JSDoc coverage | **Code review only** | Aim for 100% |

## Branch strategy

- `main` is write-protected. Never commit directly to it.
- All work happens on feature branches pushed to GitHub, then merged via pull request.
- Branch naming:
    - `feature/<short-description>` — new features
    - `bugfix/<short-description>` — bug fixes
- Example: `feature/prose-linter`, `bugfix/settings-crash`
- Open a PR to `main` when the feature is ready. CodeRabbit will review automatically.

## Security & compliance

- No `innerHTML`. Use `createEl()` + `textContent`.
- No raw timers. Use `registerInterval()` (exceptions: known debounced timers in `decorations.ts`).
- No raw DOM listeners. Use `registerDomEvent()` (exceptions: raw `addEventListener` in `feedback-panel.ts`).
- No `fetch`. Use `requestUrl()` for HTTP (mobile-compatible) (exception: `fetch` in `transport.ts` for SSE streaming, guarded by `isStreamingSupported()`).
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
10. **AI Generation Style Constraints** — 18 rules + 6 narrative perspective presets.

## Committing

- Do not commit or push unless the user explicitly asks you to. Build and lint to verify your work, but leave the commits to the user.

## Planning files

- `.planning/` is gitignored and local-only. Never force-add (`git add -f`) or commit planning files.
- Use `.planning/pr-<feature>.md` for PR scope documents (scope, rules, fixes, known issues, data flow).

## When in doubt

- Prefer the existing code's pattern over any convention described here.
- If a convention conflicts with an enforced config rule (e.g., `.editorconfig` vs. AGENTS.md), the config file wins.

## References

- Obsidian API docs: https://docs.obsidian.md
- Obsidian plugin guidelines: https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines
