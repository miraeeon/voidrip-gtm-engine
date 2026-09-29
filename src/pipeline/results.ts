import { OverloopClient } from '../clients/overloop.js';
import { all, auditSink, logRun, nowIso, one, run, tx } from '../db/db.js';

const after = (ts: string | null | undefined, since: string) => !!ts && ts > since;

/**
 * Pull engagement for every lead we pushed. Only engagement that happened *after*
 * our push counts — prospects that already existed in Overloop may carry history
 * from other campaigns.
 */
export async function syncResults(opts: { client?: OverloopClient } = {}) {
  const client = opts.client ?? new OverloopClient({ audit: auditSink });
  const pushes = all<any>('SELECT * FROM pushes WHERE deleted_at IS NULL AND ovl_prospect_id IS NOT NULL');
  let updated = 0;
  const errors: { lead_id: number; error: string }[] = [];
  for (const p of pushes) {
    const existing = one<any>('SELECT * FROM outcomes WHERE lead_id = ?', p.lead_id);
    if (existing?.is_simulated) continue; // don't overwrite a simulation with real zeros in test mode
    try {
      const pr = await client.getProspect(p.ovl_prospect_id);
      const since = p.pushed_at as string;
      const replied = after(pr.replied_at, since);
      const row = {
        sent: after(pr.last_emailed_at, since) ? 1 : 0,
        opened: after(pr.opened_at, since) ? 1 : 0,
        clicked: pr.clicked && after((pr as any).clicked_at, since) ? 1 : 0,
        replied: replied ? 1 : 0,
        email_replies: replied ? pr.email_reply_count : 0,
        linkedin_replies: replied ? pr.linkedin_reply_count : 0,
        bounced: pr.bounced && after(pr.last_emailed_at, since) ? 1 : 0,
      };
      // Nothing sent and no engagement yet (e.g. locked mode): there is no outcome to record.
      if (!existing && Object.values(row).every((v) => !v)) continue;
      run(
        `INSERT INTO outcomes(lead_id, ovl_prospect_id, sent, opened, clicked, replied, email_replies, linkedin_replies, bounced, positive, meeting, is_simulated, synced_at)
         VALUES (?,?,?,?,?,?,?,?,?, COALESCE((SELECT positive FROM outcomes WHERE lead_id = ?),0), COALESCE((SELECT meeting FROM outcomes WHERE lead_id = ?),0), 0, ?)
         ON CONFLICT(lead_id) DO UPDATE SET sent=excluded.sent, opened=excluded.opened, clicked=excluded.clicked, replied=excluded.replied,
           email_replies=excluded.email_replies, linkedin_replies=excluded.linkedin_replies, bounced=excluded.bounced, synced_at=excluded.synced_at`,
        p.lead_id,
        p.ovl_prospect_id,
        row.sent,
        row.opened,
        row.clicked,
        row.replied,
        row.email_replies,
        row.linkedin_replies,
        row.bounced,
        p.lead_id,
        p.lead_id,
        nowIso(),
      );
      updated++;
    } catch (e) {
      errors.push({ lead_id: p.lead_id, error: (e as Error).message });
    }
  }
  const summary = { pushed_leads: pushes.length, with_activity: updated, errors };
  logRun('sync', summary);
  return summary;
}

/** Human / agent feedback that the API can't see: reply sentiment and meetings. */
export function recordOutcome(input: { lead_id: number; replied?: boolean; positive?: boolean; meeting?: boolean }) {
  const lead = one('SELECT id FROM leads WHERE id = ?', input.lead_id);
  if (!lead) throw new Error(`unknown lead ${input.lead_id}`);
  run(
    `INSERT INTO outcomes(lead_id, replied, positive, meeting, synced_at) VALUES (?,?,?,?,?)
     ON CONFLICT(lead_id) DO UPDATE SET
       replied = MAX(outcomes.replied, excluded.replied), positive = excluded.positive, meeting = excluded.meeting, synced_at = excluded.synced_at`,
    input.lead_id,
    input.replied || input.positive || input.meeting ? 1 : 0,
    input.positive ? 1 : 0,
    input.meeting ? 1 : 0,
    nowIso(),
  );
  return one('SELECT * FROM outcomes WHERE lead_id = ?', input.lead_id);
}

/** Deterministic PRNG so simulations are reproducible. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 10_000) / 10_000;
  };
}

/**
 * TEST ONLY: synthesize plausible outcomes so the learning loop can be exercised
 * without sending anything. Rows are flagged is_simulated=1 and every analytics
 * view reports them separately.
 */
export function simulateResults(opts: { seed?: number; overwrite?: boolean } = {}) {
  const rand = rng(opts.seed ?? 42);
  const leads = all<any>(
    `SELECT l.id, l.signal_slug, l.icp_score, c.tier, c.intent_strength, c.route, s.hook_type, s.steps_json
       FROM leads l JOIN classifications c ON c.lead_id = l.id
       JOIN sequences s ON s.lead_id = l.id AND s.status = 'final'
      WHERE l.status IN ('final', 'pushed')`,
  );
  let n = 0;
  tx(() => {
    for (const l of leads) {
      const existing = one<any>('SELECT is_simulated, sent, replied FROM outcomes WHERE lead_id = ?', l.id);
      // Never overwrite a real outcome where something actually happened.
      if (existing && !existing.is_simulated && (existing.sent || existing.replied) && !opts.overwrite) continue;
      const tierBoost = { A: 1.6, B: 1.0, C: 0.55 }[l.tier as 'A' | 'B' | 'C'] ?? 0.5;
      const hookBoost = l.hook_type === 'signal_reference' ? 1.5 : l.hook_type === 'company_trigger' ? 1.25 : 0.9;
      const routeBoost = l.route === 'both' ? 1.3 : l.route === 'linkedin' ? 1.1 : 1.0;
      const intent = 0.6 + 0.15 * (l.intent_strength ?? 3);
      const pReply = Math.min(0.6, 0.06 * tierBoost * hookBoost * routeBoost * intent);
      const hasEmail = JSON.parse(l.steps_json).some((s: any) => s.type === 'email');
      const bounced = hasEmail && rand() < 0.04 ? 1 : 0;
      const opened = hasEmail && !bounced && rand() < 0.55 + 0.1 * tierBoost ? 1 : 0;
      const replied = !bounced && rand() < pReply ? 1 : 0;
      const positive = replied && rand() < 0.45 * tierBoost ? 1 : 0;
      const meeting = positive && rand() < 0.5 ? 1 : 0;
      const liReply = replied && l.route !== 'email' && (l.route === 'linkedin' || rand() < 0.5);
      run(
        `INSERT INTO outcomes(lead_id, sent, opened, clicked, replied, email_replies, linkedin_replies, bounced, positive, meeting, is_simulated, synced_at)
         VALUES (?,1,?,?,?,?,?,?,?,?,1,?)
         ON CONFLICT(lead_id) DO UPDATE SET sent=1, opened=excluded.opened, clicked=excluded.clicked, replied=excluded.replied,
           email_replies=excluded.email_replies, linkedin_replies=excluded.linkedin_replies, bounced=excluded.bounced,
           positive=excluded.positive, meeting=excluded.meeting, is_simulated=1, synced_at=excluded.synced_at`,
        l.id,
        opened,
        opened && rand() < 0.2 ? 1 : 0,
        replied,
        replied && !liReply ? 1 : 0,
        liReply ? 1 : 0,
        bounced,
        positive,
        meeting,
        nowIso(),
      );
      n++;
    }
  });
  const summary = { simulated: n, note: 'Synthetic outcomes (is_simulated=1) for exercising the learning loop. Never treat as real performance.' };
  logRun('simulate', summary);
  return summary;
}
