# Eventide Quill

[![Sponsor](https://img.shields.io/badge/sponsor-30363C?logo=github-sponsors&logoColor=white)](https://github.com/sponsors/EventideMiles)

A feedback-first, novelist-focused writing assistant for Obsidian.

MIT license. Built from scratch. Mobile-targeted. Local-model first.

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
- **Mobile as a first-class target.** The plugin ships with `isDesktopOnly: false`, `requestUrl` transport, and touch-target sizing — but it has not yet been smoke-tested on a real mobile device. A Capacitor install + on-device pass is scheduled for immediately after the 1.3.0 release; report mobile issues against the `1.0.x` milestone.

## Network & privacy

The plugin has three layers of functionality:

1. **No model, no network.** The prose linter, manuscript dashboard (word counts, pacing, readability, flow score), context engine (character/location/plot-thread extraction), and lorebook coverage scanner all run locally with zero AI cost and zero network access. The plugin is useful immediately after install.

2. **Local model, no network.** Configure a local model (Ollama, LM Studio, or any OpenAI-compatible local server) to unlock AI feedback, co-writer collaboration, critical analysis, manuscript analysis, lorebook coach, and selection transformations. All processing stays on your machine. Cloud providers (OpenAI and other OpenAI-compatible endpoints) also work if you prefer — you choose where your data goes.

3. **Optional network research tools.** Wikipedia lookups, Fandom lookups, and URL fetching let the co-writer check lore against external references. These are toggleable in settings and gated by allowlists. A local Fandom cache can sync pages for offline use.

No telemetry. Vault contents are never sent anywhere you didn't explicitly configure. The plugin does not access files outside of Obsidian vaults.

## Sponsors

Eventide Quill is MIT-licensed and free for everyone — the same feature-complete plugin for all, no paywalls. If it's part of your writing practice, consider [sponsoring on GitHub](https://github.com/sponsors/EventideMiles). Sponsorships keep the tool free, local-first, and open-source forever — no vendor lock-in.

Tiers (rewards are recognition + influence, not gated features — every tier gets the whole plugin):

- **$5/mo — Beta Reader:** your name under "Supported by Beta Readers" below, plus a community role in project discussions.
- **$25/mo — Editor:** your logo under "Supported by Editors," 3× vote weight in monthly maintenance polls, a monthly suggestion queue, and behind-the-scenes project updates.
- **$50/mo — Pro/team:** prominent logo placement, priority bug-report review (within 48 hours), and a quarterly 30-minute office-hours call for setup, lorebook, or workflow tuning. Custom/enterprise options available ($100+).

See the [sponsor page](https://github.com/sponsors/EventideMiles) for full details.

### Supported by Beta Readers

*Be the first — [sponsor at the Beta Reader tier](https://github.com/sponsors/EventideMiles).*

### Supported by Editors

*Be the first — [sponsor at the Editor tier](https://github.com/sponsors/EventideMiles).*

## License

MIT — see [LICENSE](LICENSE).
