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
		// Obsidian-specific rules don't apply to test files (no popout windows,
		// no vault config folder — tests run under Node via Vitest).
		files: ['tests/**/*.ts'],
		rules: {
			'obsidianmd/prefer-window-timers': 'off',
			'obsidianmd/hardcoded-config-path': 'off',
		},
	},
);
