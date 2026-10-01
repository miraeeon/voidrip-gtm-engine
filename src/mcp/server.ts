#!/usr/bin/env node
/**
 * VOIDRIP GTM Engine MCP server (stdio). Exposes the provider-agnostic GTM loop
 * to Codex and other MCP clients.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getConfig } from '../config.js';
import { TOOLS } from '../tools.js';
import { getPlaybook } from '../pipeline/playbook.js';
import { status } from '../pipeline/report.js';
import { toolAllowedInRuntime } from '../safety/unattended.js';
import { getBoundaryContract } from '../market-map/boundary.js';

const UNATTENDED = process.env.GTM_UNATTENDED === '1';

const INSTRUCTIONS = `VOIDRIP GTM Engine: SourceAdapter supplies candidates; ExecutionAdapter manages outbound drafts, activation and results. Max and Overloop are optional bundled adapters; Codex is the qualification and orchestration engine.
Daily loop: gtm_sync_results -> gtm_get_performance -> gtm_save_learnings -> gtm_source_leads -> gtm_get_classification_queue -> gtm_save_classifications -> gtm_get_drafting_queue -> gtm_save_sequence (draft, critique, final) -> gtm_push_to_overloop -> gtm_verify_overloop -> gtm_write_report.
Local E2E: gtm_ingest_candidates -> gtm_get_resolution_queue -> gtm_save_project_resolution -> gtm_get_boundary_queue -> gtm_save_boundary_qualifications -> gtm_get_priority_queue -> gtm_save_activation_scores -> gtm_get_market_drafting_queue -> gtm_save_candidate_sequence -> gtm_get_market_review_queue. Stop there: no provider push or send.
HeyReach V1: gtm_verify_heyreach only inspects the existing configured campaign. It never creates, edits, enrolls, starts or resumes anything.
Rules: the lead's buying signal is the hook of the first touch; every message must be specific to one person; never invent facts; no signatures (Overloop adds them).
Safety: SEND_MODE=${safeMode()} — in locked mode campaigns are inert drafts and enrollment is blocked in code. Never try to work around the SafetyGuard.${UNATTENDED ? ' This is an unattended run: approval, launch, cleanup, simulations and source-control mutations are not exposed.' : ''}`;

function safeMode() {
  try {
    return getConfig().SEND_MODE;
  } catch {
    return 'locked';
  }
}

const server = new McpServer({ name: 'voidrip-gtm-engine', version: '0.2.0' }, { instructions: INSTRUCTIONS });

for (const tool of TOOLS.filter((candidate) => toolAllowedInRuntime(candidate.name, UNATTENDED))) {
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

server.registerResource('boundary', 'gtm://boundary', { title: 'GTM Boundary V1', mimeType: 'text/markdown' }, async (uri) => ({
  contents: [{ uri: uri.href, mimeType: 'text/markdown', text: getBoundaryContract().content }],
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
            'Run today’s VOIDRIP GTM loop end to end using the gtm_* tools, following the server instructions. ' +
            'Classify and route every new lead, write a lead-specific sequence for each (draft, self-critique, then final), push to Overloop, verify everything is inert, and write the daily brief. Summarize what you did and what you learned.',
        },
      },
    ],
  }),
);

await server.connect(new StdioServerTransport());
