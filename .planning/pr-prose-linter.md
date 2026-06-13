# PR: Prose Linter (Novelist Edition)

## Summary

Implements the prose linter engine with in-editor decorations and a results panel. Deterministic, rule-based, no AI dependency.

## What's included

### Linter engine (`src/core/linter/`)

| File | Purpose |
|---|---|
| `types.ts` | `LintResult`, `Severity` interfaces |
| `rules.ts` | 9 rule implementations |
| `linter.ts` | Orchestrator — runs all rules, sorts results |
| `decorations.ts` | CM6 ViewPlugin for wavy-underline highlights |

### 9 Rules

| Rule | Severity | What it flags |
|---|---|---|
| `long-sentences` | warning | Sentences > 30 words |
| `passive-voice` | info | "is/was/were/been/being" + past participle |
| `adverbs` | info | -ly adverbs that weaken prose |
| `qualifiers` | warning | very, really, quite, rather, etc. |
| `repeated-words` | info | Same word 3+ times on a single line |
| `echoes` | info | Repeated sentence starts within a paragraph |
| `telling-vs-showing` | warning | Heuristic: "he felt angry" → emotion named directly |
| `dialogue-tags` | info | Overused tags; "said" at 4+, novel tags at 2+ |
| `complex-words` | info | Words with 3+ syllables, suggests simpler alternative |

### In-editor decorations

- Category-colored wavy underlines: red (error), orange (warning), cyan (info)
- Hover tooltip shows `[rule-name]` and the issue message
- Uses a CM6 `ViewPlugin` registered via `registerEditorExtension()`

### Results panel (`src/ui/lint-panel.ts`)

- Sidebar view showing all issues grouped by severity
- Badge, rule name, message, and line/column location
- Ribbon icon to open the panel

### Integration (`src/main.ts`)

- **"Lint active document"** command — runs linter, applies decorations, updates panel
- Ribbon icon to show the lint results panel
- CM6 extension registered on plugin load

## Not included (future)

- Lint-on-save or lint-on-idle (auto-run)
- One-click safe fixes
- Per-rule enable/disable in settings

## Branch

`feature/prose-linter`
