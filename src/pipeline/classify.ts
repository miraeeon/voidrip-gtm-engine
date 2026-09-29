import { z } from 'zod';
import { all, logRun, nowIso, one, run, today, tx } from '../db/db.js';
import { getConfig } from '../config.js';
import { getPlaybook } from './playbook.js';
import { applyRoutingRules, Channel, channelsAvailable, overloopContext, resolveFirstChannel, Route } from './route.js';
import { getWeights } from './weights.js';
import { latestLearnings } from './learn.js';
import { getSellerProfile } from './setup.js';

const ChannelTrack = z.object({
  role: z.enum(['lead', 'support', 'none']).describe('lead = carries the main pitch; support = warms up / follows up; none = unused'),
  content: z
    .string()
    .min(5)
    .max(400)
    .describe('what THIS channel should say for this lead (e.g. "email: signal hook + 48h shortlist offer + proof point"; "LinkedIn: no-pitch connect referencing their post, then a question")'),
});

/** Claude's per-lead decision of which channel says what. */
export const ChannelPlan = z.object({
  first_channel: Channel.describe('channel that carries the first real message'),
  email: ChannelTrack,
  linkedin: ChannelTrack,
  why: z.string().min(5).max(300).describe('why this split fits this person (seniority, where the signal happened, deliverability, language)'),
});
export type ChannelPlan = z.infer<typeof ChannelPlan>;

export const ClassificationInput = z.object({
  lead_id: z.number().int(),
  tier: z.enum(['A', 'B', 'C', 'DQ']).describe('A = strong fit + strong signal, B = good, C = weak, DQ = do not contact'),
  persona: z.string().min(2).max(60).describe('short persona label, e.g. "agency-owner", "cmo", "bizdev-manager"'),
  intent_strength: z.number().int().min(1).max(5).describe('1 = cold, 5 = actively in-market'),
  route: Route.describe('preferred channel mix before data checks'),
  angle: z.string().min(3).max(200).describe('the one commercial angle / hook to lead with'),
  channel_plan: ChannelPlan.optional().describe('what each channel carries; required unless tier is DQ / route none'),
  reasoning: z.string().min(10).max(800),
});
export type ClassificationInput = z.infer<typeof ClassificationInput>;

export function leadBrief(l: any) {
  return {
    lead_id: l.id,
    name: l.name,
    job_title: l.job_title,
    headline: l.headline,
    location: l.location,
    company: l.company,
    company_industry: l.company_industry,
    company_size: l.company_size,
    company_website: l.company_website,
    company_summary: l.company_summary,
    icp_score: l.icp_score,
    signal: {
      slug: l.signal_slug,
      name: l.signal_name,
      engagement_type: l.engagement_type,
      context: l.engagement_context,
      excerpt: l.signal_excerpt,
      post_url: l.post_url,
      triggered_at: l.triggered_at,
    },
    channels_available: channelsAvailable(l),
    overloop: overloopContext(l) ?? 'not checked (run gtm_enrich_from_overloop)',
  };
}

/**
 * Keep the model's channel plan consistent with the final (rule-adjusted) route:
 * a channel the route doesn't allow can't carry content.
 */
export function reconcilePlan(plan: ChannelPlan | undefined, route: Route): ChannelPlan | null {
  if (route === 'none') return null;
  const base: ChannelPlan = plan ?? {
    first_channel: route === 'linkedin' ? 'linkedin' : 'email',
    email: { role: route === 'linkedin' ? 'none' : 'lead', content: 'signal-hook email sequence (auto-filled: no plan given)' },
    linkedin: { role: route === 'email' ? 'none' : route === 'linkedin' ? 'lead' : 'support', content: 'connect + follow-up messages (auto-filled: no plan given)' },
    why: 'default plan derived from route',
  };
  const out: ChannelPlan = structuredClone(base);
  if (route === 'email') out.linkedin = { role: 'none', content: 'not used (route is email)' };
  if (route === 'linkedin') out.email = { role: 'none', content: 'not used (route is linkedin)' };
  if (route === 'both') {
    if (out.email.role === 'none') out.email.role = 'support';
    if (out.linkedin.role === 'none') out.linkedin.role = 'support';
  }
  out.first_channel = resolveFirstChannel(route, base.first_channel)!;
  if (out[out.first_channel].role === 'none') out[out.first_channel].role = 'lead';
  return out;
}

export function classifiedToday(): number {
  return one<{ n: number }>(`SELECT COUNT(*) n FROM classifications WHERE substr(created_at,1,10) = ?`, today())?.n ?? 0;
}

export function getClassificationQueue(limit = 20) {
  const cap = getConfig().GTM_DAILY_NEW_LEADS;
  const left = Math.max(0, cap - classifiedToday());
  const leads = left === 0 ? [] : all(`SELECT * FROM leads WHERE status = 'new' ORDER BY COALESCE(icp_score, 0) DESC, triggered_at DESC LIMIT ?`, Math.min(limit, left));
  const remaining = one<{ n: number }>(`SELECT COUNT(*) n FROM leads WHERE status = 'new'`)?.n ?? 0;
  const pb = getPlaybook();
  return {
    remaining_in_queue: left === 0 ? 0 : remaining,
    daily_cap: { limit: cap, used: cap - left, reached: left === 0, note: left === 0 ? `Daily classification cap reached (GTM_DAILY_NEW_LEADS=${cap}); ${remaining} leads wait for tomorrow.` : undefined },
    seller: getSellerProfile(),
    playbook_version: pb.version,
    playbook: pb.content,
    weights: getWeights(),
    recent_learnings: latestLearnings(2),
    leads: leads.map(leadBrief),
    instructions:
      'Classify every lead with gtm_save_classifications: tier, persona, intent, route AND a channel_plan (which channel opens, what the email track says, what the LinkedIn track says, why). Use the playbook, weights and the Overloop history. Hard data rules adjust route + plan on save.',
  };
}

export function saveClassifications(items: ClassificationInput[]) {
  const pbVersion = getPlaybook().version;
  const results: { lead_id: number; tier: string; route: string; first_channel: string | null; route_reason: string }[] = [];
  const errors: { lead_id: number; error: string }[] = [];
  tx(() => {
    for (const raw of items) {
      const parsed = ClassificationInput.safeParse(raw);
      if (!parsed.success) {
        errors.push({ lead_id: (raw as any)?.lead_id ?? -1, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
        continue;
      }
      const c = parsed.data;
      const lead = one<any>('SELECT * FROM leads WHERE id = ?', c.lead_id);
      if (!lead) {
        errors.push({ lead_id: c.lead_id, error: 'unknown lead' });
        continue;
      }
      const { route, reason } = applyRoutingRules(lead, c.route, c.tier);
      const plan = reconcilePlan(c.channel_plan, route);
      run(
        `INSERT INTO classifications(lead_id, tier, persona, intent_strength, route, model_route, route_reason, angle, reasoning, playbook_version, created_at, first_channel, channel_plan_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(lead_id) DO UPDATE SET tier=excluded.tier, persona=excluded.persona, intent_strength=excluded.intent_strength,
           route=excluded.route, model_route=excluded.model_route, route_reason=excluded.route_reason, angle=excluded.angle,
           reasoning=excluded.reasoning, playbook_version=excluded.playbook_version, created_at=excluded.created_at,
           first_channel=excluded.first_channel, channel_plan_json=excluded.channel_plan_json`,
        c.lead_id,
        c.tier,
        c.persona.toLowerCase(),
        c.intent_strength,
        route,
        c.route,
        reason,
        c.angle,
        c.reasoning,
        pbVersion,
        nowIso(),
        plan?.first_channel ?? null,
        plan ? JSON.stringify(plan) : null,
      );
      const status = route === 'none' ? 'disqualified' : 'classified';
      run('UPDATE leads SET status = ? WHERE id = ?', status, c.lead_id);
      results.push({ lead_id: c.lead_id, tier: c.tier, route, first_channel: plan?.first_channel ?? null, route_reason: reason });
    }
  });
  const summary = {
    saved: results.length,
    errors,
    by_route: countBy(results.map((r) => r.route)),
    by_first_channel: countBy(results.filter((r) => r.first_channel).map((r) => r.first_channel!)),
    by_tier: countBy(results.map((r) => r.tier)),
    rerouted: results.filter((r) => !r.route_reason.startsWith(`model: ${r.route}`) && r.route_reason !== 'disqualified'),
  };
  logRun('classify', summary);
  return summary;
}

export function countBy(xs: string[]): Record<string, number> {
  const o: Record<string, number> = {};
  for (const x of xs) o[x] = (o[x] ?? 0) + 1;
  return o;
}
