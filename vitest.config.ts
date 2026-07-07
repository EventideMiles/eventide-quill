import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration. Mirrors the esbuild dev-build environment:
 * `__DEV__` is defined as `true` so tests exercise the same code paths as
 * `npm run dev` / `npm run build` (the dev variants), not the release
 * tree-shaken variants.
 *
 * Tests live under `tests/` at the repo root (NOT `src/__tests__/`) so the
 * jscpd duplication gate — which scans `src/` only — keeps its 2.34% baseline
 * pristine. The `tests/` tree is type-checked via `tsconfig.json` `include`.
 */
export default defineConfig({
    define: {
        __DEV__: JSON.stringify(true)
    },
    test: {
        include: ['tests/**/*.test.ts'],
        environment: 'node',
        globals: false
    }
});
