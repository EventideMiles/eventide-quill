<!-- This is a tracked copy of a plan that normally lives in the gitignored .planning/ folder.
     Committed to temporary-plans/ so it survives on origin and is reviewable alongside the PR.
     Safe to delete once the PR is merged; the canonical source remains .planning/pr-lorebook-foundation.md. -->

# PR: Lorebook Foundation (Feature 15 — Slice 1)

## Summary

First slice of Feature 15 (Lorebook Integration). Ships lore entry **detection** via user-configured folders, a dedicated **Lorebook sidebar tab** (coverage: referenced / orphaned / missing entities, with per-gap dismiss), an **inline entry-type editor** (dropdown on the open lore file — no hand-editing of frontmatter), **folder-level type defaults**, and **context fuel** — lore entries auto-injected as embedded context into the co-writer (6 sites) and Review engines via the existing `embed:` folder convention.

**No linking required.** Detection is folder membership; context fuel uses embedding similarity; coverage matches on entity name. An unlinked entry is detected, flows into AI context, and matches on plain-text mention — no `[[wikilinks]]` anywhere in the flow.

Defers to PR B (lore-consistency Review engine + entry-creation wizard) and PR C (co-writer Lore-draft mode + relationship map).

Targets **0.7.0**. Branch: `feature/lorebook-foundation`.

## Revision: Lorebook is its own top-level tab

Originally scoped as a Dashboard sub-section. Promoted to a peer top-level tab (`quill-sidebar` `TopTab: 'lorebook'`) because the coverage list + gaps were cluttering the Dashboard. The tab has its own refresh button (`plugin.refreshLorebook()`) and document header, and reuses the entity base from the last dashboard refresh (falling back to a single-file extraction when no dashboard refresh has run).

## Scope decisions (locked)

| Decision | Choice |
|----------|--------|
| Primary surface | Dashboard panel (curation, coverage) |
| Detection | User-defined folder list (`lorebookFolders: string[]`) — folder membership is the gate |
| Typing | Frontmatter `quill-type` (optional); vocabulary aligned with entity extractor (see below) |
| Co-writer mode | Deferred to PR C |
| Relationship viz | List/matrix in PR C; deferred here |

### Lore entry type vocabulary

`LORE_ENTRY_TYPES = ['character', 'location', 'event', 'item', 'faction', 'plot-thread', 'theme']` (7).

Aligns 1:1 with `EntityType` in `src/core/context-engine/types.ts` (`character | location | plot-thread | theme | item`) plus two lore-only types (`event`, `faction`). This makes coverage-gap mapping complete — every extracted entity type can be matched against a lore entry of the same type.

A `.md` is a lore entry iff it lives under a configured `lorebookFolders` path. Frontmatter is optional; `quill-type` classifies the entry for coverage + relationship features. Entries without `quill-type` are treated as `untyped` and surface in the Dashboard but don't participate in coverage mapping.

## Architecture

```
lorebookFolders (setting)
   └─▶ LorebookScanner.scan() ──▶ LoreEntry[] (in-memory, recomputed on refresh)
          │
          ├─▶ Dashboard panel (coverage: referenced / orphaned / missing)
          └─▶ ContextEngine ──▶ each folder auto-injected as `embed:{path}` source
                 └─▶ co-writer 6 sites (gated coWriterLoreContext) + Review init (reviewLoreContext)
```

**Key reuse:** the `embed:` folder convention (`src/utils/vault-files.ts`) is already wired into all 6 co-writer call sites and the 4 Review call sites in `main.ts`. Lore context fuel is therefore *not* a new retrieval path — it's auto-injecting each `lorebookFolder` as an `embed:{path}` context source when the relevant toggle is on. Embeddings (provider + per-folder cache + top-K retrieval) already ship.

## Settings additions

| Setting | Type | Default | Purpose |
|---|---|---|---|
| `lorebookFolders` | `string[]` | `[]` | Vault-relative folders scanned for lore entries |
| `lorebookFolderTypes` | `Record<string, LoreEntryType>` | `{}` | Per-folder entry-type default; absent key = mixed (per-file `quill-type`) |
| `coWriterLoreContext` | `boolean` | `true` | Feed lore entries into co-writer context |
| `reviewLoreContext` | `boolean` | `true` | Feed lore entries into Review engine context |

All added to `DEFAULT_SETTINGS` and both restore-defaults sections in `settings.ts`.

## Inline entry-type editor

When the active markdown file lives under a configured lorebook folder, the Lorebook tab shows an "Active entry" card with a type dropdown (`Mixed (inherit folder)` + the 7 types). Selecting writes the flat `quill-type` frontmatter key via `plugin.setLoreEntryType(file, type | null)` (Obsidian `processFrontMatter`, non-destructive). A muted hint shows the effective resolved type so the file → folder → untyped chain is visible. "Mixed" clears the per-file key so the folder default takes over.

Two commands: `quill-lorebook-open` (switch to the tab) and `quill-lorebook-refresh` (rescan).

## Files

### New

- `src/core/dashboard/lorebook-types.ts` — `LoreEntry`, `LoreCoverage`, `LoreCoverageGap`, 7-type vocabulary (`LORE_ENTRY_TYPES`), labels, `entityTypeToLoreType` mapping
- `src/core/dashboard/lorebook-scanner.ts` — `scanLorebook()` (folder walk + metadata-cache frontmatter parse + folder-type fallback), `computeCoverage()` (respects dismissed IDs), `findLoreFolder()` + `parseLoreType()` exports for the inline editor
- `src/ui/lorebook-panel.ts` — Lorebook tab renderer (coverage, gaps with dismiss, referenced/orphaned lists) + inline active-entry type editor
- `styles/_lorebook-panel.scss` — `quill-lorebook-panel` BEM block
- `src/ui/dashboard-panel.ts` — additions (new lorebook section in `renderDashboardTab`)

### Modified

- `src/types.ts` — `LORE_ENTRY_TYPES` constant, `LoreEntryType` union
- `src/settings.ts` — 4 new settings + defaults + restore-defaults + UI (Lorebook heading + folder dynamic rows mirroring `folderTopKOverrides` pattern at lines 386–416)
- `src/ai/co-writer.ts` — append lorebook folders to context sources in `loadAdditionalContext` / `buildVaultContext` call sites (6 sites) when `coWriterLoreContext`
- `src/main.ts` — append lorebook folders to context resolution before Review AI call sites when `reviewLoreContext`; wire scanner into dashboard refresh
- `src/utils/vault-files.ts` — `buildEmbedFolderPath` reuse (no change expected, confirm)
- `package.json`, `manifest.json`, `versions.json` — version bump to 0.7.0

## Coverage-gap algorithm

For each `ExtractedEntity` from the active manuscript:

1. Skip if its ID is in the Dashboard's `dismissedEntities` (false positives the writer dismissed). This is shared state — a one-time dismiss in the Dashboard character list or the Lorebook gap row clears it everywhere.
2. Skip if `occurrences < LORE_COVERAGE_GAP_MIN_OCCURRENCES` (default `3`) — avoids noise from one-off mentions.
3. Look for a lore entry whose `quill-type` matches the entity `type` AND whose name/aliases match (case-insensitive, trimmed).
4. If none found → coverage gap: `{ entityId, entityName, entityType, occurrences }`.

Each gap row has a working **Dismiss** button that calls `plugin.dismissDashboardEntity(entityId)` — the primary mechanism for clearing sentence-capitalization false positives the entity extractor misreads as names. The dismissal persists to the manuscript sidecar and is respected by both the Dashboard and Lorebook coverage.

Output is rendered in the Lorebook tab as "Mentioned but not documented." Entry creation from a gap is deferred to PR B's wizard.

## Dashboard section layout

```
┌─ Lorebook ──────────────────────────────────┐
│ {N} entries across {M} folders              │
│ Coverage: {X} referenced · {Y} orphaned · {Z} missing │
│                                              │
│ [type filter chips: All · Character · ...]   │
│                                              │
│ ▸ Entry Name (character) — 12 refs           │
│ ▸ Untitled entry (untyped) — orphaned        │
│ ...                                          │
│                                              │
│ Missing:                                     │
│ • "Marcus" (character, 8 occurrences) [Create]│
└──────────────────────────────────────────────┘
```

BEM class: `quill-dashboard__lorebook` (block) with `__lorebook-entry`, `__lorebook-coverage`, `__lorebook-gap` elements. Styles added to `styles/_dashboard.scss`.

## Context fuel wiring (detail)

In `co-writer.ts`, `loadAdditionalContext()` resolves embed paths via `resolveEmbedPathsToMessages()`. The change: when `coWriterLoreContext` is on, prepend each `lorebookFolder` (as `embed:{path}`) to the list of context folders before resolution. This piggybacks on the existing top-K retrieval, per-folder overrides, and token estimation.

In `main.ts`, the 4 Review call sites (`requestFeedback`, `sendFeedbackChatMessage`, `sendAnalysisChatMessage`, `sendManuscriptAnalysisChatMessage`) resolve context via `resolveFolderContextItems()` / `resolveEmbedPathsToMessages()`. Same prepend pattern when `reviewLoreContext` is on.

## Out of scope (PR B / PR C)

- Lore-consistency Review engine (contradiction detection) — PR B
- Entry-creation/edit wizard modal — PR B
- Co-writer "Lore draft" mode — PR C
- Relationship mapping view — PR C
- Lore entry persistence to disk as sidecar JSON (scanner is in-memory for v1)

## Verification

- `npm run build` (sass + prettier + tsc + esbuild)
- `npm run lint` (eslint + stylelint)
- Manual Obsidian smoke test:
  - Configure 1–2 lore folders in settings; confirm entries surface in Dashboard
  - Confirm coverage gap detection against a manuscript with known characters
  - Toggle `coWriterLoreContext` off/on; confirm token indicator reflects lore folder embed cost
  - Mobile: Dashboard section renders, folder rows tappable

## Follow-ups (tracked, not in this PR)

- PR B: consistency engine + wizard
- PR C: Lore-draft mode + relationship map
- Persist scanner index to `pluginDataDir` if scan cost becomes noticeable on large vaults
- Graph visualization for relationships (post-PR C)
