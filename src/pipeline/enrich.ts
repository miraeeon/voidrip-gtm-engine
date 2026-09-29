import { OverloopClient, type OvlProspect } from '../clients/overloop.js';
import { all, auditSink, logRun, run } from '../db/db.js';

/** What Overloop already knows about a lead — used for routing and to avoid double-contacting. */
export interface OverloopContext {
  exists: boolean;
  prospect_id?: number;
  email_status?: string | null;
  bounced?: boolean;
  replied?: boolean;
  email_reply_count?: number;
  linkedin_reply_count?: number;
  opened?: boolean;
  excluded?: boolean;
  last_emailed_at?: string | null;
  checked_at: string;
}

export function toContext(p: OvlProspect | null): OverloopContext {
  const checked_at = new Date().toISOString();
  if (!p) return { exists: false, checked_at };
  return {
    exists: true,
    prospect_id: p.id,
    email_status: p.email_status ?? null,
    bounced: p.bounced,
    replied: p.replied,
    email_reply_count: p.email_reply_count,
    linkedin_reply_count: p.linkedin_reply_count,
    opened: p.opened,
    excluded: p.excluded,
    last_emailed_at: p.last_emailed_at,
    checked_at,
  };
}

/**
 * Read-only lookup of every not-yet-enriched lead in Overloop (by email, then LinkedIn URL).
 * The result feeds classification (history, deliverability) and hard routing rules.
 */
export async function enrichFromOverloop(opts: { client?: OverloopClient; limit?: number; leadIds?: number[] } = {}) {
  const client = opts.client ?? new OverloopClient({ audit: auditSink });
  const filter = opts.leadIds?.length ? `AND id IN (${opts.leadIds.map(Number).join(',')})` : '';
  const leads = all<any>(
    `SELECT id, email, linkedin_url FROM leads WHERE status = 'new' AND ovl_context_json IS NULL ${filter} ORDER BY id LIMIT ?`,
    opts.limit ?? 200,
  );
  let known = 0;
  const errors: { lead_id: number; error: string }[] = [];
  for (const l of leads) {
    try {
      let p: OvlProspect | null = null;
      if (l.email) p = await client.findProspectByEmail(l.email);
      if (!p && l.linkedin_url) p = await client.findProspectByLinkedin(l.linkedin_url);
      const ctx = toContext(p);
      if (ctx.exists) known++;
      run('UPDATE leads SET ovl_context_json = ? WHERE id = ?', JSON.stringify(ctx), l.id);
    } catch (e) {
      errors.push({ lead_id: l.id, error: (e as Error).message });
    }
  }
  const summary = { checked: leads.length - errors.length, already_in_overloop: known, errors };
  logRun('enrich', summary);
  return summary;
}
