import { z } from 'zod';
import type { ToolDef } from '../tools.js';
import {
  activationRows,
  approveHeyReachImport,
  approveHeyReachLaunch,
  getActivationReadiness,
  launchApprovedHeyReach,
  stageApprovedHeyReachImport,
} from './activation.js';
import {
  getMarketReplyQueue,
  MarketReplyTriageInput,
  marketReplyInbox,
  resolveMarketReply,
  saveMarketReplyTriage,
} from './replies.js';
import { ingestMarketReply, recordMarketOutcome, syncHeyReachReplies, syncHeyReachResults } from './results.js';
import { getMarketPerformance } from './performance.js';
import {
  getMarketLearningProposals,
  MarketLearningProposalInput,
  reviewMarketLearningProposal,
  saveMarketLearningProposal,
} from './learning.js';

const def = <S extends z.ZodRawShape>(tool: ToolDef<S>) => tool as unknown as ToolDef;

export const MARKET_RUNTIME_TOOLS: ToolDef[] = [
  def({
    name: 'gtm_get_activation_readiness',
    title: 'Check controlled-production readiness',
    description: 'Read-only readiness gate across the local 20-person buffer, HeyReach campaign, lead list, sender account and sequence. Performs no provider write.',
    input: {},
    readOnly: true,
    handler: () => getActivationReadiness(),
  }),
  def({
    name: 'gtm_get_activation_ledger',
    title: 'Read the provider activation ledger',
    description: 'Read-only activation states. Approval, import and launch remain distinct.',
    input: { status: z.enum(['IMPORT_APPROVED', 'STAGED', 'LAUNCH_APPROVED', 'ACTIVE']).optional() },
    readOnly: true,
    handler: (args) => activationRows(args.status),
  }),
  def({
    name: 'gtm_approve_heyreach_import',
    title: 'Record explicit import approval',
    description: 'Local first approval gate for explicitly named candidates. Does not call HeyReach and does not launch anything.',
    input: { candidate_ids: z.array(z.number().int()).min(1).max(20) },
    handler: (args) => approveHeyReachImport(args.candidate_ids),
  }),
  def({
    name: 'gtm_stage_heyreach_import',
    title: 'Stage import-approved leads in the HeyReach lead list',
    description: 'Writes only import-approved leads to the configured lead list while the campaign remains DRAFT. Requires the separate import approval; never starts the campaign.',
    input: {},
    handler: () => stageApprovedHeyReachImport(),
  }),
  def({
    name: 'gtm_approve_heyreach_launch',
    title: 'Record explicit launch approval',
    description: 'Second approval gate for staged candidates. Does not start the campaign.',
    input: { candidate_ids: z.array(z.number().int()).min(1).max(20) },
    handler: (args) => approveHeyReachLaunch(args.candidate_ids),
  }),
  def({
    name: 'gtm_launch_heyreach',
    title: 'Start the approved HeyReach campaign',
    description: 'The only HeyReach sending path. Requires staged prospects, separate launch approval, SEND_MODE=live and confirm=LAUNCH.',
    input: { confirm: z.string() },
    handler: (args) => launchApprovedHeyReach(args.confirm),
  }),
  def({
    name: 'gtm_sync_heyreach_results',
    title: 'Synchronize HeyReach results',
    description: 'Read provider state for launched activations and append idempotent result events. Performs no send.',
    input: {},
    handler: () => syncHeyReachResults(),
  }),
  def({
    name: 'gtm_sync_heyreach_replies',
    title: 'Synchronize HeyReach replies',
    description: 'Read HeyReach Unibox conversations for launched prospects. Missing text remains explicit; no reply is ever sent.',
    input: {},
    handler: () => syncHeyReachReplies(),
  }),
  def({
    name: 'gtm_ingest_market_reply',
    title: 'Attach text to a market reply',
    description: 'Attach user-provided or authorized-provider reply text. Never guesses missing text.',
    input: {
      reply_id: z.number().int().optional(),
      candidate_id: z.number().int().optional(),
      text: z.string().min(1).max(10_000),
      received_at: z.string().optional(),
    },
    handler: (args) => ingestMarketReply(args),
  }),
  def({
    name: 'gtm_get_market_reply_queue',
    title: 'Market replies awaiting triage',
    description: 'Read-only queue containing exact reply text, Person + Project context and what was sent.',
    input: { limit: z.number().int().min(1).max(50).default(20) },
    readOnly: true,
    handler: (args) => getMarketReplyQueue(args.limit),
  }),
  def({
    name: 'gtm_save_market_reply_triage',
    title: 'Triage a market reply and draft an answer',
    description: 'Stores triage and a human-review draft. It may stop or blacklist a prospect when required, but never sends the drafted answer.',
    input: MarketReplyTriageInput.shape,
    handler: (args) => saveMarketReplyTriage(args),
  }),
  def({
    name: 'gtm_market_reply_inbox',
    title: 'Market replies needing human action',
    description: 'Read-only hot-first inbox with drafts and next actions.',
    input: { limit: z.number().int().min(1).max(100).default(50) },
    readOnly: true,
    handler: (args) => marketReplyInbox(args.limit),
  }),
  def({
    name: 'gtm_resolve_market_reply',
    title: 'Resolve a market reply',
    description: 'Human closes the reply after answering or deciding not to answer.',
    input: { reply_id: z.number().int(), outcome: z.enum(['answered', 'meeting_booked', 'closed']).optional() },
    handler: (args) => resolveMarketReply(args),
  }),
  def({
    name: 'gtm_record_market_outcome',
    title: 'Record Scan, meeting or sale outcome',
    description: 'Append a real business outcome tied to Person + Project for the learning loop.',
    input: {
      candidate_id: z.number().int(),
      project_id: z.number().int(),
      event_type: z.enum(['MEETING_BOOKED', 'SCAN_STARTED', 'SCAN_COMPLETED', 'SALE']),
      event_at: z.string().optional(),
      value_number: z.number().optional(),
      currency: z.string().max(3).optional(),
      notes: z.string().max(1000).optional(),
    },
    handler: (args) => recordMarketOutcome(args),
  }),
  def({
    name: 'gtm_get_market_performance',
    title: 'Market Map performance analytics',
    description: 'Read-only outcomes by Kernel, signal, tier, route, hook, intent and playbook version.',
    input: { include_simulated: z.boolean().default(false) },
    readOnly: true,
    handler: (args) => getMarketPerformance({ includeSimulated: args.include_simulated }),
  }),
  def({
    name: 'gtm_save_market_learning_proposal',
    title: 'Save a proposal from real outcomes',
    description: 'Creates a review-only learning proposal. Never changes the Boundary and does not apply weights or playbook changes.',
    input: MarketLearningProposalInput.shape,
    handler: (args) => saveMarketLearningProposal(args),
  }),
  def({
    name: 'gtm_get_market_learning_proposals',
    title: 'Read learning proposals',
    description: 'Read-only proposal queue.',
    input: { limit: z.number().int().min(1).max(50).default(10) },
    readOnly: true,
    handler: (args) => getMarketLearningProposals(args.limit),
  }),
  def({
    name: 'gtm_review_market_learning',
    title: 'Approve or reject a learning proposal',
    description: 'Human-only gate. Applies only approved playbook and activation-weight changes; the Boundary remains untouched.',
    input: { proposal_id: z.number().int(), approve: z.boolean() },
    handler: (args) => reviewMarketLearningProposal(args),
  }),
];
