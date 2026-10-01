/**
 * One registry of GTM tools shared by the MCP server and the CLI. The engine is
 * deterministic; Codex supplies classification, routing, writing and learning.
 */
import { z } from 'zod';
import { businessId as configuredBusinessId, getConfig } from './config.js';
import { getPerformance } from './pipeline/analytics.js';
import { systemChecks } from './ops.js';
import { enrichFromOverloop } from './pipeline/enrich.js';
import { ClassificationInput, getClassificationQueue, saveClassifications } from './pipeline/classify.js';
import { LearningInput, saveLearnings } from './pipeline/learn.js';
import { getPlaybook } from './pipeline/playbook.js';
import { verifyHeyReachCampaign } from './pipeline/heyreach.js';
import { approvePushes, cleanupOverloop, launchApproved, pushToOverloop, reviewQueue, verifyPushes } from './pipeline/push.js';
import { detectReplies, getReplyQueue, ingestReply, replyInbox, ReplyTriageInput, resolveReply, saveReplyTriage, simulateReplies } from './pipeline/replies.js';
import { recordOutcome, simulateResults, syncResults } from './pipeline/results.js';
import { status, writeReport } from './pipeline/report.js';
import { getDraftingQueue, SequenceInput, saveSequence } from './pipeline/sequence.js';
import { doctor, getSellerProfile, init, SellerProfile, setSellerProfile, syncSellerFromSource } from './pipeline/setup.js';
import { ensureSubscription, getSetup, pauseSubscription, resumeSubscription, sourceLeads, updateIcp } from './pipeline/source.js';
import { MARKET_MAP_TOOLS } from './market-map/tools.js';
import { MARKET_RUNTIME_TOOLS } from './market-runtime/tools.js';

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  input: S;
  readOnly?: boolean;
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<unknown> | unknown;
}

const def = <S extends z.ZodRawShape>(t: ToolDef<S>) => t as unknown as ToolDef;

export const TOOLS: ToolDef[] = [
  def({
    name: 'gtm_doctor',
    title: 'Health check',
    description:
      'Health check for the active Drive Market Map → Codex → local review → HeyReach path, safety mode, daily target, database, agent CLI and schedule. Legacy Max/Overloop are reported only when configured.',
    input: {},
    readOnly: true,
    handler: async () => ({ ...(await doctor()), system: systemChecks() }),
  }),
  def({
    name: 'gtm_status',
    title: 'Pipeline status',
    description: 'Counts of leads by stage, pushed campaigns, outcomes, playbook version, blocked safety events and recent runs.',
    input: {},
    readOnly: true,
    handler: () => status(),
  }),
  def({
    name: 'gtm_init',
    title: 'Onboard a company',
    description:
      'Onboard the seller company: creates (or reuses) the Max business from its website (Max auto-builds the ICP) and caches the seller profile. Pass business_id to reuse an existing Max business.',
    input: { website: z.string().optional(), business_id: z.number().int().optional() },
    handler: (a) => init({ website: a.website, businessId: a.business_id }),
  }),
  def({
    name: 'gtm_setup',
    title: 'ICP, subscriptions & signal catalog',
    description:
      'Read the Max business, its ICP, current signal subscriptions, the full signal catalog (with config schemas) and learned signal weights. Use before changing subscriptions.',
    input: { include_catalog: z.boolean().default(true) },
    readOnly: true,
    handler: (a) => getSetup({ includeCatalog: a.include_catalog }),
  }),
  def({
    name: 'gtm_update_icp',
    title: 'Update ICP',
    description:
      'Patch the Max ICP. Fields: target_job_titles, target_locations, target_industries, company_types, company_sizes, mandatory_keywords, excluded_companies. The ICP id is required (from gtm_setup).',
    input: {
      icp: z
        .object({
          id: z.number().int(),
          target_job_titles: z.array(z.string()).optional(),
          target_locations: z.array(z.string()).optional(),
          target_industries: z.array(z.string()).optional(),
          company_types: z.array(z.string()).optional(),
          company_sizes: z.array(z.string()).optional(),
          mandatory_keywords: z.array(z.string()).optional(),
          excluded_companies: z.array(z.string()).optional(),
        })
        .describe('ICP patch'),
    },
    handler: async (a) => {
      const biz = await updateIcp(a.icp, { businessId: configuredBusinessId() });
      await syncSellerFromSource();
      return biz.ideal_customer_profile;
    },
  }),
  def({
    name: 'gtm_manage_subscription',
    title: 'Create / pause / resume a Max signal subscription',
    description:
      'Lead-searching control. create: subscribe the business to a signal (config must follow the signal input_schema from gtm_setup). pause/resume by subscription_id.',
    input: {
      action: z.enum(['create', 'pause', 'resume']),
      signal_slug: z.string().optional(),
      name: z.string().optional(),
      config: z.record(z.string(), z.unknown()).optional(),
      subscription_id: z.number().int().optional(),
    },
    handler: async (a) => {
      if (a.action === 'create') {
        if (!a.signal_slug) throw new Error('signal_slug required');
        return ensureSubscription({ signal_slug: a.signal_slug, name: a.name ?? a.signal_slug, config: a.config });
      }
      if (!a.subscription_id) throw new Error('subscription_id required');
      if (a.action === 'pause') return pauseSubscription(a.subscription_id);
      return resumeSubscription(a.subscription_id, { businessId: configuredBusinessId() });
    },
  }),
  def({
    name: 'gtm_seller_profile',
    title: 'Get / set seller profile',
    description:
      'The seller context used in every draft: value_proposition, proof_points, primary_cta, tone, language, do_not_say. Omit `set` to read.',
    input: { set: SellerProfile.partial().optional() },
    handler: (a) => (a.set ? setSellerProfile(a.set) : getSellerProfile()),
  }),
  def({
    name: 'gtm_source_leads',
    title: 'Source leads from Max',
    description:
      'Pull new signal-based leads from Max into the local pipeline (deduplicated), then check each one against Overloop history. Returns counts by signal.',
    input: { max_pages: z.number().int().min(1).max(50).optional(), enrich: z.boolean().optional() },
    handler: async (a) => {
      const cfg = getConfig();
      const sourced = await sourceLeads({ maxPages: a.max_pages ?? cfg.GTM_SOURCE_MAX_PAGES });
      return a.enrich ?? cfg.GTM_ENRICH_FROM_OVERLOOP ? { ...sourced, overloop_check: await enrichFromOverloop() } : sourced;
    },
  }),
  def({
    name: 'gtm_enrich_from_overloop',
    title: 'Check new leads against Overloop',
    description:
      'Read-only: look up each new lead in Overloop (email, then LinkedIn) — existing prospect, email status, bounces, past replies, exclusion. Feeds classification and hard routing (bounced -> LinkedIn, replied/excluded -> human). Runs automatically after gtm_source_leads.',
    input: { limit: z.number().int().min(1).max(500).default(200) },
    handler: (a) => enrichFromOverloop({ limit: a.limit }),
  }),
  ...MARKET_MAP_TOOLS,
  ...MARKET_RUNTIME_TOOLS,
  def({
    name: 'gtm_get_classification_queue',
    title: 'Leads to classify',
    description:
      'Next batch of unclassified leads with their signal evidence, plus seller profile, playbook, weights and recent learnings. Classify each and call gtm_save_classifications.',
    input: { limit: z.number().int().min(1).max(50).default(20) },
    readOnly: true,
    handler: (a) => getClassificationQueue(a.limit),
  }),
  def({
    name: 'gtm_save_classifications',
    title: 'Save classifications + routing',
    description:
      'Save per lead: tier (A/B/C/DQ), persona, intent_strength (1-5), preferred route (email|linkedin|both|none), angle, reasoning and a channel_plan {first_channel, email:{role,content}, linkedin:{role,content}, why} deciding what each channel says. Hard rules (data + Overloop history) adjust route and plan.',
    input: { items: z.array(ClassificationInput).min(1).max(50) },
    handler: (a) => saveClassifications(a.items),
  }),
  def({
    name: 'gtm_get_drafting_queue',
    title: 'Leads to write sequences for',
    description:
      'Classified leads with full context (signal evidence, classification, seller profile, playbook, route template, winning examples, current draft + lint). Write a sequence per lead and save with gtm_save_sequence.',
    input: { limit: z.number().int().min(1).max(25).default(8) },
    readOnly: true,
    handler: (a) => getDraftingQueue(a.limit),
  }),
  def({
    name: 'gtm_save_sequence',
    title: 'Save a sequence (draft or final)',
    description:
      'Validate + lint + store a lead-specific sequence. Step types: email{delay_days,subject,body}, linkedin_visit{delay_days}, linkedin_invite{delay_days,note<=300}, linkedin_message{delay_days,message}. status "final" only sticks when there are no lint errors. No signatures — Overloop appends the sender signature.',
    input: { sequence: SequenceInput },
    handler: (a) => saveSequence(a.sequence),
  }),
  def({
    name: 'gtm_push_to_overloop',
    title: 'Push final sequences to Overloop',
    description:
      'Create/reuse the Overloop prospect and an inert draft campaign per lead with the finalized copy. In SEND_MODE=locked nothing is enrolled or activated — the SafetyGuard blocks it in code.',
    input: {
      limit: z.number().int().min(1).max(100).default(50),
      lead_ids: z.array(z.number().int()).optional(),
      enroll: z.boolean().default(false).describe('attempt enrollment (blocked unless SEND_MODE=live)'),
    },
    handler: (a) => pushToOverloop({ limit: a.limit, leadIds: a.lead_ids, enroll: a.enroll }),
  }),
  def({
    name: 'gtm_verify_overloop',
    title: 'Verify Overloop campaigns are inert',
    description: 'Read back the campaigns the bot created: status and enrollment count. all_inert must be true in locked mode.',
    input: { limit: z.number().int().min(1).max(100).default(25) },
    readOnly: true,
    handler: (a) => verifyPushes({ limit: a.limit }),
  }),
  def({
    name: 'gtm_verify_heyreach',
    title: 'Verify the configured HeyReach campaign',
    description:
      'Read-only: inspect the existing HeyReach campaign selected by HEYREACH_CAMPAIGN_ID. Reports identity, status, lead count and whether it remains an inert DRAFT. Never creates, edits, starts or resumes a campaign.',
    input: {},
    readOnly: true,
    handler: () => verifyHeyReachCampaign(),
  }),
  def({
    name: 'gtm_sync_results',
    title: 'LEGACY: sync Overloop results + replies',
    description:
      'Optional legacy Overloop path only. The active V1 path uses gtm_sync_heyreach_results and gtm_sync_heyreach_replies.',
    input: {},
    handler: async () => ({ results: await syncResults(), replies: await detectReplies() }),
  }),
  def({
    name: 'gtm_ingest_reply',
    title: 'Add a reply text',
    description:
      'Attach the text of a prospect reply (Overloop’s API exposes that someone replied, not what they said). Get the text from a mailbox MCP (e.g. Gmail search from:<prospect email>) or from the user. Match by reply_id, lead_id or prospect email.',
    input: {
      reply_id: z.number().int().optional(),
      lead_id: z.number().int().optional(),
      email: z.string().optional(),
      channel: z.enum(['email', 'linkedin']).optional(),
      text: z.string().min(1).max(10_000),
      received_at: z.string().optional(),
    },
    handler: (a) => ingestReply(a),
  }),
  def({
    name: 'gtm_get_reply_queue',
    title: 'Replies to triage',
    description:
      'Replies with text waiting for triage (with the lead, what we sent, seller profile) plus replies still missing their text.',
    input: { limit: z.number().int().min(1).max(50).default(20) },
    readOnly: true,
    handler: (a) => getReplyQueue(a.limit),
  }),
  def({
    name: 'gtm_save_reply_triage',
    title: 'Triage a reply + draft the answer',
    description:
      'Save category (interested|question|objection|not_now|referral|not_interested|unsubscribe|out_of_office|wrong_person|other), sentiment, summary, next action and a drafted response. Safe follow-ups run automatically: unsubscribe/not interested -> Overloop exclusion list, human replies -> stop the sequence, hot replies -> assign the conversation. Answers are never sent by the bot.',
    input: ReplyTriageInput.shape,
    handler: (a) => saveReplyTriage(a),
  }),
  def({
    name: 'gtm_reply_inbox',
    title: 'Replies waiting on a human',
    description: 'Hot replies first, each with the summary, next action and drafted answer.',
    input: { limit: z.number().int().min(1).max(100).default(50) },
    readOnly: true,
    handler: (a) => replyInbox(a.limit),
  }),
  def({
    name: 'gtm_resolve_reply',
    title: 'Close a reply',
    description: 'Mark a reply handled by a human; outcome meeting_booked feeds the learning loop.',
    input: { reply_id: z.number().int(), outcome: z.enum(['answered', 'meeting_booked', 'closed']).optional() },
    handler: (a) => resolveReply(a),
  }),
  def({
    name: 'gtm_simulate_replies',
    title: 'TEST: simulate replies',
    description: 'Test mode only: inject realistic replies (interested, question, not now, unsubscribe, OOO, referral) for pushed leads, flagged is_simulated.',
    input: { count: z.number().int().min(1).max(20).default(6) },
    handler: (a) => simulateReplies({ count: a.count }),
  }),
  def({
    name: 'gtm_review_queue',
    title: 'Campaigns awaiting human review',
    description: 'Pushed, not-yet-launched campaigns with their literal steps and Overloop links, for a human to read before approving.',
    input: { limit: z.number().int().min(1).max(100).default(25) },
    readOnly: true,
    handler: (a) => reviewQueue(a.limit),
  }),
  def({
    name: 'gtm_approve',
    title: 'Approve campaigns for launch',
    description: 'Human review gate: mark pushed campaigns approved (specific lead_ids, or all pending). Only call when the user explicitly approves.',
    input: { lead_ids: z.array(z.number().int()).optional(), revoke: z.boolean().default(false).describe('true = withdraw approval') },
    handler: (a) => approvePushes(a.lead_ids, a.revoke),
  }),
  def({
    name: 'gtm_launch',
    title: 'Launch approved campaigns (sends!)',
    description:
      'The only sending path: enroll + activate approved campaigns. Requires SEND_MODE=live, prior gtm_approve, and confirm "SEND". Re-checks replied/excluded/bounced first. Blocked by the SendGuard in locked mode. Only call when the user explicitly asks to send.',
    input: { lead_ids: z.array(z.number().int()).optional(), confirm: z.string().optional() },
    handler: (a) => launchApproved({ leadIds: a.lead_ids, confirm: a.confirm }),
  }),
  def({
    name: 'gtm_record_outcome',
    title: 'Record reply sentiment / meeting',
    description: 'Record what the API cannot see: positive reply, meeting booked. Used by the learning step.',
    input: { lead_id: z.number().int(), replied: z.boolean().optional(), positive: z.boolean().optional(), meeting: z.boolean().optional() },
    handler: (a) => recordOutcome(a),
  }),
  def({
    name: 'gtm_simulate_results',
    title: 'TEST: simulate outcomes',
    description: 'Test mode only: synthesize reproducible outcomes (flagged is_simulated) so the learning loop can run without sending.',
    input: { seed: z.number().int().default(42) },
    handler: (a) => simulateResults({ seed: a.seed }),
  }),
  def({
    name: 'gtm_get_performance',
    title: 'LEGACY: Overloop performance analytics',
    description:
      'Reply / positive / meeting rates by signal, tier, persona, route, hook_type, intent and playbook version, plus replied vs. non-replied examples. Input for the learning step.',
    input: { include_simulated: z.boolean().default(true), since_days: z.number().int().default(90) },
    readOnly: true,
    handler: (a) => getPerformance({ includeSimulated: a.include_simulated, sinceDays: a.since_days }),
  }),
  def({
    name: 'gtm_get_playbook',
    title: 'Current playbook',
    description: 'The living playbook (markdown) that classification and writing follow, with its version.',
    input: {},
    readOnly: true,
    handler: () => getPlaybook(),
  }),
  def({
    name: 'gtm_save_learnings',
    title: 'LEGACY: save Max/Overloop learnings',
    description:
      'Record evidence-backed insights, optionally the full updated playbook_markdown, weight multipliers (signal:/persona:/route:/hook:/tier:) and Max subscription changes (suggested, or applied when apply_subscription_changes=true).',
    input: LearningInput.shape,
    handler: (a) => saveLearnings(a),
  }),
  def({
    name: 'gtm_write_report',
    title: 'Write the daily brief',
    description: 'Write reports/<date>.md for the active Market Map → human review → gated HeyReach path, including real outcomes and proposal-only learning.',
    input: { date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() },
    handler: (a) => writeReport(a.date),
  }),
  def({
    name: 'gtm_cleanup_overloop',
    title: 'Delete test objects from Overloop',
    description: 'Delete every campaign (and prospect it created) the bot pushed with the configured name prefix. dry_run lists them first.',
    input: { dry_run: z.boolean().default(true) },
    handler: (a) => cleanupOverloop({ dryRun: a.dry_run }),
  }),
];

export function findTool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name || t.name === `gtm_${name.replace(/-/g, '_')}`);
}

export async function callTool(name: string, args: unknown): Promise<unknown> {
  const tool = findTool(name);
  if (!tool) throw new Error(`Unknown tool ${name}. Available: ${TOOLS.map((t) => t.name).join(', ')}`);
  const parsed = z.object(tool.input).parse(args ?? {});
  return tool.handler(parsed);
}
