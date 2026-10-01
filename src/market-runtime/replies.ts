import { z } from 'zod';
import { createDefaultHeyReachAdapter } from '../adapters/runtime.js';
import type { HeyReachAdapter } from '../adapters/heyreach-execution.js';
import { all, auditSink, logRun, nowIso, one, run } from '../db/db.js';
import { getPlaybook } from '../pipeline/playbook.js';
import { getSellerProfile } from '../pipeline/setup.js';

export const MarketReplyCategory = z.enum([
  'interested', 'question', 'objection', 'not_now', 'referral', 'not_interested',
  'unsubscribe', 'out_of_office', 'wrong_person', 'other',
]);

export const MarketReplyTriageInput = z.object({
  reply_id: z.number().int(),
  category: MarketReplyCategory,
  sentiment: z.enum(['positive', 'neutral', 'negative']),
  summary: z.string().min(3).max(400),
  next_action: z.string().min(3).max(300),
  draft_response: z.string().max(3000).optional(),
  follow_up_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  meeting_booked: z.boolean().default(false),
});

const STOP = new Set(['interested', 'question', 'objection', 'not_now', 'referral', 'not_interested', 'unsubscribe', 'wrong_person']);
const EXCLUDE = new Set(['not_interested', 'unsubscribe', 'wrong_person']);

function recordReplyEvent(reply: any, eventType: string, source = 'human_triage') {
  run(
    `INSERT INTO market_outcome_events(activation_id,candidate_id,project_id,event_type,event_at,source,
      metadata_json,is_simulated,created_at) VALUES (?,?,?,?,?,?,?,0,?)`,
    reply.activation_id, reply.candidate_id, reply.project_id, eventType, nowIso(), source,
    JSON.stringify({ reply_id: reply.id }), nowIso(),
  );
}

export function getMarketReplyQueue(limit = 20) {
  const rows = all<any>(
    `SELECT r.*,c.name,c.current_role,c.current_org,p.name project_name,s.steps_json
       FROM market_replies r JOIN candidates c ON c.id=r.candidate_id JOIN projects p ON p.id=r.project_id
       LEFT JOIN provider_activations pa ON pa.id=r.activation_id
       LEFT JOIN candidate_sequences s ON s.id=pa.sequence_id
      WHERE r.status IN ('NEW','NEEDS_TEXT')
      ORDER BY CASE r.status WHEN 'NEW' THEN 0 ELSE 1 END,r.id LIMIT ?`,
    limit,
  );
  return {
    seller: getSellerProfile(),
    playbook_version: getPlaybook().version,
    needs_text: rows.filter((row) => row.status === 'NEEDS_TEXT').map((row) => ({
      reply_id: row.id, candidate_id: row.candidate_id, name: row.name, project: row.project_name, channel: row.channel,
    })),
    to_triage: rows.filter((row) => row.status === 'NEW').map((row) => ({
      reply_id: row.id,
      candidate_id: row.candidate_id,
      channel: row.channel,
      received_at: row.received_at,
      text: row.text,
      prospect: { name: row.name, role: row.current_role, organization: row.current_org, project: row.project_name },
      what_we_sent: row.steps_json ? JSON.parse(row.steps_json) : null,
    })),
    instructions: 'Draft only. Never send a reply automatically. Use only the reply text, seller profile and approved project evidence.',
  };
}

export async function saveMarketReplyTriage(raw: unknown, opts: { execution?: HeyReachAdapter } = {}) {
  const input = MarketReplyTriageInput.parse(raw);
  const reply = one<any>(
    `SELECT r.*,pa.provider_profile_url,pa.status activation_status
       FROM market_replies r LEFT JOIN provider_activations pa ON pa.id=r.activation_id WHERE r.id=?`,
    input.reply_id,
  );
  if (!reply) throw new Error(`unknown market reply ${input.reply_id}`);
  if (!reply.text) throw new Error('reply text is required before triage');
  const execution = opts.execution ?? createDefaultHeyReachAdapter(auditSink);
  const actions: { action: string; ok: boolean; detail?: string }[] = [];
  if (reply.provider_profile_url && EXCLUDE.has(input.category) && !reply.is_simulated) {
    try {
      await execution.exclude(reply.provider_profile_url);
      actions.push({ action: 'blacklist', ok: true });
    } catch (error) {
      actions.push({ action: 'blacklist', ok: false, detail: (error as Error).message });
    }
  }
  if (reply.provider_profile_url && STOP.has(input.category) && reply.activation_status === 'ACTIVE' && !reply.is_simulated) {
    try {
      await execution.stopLead(reply.provider_profile_url);
      actions.push({ action: 'stop_campaign_for_lead', ok: true });
    } catch (error) {
      actions.push({ action: 'stop_campaign_for_lead', ok: false, detail: (error as Error).message });
    }
  }
  recordReplyEvent(reply, 'REPLY_RECEIVED');
  if (input.sentiment === 'positive' || input.category === 'interested') recordReplyEvent(reply, 'POSITIVE_REPLY');
  if (input.sentiment === 'negative' || EXCLUDE.has(input.category)) recordReplyEvent(reply, 'NEGATIVE_REPLY');
  if (input.meeting_booked) recordReplyEvent(reply, 'MEETING_BOOKED');
  const needsHuman = !['unsubscribe', 'out_of_office', 'not_interested'].includes(input.category);
  run(
    `UPDATE market_replies SET status=?,category=?,sentiment=?,summary=?,next_action=?,draft_response=?,follow_up_on=?,
      actions_json=?,triaged_at=? WHERE id=?`,
    needsHuman ? 'NEEDS_HUMAN' : 'HANDLED', input.category, input.sentiment, input.summary, input.next_action,
    input.draft_response ?? null, input.follow_up_on ?? null, JSON.stringify(actions), nowIso(), input.reply_id,
  );
  const result = { reply_id: input.reply_id, candidate_id: reply.candidate_id, category: input.category, needs_human: needsHuman, actions };
  logRun('market_reply_triage', result);
  return result;
}

export function marketReplyInbox(limit = 50) {
  return all<any>(
    `SELECT r.id reply_id,r.candidate_id,c.name,p.name project_name,r.channel,r.status,r.category,r.sentiment,
            r.summary,r.next_action,r.draft_response,r.follow_up_on,r.received_at
       FROM market_replies r JOIN candidates c ON c.id=r.candidate_id JOIN projects p ON p.id=r.project_id
      WHERE r.status IN ('NEEDS_HUMAN','NEEDS_TEXT','NEW')
      ORDER BY CASE r.category WHEN 'interested' THEN 0 WHEN 'question' THEN 1 WHEN 'objection' THEN 2 ELSE 3 END,r.id LIMIT ?`,
    limit,
  );
}

export function resolveMarketReply(input: { reply_id: number; outcome?: 'answered' | 'meeting_booked' | 'closed' }) {
  const reply = one<any>('SELECT * FROM market_replies WHERE id=?', input.reply_id);
  if (!reply) throw new Error(`unknown market reply ${input.reply_id}`);
  if (input.outcome === 'meeting_booked') recordReplyEvent(reply, 'MEETING_BOOKED', 'human_resolution');
  run(`UPDATE market_replies SET status='RESOLVED',resolved_at=? WHERE id=?`, nowIso(), input.reply_id);
  return { reply_id: input.reply_id, status: 'RESOLVED', outcome: input.outcome ?? 'answered' };
}
