import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * Vitest configuration. Mirrors the esbuild dev-build environment:
 * `__DEV__` is defined as `true` so tests exercise the same code paths as
 * `npm run dev` / `npm run build` (the dev variants), not the release
 * tree-shaken variants.
 *
 * Tests live under `tests/` at the repo root (NOT `src/__tests__/`) so the
 * jscpd duplication gate — which scans `src/` only — keeps its 2.34% baseline
 * pristine. The `tests/` tree is type-checked via `tsconfig.json` `include`.
 *
 * The `obsidian` package is a runtime-only Obsidian API that has no Node
 * entry point — it resolves only inside the Obsidian app. Tests alias it to
 * the `__mocks__/obsidian.ts` stub so modules with runtime `import ... from
 * 'obsidian'` load without error. Type-only imports are erased by esbuild
 * and never hit the alias.
 */
export default defineConfig({
    define: {
        __DEV__: JSON.stringify(true)
    },
    resolve: {
        alias: {
            obsidian: resolve(__dirname, '__mocks__/obsidian.ts')
        }
    },
    test: {
        include: ['tests/**/*.test.ts'],
        environment: 'node',
        globals: false
    }
});
