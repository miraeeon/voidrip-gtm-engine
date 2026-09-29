import fs from 'node:fs';
import path from 'node:path';
import { getConfig, ROOT } from '../config.js';
import { all, one, today } from '../db/db.js';
import { getPerformance } from './analytics.js';
import { latestLearnings } from './learn.js';
import { getPlaybook } from './playbook.js';
import { getWeights } from './weights.js';
import { replyInbox } from './replies.js';

export function status() {
  const cfg = getConfig();
  const byStatus = Object.fromEntries(all<{ status: string; n: number }>('SELECT status, COUNT(*) n FROM leads GROUP BY status').map((r) => [r.status, r.n]));
  return {
    send_mode: cfg.SEND_MODE,
    business_id: cfg.MAX_BUSINESS_ID,
    leads: byStatus,
    pushed_campaigns: one<{ n: number }>('SELECT COUNT(*) n FROM pushes WHERE deleted_at IS NULL')?.n ?? 0,
    enrolled: one<{ n: number }>('SELECT COUNT(*) n FROM pushes WHERE enrolled = 1')?.n ?? 0,
    outcomes: one<any>('SELECT COUNT(*) n, SUM(replied) replied, SUM(is_simulated) simulated FROM outcomes'),
    playbook_version: getPlaybook().version,
    blocked_by_guard: one<{ n: number }>('SELECT COUNT(*) n FROM audit WHERE allowed = 0')?.n ?? 0,
    last_runs: all('SELECT run_date, stage, at FROM runs ORDER BY id DESC LIMIT 8'),
  };
}

export function buildReport(date = today()) {
  const cfg = getConfig();
  const runs = all<any>('SELECT stage, summary_json FROM runs WHERE run_date = ? ORDER BY id', date);
  const sourced = all<any>('SELECT signal_slug, COUNT(*) n FROM leads WHERE run_date = ? GROUP BY signal_slug ORDER BY n DESC', date);
  const classified = all<any>(
    `SELECT c.tier, c.route, COALESCE(c.first_channel, '-') first_channel, COUNT(*) n FROM classifications c
      WHERE substr(c.created_at,1,10) = ? GROUP BY c.tier, c.route, c.first_channel ORDER BY c.tier`,
    date,
  );
  const pushed = all<any>(
    `SELECT p.campaign_name, p.ovl_campaign_id, p.lead_id, c.tier, c.route, l.signal_name
       FROM pushes p JOIN leads l ON l.id = p.lead_id JOIN classifications c ON c.lead_id = p.lead_id
      WHERE substr(p.pushed_at,1,10) = ? AND p.deleted_at IS NULL`,
    date,
  );
  const finals = all<any>(
    `SELECT l.name, l.company, c.tier, c.route, c.channel_plan_json, s.angle, s.hook_type, s.steps_json
       FROM sequences s JOIN leads l ON l.id = s.lead_id JOIN classifications c ON c.lead_id = s.lead_id
      WHERE s.status = 'final' AND substr(s.created_at,1,10) = ? ORDER BY s.id DESC LIMIT 12`,
    date,
  );
  const perf = getPerformance();
  const learn = latestLearnings(1)[0];
  const blocked = all<any>('SELECT at, method, path, reason FROM audit WHERE allowed = 0 AND substr(at,1,10) = ?', date);
  const pb = getPlaybook();

  const L: string[] = [];
  L.push(`# GTM Autopilot — daily brief ${date}`, '');
  L.push(`**Business:** #${cfg.MAX_BUSINESS_ID} · **Send mode:** \`${cfg.SEND_MODE}\` · **Playbook:** v${pb.version}`, '');
  if (cfg.SEND_MODE === 'locked') L.push('> 🔒 Locked mode — campaigns are inert drafts in Overloop. No one was enrolled or messaged.', '');

  L.push('## 1. Leads sourced (Max)', '');
  if (sourced.length === 0) L.push('_No new leads today._', '');
  else {
    L.push('| Signal | Leads |', '|---|---|');
    for (const s of sourced) L.push(`| ${s.signal_slug ?? 'unknown'} | ${s.n} |`);
    L.push('');
  }

  L.push('## 2. Classification & routing (Claude)', '');
  if (classified.length === 0) L.push('_Nothing classified today._', '');
  else {
    L.push('| Tier | Route | Opens on | Leads |', '|---|---|---|---|');
    for (const c of classified) L.push(`| ${c.tier} | ${c.route} | ${c.first_channel} | ${c.n} |`);
    L.push('');
  }

  L.push('## 3. Sequences finalized', '');
  if (finals.length === 0) L.push('_None._', '');
  for (const f of finals) {
    const steps = JSON.parse(f.steps_json);
    const first = steps.find((s: any) => s.type !== 'linkedin_visit');
    const preview = first?.type === 'email' ? `**${first.subject}** — ${first.body}` : (first?.note ?? first?.message ?? '');
    L.push(`- **${f.name}** (${f.company}) · tier ${f.tier} · ${f.route} · hook: ${f.hook_type} · angle: ${f.angle}`);
    if (f.channel_plan_json) {
      const p = JSON.parse(f.channel_plan_json);
      L.push(`  - 🧭 opens on **${p.first_channel}** — ✉️ ${p.email.role}: ${p.email.content} · 💼 ${p.linkedin.role}: ${p.linkedin.content}`);
    }
    L.push(`  > ${String(preview).replace(/\n+/g, ' ').slice(0, 280)}`);
  }
  L.push('');

  L.push('## 4. Pushed to Overloop', '');
  if (pushed.length === 0) L.push('_Nothing pushed today._', '');
  else {
    L.push('| Campaign | Tier | Route | Signal |', '|---|---|---|---|');
    for (const p of pushed) L.push(`| [${p.campaign_name}](https://app.overloop.ai/campaigns/${p.ovl_campaign_id}) | ${p.tier} | ${p.route} | ${p.signal_name ?? ''} |`);
    L.push('');
  }

  const inbox = replyInbox(20);
  L.push('## 5. Replies — needs you', '');
  if (inbox.length === 0) L.push('_No replies waiting._', '');
  const icon: Record<string, string> = { interested: '🔥', question: '❓', objection: '🧱', referral: '👉', not_now: '⏳', wrong_person: '🔀' };
  for (const r of inbox) {
    if (!r.category) {
      L.push(`- ✉️ **${r.name}** (${r.company}) replied on ${r.channel} — _${r.summary ? 'untriaged' : 'text not yet fetched'}_ (reply #${r.reply_id})`);
      continue;
    }
    L.push(`- ${icon[r.category] ?? '•'} **${r.name}** (${r.company}) · ${r.category} · ${r.sentiment}${r.simulated ? ' · _simulated_' : ''} — ${r.summary}`);
    L.push(`  - Next: ${r.next_action}${r.follow_up_on ? ` (follow up ${r.follow_up_on})` : ''}`);
    if (r.draft_response) L.push(`  - Draft: > ${String(r.draft_response).replace(/\n+/g, ' ').slice(0, 300)}`);
  }
  const handled = all<any>(`SELECT category, COUNT(*) n FROM replies WHERE status = 'handled' GROUP BY category`);
  if (handled.length) L.push('', `Handled automatically: ${handled.map((h) => `${h.category} ${h.n}`).join(' · ')}`);
  L.push('');

  L.push('## 6. Performance', '');
  if (perf.data_quality.warning) L.push(`> ⚠️ ${perf.data_quality.warning}`, '');
  if (perf.totals) {
    const t = perf.totals;
    L.push(`Contacted **${t.contacted}** · open **${t.open_rate}%** · reply **${t.reply_rate}%** · positive **${t.positive_rate}%** · meetings **${t.meetings}**`, '');
    for (const dim of ['signal', 'route', 'hook_type', 'tier'] as const) {
      const rows = perf.by[dim] ?? [];
      if (!rows.length) continue;
      L.push(`**By ${dim}:** ` + rows.map((b) => `${b.key} ${b.reply_rate}% (${b.contacted}${b.low_sample ? '*' : ''})`).join(' · '));
    }
    L.push('', '_* low sample_', '');
  } else L.push('_No outcomes yet._', '');

  L.push('## 7. What the loop learned', '');
  if (!learn) L.push('_No learnings recorded yet._', '');
  else {
    if (learn.based_on_simulated) L.push('> Based on simulated outcomes (test mode).', '');
    for (const i of learn.insights ?? []) L.push(`- **${i.finding}** (${i.confidence}) — ${i.evidence} → _${i.action}_`);
    const w = getWeights();
    if (Object.keys(w).length) L.push('', '**Weights:** ' + Object.entries(w).map(([k, v]) => `${k}=${v}`).join(', '));
    for (const s of learn.subscription_changes ?? []) L.push(`- Max subscription: ${s.action} ${s.signal_slug ?? s.subscription_id} — ${s.why} ${s.applied ? '✅ applied' : '(suggested)'}`);
    L.push('');
  }

  L.push('## 8. Safety', '');
  L.push(blocked.length ? blocked.map((b) => `- 🛑 blocked ${b.method} ${b.path}: ${b.reason}`).join('\n') : '- No blocked actions today.', '');

  const stagesRun = [...new Set(runs.map((r) => r.stage))];
  L.push('---', `Stages run: ${stagesRun.join(' → ') || 'none'}`);
  return L.join('\n');
}

export function writeReport(date = today()) {
  const md = buildReport(date);
  const dir = getConfig().GTM_REPORTS_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${date}.md`);
  fs.writeFileSync(file, md, 'utf8');
  return { file, markdown: md };
}
