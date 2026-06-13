# PR: Prose Linter (Novelist Edition)

## Summary

Implements the core prose linter engine — a deterministic, rule-based linter for narrative prose. No AI dependency. Runs locally at zero cost.

Closes the first half of feature area #3 from the spec.

## What's included

### Linter engine (`src/core/linter/`)

| File | Purpose |
|---|---|
| `types.ts` | `LintResult`, `LintRule`, `Severity` interfaces |
| `rules.ts` | 8 rule implementations |
| `linter.ts` | Orchestrator — runs all rules, sorts results |

### 8 Rules

| Rule | Severity | What it flags |
|---|---|---|
| `long-sentences` | warning | Sentences > 30 words |
| `passive-voice` | info | "is/was/were/been/being" + past participle |
| `adverbs` | info | -ly adverbs that weaken prose |
| `qualifiers` | warning | very, really, quite, somewhat, rather, etc. |
| `repeated-words` | info | Same word 3+ times on a single line |
| `echoes` | info | Repeated sentence starts within a paragraph |
| `telling-vs-showing` | warning | Heuristic: "he felt angry" → shows emotion names |
| `dialogue-tags` | info | Overused said/whispered/shouted; flags novel tags at 2+ uses, "said" at 4+ |

### Integration (`src/main.ts`)

- New command: **"Lint active document"** — runs the linter on the current editor content, shows a Notice with issue count by severity.

## Not included (next iteration)

- Complex words check (3+ syllable heuristic)
- In-editor decorations (category-colored highlights, margin icons)
- One-click safe fixes
- Lint-on-save or lint-on-idle
- Lint results panel

## Design notes

- All rules operate on raw text via regex — no AST, no tokenizer. This keeps the bundle small and mobile-friendly but means some rules are heuristic (e.g., telling vs. showing has false positives).
- Rules are pure functions: `(text: string) => LintResult[]`. Adding a new rule is a one-function addition to `rules.ts` and the `ALL_RULES` array.
- The linter is wired into an editor command but has no persistent UI yet — the Notice is temporary until decorations land.

## Branch

`feature/prose-linter`
