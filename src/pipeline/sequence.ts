import { z } from 'zod';
import { all, logRun, nowIso, one, run, today, tx } from '../db/db.js';
import { getConfig } from '../config.js';
import { latestLearnings } from './learn.js';
import { getSellerProfile } from './setup.js';
import { leadBrief } from './classify.js';
import { getPlaybook } from './playbook.js';
import { Route } from './route.js';

export const EmailStep = z.object({
  type: z.literal('email'),
  delay_days: z.number().int().min(0).max(14),
  subject: z.string().min(2).max(120),
  body: z.string().min(20).max(3000).describe('plain text; blank lines separate paragraphs'),
});
export const LinkedinVisitStep = z.object({
  type: z.literal('linkedin_visit'),
  delay_days: z.number().int().min(0).max(14),
});
export const LinkedinInviteStep = z.object({
  type: z.literal('linkedin_invite'),
  delay_days: z.number().int().min(0).max(14),
  note: z.string().max(300).describe('connection note, max 300 chars; empty string = no note'),
});
export const LinkedinMessageStep = z.object({
  type: z.literal('linkedin_message'),
  delay_days: z.number().int().min(0).max(14),
  message: z.string().min(10).max(1900),
});
export const Step = z.discriminatedUnion('type', [EmailStep, LinkedinVisitStep, LinkedinInviteStep, LinkedinMessageStep]);
export type Step = z.infer<typeof Step>;

export const HookType = z.enum([
  'signal_reference',
  'company_trigger',
  'role_pain',
  'peer_proof',
  'competitor_context',
  'question',
  'other',
]);

export const SequenceInput = z.object({
  lead_id: z.number().int(),
  angle: z.string().min(3).max(200),
  hook_type: HookType,
  steps: z.array(Step).min(1).max(8),
  critique: z.string().max(2000).optional().describe('your self-critique notes (what you checked / changed)'),
  status: z.enum(['draft', 'final']).default('draft'),
});
export type SequenceInput = z.infer<typeof SequenceInput>;

export interface LintIssue {
  level: 'error' | 'warning';
  step: number | null;
  rule: string;
  message: string;
}

const SPAM = [
  'free',
  'guarantee',
  'act now',
  'limited time',
  'click here',
  'risk-free',
  '100%',
  'no obligation',
  'buy now',
  'winner',
  'urgent',
  '$$$',
  'cash',
  'amazing deal',
];
const CLICHES = [
  'i hope this email finds you well',
  'i hope you are doing well',
  'i hope this finds you well',
  'just checking in',
  'just following up',
  'circling back',
  'touching base',
  'i wanted to reach out',
  'synergy',
  'game-changer',
  'game changer',
  'revolutionary',
  'cutting-edge',
];
const PLACEHOLDER = /(\[[A-Z][^\]]{1,30}\]|\{\{|\}\}|<insert|lorem ipsum|xxx)/i;

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** Quantified / comparative claims that must be backed by the seller's proof points. */
// Performance claims only — "double" alone is a normal word ("sans double outil"), so it must sit next to a metric.
const METRIC = '(repl(y|ies)|responses?|meetings?|pipeline|revenue|conversions?|rates?|results|leads|deals|sales|roi)';
const CLAIM = new RegExp(
  [
    String.raw`\b\d+(\.\d+)?\s?(%|x\b|×)`,
    String.raw`\b(2x|3x|5x|10x)\b`,
    String.raw`\b(doubled?|doubles|doubling|tripled?|triples|tripling)\b(\W+\w+){0,3}?\W+${METRIC}\b`,
    String.raw`\b${METRIC}\b(\W+\w+){0,3}?\W+(doubled?|doubles|tripled?|triples)\b`,
    String.raw`\b(far|significantly|noticeably|dramatically) (more|better|higher)\b`,
  ].join('|'),
  'i',
);

export function lintSequence(
  seq: SequenceInput,
  route: Route,
  lead: { first_name?: string | null; company?: string | null },
  proofPoints: string[] = [],
  firstChannel: 'email' | 'linkedin' | null = null,
): LintIssue[] {
  const issues: LintIssue[] = [];
  const add = (level: LintIssue['level'], step: number | null, rule: string, message: string) => issues.push({ level, step, rule, message });

  // The channel plan decides which channel carries the first real message (profile visits don't count).
  const firstMsg = seq.steps.find((s) => s.type !== 'linkedin_visit');
  if (firstChannel && firstMsg) {
    const actual = firstMsg.type === 'email' ? 'email' : 'linkedin';
    if (actual !== firstChannel) add('error', seq.steps.indexOf(firstMsg), 'channel_plan', `channel plan opens on ${firstChannel} but the first message is ${actual}`);
  }

  const hasEmail = seq.steps.some((s) => s.type === 'email');
  const hasLi = seq.steps.some((s) => s.type.startsWith('linkedin'));
  if (route === 'email' && hasLi) add('error', null, 'route', 'route is email but sequence contains LinkedIn steps');
  if (route === 'linkedin' && hasEmail) add('error', null, 'route', 'route is linkedin but sequence contains email steps');
  if (route === 'both' && !(hasEmail && hasLi)) add('error', null, 'route', 'route is both but sequence does not use both channels');
  if (route === 'none') add('error', null, 'route', 'lead is routed to none — do not draft');

  const invites = seq.steps.filter((s) => s.type === 'linkedin_invite').length;
  if (invites > 1) add('error', null, 'linkedin', 'only one connection request per sequence');
  const firstMsgIdx = seq.steps.findIndex((s) => s.type === 'linkedin_message');
  const inviteIdx = seq.steps.findIndex((s) => s.type === 'linkedin_invite');
  if (firstMsgIdx >= 0 && (inviteIdx < 0 || inviteIdx > firstMsgIdx)) {
    add('warning', firstMsgIdx, 'linkedin', 'LinkedIn message before a connection request only reaches 1st-degree connections');
  }

  const span = seq.steps.reduce((a, s) => a + s.delay_days, 0);
  if (span > 24) add('warning', null, 'cadence', `sequence spans ${span} days (> 24)`);
  if (seq.steps[0] && seq.steps[0].delay_days > 1) add('warning', 0, 'cadence', 'first touch should go out on day 0/1');
  const emails = seq.steps.filter((s) => s.type === 'email').length;
  if (emails > 4) add('warning', null, 'cadence', `${emails} emails — more than 4 hurts deliverability and reputation`);

  let firstEmailSeen = false;
  seq.steps.forEach((s, i) => {
    const texts: string[] = [];
    if (s.type === 'email') {
      texts.push(s.subject, s.body);
      if (s.subject.length > 60) add('warning', i, 'subject', `subject is ${s.subject.length} chars (aim < 60)`);
      if (/^[^a-z]*$/.test(s.subject) && /[A-Z]/.test(s.subject)) add('error', i, 'subject', 'subject is ALL CAPS');
      if ((s.subject.match(/!/g) ?? []).length > 0) add('warning', i, 'subject', 'avoid exclamation marks in subjects');
      const w = words(s.body);
      const limit = firstEmailSeen ? 110 : 160;
      if (w > limit) add('warning', i, 'length', `email body is ${w} words (aim <= ${limit})`);
      const isLastEmail = i === seq.steps.map((x) => x.type).lastIndexOf('email');
      if (w < 25 && !(isLastEmail && firstEmailSeen)) add('warning', i, 'length', `email body is only ${w} words`);
      if ((s.body.match(/https?:\/\//g) ?? []).length > 1) add('warning', i, 'links', 'more than one link hurts deliverability');
      if (!firstEmailSeen) {
        const q = (s.body.match(/\?/g) ?? []).length;
        if (q === 0) add('warning', i, 'cta', 'first email has no question / clear low-friction CTA');
      }
      firstEmailSeen = true;
    }
    if (s.type === 'linkedin_invite') {
      texts.push(s.note);
      if (s.note.length > 300) add('error', i, 'length', `invite note ${s.note.length} > 300 chars`);
      if (/https?:\/\//.test(s.note)) add('error', i, 'links', 'no links in connection notes');
    }
    if (s.type === 'linkedin_message') {
      texts.push(s.message);
      if (words(s.message) > 120) add('warning', i, 'length', 'LinkedIn message > 120 words — keep it conversational');
    }
    for (const t of texts) {
      const lower = t.toLowerCase();
      if (PLACEHOLDER.test(t)) add('error', i, 'placeholder', `unresolved placeholder in: "${t.slice(0, 60)}…"`);
      const claim = t.match(CLAIM)?.[0];
      if (claim && !proofPoints.some((p) => p.toLowerCase().includes(claim.toLowerCase()))) {
        add('warning', i, 'claim', `unbacked claim "${claim}" — only use numbers/comparisons from the seller's proof_points`);
      }
      for (const sp of SPAM) if (new RegExp(`(^|\\W)${escapeRe(sp)}(\\W|$)`, 'i').test(lower)) add('warning', i, 'spam', `spam-trigger phrase "${sp}"`);
      for (const c of CLICHES) if (lower.includes(c)) add('warning', i, 'cliche', `cliché "${c}"`);
      if (/—/.test(t) && (t.match(/—/g) ?? []).length > 2) add('warning', i, 'style', 'heavy em-dash use reads as AI-written');
    }
  });

  // Personalization: the opener must be specific to this lead.
  const first = seq.steps.find((s) => s.type !== 'linkedin_visit');
  if (first) {
    const t = first.type === 'email' ? first.body : first.type === 'linkedin_invite' ? first.note : first.type === 'linkedin_message' ? first.message : '';
    const tl = t.toLowerCase();
    const specific =
      (lead.company && tl.includes(lead.company.toLowerCase().split(/\s+/)[0]!)) ||
      (lead.first_name && tl.includes(lead.first_name.toLowerCase()));
    if (t && !specific) add('warning', seq.steps.indexOf(first), 'personalization', 'first touch mentions neither the person nor their company');
  }
  return issues;
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function winningExamples(persona: string | null, route: string, limit = 3) {
  const rows = all<any>(
    `SELECT s.steps_json, s.angle, s.hook_type, c.persona, c.route, o.replied, o.positive, o.is_simulated
       FROM sequences s
       JOIN outcomes o ON o.lead_id = s.lead_id
       JOIN classifications c ON c.lead_id = s.lead_id
      WHERE s.status = 'final' AND (o.replied = 1 OR o.positive = 1)
      ORDER BY (c.persona = ?) DESC, (c.route = ?) DESC, o.positive DESC, s.id DESC
      LIMIT ?`,
    persona,
    route,
    limit,
  );
  return rows.map((r) => ({
    persona: r.persona,
    route: r.route,
    angle: r.angle,
    hook_type: r.hook_type,
    positive_reply: !!r.positive,
    simulated: !!r.is_simulated,
    steps: JSON.parse(r.steps_json),
  }));
}

export const ROUTE_TEMPLATES: Record<string, string> = {
  email:
    'Email-first: [email d0 signal-hook + 1 low-friction question] -> [email d3 new value/insight, 2-4 lines] -> [email d7 short break-up / easy out].',
  linkedin:
    'LinkedIn-first: [linkedin_visit d0] -> [linkedin_invite d1, note <=300 chars referencing the signal, no pitch] -> [linkedin_message d3 after connect: value + question] -> [linkedin_message d7 short nudge].',
  both:
    'Multichannel: [linkedin_visit d0] -> [email d0 signal-hook] -> [linkedin_invite d1 short note] -> [email d3 value] -> [linkedin_message d5 if connected] -> [email d7 break-up].',
};

export function finalizedToday(): number {
  return one<{ n: number }>(`SELECT COUNT(*) n FROM sequences WHERE status = 'final' AND substr(created_at,1,10) = ?`, today())?.n ?? 0;
}

export function getDraftingQueue(limit = 10) {
  const cap = getConfig().GTM_DAILY_SEQUENCES;
  const left = Math.max(0, cap - finalizedToday());
  const leads =
    left === 0
      ? []
      : all<any>(
          `SELECT l.*, c.tier, c.persona, c.intent_strength, c.route, c.angle, c.reasoning, c.channel_plan_json
             FROM leads l JOIN classifications c ON c.lead_id = l.id
            WHERE l.status IN ('classified', 'drafted') AND c.route != 'none'
            ORDER BY CASE c.tier WHEN 'A' THEN 0 WHEN 'B' THEN 1 ELSE 2 END, c.intent_strength DESC
            LIMIT ?`,
          Math.min(limit, left),
        );
  const pb = getPlaybook();
  const waiting = one<{ n: number }>(`SELECT COUNT(*) n FROM leads WHERE status IN ('classified','drafted')`)?.n ?? 0;
  return {
    remaining: left === 0 ? 0 : waiting,
    daily_cap: { limit: cap, used: cap - left, reached: left === 0, note: left === 0 ? `Daily sequence cap reached (GTM_DAILY_SEQUENCES=${cap}); ${waiting} leads wait for tomorrow.` : undefined },
    seller: getSellerProfile(),
    recent_learnings: latestLearnings(2),
    playbook_version: pb.version,
    playbook: pb.content,
    route_templates: ROUTE_TEMPLATES,
    leads: leads.map((l) => ({
      ...leadBrief(l),
      classification: { tier: l.tier, persona: l.persona, intent_strength: l.intent_strength, route: l.route, angle: l.angle, reasoning: l.reasoning },
      channel_plan: l.channel_plan_json ? JSON.parse(l.channel_plan_json) : null,
      current_draft: currentSequence(l.id),
      winning_examples: winningExamples(l.persona, l.route),
    })),
  };
}

export function currentSequence(leadId: number) {
  const s = one<any>(`SELECT * FROM sequences WHERE lead_id = ? AND status != 'superseded' ORDER BY version DESC LIMIT 1`, leadId);
  if (!s) return null;
  return { id: s.id, version: s.version, status: s.status, angle: s.angle, hook_type: s.hook_type, steps: JSON.parse(s.steps_json), lint: JSON.parse(s.lint_json ?? '[]') };
}

export function saveSequence(raw: unknown) {
  const parsed = SequenceInput.safeParse(raw);
  if (!parsed.success) {
    return { ok: false as const, errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
  }
  const seq = parsed.data;
  const lead = one<any>(`SELECT l.*, c.route, c.first_channel FROM leads l JOIN classifications c ON c.lead_id = l.id WHERE l.id = ?`, seq.lead_id);
  if (!lead) return { ok: false as const, errors: [`lead ${seq.lead_id} is not classified`] };
  if (lead.status === 'pushed') return { ok: false as const, errors: [`lead ${seq.lead_id} already pushed to Overloop`] };
  const issues = lintSequence(seq, lead.route, lead, getSellerProfile()?.proof_points ?? [], lead.first_channel ?? null);
  const errors = issues.filter((i) => i.level === 'error');
  let status = seq.status;
  if (status === 'final' && errors.length > 0) status = 'draft';
  const prev = one<{ v: number }>('SELECT MAX(version) v FROM sequences WHERE lead_id = ?', seq.lead_id)?.v ?? 0;
  const id = tx(() => {
    run(`UPDATE sequences SET status = 'superseded' WHERE lead_id = ? AND status != 'superseded'`, seq.lead_id);
    const r = run(
      `INSERT INTO sequences(lead_id, version, status, route, angle, hook_type, steps_json, lint_json, critique, playbook_version, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      seq.lead_id,
      prev + 1,
      status,
      lead.route,
      seq.angle,
      seq.hook_type,
      JSON.stringify(seq.steps),
      JSON.stringify(issues),
      seq.critique ?? null,
      getPlaybook().version,
      nowIso(),
    );
    run('UPDATE leads SET status = ? WHERE id = ?', status === 'final' ? 'final' : 'drafted', seq.lead_id);
    return Number(r.lastInsertRowid);
  });
  logRun('sequence', { lead_id: seq.lead_id, version: prev + 1, status, errors: errors.length, warnings: issues.length - errors.length });
  return {
    ok: true as const,
    sequence_id: id,
    version: prev + 1,
    status,
    finalized: status === 'final',
    lint: issues,
    next:
      errors.length > 0
        ? 'Fix the lint errors and save again (status stays draft until clean).'
        : status === 'draft'
          ? 'Critique it against the rubric, revise, then save with status "final".'
          : 'Final. It will be pushed by gtm_push_to_overloop.',
  };
}
