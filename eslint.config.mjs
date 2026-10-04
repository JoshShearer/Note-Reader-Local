// Obsidian's own lint rules (eslint-plugin-obsidianmd), the closest public
// approximation of the community directory's automated source review. Errors
// fail CI; warnings are reported but tolerated, each one having a recorded
// reason in the PR that introduced this file (bare-Node testability, worker
// scope, or a deliberately verbatim copy of Obsidian's parser).
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
	{ ignores: ["main.js", "node_modules/**", "tests/**", "*.mjs", "*.mts", "companion/**", "docs/**"] },
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				project: "./tsconfig.json",
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
]);
