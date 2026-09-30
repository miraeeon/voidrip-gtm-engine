import { z } from 'zod';
import type { ExecutionAdapter } from '../adapters/execution.js';
import { createDefaultExecutionAdapter } from '../adapters/runtime.js';
import { all, auditSink, logRun, nowIso, one, run } from '../db/db.js';
import { recordOutcome } from './results.js';
import { getSellerProfile } from './setup.js';
import { getPlaybook } from './playbook.js';

/**
 * Reply handling. Overloop's public API exposes *that* someone replied (prospect
 * flags + reply counts) but not the message text, so:
 *   1. detectReplies()  – opens a reply item whenever reply counts go up
 *   2. ingestReply()    – the agent (from Gmail/Outlook MCP) or a human adds the text
 *   3. the agent triages it (category, sentiment, next action, drafted answer)
 *   4. saveReplyTriage() applies the *safe* follow-ups automatically
 *      (exclusion list, stop the sequence, assign the conversation, record outcome).
 * Answers are never sent by the bot — they wait for a human.
 */

export const ReplyCategory = z.enum([
  'interested', // wants to talk / asks for a meeting or demo
  'question', // asks something before deciding
  'objection', // pushback: price, timing, already have a tool…
  'not_now', // timing — follow up later
  'referral', // points to someone else
  'not_interested',
  'unsubscribe', // asks to stop / remove
  'out_of_office',
  'wrong_person',
  'other',
]);
export type ReplyCategory = z.infer<typeof ReplyCategory>;

export const ReplyTriageInput = z.object({
  reply_id: z.number().int(),
  category: ReplyCategory,
  sentiment: z.enum(['positive', 'neutral', 'negative']),
  summary: z.string().min(3).max(400).describe('one or two lines: what they said'),
  next_action: z.string().min(3).max(300).describe('what the human should do next'),
  draft_response: z.string().max(3000).optional().describe('suggested answer in the prospect language; omit for unsubscribe/OOO'),
  follow_up_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('for not_now / out_of_office: when to re-engage'),
  referral: z.object({ name: z.string().optional(), email: z.string().optional(), title: z.string().optional() }).optional(),
  meeting_booked: z.boolean().default(false),
});
export type ReplyTriageInput = z.infer<typeof ReplyTriageInput>;

const POSITIVE: ReplyCategory[] = ['interested'];
const STOP: ReplyCategory[] = ['unsubscribe', 'not_interested', 'wrong_person', 'interested', 'question', 'objection', 'referral', 'not_now'];

/** Compare Overloop reply counts with what we've already seen; open a reply item for every increase. */
export async function detectReplies(opts: { execution?: ExecutionAdapter } = {}) {
  const execution = opts.execution ?? createDefaultExecutionAdapter(auditSink);
  const pushes = all<any>('SELECT * FROM pushes WHERE deleted_at IS NULL AND ovl_prospect_id IS NOT NULL');
  const opened: { reply_id: number; lead_id: number; channel: string }[] = [];
  const errors: { lead_id: number; error: string }[] = [];
  for (const p of pushes) {
    try {
      const pr = await execution.getProspect(p.ovl_prospect_id);
      if (!pr.replied_at || pr.replied_at <= p.pushed_at) continue;
      for (const channel of ['email', 'linkedin'] as const) {
        const count = channel === 'email' ? pr.email_reply_count : pr.linkedin_reply_count;
        const seen = one<{ n: number }>('SELECT COUNT(*) n FROM replies WHERE lead_id = ? AND channel = ? AND is_simulated = 0', p.lead_id, channel)?.n ?? 0;
        for (let i = seen; i < (count ?? 0); i++) {
          const r = run(
            `INSERT INTO replies(lead_id, ovl_prospect_id, ovl_campaign_id, channel, status, received_at, detected_at, is_simulated)
             VALUES (?,?,?,?, 'needs_text', ?, ?, 0)`,
            p.lead_id,
            p.ovl_prospect_id,
            p.ovl_campaign_id,
            channel,
            pr.replied_at,
            nowIso(),
          );
          opened.push({ reply_id: Number(r.lastInsertRowid), lead_id: p.lead_id, channel });
        }
      }
    } catch (e) {
      errors.push({ lead_id: p.lead_id, error: (e as Error).message });
    }
  }
  const summary = {
    checked: pushes.length,
    new_replies: opened.length,
    opened,
    errors,
    next: opened.length
      ? 'Fetch each reply text (mailbox MCP such as Gmail, or ask the user) and add it with gtm_ingest_reply, then triage.'
      : undefined,
  };
  logRun('replies_detect', summary);
  return summary;
}

/** Add (or attach) the text of a reply. Matches by reply_id, else by lead_id / prospect email. */
export function ingestReply(input: { reply_id?: number; lead_id?: number; email?: string; channel?: 'email' | 'linkedin'; text: string; received_at?: string; simulated?: boolean }) {
  let leadId = input.lead_id;
  if (!leadId && input.email) leadId = one<{ id: number }>('SELECT id FROM leads WHERE lower(email) = lower(?)', input.email)?.id;
  if (input.reply_id) {
    const existing = one<any>('SELECT * FROM replies WHERE id = ?', input.reply_id);
    if (!existing) throw new Error(`unknown reply ${input.reply_id}`);
    run(`UPDATE replies SET text = ?, status = 'new' WHERE id = ?`, input.text, input.reply_id);
    return { reply_id: input.reply_id, lead_id: existing.lead_id, status: 'new' };
  }
  if (!leadId) throw new Error('need reply_id, lead_id or a known prospect email');
  const lead = one<any>('SELECT id FROM leads WHERE id = ?', leadId);
  if (!lead) throw new Error(`unknown lead ${leadId}`);
  // Attach to the oldest open item for that lead/channel if there is one.
  const pending = one<any>(
    `SELECT id FROM replies WHERE lead_id = ? AND status = 'needs_text' AND (? IS NULL OR channel = ?) ORDER BY id LIMIT 1`,
    leadId,
    input.channel ?? null,
    input.channel ?? null,
  );
  if (pending) {
    run(`UPDATE replies SET text = ?, status = 'new' WHERE id = ?`, input.text, pending.id);
    return { reply_id: pending.id, lead_id: leadId, status: 'new' };
  }
  const push = one<any>('SELECT * FROM pushes WHERE lead_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1', leadId);
  const r = run(
    `INSERT INTO replies(lead_id, ovl_prospect_id, ovl_campaign_id, channel, status, text, received_at, detected_at, is_simulated)
     VALUES (?,?,?,?, 'new', ?, ?, ?, ?)`,
    leadId,
    push?.ovl_prospect_id ?? null,
    push?.ovl_campaign_id ?? null,
    input.channel ?? 'email',
    input.text,
    input.received_at ?? nowIso(),
    nowIso(),
    input.simulated ? 1 : 0,
  );
  return { reply_id: Number(r.lastInsertRowid), lead_id: leadId, status: 'new' };
}

/** Everything the agent needs to triage replies and draft answers. */
export function getReplyQueue(limit = 20) {
  const rows = all<any>(
    `SELECT r.*, l.name, l.first_name, l.job_title, l.company, l.location, l.signal_name, c.tier, c.persona, c.route, c.angle
       FROM replies r JOIN leads l ON l.id = r.lead_id LEFT JOIN classifications c ON c.lead_id = r.lead_id
      WHERE r.status IN ('new', 'needs_text') ORDER BY r.status = 'needs_text', r.id LIMIT ?`,
    limit,
  );
  return {
    seller: getSellerProfile(),
    playbook_version: getPlaybook().version,
    needs_text: rows.filter((r) => r.status === 'needs_text').map((r) => ({ reply_id: r.id, lead_id: r.lead_id, name: r.name, company: r.company, channel: r.channel, received_at: r.received_at })),
    to_triage: rows
      .filter((r) => r.status === 'new')
      .map((r) => {
        const seq = one<any>(`SELECT steps_json FROM sequences WHERE lead_id = ? AND status = 'final' ORDER BY version DESC LIMIT 1`, r.lead_id);
        return {
          reply_id: r.id,
          lead_id: r.lead_id,
          channel: r.channel,
          received_at: r.received_at,
          simulated: !!r.is_simulated,
          text: r.text,
          lead: { name: r.name, job_title: r.job_title, company: r.company, location: r.location, tier: r.tier, persona: r.persona, signal: r.signal_name, angle: r.angle },
          what_we_sent: seq ? JSON.parse(seq.steps_json) : null,
        };
      }),
    instructions:
      'For each reply: pick the category, sentiment, 1-line summary, next action for the human, and a draft response in the prospect language (not for unsubscribe / out_of_office). Save with gtm_save_reply_triage. Never promise anything not in the seller profile.',
  };
}

/** Store the agent's triage and apply safe follow-ups. Sending the answer is always left to a human. */
export async function saveReplyTriage(raw: unknown, opts: { execution?: ExecutionAdapter } = {}) {
  const t = ReplyTriageInput.parse(raw);
  const reply = one<any>('SELECT * FROM replies WHERE id = ?', t.reply_id);
  if (!reply) throw new Error(`unknown reply ${t.reply_id}`);
  if (!reply.text) throw new Error(`reply ${t.reply_id} has no text yet — add it with gtm_ingest_reply first`);
  const lead = one<any>('SELECT * FROM leads WHERE id = ?', reply.lead_id);
  const execution = opts.execution ?? createDefaultExecutionAdapter(auditSink);
  const actions: { action: string; ok: boolean; detail?: string }[] = [];
  const simulated = !!reply.is_simulated;

  // 1. Unsubscribe / not interested / wrong person → never contact again from Overloop.
  if (['unsubscribe', 'not_interested', 'wrong_person'].includes(t.category) && lead?.email) {
    if (simulated) actions.push({ action: 'exclusion_list', ok: true, detail: 'skipped (simulated reply)' });
    else {
      try {
        await execution.exclude(lead.email);
        actions.push({ action: 'exclusion_list', ok: true, detail: lead.email });
      } catch (e) {
        actions.push({ action: 'exclusion_list', ok: false, detail: (e as Error).message });
      }
    }
  }

  // 2. Any human answer (except OOO / other) → stop the automated sequence for this person.
  if (STOP.includes(t.category) && reply.ovl_campaign_id && reply.ovl_prospect_id) {
    if (simulated) actions.push({ action: 'stop_sequence', ok: true, detail: 'skipped (simulated reply)' });
    else {
      try {
        const n = await execution.pause(reply.ovl_campaign_id, reply.ovl_prospect_id);
        actions.push({ action: 'stop_sequence', ok: true, detail: `${n} enrollment(s) removed` });
      } catch (e) {
        actions.push({ action: 'stop_sequence', ok: false, detail: (e as Error).message });
      }
    }
  }

  // 3. Hot reply → make sure a human owns the conversation in Overloop.
  if (['interested', 'question', 'objection', 'referral'].includes(t.category) && reply.ovl_prospect_id && !simulated) {
    try {
      const assigned = await execution.assignReplyOwner(reply.ovl_prospect_id, reply.ovl_campaign_id);
      actions.push({ action: 'assign_conversation', ok: !!assigned, detail: assigned ? `conversation ${assigned.conversation_id} → user ${assigned.owner_id}` : 'conversation not found in recent activity' });
    } catch (e) {
      actions.push({ action: 'assign_conversation', ok: false, detail: (e as Error).message });
    }
  }

  // 4. Feed the learning loop.
  recordOutcome({
    lead_id: reply.lead_id,
    replied: t.category !== 'out_of_office',
    positive: POSITIVE.includes(t.category) || t.meeting_booked || (t.sentiment === 'positive' && ['question', 'referral'].includes(t.category)),
    meeting: t.meeting_booked,
  });
  if (simulated) run('UPDATE outcomes SET is_simulated = 1 WHERE lead_id = ?', reply.lead_id);

  const needsHuman = !['unsubscribe', 'out_of_office', 'not_interested'].includes(t.category);
  run(
    `UPDATE replies SET status = ?, category = ?, sentiment = ?, summary = ?, next_action = ?, draft_response = ?, follow_up_on = ?,
       referral_json = ?, actions_json = ?, triaged_at = ? WHERE id = ?`,
    needsHuman ? 'needs_human' : 'handled',
    t.category,
    t.sentiment,
    t.summary,
    t.next_action,
    t.draft_response ?? null,
    t.follow_up_on ?? null,
    t.referral ? JSON.stringify(t.referral) : null,
    JSON.stringify(actions),
    nowIso(),
    t.reply_id,
  );
  run(`UPDATE leads SET status = 'replied' WHERE id = ?`, reply.lead_id);
  const summary = { reply_id: t.reply_id, lead_id: reply.lead_id, category: t.category, needs_human: needsHuman, actions };
  logRun('reply_triage', summary);
  return summary;
}

/** Human closes the loop after answering (or deciding not to). */
export function resolveReply(input: { reply_id: number; outcome?: 'answered' | 'meeting_booked' | 'closed' }) {
  const reply = one<any>('SELECT * FROM replies WHERE id = ?', input.reply_id);
  if (!reply) throw new Error(`unknown reply ${input.reply_id}`);
  run(`UPDATE replies SET status = 'resolved', resolved_at = ? WHERE id = ?`, nowIso(), input.reply_id);
  if (input.outcome === 'meeting_booked') recordOutcome({ lead_id: reply.lead_id, replied: true, positive: true, meeting: true });
  return { reply_id: input.reply_id, status: 'resolved', outcome: input.outcome ?? 'answered' };
}

/** Replies waiting on a person: hot ones first, with the drafted answer. */
export function replyInbox(limit = 50) {
  return all<any>(
    `SELECT r.id reply_id, r.lead_id, l.name, l.company, r.channel, r.category, r.sentiment, r.summary, r.next_action,
            r.draft_response, r.follow_up_on, r.is_simulated simulated, r.received_at
       FROM replies r JOIN leads l ON l.id = r.lead_id
      WHERE r.status IN ('needs_human', 'needs_text', 'new')
      ORDER BY CASE r.category WHEN 'interested' THEN 0 WHEN 'question' THEN 1 WHEN 'objection' THEN 2 WHEN 'referral' THEN 3 ELSE 4 END, r.id
      LIMIT ?`,
    limit,
  );
}

/** TEST ONLY: inject realistic replies for pushed leads so reply handling can be exercised without sending. */
export function simulateReplies(opts: { count?: number } = {}) {
  const samples: { channel: 'email' | 'linkedin'; text: (n: string) => string }[] = [
    { channel: 'email', text: (n) => `Hi, thanks for reaching out. Timing is actually good, we're reviewing our outbound setup this month. Could you send over the overview and a couple of times next week? ${n}` },
    { channel: 'linkedin', text: () => `Thanks for connecting. How is this different from what we do today with our CRM sequences? And what does it cost roughly?` },
    { channel: 'email', text: () => `Not a priority for us right now, we just signed with another vendor for 12 months. Maybe ping me next year.` },
    { channel: 'email', text: () => `Please remove me from your list.` },
    { channel: 'email', text: () => `I'm out of the office until next Monday with limited access to email. For urgent matters contact my colleague.` },
    { channel: 'linkedin', text: () => `I'm not the right person for this, you should talk to our Head of Sales Ops, Maria Lopez (maria.lopez@example.com).` },
  ];
  const leads = all<any>(
    `SELECT p.lead_id, l.first_name FROM pushes p JOIN leads l ON l.id = p.lead_id
      WHERE p.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM replies r WHERE r.lead_id = p.lead_id) ORDER BY p.id LIMIT ?`,
    opts.count ?? samples.length,
  );
  const created = leads.map((l, i) => {
    const s = samples[i % samples.length]!;
    return ingestReply({ lead_id: l.lead_id, channel: s.channel, text: s.text(l.first_name ? `Best, ${l.first_name}` : ''), simulated: true });
  });
  logRun('replies_simulate', { created: created.length });
  return { created, note: 'Simulated replies (is_simulated=1). Safe actions are skipped for simulated replies.' };
}
