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
- **Linting: ESLint** with `eslint-plugin-obsidianmd`
- **Types: `obsidian`** type definitions
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

- **Spaces, not tabs.** Indent size: 4 spaces.
- **kebab-case.ts** for modules, **PascalCase.ts** for classes.
- **PascalCase** for interfaces and types (no `I` prefix).
- **camelCase** for functions and variables.
- **UPPER_SNAKE_CASE** for magic constants.
- Keep imports sorted: external → internal, absolute → relative.

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
- No raw timers. Use `registerInterval()`.
- No raw DOM listeners. Use `registerDomEvent()`.
- No `fetch`. Use `requestUrl()` for HTTP (mobile-compatible).
- Use `Component` lifecycle + `register()` for proper teardown.
- All UI text is sentence-case.
- No telemetry. Never send vault contents without explicit opt-in.

## Commands & settings

- Use stable command IDs; never rename after release.
- Persist settings via `loadData()` / `saveData()`.

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

## References

- Obsidian API docs: https://docs.obsidian.md
- Obsidian plugin guidelines: https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines
