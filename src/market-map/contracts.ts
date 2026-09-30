import { z } from 'zod';
import { HookType, Step } from '../pipeline/sequence.js';
import { Route } from '../pipeline/route.js';

const nullableText = z.string().trim().min(1).nullable().optional();

export const CandidateImportRecord = z.object({
  source_record_id: z.string().trim().min(1),
  person_name: z.string().trim().min(1),
  professional_profile_url: nullableText,
  email: z.string().email().nullable().optional(),
  phone: nullableText,
  headline: nullableText,
  current_role: nullableText,
  current_org: nullableText,
  org_url: nullableText,
  location: nullableText,
  project_name_if_visible: nullableText,
  project_url_if_visible: nullableText,
  project_description_if_visible: nullableText,
  evidence: z.array(z.string().trim().min(1)).default([]),
  retrieved_at: z.string().datetime().optional(),
  raw_source_data: z.record(z.string(), z.unknown()).default({}),
});
export type CandidateImportRecord = z.infer<typeof CandidateImportRecord>;

export const ProjectVisibility = z.enum(['VISIBLE', 'PARTIAL', 'NOT_VISIBLE', 'UNKNOWN']);
export const ProjectAlignment = z.enum([
  'CURRENT_ORG_PROJECT',
  'SELF_OWNED_PROFESSIONAL_PROJECT',
  'MULTI_ROLE_PROJECT',
  'MISALIGNED_WITH_PROFESSIONAL_IDENTITY',
  'UNKNOWN',
]);
export const Kernel = z.enum(['VENTURE', 'HARDWARE', 'RESEARCH', 'MEDIA', 'UNKNOWN']);

export const ProjectResolutionInput = z.object({
  candidate_id: z.number().int().positive(),
  name: nullableText,
  url: nullableText,
  description: nullableText,
  kernel_primary: Kernel,
  kernel_secondary: Kernel.nullable().optional(),
  project_visibility: ProjectVisibility,
  project_alignment: ProjectAlignment,
  status: nullableText,
  evidence: z.array(z.string().trim().min(1)).default([]),
});
export type ProjectResolutionInput = z.infer<typeof ProjectResolutionInput>;

export const BoundaryStatus = z.enum(['PASS_OUTBOUND_V1', 'PASS_MARKET_ONLY', 'HOLD_EVIDENCE', 'FAIL_BOUNDARY']);
const YesNoUnknown = z.enum(['YES', 'NO', 'UNKNOWN']);
const Authority = z.enum(['INDIVIDUAL', 'DISTRIBUTED', 'UNKNOWN']);
const Level = z.enum(['HIGH', 'SUFFICIENT', 'LOW', 'UNKNOWN']);
const ProfessionalVisibility = z.enum(['ALIGNED', 'PARTIAL', 'MISALIGNED', 'UNKNOWN']);

export const BoundaryQualificationInput = z.object({
  candidate_id: z.number().int().positive(),
  project_id: z.number().int().positive(),
  boundary_version: z.literal('GTM_BOUNDARY_V1'),
  boundary_status: BoundaryStatus,
  kernel_primary: Kernel,
  kernel_secondary: Kernel.nullable().optional(),
  project_real: YesNoUnknown,
  strategic_authority: Authority,
  ambition: Level,
  intrinsic_complexity: Level,
  professional_project_visibility: ProfessionalVisibility,
  failed_gates: z.array(z.string()).default([]),
  missing_evidence: z.array(z.string()).default([]),
  evidence_summary: z.string().min(1).max(4000),
  confidence: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  reasoning: z.string().min(1).max(4000),
});
export type BoundaryQualificationInput = z.infer<typeof BoundaryQualificationInput>;

export const ActivationScoreInput = z.object({
  candidate_id: z.number().int().positive(),
  project_id: z.number().int().positive(),
  intent_strength: z.number().int().min(1).max(5).nullable().default(null),
  freshness: z.enum(['CURRENT', 'RECENT', 'STALE', 'UNKNOWN']),
  priority_tier: z.enum(['A', 'B', 'C', 'DQ']),
  route: Route,
  angle: z.string().min(1).max(300),
  channel_plan: z.record(z.string(), z.unknown()).nullable().default(null),
  reasoning: z.string().min(1).max(4000),
});
export type ActivationScoreInput = z.infer<typeof ActivationScoreInput>;

export const CandidateSequenceInput = z.object({
  candidate_id: z.number().int().positive(),
  project_id: z.number().int().positive(),
  angle: z.string().min(3).max(200),
  hook_type: HookType,
  steps: z.array(Step).min(1).max(8),
  critique: z.string().max(2000).optional(),
  status: z.enum(['draft', 'final']).default('draft'),
});
export type CandidateSequenceInput = z.infer<typeof CandidateSequenceInput>;
