#!/usr/bin/env node
/**
 * GTM Autopilot MCP server (stdio). Exposes the full Max × Overloop GTM loop as tools
 * so any MCP client — Claude Code, Claude Desktop, Codex, Cursor — can run it with
 * its own model as the brain.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getConfig } from '../config.js';
import { TOOLS } from '../tools.js';
import { getPlaybook } from '../pipeline/playbook.js';
import { status } from '../pipeline/report.js';

const INSTRUCTIONS = `GTM Autopilot: Max (yourmax.ai) finds in-market leads from buying signals; Overloop (overloop.ai) runs email + LinkedIn outreach; you are the brain in between.
Daily loop: gtm_sync_results -> gtm_get_performance -> gtm_save_learnings -> gtm_source_leads -> gtm_get_classification_queue -> gtm_save_classifications -> gtm_get_drafting_queue -> gtm_save_sequence (draft, critique, final) -> gtm_push_to_overloop -> gtm_verify_overloop -> gtm_write_report.
Rules: the lead's buying signal is the hook of the first touch; every message must be specific to one person; never invent facts; no signatures (Overloop adds them).
Safety: SEND_MODE=${safeMode()} — in locked mode campaigns are inert drafts and enrollment is blocked in code. Never try to work around the SafetyGuard.`;

function safeMode() {
  try {
    return getConfig().SEND_MODE;
  } catch {
    return 'locked';
  }
}

const server = new McpServer({ name: 'gtm-autopilot', version: '0.1.0' }, { instructions: INSTRUCTIONS });

for (const tool of TOOLS) {
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.input,
      annotations: { readOnlyHint: !!tool.readOnly, openWorldHint: true },
    },
    async (args: unknown) => {
      try {
        const parsed = z.object(tool.input).parse(args ?? {});
        const result = await tool.handler(parsed);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result ?? null, null, 2) }] };
      } catch (e) {
        return { isError: true, content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }] };
      }
    },
  );
}

server.registerResource('playbook', 'gtm://playbook', { title: 'Current GTM playbook', mimeType: 'text/markdown' }, async (uri) => ({
  contents: [{ uri: uri.href, mimeType: 'text/markdown', text: getPlaybook().content }],
}));

server.registerResource('status', 'gtm://status', { title: 'Pipeline status', mimeType: 'application/json' }, async (uri) => ({
  contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(status(), null, 2) }],
}));

server.registerPrompt(
  'daily-loop',
  { title: 'Run the daily GTM loop', description: 'Run today’s full loop: learn -> source -> classify/route -> write -> push -> report.' },
  () => ({
    messages: [
      {
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text:
            'Run today’s GTM Autopilot loop end to end using the gtm_* tools, following the server instructions. ' +
            'Classify and route every new lead, write a lead-specific sequence for each (draft, self-critique, then final), push to Overloop, verify everything is inert, and write the daily brief. Summarize what you did and what you learned.',
        },
      },
    ],
  }),
);

await server.connect(new StdioServerTransport());
