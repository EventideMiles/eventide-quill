import tseslint from 'typescript-eslint';
import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { globalIgnores } from 'eslint/config';

export default tseslint.config(
	globalIgnores([
		'node_modules',
		'dist',
		'.planning', // gitignored local-only scratch (PR scope docs, sizing scripts, etc.)
		'esbuild.config.mjs',
		'prettier.config.mjs',
		'version-bump.mjs',
		'update-version.mjs',
		'versions.json',
		'main.js',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
		'vitest.config.ts', // Node.js config file (uses node:path, __dirname)
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
				__DEV__: 'readonly',
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ['eslint.config.mts', 'manifest.json'],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		// Placeholder example URLs (e.g. the provider endpoint) aren't prose,
		// so any UI string containing a URL scheme is exempt from sentence-case.
		// The rule stays active everywhere else — this is the rule's documented
		// ignoreRegex escape hatch, not a disable.
		rules: {
			'obsidianmd/ui/sentence-case': ['error', { enforceCamelCaseLower: true, ignoreRegex: ['https?://'] }],
		},
	},
	{
		// Obsidian-specific rules don't apply to test files (no popout windows,
		// no vault config folder — tests run under Node via Vitest).
		files: ['tests/**/*.ts'],
		rules: {
			'obsidianmd/prefer-window-timers': 'off',
			'obsidianmd/hardcoded-config-path': 'off',
			// Test helpers install a `window.fetch` mock via globalThis since the
			// node test environment has no real window (the rule is about popout
			// compatibility inside Obsidian, which doesn't apply here).
			'obsidianmd/no-global-this': 'off',
		},
	},
);
