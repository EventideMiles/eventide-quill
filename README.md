# Eventide Quill

A feedback-first, novelist-focused writing assistant for Obsidian.

MIT license. Built from scratch. Mobile-ready. Local-model first.

## What it is

Eventide Quill is an Obsidian plugin that reads like a thoughtful editor, not a text generator. It helps novelists write better prose through deterministic linting, AI-powered feedback, and co-writer collaboration — all without leaving your editor.

It runs locally by default (Ollama) and never sends your manuscript anywhere you didn't explicitly configure.

## Features

- **Manuscript Context Engine** — automatically builds working context from your open document. Extracts characters, locations, and plot threads on the fly.
- **Prose Linter (Novelist Edition)** — catches passive voice, adverb density, repeated sentence starts, telling vs. showing, and dialogue tag overuse. All deterministic, no AI cost.
- **Manuscript Dashboard** — chapter word counts, pacing analysis, dialogue vs. description ratios, character appearance tracking.
- **AI Review Engine** — unified editorial feedback (persona-driven, multi-manuscript) and critical analysis (plot logic, character consistency, continuity, voice drift) in a single Review tab with line-referenced findings.
- **Async Feedback Queue** — drop a chapter at 3 AM, get a structured report when it's ready.
- **Collaborative Drafting** — writer leads, AI extends. Turn by turn, in your voice and perspective.
- **Selection Transformations** — rewrite selected passages in place: improve, expand, tighten, or change tone.
- **Critical Analysis / Continuity Engine** — part of the Review tab; plot logic checks, character consistency, voice drift detection.
- **Writer Guidance Layers** — inline directives (`<!-- quill: -->`) and free-form plot map to steer the AI.
- **AI Generation Style Constraints** — 18 rules + 6 narrative perspective presets keep generated prose on-model.

## Quick start

```bash
git clone git@github.com:EventideMiles/eventide-quill.git
cd eventide-quill
npm install
npm run dev
```

Copy `main.js`, `manifest.json`, and `styles.css` to `VaultFolder/.obsidian/plugins/eventide-quill/`. Enable the plugin in Obsidian settings.

## Development

- `npm run dev` — watch mode with hot reload
- `npm run build` — production build
- `npm run lint` — ESLint check

## Architecture

- **Deterministic first, AI second.** Prose linter, character extraction, and metrics run locally without AI cost or latency.
- **Async by default.** No operation blocks the editor.
- **Pluggable providers.** Ollama default, OpenAI-compatible as fallback. Claude, Gemini, OpenAI supported as options.
- **Mobile as a first-class target.** Test on phone before shipping desktop.

## License

MIT — see [LICENSE](LICENSE).
