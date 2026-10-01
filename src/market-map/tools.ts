import { z } from 'zod';
import type { ToolDef } from '../tools.js';
import { ingestCandidates } from './ingest.js';
import {
  ActivationScoreInput,
  BoundaryQualificationInput,
  CandidateImportRecord,
  CandidateSequenceInput,
  MarketMapSnapshotRecord,
  ProjectResolutionInput,
  SignalEventInput,
} from './contracts.js';
import {
  getBoundaryQueue,
  getPriorityQueue,
  getResolutionQueue,
  saveActivationScores,
  saveBoundaryQualifications,
  saveProjectResolution,
} from './qualification.js';
import { getMarketDraftingQueue, getMarketReviewQueue, saveCandidateSequence, saveCandidateSequences } from './drafting.js';
import { getSignalQueue, saveSignalEvents } from './signals.js';
import { syncMarketMapSnapshot } from './snapshot.js';
import { getDailyBuffer } from './daily-buffer.js';

const def = <S extends z.ZodRawShape>(tool: ToolDef<S>) => tool as unknown as ToolDef;

export const MARKET_MAP_TOOLS: ToolDef[] = [
  def({
    name: 'gtm_sync_market_map_snapshot',
    title: 'Synchronize the governed Market Map snapshot',
    description: 'Idempotently imports already-governed Person + Project, Boundary and signal records from the Drive Market Map. No activation or provider action occurs.',
    input: { records: z.array(MarketMapSnapshotRecord).min(1).max(1000) },
    handler: (args) => syncMarketMapSnapshot(args.records),
  }),
  def({
    name: 'gtm_ingest_candidates',
    title: 'Ingest candidates into the persistent Market Map',
    description: 'Import normalized CSV/JSON records, deduplicate people and preserve every source observation. No qualification or contact occurs.',
    input: { source: z.string().min(1), source_lane_id: z.string().min(1), records: z.array(CandidateImportRecord).min(1).max(1000) },
    handler: (args) => ingestCandidates(args),
  }),
  def({
    name: 'gtm_get_resolution_queue',
    title: 'Candidates needing Person + Project resolution',
    description: 'Raw Market Map candidates with all source observations. Resolve the real project before Boundary qualification.',
    input: { limit: z.number().int().min(1).max(100).default(25) },
    readOnly: true,
    handler: (args) => getResolutionQueue(args.limit),
  }),
  def({
    name: 'gtm_save_project_resolution',
    title: 'Save Person + Project resolution',
    description: 'Save project identity, visibility, professional alignment, Kernel hypothesis and evidence.',
    input: ProjectResolutionInput.shape,
    handler: (args) => saveProjectResolution(args),
  }),
  def({
    name: 'gtm_get_boundary_queue',
    title: 'Records ready for Boundary qualification',
    description: 'Resolved Person + Project records with source evidence for conservative GTM_BOUNDARY_V1 qualification.',
    input: { limit: z.number().int().min(1).max(100).default(25) },
    readOnly: true,
    handler: (args) => getBoundaryQueue(args.limit),
  }),
  def({
    name: 'gtm_save_boundary_qualifications',
    title: 'Save Boundary qualification separately from intent',
    description: 'Persist PASS, HOLD or FAIL with gates, missing evidence, confidence and Boundary version. UNKNOWN is never converted to FAIL.',
    input: { items: z.array(BoundaryQualificationInput).min(1).max(100) },
    handler: (args) => saveBoundaryQualifications(args.items),
  }),
  def({
    name: 'gtm_get_signal_queue',
    title: 'Qualified prospects needing public signal refresh',
    description: 'PASS_OUTBOUND_V1 Person + Project records that need current public evidence before activation.',
    input: { limit: z.number().int().min(1).max(100).default(20) },
    readOnly: true,
    handler: (args) => getSignalQueue(args.limit),
  }),
  def({
    name: 'gtm_save_signal_events',
    title: 'Save public intent signals separately from fit',
    description: 'Upsert dated, evidenced public signals. FIT is unchanged and signal mentionability remains explicit.',
    input: { items: z.array(SignalEventInput).min(1).max(100) },
    handler: (args) => saveSignalEvents(args.items),
  }),
  def({
    name: 'gtm_get_priority_queue',
    title: 'Qualified prospects needing activation priority',
    description: 'Only PASS_OUTBOUND_V1 records. FIT is fixed; use signals and timing to decide priority, intent and route.',
    input: { limit: z.number().int().min(1).max(100).default(25) },
    readOnly: true,
    handler: (args) => getPriorityQueue(args.limit),
  }),
  def({
    name: 'gtm_save_activation_scores',
    title: 'Save intent and activation priority',
    description: 'Persist intent, freshness, A/B/C/DQ priority, route and angle without changing Boundary status.',
    input: { items: z.array(ActivationScoreInput).min(1).max(100) },
    handler: (args) => saveActivationScores(args.items),
  }),
  def({
    name: 'gtm_get_market_drafting_queue',
    title: 'Market Map prospects ready for a local draft',
    description: 'Activation-ready Person + Project records, evidence, seller profile and playbook. No provider action occurs.',
    input: { limit: z.number().int().min(1).max(100).default(25) },
    readOnly: true,
    handler: (args) => getMarketDraftingQueue(args.limit),
  }),
  def({
    name: 'gtm_save_candidate_sequence',
    title: 'Save a local Person + Project sequence',
    description: 'Lint and version a local sequence. A clean final enters human review; nothing is pushed or sent.',
    input: CandidateSequenceInput.shape,
    handler: (args) => saveCandidateSequence(args),
  }),
  def({
    name: 'gtm_save_candidate_sequences',
    title: 'Save a batch of local Person + Project sequences',
    description: 'Lint and version up to 100 local sequences. Clean finals enter human review; no provider action occurs.',
    input: { items: z.array(CandidateSequenceInput).min(1).max(100) },
    handler: (args) => saveCandidateSequences(args.items),
  }),
  def({
    name: 'gtm_get_market_review_queue',
    title: 'Local drafts awaiting human review',
    description: 'Final local drafts with exact copy, Boundary evidence and activation priority. Read-only.',
    input: { limit: z.number().int().min(1).max(100).default(25) },
    readOnly: true,
    handler: (args) => getMarketReviewQueue(args.limit),
  }),
  def({
    name: 'gtm_get_daily_buffer',
    title: 'Daily human-review buffer',
    description: 'Shows progress toward 20 evidence-backed prospects ready for human validation. Never lowers the quality floor and performs no provider action.',
    input: { limit: z.number().int().min(1).max(100).optional() },
    readOnly: true,
    handler: (args) => getDailyBuffer(args.limit),
  }),
];
