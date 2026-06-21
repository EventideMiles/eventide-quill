/**
 * Compile-time constant injected by esbuild's `define`.
 * `true` in dev builds (npm run build, npm run dev).
 * `false` in release builds (npm run build:release).
 * Use this to gate debug-only code that should be tree-shaken from releases.
 */
declare const __DEV__: boolean;
