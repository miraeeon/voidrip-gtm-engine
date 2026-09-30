import { businessId as configuredBusinessId, getConfig } from '../config.js';
import { createDefaultManagedSourceAdapter, createDefaultSourceAdapter } from '../adapters/runtime.js';
import type { ManagedSourceAdapter, SourceAdapter, SourceCandidate, SourceSignal } from '../adapters/source.js';
import { normalizeLinkedinUrl } from '../identity/linkedin.js';
import { all, getDb, kvSet, logRun, nowIso, one, run, today, tx } from '../db/db.js';
import { getWeights } from './weights.js';

export function splitName(full: string | null): { first: string | null; last: string | null } {
  if (!full) return { first: null, last: null };
  const clean = full.replace(/\s*[,|].*$/, '').replace(/\s+/g, ' ').trim();
  const parts = clean.split(' ');
  if (parts.length === 1) return { first: parts[0]!, last: null };
  return { first: parts[0]!, last: parts.slice(1).join(' ') };
}

export function dedupeKey(lead: Pick<SourceCandidate, 'email' | 'linkedin_url' | 'name' | 'company'>): string {
  if (lead.email) return `email:${lead.email.trim().toLowerCase()}`;
  if (lead.linkedin_url) return `li:${normalizeLinkedinUrl(lead.linkedin_url)}`;
  return `name:${(lead.name ?? '').toLowerCase()}|${(lead.company ?? '').toLowerCase()}`;
}

export function leadToRow(lead: SourceCandidate, businessId: number, runDate: string) {
  const { first, last } = splitName(lead.name);
  const p = lead.payload ?? {};
  const signal = lead.signals?.[0];
  return {
    id: lead.id,
    business_id: businessId,
    external_id: lead.external_id,
    name: lead.name,
    first_name: first,
    last_name: last,
    headline: lead.headline,
    job_title: lead.job_title,
    email: lead.email,
    phone: lead.phone,
    linkedin_url: lead.linkedin_url,
    location: lead.location,
    company: lead.company,
    company_industry: lead.company_industry,
    company_size: lead.company_size,
    company_website: lead.company_website,
    company_linkedin: lead.company_linkedin,
    company_summary: (p.company_summary as string) ?? null,
    icp_score: lead.icp_score,
    engagement_type: lead.engagement_type,
    engagement_context: (p.engagement_context as string) ?? null,
    signal_excerpt: (p.signal_excerpt as string) ?? null,
    post_url: lead.post_url,
    signal_slug: signal?.slug ?? null,
    signal_name: signal?.name ?? null,
    payload_json: JSON.stringify(p),
    triggered_at: lead.triggered_at,
    sourced_at: nowIso(),
    run_date: runDate,
    status: 'new',
    dedupe_key: dedupeKey(lead),
  };
}

export interface SourceResult {
  business_id: number;
  fetched: number;
  inserted: number;
  duplicates: number;
  by_signal: Record<string, number>;
  note?: string;
}

export async function sourceLeads(opts: { businessId?: number; maxPages?: number; source?: SourceAdapter } = {}): Promise<SourceResult> {
  const businessId = opts.businessId ?? configuredBusinessId();
  const source = opts.source ?? createDefaultSourceAdapter();
  const runDate = today();
  const known = new Set(all<{ id: number }>('SELECT id FROM leads WHERE business_id = ?', businessId).map((r) => r.id));
  const fresh = await source.listCandidates({ scopeId: businessId, knownIds: known, maxPages: opts.maxPages ?? 10 });

  const stmt = getDb().prepare(`INSERT OR IGNORE INTO leads (
    id, business_id, external_id, name, first_name, last_name, headline, job_title, email, phone, linkedin_url, location,
    company, company_industry, company_size, company_website, company_linkedin, company_summary, icp_score,
    engagement_type, engagement_context, signal_excerpt, post_url, signal_slug, signal_name, payload_json,
    triggered_at, sourced_at, run_date, status, dedupe_key
  ) VALUES (${new Array(31).fill('?').join(',')})`);

  let inserted = 0;
  let duplicates = 0;
  const bySignal: Record<string, number> = {};
  tx(() => {
    for (const lead of fresh) {
      const row = leadToRow(lead, businessId, runDate);
      const dupe = one<{ id: number }>('SELECT id FROM leads WHERE dedupe_key = ? AND id != ?', row.dedupe_key, row.id);
      if (dupe) {
        row.status = 'duplicate';
        duplicates++;
      }
      const r = stmt.run(...(Object.values(row) as any[]));
      if (Number(r.changes) > 0) {
        inserted++;
        const k = row.signal_slug ?? 'unknown';
        bySignal[k] = (bySignal[k] ?? 0) + 1;
      }
    }
  });
  kvSet(`last_source_at:${businessId}`, nowIso());
  const result: SourceResult = { business_id: businessId, fetched: fresh.length, inserted, duplicates, by_signal: bySignal };
  if (fresh.length === 0) {
    result.note =
      `No new leads from ${source.getSourceMetadata().provider}. Check the configured source, then re-run later.`;
  }
  logRun('source', result);
  return result;
}

export interface SetupView {
  business: { id: number; name: string; website: string; description: string | null };
  icp: unknown;
  subscriptions: { id: number; name: string; signal: string; active: boolean; config: unknown; last_checked_at: string | null }[];
  signal_catalog: { slug: string; name: string; description: string; input_schema: unknown }[];
  signal_weights: Record<string, number>;
  leads_in_db: number;
}

export async function getSetup(opts: { businessId?: number; source?: ManagedSourceAdapter; includeCatalog?: boolean } = {}): Promise<SetupView> {
  const businessId = opts.businessId ?? configuredBusinessId();
  const source = opts.source ?? createDefaultManagedSourceAdapter();
  const [biz, subs, signals] = await Promise.all([
    source.getBusiness(businessId),
    source.listSubscriptions(businessId),
    opts.includeCatalog === false ? Promise.resolve([] as SourceSignal[]) : source.listSignals(),
  ]);
  const weights = getWeights('signal:');
  return {
    business: { id: biz.id, name: biz.name, website: biz.website, description: biz.description },
    icp: biz.ideal_customer_profile ?? null,
    subscriptions: subs.map((s) => ({
      id: s.id,
      name: s.name,
      signal: s.signal.slug,
      active: s.active,
      config: s.config,
      last_checked_at: s.last_checked_at,
    })),
    signal_catalog: signals
      .filter((s) => s.active)
      .map((s) => ({
        slug: s.slug,
        name: s.name,
        description: s.description.slice(0, 400),
        input_schema: s.default_config?.input_schema ?? null,
      })),
    signal_weights: weights,
    leads_in_db: one<{ n: number }>('SELECT COUNT(*) n FROM leads WHERE business_id = ?', businessId)?.n ?? 0,
  };
}

/** Create a subscription, or resume it if an identical-signal one exists but is paused. Lead *searching* only. */
export async function ensureSubscription(input: {
  signal_slug: string;
  name: string;
  config?: Record<string, unknown>;
  businessId?: number;
  source?: ManagedSourceAdapter;
}) {
  const businessId = input.businessId ?? configuredBusinessId();
  const source = input.source ?? createDefaultManagedSourceAdapter();
  const existing = (await source.listSubscriptions(businessId)).find(
    (s) => s.signal.slug === input.signal_slug && JSON.stringify(s.config ?? {}) === JSON.stringify(input.config ?? {}),
  );
  if (existing) {
    if (!existing.active) {
      await source.resumeSubscription(businessId, existing.id);
      logRun('subscription', { action: 'resumed', id: existing.id, signal: input.signal_slug });
      return { action: 'resumed', id: existing.id };
    }
    return { action: 'exists', id: existing.id };
  }
  const created = await source.createSubscription(businessId, {
    signal_slug: input.signal_slug,
    name: input.name,
    config: input.config,
  });
  logRun('subscription', { action: 'created', id: created.id, signal: input.signal_slug });
  run('INSERT OR IGNORE INTO weights(key, value, note, updated_at) VALUES (?,?,?,?)', `signal:${input.signal_slug}`, 1, 'new subscription', nowIso());
  return { action: 'created', id: created.id };
}

export async function pauseSubscription(id: number, opts: { businessId?: number; source?: ManagedSourceAdapter } = {}) {
  const businessId = opts.businessId ?? configuredBusinessId();
  await (opts.source ?? createDefaultManagedSourceAdapter()).pauseSubscription(businessId, id);
  logRun('subscription', { action: 'paused', id });
  return { action: 'paused', id };
}

export async function resumeSubscription(id: number, opts: { businessId?: number; source?: ManagedSourceAdapter } = {}) {
  const businessId = opts.businessId ?? configuredBusinessId();
  await (opts.source ?? createDefaultManagedSourceAdapter()).resumeSubscription(businessId, id);
  logRun('subscription', { action: 'resumed', id });
  return { action: 'resumed', id };
}

export async function updateIcp(
  icp: Record<string, unknown> & { id: number },
  opts: { businessId?: number; source?: ManagedSourceAdapter } = {},
) {
  const businessId = opts.businessId ?? configuredBusinessId();
  return (opts.source ?? createDefaultManagedSourceAdapter()).updateIcp(businessId, icp);
}
