# Eventide Quill

A feedback-first, novelist-focused writing assistant for Obsidian.

MIT license. Built from scratch. Mobile-ready. Local-model first.

## What it is

Eventide Quill is an Obsidian plugin that reads like a thoughtful editor, not a text generator. It helps novelists write better prose through deterministic linting, AI-powered feedback, a lorebook with an AI coach, and co-writer collaboration — all without leaving your editor.

It runs locally by default (Ollama, or any OpenAI-compatible local server such as LM Studio) and never sends your manuscript anywhere you didn't explicitly configure.

## Features

**Writing & prose**
- **Prose Linter (Novelist Edition)** — deterministic rules with no AI cost. Craft checks catch passive voice, adverb and qualifier clutter, repeated words and sentence starts, telling-vs-showing, dialogue-tag overuse, complex words, and overlong sentences. A dedicated cluster targets AI-prose tells directly: `ai-cliches`, `ai-em-dashes`, `ai-negation`, `ai-filler-adverbs`, `ai-hedging`, and `ai-wrap-ups`, plus typo-class `gremlins`.
- **Selection Transformations** — rewrite selected passages in place: improve, expand, tighten, or change tone.
- **Writer Guidance Layers** — inline directives (`<!-- quill: -->`) and a free-form plot map steer the AI.
- **AI Generation Style Constraints** — strict style rules (no em dashes, no cliché words, active voice, show-don't-tell, varied cadence, and more) plus 6 narrative perspective presets keep generated prose on-model.

**Manuscript intelligence**
- **Manuscript Context Engine** — automatically builds working context from your open document: extracts characters, locations, and plot threads on the fly, and profiles your narrative voice.
- **Manuscript Dashboard** — chapter word counts, pacing analysis, dialogue vs. description ratios, and per-character appearance tracking.
- **AI Review Engine** — a single Review tab with persona-driven editorial feedback and critical analysis (plot logic, character consistency, continuity, voice drift), with line-referenced findings.
- **Async Feedback Queue** — drop a chapter at 3 AM, get a structured report when it's ready.

**Co-writer, tools & subagents**
- **Collaborative Drafting** — writer leads, AI extends, turn by turn — in discuss, coach, and fulfill modes, in your voice and perspective.
- **Co-writer Tool-calling** — the co-writer calls vault tools mid-conversation: read notes (`vault_lookup`, `grep_notes`), pull siblings and manuscript mentions, measure folder/file sizes, and propose reviewable edits (`edit_note`, `insert_note`, `append_to_note`, `revise_edit`). On by default; restrictable in settings.
- **Network research tools** — optional `fetch_url`, Wikipedia, and Fandom lookups (Fandom gated by a configurable allowlist) for checking lore against external references.
- **Subagents** — for big, context-heavy work, the co-writer can spawn isolated subagents that run in their own fresh context and return a summary: batch lore edits and vault Q&A + external research. Keeps the main chat lean — especially valuable on local models.

**Worldbuilding**
- **Lorebook + Lorebook Coach** — typed lore entries (characters, locations, events, items, factions, plot threads, themes) with coverage-gap detection, plus a Coach mode that drafts entries from your manuscript.

**Vision**
- **Image support** — reference images (via `fetch_image_url` and Fandom image lookups) reach a vision-capable chat model directly, or — when the chat model is text-only — a separate image model describes them and splices the caption in, so a small local text model can pair with a cloud vision model.

## Quick start

```bash
git clone git@github.com:EventideMiles/eventide-quill.git
cd eventide-quill
npm install
npm run dev
```

Copy `main.js`, `manifest.json`, and `styles.css` to `VaultFolder/.obsidian/plugins/eventide-quill/`. Enable the plugin in Obsidian settings.

## Development

- `npm run dev` — esbuild watch mode (hot reload).
- `npm run build` — dev build (SCSS + Prettier + typecheck + bundle; `__DEV__` on).
- `npm run build:release` — production build (minified, no sourcemaps). Used by release CI.
- `npm run lint` — ESLint + stylelint (SCSS).
- `npm run sass` — build `styles.css` from `styles/main.scss`.

Styles are authored in SCSS and compiled to `styles.css` — edit the sources under `styles/`, not the build output. See `AGENTS.md` for the full architecture, conventions, and tooling.

## Architecture

- **Deterministic first, AI second.** Prose linter, character extraction, and metrics run locally without AI cost or latency.
- **Async by default.** No operation blocks the editor.
- **Pluggable providers.** Ollama by default, plus any OpenAI-compatible endpoint (LM Studio is the primary local test target; OpenAI and other compatible servers work too).
- **Capability-based model roles.** Models declare a role (`chat`, `embed`, `image`, or `chat-image`); the right model is resolved per task — a non-vision model never receives pixels.
- **Subagents for context isolation.** Heavy batch tasks run in a fresh context and return a summary, so the main conversation stays lean and responsive — local-model friendly (one inference at a time).
- **Mobile as a first-class target.** Test on phone before shipping desktop.

## License

MIT — see [LICENSE](LICENSE).
