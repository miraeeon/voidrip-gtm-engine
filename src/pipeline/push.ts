import { getConfig, toMinutes } from '../config.js';

const DAY_NAMES: Record<string, string> = {
  MON: 'monday', TUE: 'tuesday', WED: 'wednesday', THU: 'thursday', FRI: 'friday', SAT: 'saturday', SUN: 'sunday',
};
import { OverloopClient, type OvlProspect } from '../clients/overloop.js';
import { ApiError } from '../clients/http.js';
import { SafetyError } from '../safety/guard.js';
import { all, auditSink, logRun, nowIso, one, run, today } from '../db/db.js';
import type { Step } from './sequence.js';

export function textToHtml(body: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return body
    .trim()
    .split(/\n\s*\n/)
    .map((para) => `<p>${esc(para).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

/** Translate our channel-agnostic steps into Overloop inline campaign steps (with delay steps). */
export function toOverloopSteps(steps: Step[]): { type: string; config: Record<string, unknown> }[] {
  const out: { type: string; config: Record<string, unknown> }[] = [];
  for (const s of steps) {
    if (s.delay_days > 0) out.push({ type: 'delay', config: { days_delay: s.delay_days } });
    switch (s.type) {
      case 'email':
        out.push({ type: 'email', config: { generate_with_ai: false, subject: s.subject, content: textToHtml(s.body) } });
        break;
      case 'linkedin_visit':
        out.push({ type: 'linkedin_visit_profile', config: {} });
        break;
      case 'linkedin_invite':
        out.push({ type: 'linkedin_send_invitation', config: { generate_with_ai: false, message: s.note } });
        break;
      case 'linkedin_message':
        out.push({ type: 'linkedin_send_message', config: { generate_with_ai: false, message: s.message } });
        break;
    }
  }
  return out;
}

export function campaignName(prefix: string, lead: { name: string | null; company: string | null }, route: string, date = today()): string {
  const who = [lead.name, lead.company].filter(Boolean).join(' @ ') || 'lead';
  return `${prefix} ${date} · ${who} · ${route}`.slice(0, 190);
}

/** Inert campaign settings. SendGuard also enforces these, this is belt and braces. */
export const INERT_CAMPAIGN = {
  status: 'off',
  only_allow_manual_enrollment: true,
  automatically_send_messages: false,
  automatically_send_follow_ups: false,
  automatically_reenroll: false,
} as const;

export interface PushOptions {
  limit?: number;
  leadIds?: number[];
  /** Attempt enrollment after creating the campaign. Blocked by SendGuard unless SEND_MODE=live. */
  enroll?: boolean;
  client?: OverloopClient;
}

export interface PushItem {
  lead_id: number;
  status: 'pushed' | 'skipped' | 'error' | 'blocked';
  reason?: string;
  ovl_prospect_id?: number;
  prospect_created?: boolean;
  ovl_campaign_id?: number;
  campaign_name?: string;
}

export async function pushToOverloop(opts: PushOptions = {}) {
  const cfg = getConfig();
  const client = opts.client ?? new OverloopClient({ audit: auditSink });
  const filter = opts.leadIds?.length ? `AND l.id IN (${opts.leadIds.map(Number).join(',')})` : '';
  const pushedToday = one<{ n: number }>(`SELECT COUNT(*) n FROM pushes WHERE substr(pushed_at,1,10) = ?`, today())?.n ?? 0;
  const capLeft = Math.max(0, cfg.GTM_DAILY_PUSH_LIMIT - pushedToday);
  if (capLeft === 0) {
    const summary = { send_mode: cfg.SEND_MODE, attempted: 0, pushed: 0, skipped: 0, errors: 0, blocked: 0, items: [] as PushItem[], note: `Daily push limit reached (${cfg.GTM_DAILY_PUSH_LIMIT}/day, GTM_DAILY_PUSH_LIMIT). Remaining finals stay queued for tomorrow.` };
    logRun('push', summary);
    return summary;
  }
  const rows = all<any>(
    `SELECT l.*, s.id AS sequence_id, s.steps_json, s.route AS seq_route
       FROM leads l JOIN sequences s ON s.lead_id = l.id AND s.status = 'final'
      WHERE l.status = 'final' ${filter}
      ORDER BY l.id LIMIT ?`,
    Math.min(opts.limit ?? 50, capLeft),
  );

  const items: PushItem[] = [];
  for (const lead of rows) {
    try {
      items.push(await pushOne(client, lead, cfg, opts.enroll === true));
    } catch (e) {
      const blocked = e instanceof SafetyError;
      items.push({ lead_id: lead.id, status: blocked ? 'blocked' : 'error', reason: (e as Error).message });
      if (blocked) break; // a guard violation is a bug in the caller — stop the batch
    }
  }
  const summary = {
    send_mode: cfg.SEND_MODE,
    attempted: rows.length,
    pushed: items.filter((i) => i.status === 'pushed').length,
    skipped: items.filter((i) => i.status === 'skipped').length,
    errors: items.filter((i) => i.status === 'error').length,
    blocked: items.filter((i) => i.status === 'blocked').length,
    items,
    note:
      cfg.SEND_MODE === 'locked'
        ? 'SEND_MODE=locked: campaigns were created as inert drafts (status off, manual enrollment, no auto-send). Nobody was enrolled; nothing can be sent.'
        : undefined,
  };
  logRun('push', summary);
  return summary;
}

async function pushOne(client: OverloopClient, lead: any, cfg: ReturnType<typeof getConfig>, enroll: boolean): Promise<PushItem> {
  // 1. Resolve the prospect (never duplicate, never hijack an active conversation).
  let prospect: OvlProspect | null = null;
  if (lead.email) prospect = await client.findProspectByEmail(lead.email);
  if (!prospect && lead.linkedin_url) prospect = await client.findProspectByLinkedin(lead.linkedin_url);
  if (prospect && (prospect.replied || prospect.excluded)) {
    run(`UPDATE leads SET status = 'duplicate' WHERE id = ?`, lead.id);
    return {
      lead_id: lead.id,
      status: 'skipped',
      reason: prospect.excluded ? 'prospect is on the Overloop exclusion list' : 'prospect already replied in Overloop — hand to a human',
      ovl_prospect_id: prospect.id,
    };
  }
  let created = false;
  if (!prospect) {
    const attrs: Record<string, unknown> = {
      first_name: lead.first_name ?? undefined,
      last_name: lead.last_name ?? undefined,
      jobtitle: lead.job_title ?? undefined,
      linkedin_profile: lead.linkedin_url ?? undefined,
      description: `Sourced by GTM Autopilot from Max signal "${lead.signal_name ?? lead.signal_slug}" (lead #${lead.id}).`,
    };
    if (lead.email) attrs.email = lead.email;
    prospect = await client.createProspect(attrs);
    created = true;
  }

  // 2. One inert draft campaign per lead holding the literal, lead-specific copy.
  const steps = toOverloopSteps(JSON.parse(lead.steps_json));
  const name = campaignName(cfg.OVERLOOP_NAME_PREFIX, lead, lead.seq_route);
  const body: Record<string, unknown> = {
    name,
    timezone: cfg.OVERLOOP_TIMEZONE,
    sending_days: cfg.OVERLOOP_SENDING_DAYS.map((d) => DAY_NAMES[d]),
    start_sending_minutes: toMinutes(cfg.OVERLOOP_SEND_START),
    end_sending_minutes: toMinutes(cfg.OVERLOOP_SEND_END),
    ...INERT_CAMPAIGN,
    steps,
  };
  if (cfg.OVERLOOP_SENDER_ID) body.sender_id = Number(cfg.OVERLOOP_SENDER_ID);
  let campaign;
  try {
    campaign = await client.createCampaign(body);
  } catch (e) {
    // Some accounts reject unknown automation flags; retry with the minimum inert set.
    if (e instanceof ApiError && e.status === 422) {
      const { automatically_send_messages, automatically_send_follow_ups, automatically_reenroll, ...minimal } = body;
      void automatically_send_messages, automatically_send_follow_ups, automatically_reenroll;
      campaign = await client.createCampaign(minimal);
    } else throw e;
  }

  run(
    `INSERT INTO pushes(lead_id, sequence_id, ovl_prospect_id, prospect_created, ovl_campaign_id, campaign_name, send_mode, enrolled, pushed_at)
     VALUES (?,?,?,?,?,?,?,0,?)`,
    lead.id,
    lead.sequence_id,
    prospect.id,
    created ? 1 : 0,
    campaign.id,
    name,
    cfg.SEND_MODE,
    nowIso(),
  );
  run(`UPDATE leads SET status = 'pushed' WHERE id = ?`, lead.id);

  // 3. Enrollment is the only step that can send. SendGuard blocks it unless SEND_MODE=live.
  if (enroll) {
    await client.createEnrollment(campaign.id, prospect.id, { allowSend: cfg.SEND_MODE === 'live' });
    run('UPDATE pushes SET enrolled = 1 WHERE ovl_campaign_id = ?', campaign.id);
  }

  return {
    lead_id: lead.id,
    status: 'pushed',
    ovl_prospect_id: prospect.id,
    prospect_created: created,
    ovl_campaign_id: campaign.id,
    campaign_name: name,
  };
}

/** Human review gate: mark pushed campaigns as approved for launch (all pending, or specific leads). */
export function approvePushes(leadIds?: number[], revoke = false) {
  const filter = leadIds?.length ? `AND lead_id IN (${leadIds.map(Number).join(',')})` : '';
  if (revoke) {
    const r = run(`UPDATE pushes SET approved_at = NULL WHERE launched_at IS NULL AND approved_at IS NOT NULL ${filter}`);
    logRun('approve', { revoked: Number(r.changes), leadIds: leadIds ?? 'all' });
    return { revoked: Number(r.changes) };
  }
  const r = run(`UPDATE pushes SET approved_at = ? WHERE deleted_at IS NULL AND approved_at IS NULL AND launched_at IS NULL ${filter}`, nowIso());
  logRun('approve', { approved: Number(r.changes), leadIds: leadIds ?? 'all' });
  return { approved: Number(r.changes) };
}

/** What a human should review before launch: the literal copy of every pushed, not-yet-launched campaign. */
export function reviewQueue(limit = 25) {
  return all<any>(
    `SELECT p.lead_id, p.ovl_campaign_id, p.campaign_name, p.approved_at, c.tier, c.route, c.first_channel, s.steps_json
       FROM pushes p JOIN classifications c ON c.lead_id = p.lead_id JOIN sequences s ON s.id = p.sequence_id
      WHERE p.deleted_at IS NULL AND p.launched_at IS NULL ORDER BY p.id LIMIT ?`,
    limit,
  ).map((r) => ({ ...r, steps: JSON.parse(r.steps_json), steps_json: undefined, overloop_url: `https://app.overloop.ai/campaigns/${r.ovl_campaign_id}` }));
}

/**
 * The ONLY path that sends: enroll the prospect and switch the campaign on.
 * Requires SEND_MODE=live, human approval (approved_at), and confirm === "SEND".
 * In locked mode every attempt is blocked (and audited) by the SendGuard.
 */
export async function launchApproved(opts: { leadIds?: number[]; confirm?: string; client?: OverloopClient } = {}) {
  const cfg = getConfig();
  const client = opts.client ?? new OverloopClient({ audit: auditSink });
  if (opts.confirm !== 'SEND') {
    return { launched: 0, items: [], note: 'Nothing launched. Pass confirm: "SEND" to launch approved campaigns (requires SEND_MODE=live).' };
  }
  const filter = opts.leadIds?.length ? `AND lead_id IN (${opts.leadIds.map(Number).join(',')})` : '';
  const rows = all<any>(`SELECT * FROM pushes WHERE deleted_at IS NULL AND launched_at IS NULL AND approved_at IS NOT NULL ${filter} ORDER BY id`);
  const items: { lead_id: number; status: string; reason?: string }[] = [];
  for (const p of rows) {
    try {
      // Re-check right before sending: never enroll someone who replied or got excluded meanwhile.
      const pr = await client.getProspect(p.ovl_prospect_id);
      if (pr.replied || pr.excluded || pr.bounced) {
        items.push({ lead_id: p.lead_id, status: 'skipped', reason: pr.replied ? 'already replied' : pr.excluded ? 'excluded' : 'bounced' });
        continue;
      }
      const allow = { allowSend: cfg.SEND_MODE === 'live' };
      await client.createEnrollment(p.ovl_campaign_id, p.ovl_prospect_id, allow);
      await client.updateCampaign(p.ovl_campaign_id, { status: 'on' }, allow);
      run('UPDATE pushes SET enrolled = 1, launched_at = ? WHERE id = ?', nowIso(), p.id);
      items.push({ lead_id: p.lead_id, status: 'launched' });
    } catch (e) {
      const blocked = e instanceof SafetyError;
      items.push({ lead_id: p.lead_id, status: blocked ? 'blocked' : 'error', reason: (e as Error).message });
      if (blocked) break;
    }
  }
  const summary = {
    send_mode: cfg.SEND_MODE,
    approved_candidates: rows.length,
    launched: items.filter((i) => i.status === 'launched').length,
    items,
  };
  logRun('launch', summary);
  return summary;
}

/** Verify what we created in Overloop is still inert: status off/draft and zero enrollments. */
export async function verifyPushes(opts: { client?: OverloopClient; limit?: number } = {}) {
  const client = opts.client ?? new OverloopClient({ audit: auditSink });
  const rows = all<any>(`SELECT * FROM pushes WHERE deleted_at IS NULL AND launched_at IS NULL ORDER BY id DESC LIMIT ?`, opts.limit ?? 25);
  const checks = [];
  for (const p of rows) {
    try {
      const c = await client.getCampaign(p.ovl_campaign_id);
      const enr = await client.listEnrollments(p.ovl_campaign_id);
      const enrollments = enr.pagination?.total ?? enr.data.length;
      checks.push({ campaign_id: p.ovl_campaign_id, name: c.name, status: c.status, enrollments, inert: (c.status === 'off' || c.status === 'draft') && enrollments === 0 });
    } catch (e) {
      checks.push({ campaign_id: p.ovl_campaign_id, error: (e as Error).message });
    }
  }
  return { all_inert: checks.every((c: any) => c.inert === true), checks };
}

/** Delete everything the bot created in Overloop (campaigns + prospects it created). */
export async function cleanupOverloop(opts: { client?: OverloopClient; dryRun?: boolean } = {}) {
  const client = opts.client ?? new OverloopClient({ audit: auditSink });
  const prefix = getConfig().OVERLOOP_NAME_PREFIX;
  const rows = all<any>('SELECT * FROM pushes WHERE deleted_at IS NULL');
  const out: { campaign_id: number; prospect_id: number | null; deleted: boolean; error?: string }[] = [];
  for (const p of rows) {
    if (!String(p.campaign_name ?? '').startsWith(prefix)) continue;
    if (opts.dryRun) {
      out.push({ campaign_id: p.ovl_campaign_id, prospect_id: p.prospect_created ? p.ovl_prospect_id : null, deleted: false });
      continue;
    }
    try {
      await client.deleteCampaign(p.ovl_campaign_id).catch((e) => {
        if (!(e instanceof ApiError && e.status === 404)) throw e;
      });
      if (p.prospect_created) {
        await client.deleteProspect(p.ovl_prospect_id).catch((e) => {
          if (!(e instanceof ApiError && e.status === 404)) throw e;
        });
      }
      run('UPDATE pushes SET deleted_at = ? WHERE id = ?', nowIso(), p.id);
      run(`UPDATE leads SET status = 'final' WHERE id = ? AND status = 'pushed'`, p.lead_id);
      out.push({ campaign_id: p.ovl_campaign_id, prospect_id: p.prospect_created ? p.ovl_prospect_id : null, deleted: true });
    } catch (e) {
      out.push({ campaign_id: p.ovl_campaign_id, prospect_id: p.ovl_prospect_id, deleted: false, error: (e as Error).message });
    }
  }
  logRun('cleanup', { count: out.length, dryRun: !!opts.dryRun });
  return { dry_run: !!opts.dryRun, items: out };
}

export function pushedCount(): number {
  return one<{ n: number }>('SELECT COUNT(*) n FROM pushes WHERE deleted_at IS NULL')?.n ?? 0;
}
