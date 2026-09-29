import fs from 'node:fs';
import { z } from 'zod';
import { businessId as configuredBusinessId, ENV_FILE, getConfig } from '../config.js';
import { MaxClient } from '../clients/max.js';
import { OverloopClient } from '../clients/overloop.js';
import { auditSink, kvGet, kvSet, logRun } from '../db/db.js';

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
export async function syncSellerFromMax(opts: { businessId?: number; max?: MaxClient } = {}) {
  const businessId = opts.businessId ?? configuredBusinessId();
  const biz = await (opts.max ?? new MaxClient()).getBusiness(businessId);
  return setSellerProfile(
    { company: biz.name, website: biz.website, description: biz.description, icp: biz.ideal_customer_profile ?? null },
    businessId,
  );
}

/** Health check for both platforms + local state. Read-only. */
export async function doctor() {
  const cfg = getConfig();
  const out: Record<string, unknown> = { send_mode: cfg.SEND_MODE, business_id: cfg.MAX_BUSINESS_ID };
  try {
    const max = new MaxClient();
    const biz = await max.getBusiness(configuredBusinessId());
    const subs = await max.listSubscriptions(configuredBusinessId());
    out.max = {
      ok: true,
      business: `${biz.name} (${biz.website})`,
      icp: biz.ideal_customer_profile ? 'configured' : 'missing',
      subscriptions: subs.length,
      active_subscriptions: subs.filter((s) => s.active).length,
    };
  } catch (e) {
    out.max = { ok: false, error: (e as Error).message };
  }
  try {
    const ovl = new OverloopClient({ audit: auditSink });
    const me = await ovl.me();
    const senders = await ovl.listSendingAddresses();
    out.overloop = {
      ok: true,
      user: `${me.name} <${me.email}>`,
      sending_addresses: senders.data.length,
      working_senders: senders.data.filter((s) => s.working).length,
    };
  } catch (e) {
    out.overloop = { ok: false, error: (e as Error).message };
  }
  out.seller_profile = getSellerProfile() ? 'set' : 'missing — run `gtm init`';
  return out;
}

/** Onboard a company: create (or reuse) the Max business from its website and remember it in .env. */
export async function init(opts: { website?: string; businessId?: number }) {
  const max = new MaxClient();
  let businessId = opts.businessId;
  if (!businessId && opts.website) {
    const host = new URL(opts.website.startsWith('http') ? opts.website : `https://${opts.website}`).hostname.replace(/^www\./, '');
    const existing = (await max.listBusinesses()).find((b) => (b.website ?? '').includes(host));
    businessId = existing ? existing.id : (await max.createBusiness({ website: `https://${host}` })).id;
  }
  businessId ??= configuredBusinessId();
  writeEnvVar('MAX_BUSINESS_ID', String(businessId));
  process.env.MAX_BUSINESS_ID = String(businessId);
  const seller = await syncSellerFromMax({ businessId, max });
  logRun('init', { businessId });
  return { business_id: businessId, seller, next: 'Review the ICP (gtm setup), fill in value_proposition/proof_points/primary_cta (gtm seller --set), then add signal subscriptions.' };
}

export function writeEnvVar(key: string, value: string, file = ENV_FILE): void {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const re = new RegExp(`^${key}=.*$`, 'm');
  const next = re.test(text) ? text.replace(re, `${key}=${value}`) : `${text.replace(/\s*$/, '\n')}${key}=${value}\n`;
  fs.writeFileSync(file, next, 'utf8');
}
