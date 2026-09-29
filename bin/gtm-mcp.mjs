#!/usr/bin/env node
// Launcher: runs the TypeScript MCP server (stdio) in-process through tsx.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
register();
await import(pathToFileURL(path.join(root, 'src', 'mcp', 'server.ts')).href);
