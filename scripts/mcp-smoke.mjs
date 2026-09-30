// Smoke test: start the MCP server over stdio, list tools, call gtm_status.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const smokeDir = mkdtempSync(path.join(os.tmpdir(), 'voidrip-gtm-mcp-'));
const baseEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter((entry) => entry[1] !== undefined)),
  GTM_DB_PATH: path.join(smokeDir, 'smoke.db'),
};

async function inspectServer(name, env) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, 'bin', 'gtm-mcp.mjs')],
    cwd: root,
    env,
  });
  const client = new Client({ name: `smoke-${name}`, version: '0.0.1' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name);
  console.log(`${name} tools (${names.length}):`, names.join(', '));
  const res = await client.callTool({ name: 'gtm_status', arguments: {} });
  console.log(`${name} gtm_status ->`, res.content[0].text.slice(0, 300));
  const prompts = await client.listPrompts();
  console.log(`${name} prompts:`, prompts.prompts.map((prompt) => prompt.name).join(', '));
  const resources = await client.listResources();
  const resourceUris = resources.resources.map((resource) => resource.uri);
  console.log(`${name} resources:`, resourceUris.join(', '));
  if (!resourceUris.includes('gtm://boundary')) throw new Error(`${name} server did not expose gtm://boundary`);
  await client.close();
  return names;
}

try {
  await inspectServer('interactive', baseEnv);
  const unattended = await inspectServer('unattended', { ...baseEnv, GTM_UNATTENDED: '1' });
  for (const denied of [
    'gtm_approve',
    'gtm_launch',
    'gtm_cleanup_overloop',
    'gtm_simulate_results',
    'gtm_simulate_replies',
    'gtm_manage_subscription',
    'gtm_update_icp',
    'gtm_init',
  ]) {
    if (unattended.includes(denied)) throw new Error(`unattended server exposed ${denied}`);
  }
} finally {
  rmSync(smokeDir, { recursive: true, force: true });
}
