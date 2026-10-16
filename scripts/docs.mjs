import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The native realpath resolves Windows drive casing; the JS version can retain it.
// Normalize cwd and the CLI URL, since imports inherit the entry script's casing.
process.chdir(realpathSync.native(fileURLToPath(new URL('..', import.meta.url))));
const require = createRequire(import.meta.url);
const cliPath = realpathSync.native(require.resolve('vitepress/dist/node/cli.js'));

await import(pathToFileURL(cliPath).href);
