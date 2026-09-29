#!/usr/bin/env node
// Launcher: runs the TypeScript CLI through tsx so no build step is needed.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const tsx = require.resolve('tsx/cli', { paths: [root] });
const r = spawnSync(process.execPath, [tsx, path.join(root, 'src', 'cli.ts'), ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
