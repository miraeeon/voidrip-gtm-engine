import { getConfig } from '../config.js';
import type { HeyReachLead } from '../clients/heyreach.js';
import { createDefaultHeyReachAdapter } from '../adapters/runtime.js';
import type { HeyReachAdapter } from '../adapters/heyreach-execution.js';
import { all, auditSink, logRun, nowIso, one, run, tx } from '../db/db.js';
import { normalizeLinkedinUrl } from '../identity/linkedin.js';
import { activationEligibleSignalSql, outsideCurrentYcProgramSql } from '../market-map/activation-eligibility.js';

type ActivationStatus = 'IMPORT_APPROVED' | 'STAGED' | 'LAUNCH_APPROVED' | 'ACTIVE';

function selectedSequences(candidateIds: number[]) {
  const placeholders = candidateIds.map(() => '?').join(',');
  return all<any>(
    `SELECT s.id sequence_id, s.candidate_id, s.project_id, s.steps_json,
            c.name, c.linkedin_url, c.email, c.current_role, c.current_org,
            p.name project_name
       FROM candidate_sequences s
       JOIN candidates c ON c.id=s.candidate_id
       JOIN projects p ON p.id=s.project_id
       JOIN activation_scores a ON a.id=s.activation_score_id
      WHERE s.status='final' AND s.review_status='pending'
        AND a.priority_tier IN ('A','B') AND s.candidate_id IN (${placeholders})
        AND ${activationEligibleSignalSql('s.candidate_id', 's.project_id')}
        AND ${outsideCurrentYcProgramSql('s.candidate_id', 's.project_id')}
      ORDER BY s.id`,
    ...candidateIds,
  );
}

function latestReadyCount() {
  return one<{ n: number }>(
    `SELECT COUNT(*) n FROM candidate_sequences s
       JOIN activation_scores a ON a.id=s.activation_score_id
      WHERE s.status='final' AND s.review_status='pending' AND a.priority_tier IN ('A','B')
       AND ${activationEligibleSignalSql('s.candidate_id', 's.project_id')}
       AND ${outsideCurrentYcProgramSql('s.candidate_id', 's.project_id')}`,
  )?.n ?? 0;
}

export async function getActivationReadiness(opts: { execution?: HeyReachAdapter } = {}) {
  const provider = await (opts.execution ?? createDefaultHeyReachAdapter(auditSink)).inspectReadiness();
  const statuses = Object.fromEntries(
    all<{ status: string; n: number }>(
      `SELECT status, COUNT(*) n FROM provider_activations WHERE provider='heyreach' GROUP BY status`,
    ).map((row) => [row.status, row.n]),
  );
  const localReady = latestReadyCount();
  const blockers = [...provider.blockers];
  if (localReady < getConfig().GTM_DAILY_SEQUENCES) blockers.push(`daily human-review buffer is ${localReady}/${getConfig().GTM_DAILY_SEQUENCES}`);
  return {
    provider: 'heyreach',
    campaign: { id: provider.campaign.id, name: provider.campaign.name, status: provider.campaign.status },
    lead_list: provider.leadList,
    available_accounts: provider.availableAccounts,
    assigned_accounts: provider.assignedAccounts,
    sequence: provider.sequence,
    local_review_ready: localReady,
    activation_statuses: statuses,
    blockers,
    ready_to_enable: blockers.length === 0,
    import_authorized: false,
    launch_authorized: false,
  };
}

export function approveHeyReachImport(candidateIds: number[]) {
  if (!candidateIds.length) throw new Error('candidate_ids must name the prospects explicitly approved for import');
  const cap = getConfig().GTM_DAILY_PUSH_LIMIT;
  if (candidateIds.length > cap) throw new Error(`import approval exceeds daily cap ${cap}`);
  const unique = [...new Set(candidateIds)];
  const rows = selectedSequences(unique);
  if (rows.length !== unique.length) throw new Error('every approved candidate must have one pending final Tier A/B sequence');
  const campaignId = String(getConfig().HEYREACH_CAMPAIGN_ID);
  const at = nowIso();
  tx(() => {
    for (const item of rows) {
      run(
        `INSERT INTO provider_activations(candidate_id,project_id,sequence_id,provider,provider_campaign_id,
          provider_profile_url,status,import_approved_at,created_at,updated_at)
         VALUES (?,?,?,?,?,?,'IMPORT_APPROVED',?,?,?)
         ON CONFLICT(provider,provider_campaign_id,candidate_id,sequence_id) DO UPDATE SET
          status='IMPORT_APPROVED', import_approved_at=excluded.import_approved_at, updated_at=excluded.updated_at`,
        item.candidate_id, item.project_id, item.sequence_id, 'heyreach', campaignId, item.linkedin_url, at, at, at,
      );
    }
  });
  const result = { approved: rows.length, candidate_ids: unique, provider_action: 'NONE', next: 'gtm_stage_heyreach_import requires a separate explicit call' };
  logRun('heyreach_import_approval', result);
  return result;
}

function parseCustomFields(row: any) {
  const messages = (JSON.parse(row.steps_json) as any[]).filter((step) => step.type === 'linkedin_message').map((step) => String(step.message));
  if (messages.length < 2) throw new Error(`candidate ${row.candidate_id} has no M1/M2 messages`);
  const m1 = messages[0]!.match(/^[^,]+, I came across (.+?) on (.+?) and (.+?) caught my attention\./s);
  const m2 = messages[1]!.match(/^[^,]+, (.+?) made me wonder:/s);
  if (!m1 || !m2) throw new Error(`candidate ${row.candidate_id} messages do not match the approved M1/M2 structure`);
  return { specific_project: m1[1]!, platform: m1[2]!, specific_observation: m1[3]!, specific_observation_2: m2[1]! };
}

function asLead(row: any): HeyReachLead {
  const [firstName, ...rest] = String(row.name).trim().split(/\s+/);
  if (!firstName || rest.length === 0 || !row.linkedin_url) throw new Error(`candidate ${row.candidate_id} lacks HeyReach mandatory identity fields`);
  const custom = parseCustomFields(row);
  return {
    firstName,
    lastName: rest.join(' '),
    profileUrl: row.linkedin_url,
    emailAddress: row.email,
    companyName: row.current_org,
    position: row.current_role,
    customUserFields: Object.entries(custom).map(([name, value]) => ({ name, value })),
  };
}

function rawProfileUrl(item: any): string {
  return item?.profileUrl ?? item?.linkedinUrl ?? item?.linkedInUrl ?? item?.lead?.profileUrl ?? item?.lead?.linkedinUrl ?? '';
}

async function stagedProfileUrls(execution: HeyReachAdapter) {
  const urls = new Set<string>();
  let offset = 0;
  while (offset < 1000) {
    const page = await execution.listStagedLeads(offset);
    for (const item of page.items) urls.add(normalizeLinkedinUrl(rawProfileUrl(item)));
    offset += page.items.length;
    if (!page.items.length || offset >= page.totalCount) break;
  }
  return urls;
}

export async function stageApprovedHeyReachImport(opts: { execution?: HeyReachAdapter } = {}) {
  const execution = opts.execution ?? createDefaultHeyReachAdapter(auditSink);
  const rows = all<any>(
    `SELECT pa.id activation_id, pa.candidate_id, pa.project_id, pa.sequence_id, s.steps_json,
            c.name,c.linkedin_url,c.email,c.current_role,c.current_org
       FROM provider_activations pa JOIN candidate_sequences s ON s.id=pa.sequence_id JOIN candidates c ON c.id=pa.candidate_id
      WHERE pa.provider='heyreach' AND pa.status='IMPORT_APPROVED' ORDER BY pa.id`,
  );
  if (!rows.length) throw new Error('no prospects have explicit import approval');
  const campaign = await execution.inspectReadiness();
  if (!campaign.readyForImportApproval) throw new Error(`HeyReach is not ready for safe list staging: ${campaign.blockers.join('; ')}`);
  const leads = rows.map(asLead);
  const providerResult = await execution.stageApprovedLeads(leads, true);
  const verified = await stagedProfileUrls(execution);
  const at = nowIso();
  let staged = 0;
  tx(() => {
    for (const row of rows) {
      if (!verified.has(normalizeLinkedinUrl(row.linkedin_url))) continue;
      run(
        `UPDATE provider_activations SET status='STAGED',provider_list_id=?,staged_at=?,updated_at=? WHERE id=?`,
        String(campaign.leadList!.id), at, at, row.activation_id,
      );
      staged++;
    }
  });
  const result = { attempted: rows.length, staged, provider_result: providerResult, campaign_status: campaign.campaign.status, campaign_started: false };
  logRun('heyreach_import', result);
  return result;
}

export async function approveHeyReachLaunch(candidateIds: number[], opts: { execution?: HeyReachAdapter } = {}) {
  if (!candidateIds.length) throw new Error('candidate_ids must name the prospects explicitly approved for launch');
  const execution = opts.execution ?? createDefaultHeyReachAdapter(auditSink);
  const readiness = await execution.inspectReadiness();
  if (!readiness.readyForLaunchApproval) throw new Error(`HeyReach is not launch-ready: ${readiness.blockers.join('; ')}`);
  const placeholders = candidateIds.map(() => '?').join(',');
  const at = nowIso();
  const changed = run(
    `UPDATE provider_activations SET status='LAUNCH_APPROVED',launch_approved_at=?,updated_at=?
      WHERE provider='heyreach' AND status='STAGED' AND candidate_id IN (${placeholders})`,
    at, at, ...candidateIds,
  );
  if (Number(changed.changes) !== new Set(candidateIds).size) throw new Error('every launch-approved candidate must already be staged');
  return { approved: Number(changed.changes), provider_action: 'NONE', next: 'gtm_launch_heyreach requires SEND_MODE=live and confirm=LAUNCH' };
}

export async function launchApprovedHeyReach(confirm: string, opts: { execution?: HeyReachAdapter } = {}) {
  if (confirm !== 'LAUNCH') return { launched: 0, campaign_started: false, note: 'Nothing launched. Pass confirm=LAUNCH after explicit user approval.' };
  const rows = all<any>(`SELECT * FROM provider_activations WHERE provider='heyreach' AND status='LAUNCH_APPROVED' ORDER BY id`);
  if (!rows.length) throw new Error('no staged prospects have explicit launch approval');
  const execution = opts.execution ?? createDefaultHeyReachAdapter(auditSink);
  await execution.activate(getConfig().SEND_MODE === 'live');
  const at = nowIso();
  run(`UPDATE provider_activations SET status='ACTIVE',launched_at=?,updated_at=? WHERE provider='heyreach' AND status='LAUNCH_APPROVED'`, at, at);
  const result = { launched: rows.length, campaign_started: true, campaign_id: getConfig().HEYREACH_CAMPAIGN_ID };
  logRun('heyreach_launch', result);
  return result;
}

export function activationRows(status?: ActivationStatus) {
  return status
    ? all(`SELECT * FROM provider_activations WHERE provider='heyreach' AND status=? ORDER BY id`, status)
    : all(`SELECT * FROM provider_activations WHERE provider='heyreach' ORDER BY id`);
}
