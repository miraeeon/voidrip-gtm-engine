import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from '../config.js';
import { all, one, today } from '../db/db.js';
import { getDailyBuffer } from '../market-map/daily-buffer.js';
import { getMarketLearningProposals } from '../market-runtime/learning.js';
import { getMarketPerformance } from '../market-runtime/performance.js';
import { marketReplyInbox } from '../market-runtime/replies.js';
import { getPlaybook } from './playbook.js';

function activationStatuses() {
  return Object.fromEntries(
    all<{ status: string; n: number }>(
      `SELECT status,COUNT(*) n FROM provider_activations WHERE provider='heyreach' GROUP BY status`,
    ).map((row) => [row.status, row.n]),
  );
}

export function status() {
  const cfg = getConfig();
  const buffer = getDailyBuffer(cfg.GTM_DAILY_SEQUENCES);
  return {
    send_mode: cfg.SEND_MODE,
    active_path: 'Drive Market Map → Codex → human review → gated HeyReach list import → gated launch',
    market_map: {
      candidates: one<{ n: number }>('SELECT COUNT(*) n FROM candidates')?.n ?? 0,
      by_state: Object.fromEntries(
        all<{ state: string; n: number }>('SELECT state,COUNT(*) n FROM candidates GROUP BY state').map((row) => [row.state, row.n]),
      ),
      projects: one<{ n: number }>('SELECT COUNT(*) n FROM projects')?.n ?? 0,
      boundary_qualifications: one<{ n: number }>('SELECT COUNT(*) n FROM boundary_qualifications')?.n ?? 0,
      signals: one<{ n: number }>('SELECT COUNT(*) n FROM signal_events')?.n ?? 0,
      activation_scores: one<{ n: number }>('SELECT COUNT(*) n FROM activation_scores')?.n ?? 0,
      local_review: buffer.ready,
      daily_review_target: buffer.target,
      daily_deficit: buffer.deficit,
    },
    heyreach: {
      campaign_id: cfg.HEYREACH_CAMPAIGN_ID,
      activation_statuses: activationStatuses(),
      imported: one<{ n: number }>(`SELECT COUNT(*) n FROM provider_activations WHERE staged_at IS NOT NULL`)?.n ?? 0,
      launched: one<{ n: number }>(`SELECT COUNT(*) n FROM provider_activations WHERE launched_at IS NOT NULL`)?.n ?? 0,
    },
    outcomes: {
      events: one<{ n: number }>('SELECT COUNT(*) n FROM market_outcome_events')?.n ?? 0,
      replies_open: one<{ n: number }>(`SELECT COUNT(*) n FROM market_replies WHERE status NOT IN ('HANDLED','RESOLVED')`)?.n ?? 0,
      learning_pending: one<{ n: number }>(`SELECT COUNT(*) n FROM market_learning_proposals WHERE status='PENDING_REVIEW'`)?.n ?? 0,
    },
    playbook_version: getPlaybook().version,
    blocked_by_guard: one<{ n: number }>('SELECT COUNT(*) n FROM audit WHERE allowed=0')?.n ?? 0,
    last_runs: all('SELECT run_date,stage,at FROM runs ORDER BY id DESC LIMIT 12'),
    legacy: {
      max_overloop_leads: one<{ n: number }>('SELECT COUNT(*) n FROM leads')?.n ?? 0,
      overloop_pushes: one<{ n: number }>('SELECT COUNT(*) n FROM pushes WHERE deleted_at IS NULL')?.n ?? 0,
    },
  };
}

export function buildReport(date = today()) {
  const cfg = getConfig();
  const buffer = getDailyBuffer(cfg.GTM_DAILY_SEQUENCES);
  const performance = getMarketPerformance({ includeSimulated: false });
  const replies = marketReplyInbox(20);
  const proposals = getMarketLearningProposals(5);
  const runs = all<any>('SELECT stage,summary_json,at FROM runs WHERE run_date=? ORDER BY id', date);
  const blocked = all<any>('SELECT at,service,method,path,reason FROM audit WHERE allowed=0 AND substr(at,1,10)=?', date);
  const newSignals = one<{ n: number }>('SELECT COUNT(*) n FROM signal_events WHERE substr(created_at,1,10)=?', date)?.n ?? 0;
  const newSequences = one<{ n: number }>(`SELECT COUNT(*) n FROM candidate_sequences WHERE substr(created_at,1,10)=? AND status='final'`, date)?.n ?? 0;
  const activations = activationStatuses();
  const lines: string[] = [];
  lines.push(`# VOIDRIP GTM — daily brief ${date}`, '');
  lines.push(`**Mode:** \`${cfg.SEND_MODE}\` · **Provider:** HeyReach campaign ${cfg.HEYREACH_CAMPAIGN_ID} · **Playbook:** v${getPlaybook().version}`, '');
  if (cfg.SEND_MODE === 'locked') lines.push('> Locked mode: no campaign can be started and no prospect can be contacted.', '');
  lines.push('> No provider import or campaign launch belongs to the unattended loop. Import and launch require two separate explicit approvals.', '');

  lines.push('## 1. Human-review buffer', '');
  lines.push(`Ready **${buffer.ready}/${buffer.target}** · deficit **${buffer.deficit}** · quality floor: ${buffer.quality_floor}`, '');
  lines.push(`Signals added today: **${newSignals}** · final sequences added today: **${newSequences}**`, '');

  lines.push('## 2. Activation ledger', '');
  if (!Object.keys(activations).length) lines.push('_No provider activation exists. All prospects remain local._', '');
  else lines.push(Object.entries(activations).map(([key, value]) => `- ${key}: ${value}`).join('\n'), '');

  lines.push('## 3. Replies requiring a human', '');
  if (!replies.length) lines.push('_No replies waiting._', '');
  for (const reply of replies) {
    lines.push(`- **${reply.name}** · ${reply.project_name} · ${reply.category ?? reply.status} — ${reply.summary ?? 'exact text still needed'}`);
    if (reply.next_action) lines.push(`  - Next: ${reply.next_action}`);
    if (reply.draft_response) lines.push(`  - Draft only: ${String(reply.draft_response).replace(/\n+/g, ' ').slice(0, 300)}`);
  }
  lines.push('');

  lines.push('## 4. Real performance', '');
  if (performance.data_quality.warning) lines.push(`> ${performance.data_quality.warning}`, '');
  if (!performance.totals?.contacted) lines.push('_No real contacted outcome yet._', '');
  else {
    const total = performance.totals;
    lines.push(`Contacted **${total.contacted}** · replies **${total.reply_rate}%** · positive **${total.positive_rate}%** · Scan **${total.scan_rate}%** · sales **${total.sale_rate}%**`, '');
  }

  lines.push('## 5. Learning proposals', '');
  if (!proposals.length) lines.push('_No proposal yet. The system will not invent learning without real outcomes._', '');
  for (const proposal of proposals) lines.push(`- #${proposal.proposal_id} · ${proposal.status} · ${proposal.real_outcome_count} real outcomes`);
  lines.push('');

  lines.push('## 6. Safety', '');
  lines.push(blocked.length
    ? blocked.map((entry) => `- Blocked ${entry.service} ${entry.method ?? entry.path}: ${entry.reason}`).join('\n')
    : '- No blocked provider action today.', '');
  lines.push('---', `Stages run: ${[...new Set(runs.map((run) => run.stage))].join(' → ') || 'none'}`);
  return lines.join('\n');
}

export function writeReport(date = today()) {
  const markdown = buildReport(date);
  const directory = getConfig().GTM_REPORTS_DIR;
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${date}.md`);
  fs.writeFileSync(file, markdown, 'utf8');
  return { file, markdown };
}
