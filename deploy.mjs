/**
 * Copy the built plugin into a vault so it can be loaded and tried.
 *
 * Usage: node deploy.mjs [vaultPath]
 * Defaults to ~/Documents/Notes, which is the vault on this machine.
 */

import { cp, mkdir, access } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const vault = path.resolve(process.argv[2] ?? path.join(homedir(), "Documents", "Notes"));
const dest = path.join(vault, ".obsidian", "plugins", "local-tts-reader");

try {
	await access(path.join(vault, ".obsidian"));
} catch {
	console.error(`Not a vault (no .obsidian folder): ${vault}`);
	process.exit(1);
}

// Overwrite only build artifacts. Do not delete/recreate the plugin directory:
// it also contains user settings and may contain diagnostic logs or models.
await mkdir(dest, { recursive: true });

for (const item of ["main.js", "manifest.json", "styles.css", "ort"]) {
	await cp(item, path.join(dest, item), { recursive: true });
	console.log(`  ${item}`);
}

console.log(`\nDeployed to ${dest}`);
console.log("Enable it in Settings -> Community plugins, then reload Obsidian.");
