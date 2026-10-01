import fs from 'node:fs';
import { z } from 'zod';
import { businessId as configuredBusinessId, ENV_FILE, getConfig } from '../config.js';
import type { ExecutionAdapter } from '../adapters/execution.js';
import { createDefaultExecutionAdapter, createDefaultHeyReachAdapter, createDefaultManagedSourceAdapter } from '../adapters/runtime.js';
import type { ManagedSourceAdapter } from '../adapters/source.js';
import { auditSink, kvGet, kvSet, logRun, one } from '../db/db.js';

export const SellerProfile = z.object({
  company: z.string().min(1),
  website: z.string().min(3),
  description: z.string().nullable().optional(),
  value_proposition: z.string().max(1500).optional(),
  proof_points: z.array(z.string().max(300)).max(10).optional(),
  primary_cta: z.string().max(200).optional().describe('e.g. "15-min intro call", "reply for the 1-pager"'),
  tone: z.string().max(200).optional(),
  language: z.string().max(160).optional(),
  do_not_say: z.array(z.string().max(200)).max(20).optional(),
  icp: z.unknown().optional(),
});
export type SellerProfile = z.infer<typeof SellerProfile>;

export function getSellerProfile(businessId = getConfig().MAX_BUSINESS_ID): SellerProfile | null {
  const raw = kvGet(`seller:${businessId}`);
  return raw ? JSON.parse(raw) : null;
}

export function setSellerProfile(patch: Partial<SellerProfile>, businessId = getConfig().MAX_BUSINESS_ID): SellerProfile {
  const merged = { ...(getSellerProfile(businessId) ?? {}), ...patch };
  const p = SellerProfile.parse(merged);
  kvSet(`seller:${businessId}`, JSON.stringify(p));
  return p;
}

/** Pull the business + ICP from Max and cache it as the seller profile (keeps user-edited fields). */
export async function syncSellerFromSource(opts: { businessId?: number; source?: ManagedSourceAdapter } = {}) {
  const businessId = opts.businessId ?? configuredBusinessId();
  const biz = await (opts.source ?? createDefaultManagedSourceAdapter()).getBusiness(businessId);
  return setSellerProfile(
    { company: biz.name, website: biz.website, description: biz.description, icp: biz.ideal_customer_profile ?? null },
    businessId,
  );
}

export const syncSellerFromMax = syncSellerFromSource;

/** Health check for the active VOIDRIP path; legacy providers remain optional. Read-only. */
export async function doctor(opts: { source?: ManagedSourceAdapter; execution?: ExecutionAdapter } = {}) {
  const cfg = getConfig();
  const out: Record<string, unknown> = {
    send_mode: cfg.SEND_MODE,
    daily_review_target: cfg.GTM_DAILY_SEQUENCES,
    active_path: 'Drive Market Map → Codex → local review → explicit HeyReach import',
    market_map: {
      ok: true,
      candidates: one<{ n: number }>('SELECT COUNT(*) n FROM candidates')?.n ?? 0,
      outbound_fit: one<{ n: number }>(
        `SELECT COUNT(*) n FROM boundary_qualifications b
          WHERE b.boundary_status='PASS_OUTBOUND_V1'
            AND b.id=(SELECT MAX(b2.id) FROM boundary_qualifications b2 WHERE b2.project_id=b.project_id)`,
      )?.n ?? 0,
      signals: one<{ n: number }>('SELECT COUNT(*) n FROM signal_events')?.n ?? 0,
      review_ready: one<{ n: number }>(`SELECT COUNT(*) n FROM candidate_sequences WHERE status='final' AND review_status='pending'`)?.n ?? 0,
    },
  };
  try {
    const inspection = await createDefaultHeyReachAdapter(auditSink).inspectConfiguredCampaign();
    out.heyreach = {
      ok: true,
      campaign_id: inspection.campaign.id,
      status: inspection.campaign.status,
      leads: inspection.leadCount,
      inert: inspection.inert,
    };
  } catch (e) {
    out.heyreach = { ok: false, error: (e as Error).message };
  }
  if (cfg.MAX_API_KEY && cfg.MAX_BUSINESS_ID) {
    try {
      const source = opts.source ?? createDefaultManagedSourceAdapter();
      const biz = await source.getBusiness(configuredBusinessId());
      out.legacy_max = { configured: true, ok: true, business: biz.name };
    } catch (e) {
      out.legacy_max = { configured: true, ok: false, error: (e as Error).message };
    }
  } else out.legacy_max = { configured: false, required: false };
  if (cfg.OVERLOOP_API_KEY) {
    try {
      const account = await (opts.execution ?? createDefaultExecutionAdapter(auditSink)).getAccount();
      out.legacy_overloop = { configured: true, ok: true, user: account.user.name };
    } catch (e) {
      out.legacy_overloop = { configured: true, ok: false, error: (e as Error).message };
    }
  } else {
    out.legacy_overloop = { configured: false, required: false };
  }
  out.seller_profile = getSellerProfile() ? 'set' : 'missing';
  return out;
}

/** Onboard a company: create (or reuse) the Max business from its website and remember it in .env. */
export async function init(opts: { website?: string; businessId?: number; source?: ManagedSourceAdapter }) {
  const source = opts.source ?? createDefaultManagedSourceAdapter();
  let businessId = opts.businessId;
  if (!businessId && opts.website) {
    const host = new URL(opts.website.startsWith('http') ? opts.website : `https://${opts.website}`).hostname.replace(/^www\./, '');
    const existing = (await source.listBusinesses()).find((business) => (business.website ?? '').includes(host));
    businessId = existing ? existing.id : (await source.createBusiness({ website: `https://${host}` })).id;
  }
  businessId ??= configuredBusinessId();
  writeEnvVar('MAX_BUSINESS_ID', String(businessId));
  process.env.MAX_BUSINESS_ID = String(businessId);
  const seller = await syncSellerFromSource({ businessId, source });
  logRun('init', { businessId });
  return { business_id: businessId, seller, next: 'Review the ICP (gtm setup), fill in value_proposition/proof_points/primary_cta (gtm seller --set), then add signal subscriptions.' };
}

export function writeEnvVar(key: string, value: string, file = ENV_FILE): void {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const re = new RegExp(`^${key}=.*$`, 'm');
  const next = re.test(text) ? text.replace(re, `${key}=${value}`) : `${text.replace(/\s*$/, '\n')}${key}=${value}\n`;
  fs.writeFileSync(file, next, 'utf8');
}
