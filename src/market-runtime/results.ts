import { createDefaultHeyReachAdapter } from '../adapters/runtime.js';
import type { HeyReachAdapter } from '../adapters/heyreach-execution.js';
import { getConfig } from '../config.js';
import { all, auditSink, logRun, nowIso, one, run, tx } from '../db/db.js';
import { normalizeLinkedinUrl } from '../identity/linkedin.js';
import { latestInboundChatMessage, mapHeyReachConversation, mapHeyReachLeadResult } from './provider-results.js';

function activationByProfile(profileUrl: string) {
  const normalized = normalizeLinkedinUrl(profileUrl);
  return all<any>(
    `SELECT * FROM provider_activations WHERE provider='heyreach' AND status IN ('ACTIVE','PAUSED','FINISHED','FAILED')`,
  ).find((row) => normalizeLinkedinUrl(row.provider_profile_url) === normalized);
}

function saveProviderEvent(activation: any, event: { type: string; at: string; key: string; raw: Record<string, unknown> }) {
  const result = run(
    `INSERT OR IGNORE INTO market_outcome_events(activation_id,candidate_id,project_id,event_type,event_at,source,
      provider_event_key,metadata_json,is_simulated,created_at) VALUES (?,?,?,?,?,'heyreach',?,?,0,?)`,
    activation.id, activation.candidate_id, activation.project_id, event.type, event.at, event.key, JSON.stringify(event.raw), nowIso(),
  );
  return Number(result.changes);
}

export async function syncHeyReachResults(opts: { execution?: HeyReachAdapter } = {}) {
  const active = one<{ n: number }>(
    `SELECT COUNT(*) n FROM provider_activations WHERE provider='heyreach' AND status IN ('ACTIVE','PAUSED','FINISHED','FAILED')`,
  )?.n ?? 0;
  if (!active) return { checked: 0, events_added: 0, unknown_profiles: [], note: 'No launched HeyReach activations; nothing to sync.' };
  const execution = opts.execution ?? createDefaultHeyReachAdapter(auditSink);
  let offset = 0;
  let checked = 0;
  let added = 0;
  const unknown = new Set<string>();
  while (offset < 5000) {
    const page = await execution.results(offset);
    for (const item of page.items) {
      checked++;
      const events = mapHeyReachLeadResult(getConfig().HEYREACH_CAMPAIGN_ID, item);
      if (!events.length) continue;
      const activation = activationByProfile(events[0]!.profileUrl);
      if (!activation) {
        unknown.add(events[0]!.profileUrl);
        continue;
      }
      tx(() => {
        for (const event of events) added += saveProviderEvent(activation, event);
        const types = new Set(events.map((event) => event.type));
        const status = types.has('PROVIDER_FAILED') ? 'FAILED' : types.has('PROVIDER_FINISHED') ? 'FINISHED' : activation.status;
        run(`UPDATE provider_activations SET status=?,last_synced_at=?,updated_at=? WHERE id=?`, status, nowIso(), nowIso(), activation.id);
      });
    }
    offset += page.items.length;
    if (!page.items.length || offset >= page.totalCount) break;
  }
  const summary = { checked, events_added: added, unknown_profiles: [...unknown] };
  logRun('heyreach_results_sync', summary);
  return summary;
}

export async function syncHeyReachReplies(opts: { execution?: HeyReachAdapter } = {}) {
  const execution = opts.execution ?? createDefaultHeyReachAdapter(auditSink);
  const activations = all<any>(
    `SELECT * FROM provider_activations WHERE provider='heyreach' AND status IN ('ACTIVE','PAUSED','FINISHED') ORDER BY id`,
  );
  let conversations = 0;
  let added = 0;
  const errors: { candidate_id: number; error: string }[] = [];
  for (const activation of activations) {
    try {
      const page = await execution.replies(activation.provider_profile_url);
      for (const raw of page.items) {
        const conversation = mapHeyReachConversation(raw);
        if (!conversation?.fromLead) continue;
        conversations++;
        let message = conversation.text
          ? { id: `${conversation.conversationId}:${conversation.receivedAt}`, text: conversation.text, at: conversation.receivedAt }
          : null;
        if (!message && conversation.accountId) {
          message = latestInboundChatMessage(await execution.chatroom(conversation.accountId, conversation.conversationId));
        }
        const providerMessageId = `${conversation.conversationId}:${message?.id ?? conversation.receivedAt}`;
        const result = run(
          `INSERT OR IGNORE INTO market_replies(activation_id,candidate_id,project_id,provider_message_id,channel,status,
            text,received_at,detected_at,is_simulated) VALUES (?,?,?,?, 'linkedin',?,?,?,?,0)`,
          activation.id, activation.candidate_id, activation.project_id, providerMessageId,
          message?.text ? 'NEW' : 'NEEDS_TEXT', message?.text ?? null, message?.at ?? conversation.receivedAt, nowIso(),
        );
        added += Number(result.changes);
      }
    } catch (error) {
      errors.push({ candidate_id: activation.candidate_id, error: (error as Error).message });
    }
  }
  const summary = { checked: activations.length, conversations, replies_added: added, errors };
  logRun('heyreach_replies_sync', summary);
  return summary;
}

export function ingestMarketReply(input: { reply_id?: number; candidate_id?: number; text: string; received_at?: string }) {
  let reply = input.reply_id ? one<any>('SELECT * FROM market_replies WHERE id=?', input.reply_id) : undefined;
  if (!reply && input.candidate_id) {
    reply = one<any>(
      `SELECT * FROM market_replies WHERE candidate_id=? AND status='NEEDS_TEXT' ORDER BY id LIMIT 1`,
      input.candidate_id,
    );
  }
  if (!reply) throw new Error('no matching market reply; provide a valid reply_id or candidate_id with NEEDS_TEXT');
  run(`UPDATE market_replies SET text=?,status='NEW',received_at=COALESCE(received_at,?) WHERE id=?`, input.text, input.received_at ?? nowIso(), reply.id);
  return { reply_id: reply.id, candidate_id: reply.candidate_id, status: 'NEW' };
}

export type ManualOutcomeType = 'MEETING_BOOKED' | 'SCAN_STARTED' | 'SCAN_COMPLETED' | 'SALE';

export function recordMarketOutcome(input: {
  candidate_id: number;
  project_id: number;
  event_type: ManualOutcomeType;
  event_at?: string;
  value_number?: number;
  currency?: string;
  notes?: string;
}) {
  const project = one('SELECT id FROM projects WHERE id=? AND candidate_id=?', input.project_id, input.candidate_id);
  if (!project) throw new Error('project does not belong to candidate');
  if (input.event_type === 'SALE' && input.value_number !== undefined && input.value_number < 0) throw new Error('sale value cannot be negative');
  const activation = one<{ id: number }>(
    `SELECT id FROM provider_activations WHERE candidate_id=? AND project_id=? ORDER BY id DESC LIMIT 1`,
    input.candidate_id, input.project_id,
  );
  const result = run(
    `INSERT INTO market_outcome_events(activation_id,candidate_id,project_id,event_type,event_at,source,value_number,currency,
      metadata_json,is_simulated,created_at) VALUES (?,?,?,?,?,'manual',?,?,?,0,?)`,
    activation?.id ?? null, input.candidate_id, input.project_id, input.event_type, input.event_at ?? nowIso(),
    input.value_number ?? null, input.currency ?? null, JSON.stringify({ notes: input.notes ?? null }), nowIso(),
  );
  return { event_id: Number(result.lastInsertRowid), ...input, source: 'manual' };
}
