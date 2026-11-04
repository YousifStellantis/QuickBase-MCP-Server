// Make the CLI entry executable (no-op on Windows) so `npx`/`bin` work.
import { chmodSync, existsSync } from 'node:fs';

const entry = new URL('../build/index.js', import.meta.url);
if (existsSync(entry) && process.platform !== 'win32') chmodSync(entry, 0o755);
