// Smoke test: start the MCP server over stdio, list tools, call gtm_status.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'bin', 'gtm-mcp.mjs')], cwd: root });
const client = new Client({ name: 'smoke', version: '0.0.1' });
await client.connect(transport);
const { tools } = await client.listTools();
console.log(`tools (${tools.length}):`, tools.map((t) => t.name).join(', '));
const res = await client.callTool({ name: 'gtm_status', arguments: {} });
console.log('gtm_status ->', res.content[0].text.slice(0, 300));
const prompts = await client.listPrompts();
console.log('prompts:', prompts.prompts.map((p) => p.name).join(', '));
await client.close();
