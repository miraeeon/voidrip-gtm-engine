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
Daily loop: gtm_get_activation_readiness -> gtm_sync_heyreach_results -> gtm_sync_heyreach_replies -> gtm_sync_market_map_snapshot -> resolve -> qualify -> signal -> prioritize -> draft -> gtm_get_daily_buffer -> human-review sheet -> report. Stop at human review.
Local E2E: gtm_ingest_candidates -> gtm_get_resolution_queue -> gtm_save_project_resolution -> gtm_get_boundary_queue -> gtm_save_boundary_qualifications -> gtm_get_priority_queue -> gtm_save_activation_scores -> gtm_get_market_drafting_queue -> gtm_save_candidate_sequence -> gtm_get_market_review_queue.
HeyReach V1 uses two distinct gates: gtm_approve_heyreach_import then gtm_stage_heyreach_import; later gtm_approve_heyreach_launch then gtm_launch_heyreach. Never combine the approvals. Adding approved leads targets the configured lead list while the campaign remains DRAFT.
Results and learning: provider events, exact replies, Scan and sales stay tied to Person + Project. Learning creates a proposal; a human separately approves it. The Boundary is never changed automatically.
Rules: the public project signal is the hook; every message must be specific to one person; never invent facts; never send a reply automatically.
Safety: SEND_MODE=${safeMode()} — in locked mode campaign launch is blocked in code. Provider import also requires explicit allowImport. Never try to work around the SafetyGuard.${UNATTENDED ? ' This is an unattended run: provider writes, approvals, launch, reply triage, learning application, simulations and source-control mutations are not exposed.' : ''}`;

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
  { title: 'Prepare the daily GTM review buffer', description: 'Refresh the governed Market Map and prepare up to 20 evidence-backed prospects for human review without provider writes.' },
  () => ({
    messages: [
      {
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text:
            'Run today’s VOIDRIP GTM preparation loop using the governed Drive Market Map and the gtm_* tools. ' +
            'Preflight the locked HeyReach configuration, sync results and replies only for previously launched activations, refresh Person + Project records, qualify, refresh public signals, prioritize and draft until the human-review buffer reaches 20 or report the exact evidence-backed deficit. ' +
            'Stop at the review sheet. Do not approve, import, launch, send, or apply a learning proposal. Confirm every provider action remained NONE.',
        },
      },
    ],
  }),
);

await server.connect(new StdioServerTransport());
