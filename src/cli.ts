#!/usr/bin/env node
/**
 * gtm — CLI for GTM Autopilot. Every command prints JSON (pipe to jq) except `report`.
 * `gtm tool <name> '<json>'` calls any tool exactly as an MCP client would.
 */
import fs from 'node:fs';
import { Command } from 'commander';
import { callTool, TOOLS } from './tools.js';
import { PLAYBOOK_FILE, savePlaybook } from './pipeline/playbook.js';
import { backupDb, runDaily, scheduleInstall, scheduleRemove, scheduleStatus } from './ops.js';
import { runWizard } from './wizard.js';

const program = new Command()
  .name('gtm')
  .description('GTM Autopilot — Max signal leads × Overloop outreach × your AI agent')
  .version('0.1.0');

const print = (x: unknown) => console.log(typeof x === 'string' ? x : JSON.stringify(x, null, 2));

async function run(tool: string, args: Record<string, unknown> = {}) {
  try {
    print(await callTool(tool, args));
  } catch (e) {
    console.error(`✖ ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

function readJsonArg(v: string): unknown {
  const text = v.startsWith('@') ? fs.readFileSync(v.slice(1), 'utf8') : v === '-' ? fs.readFileSync(0, 'utf8') : v;
  return JSON.parse(text);
}

program.command('doctor').description('check Max + Overloop connectivity and safety mode').action(() => run('gtm_doctor'));
program.command('status').description('pipeline counts and recent runs').action(() => run('gtm_status'));
program
  .command('init')
  .description('onboard a company from its website (creates/reuses the Max business)')
  .option('-w, --website <url>')
  .option('-b, --business <id>', 'existing Max business id', (v) => Number(v))
  .action((o) => run('gtm_init', { website: o.website, business_id: o.business }));
program
  .command('setup')
  .description('show ICP, subscriptions and the signal catalog')
  .option('--no-catalog', 'skip the signal catalog')
  .action((o) => run('gtm_setup', { include_catalog: o.catalog }));
program
  .command('subscribe <signal>')
  .description('subscribe the business to a Max signal')
  .option('-n, --name <name>')
  .option('-c, --config <json>', 'signal config JSON (see input_schema in `gtm setup`)')
  .action((signal, o) => run('gtm_manage_subscription', { action: 'create', signal_slug: signal, name: o.name, config: o.config ? JSON.parse(o.config) : undefined }));
program
  .command('seller')
  .description('show or update the seller profile used for writing')
  .option('-s, --set <json>', 'JSON patch, or @file.json')
  .action((o) => run('gtm_seller_profile', o.set ? { set: readJsonArg(o.set) } : {}));
program
  .command('source')
  .description('pull new leads from Max')
  .option('-p, --pages <n>', 'max pages', (v) => Number(v), 10)
  .action((o) => run('gtm_source_leads', { max_pages: o.pages }));
program
  .command('enrich')
  .description('check new leads against Overloop history (read-only)')
  .action(() => run('gtm_enrich_from_overloop'));
program
  .command('queue')
  .description('show the classification queue (what the agent sees)')
  .option('-l, --limit <n>', '', (v) => Number(v), 20)
  .action((o) => run('gtm_get_classification_queue', { limit: o.limit }));
program
  .command('classify <json>')
  .description('save classifications: JSON array, @file.json or - for stdin')
  .action((j) => run('gtm_save_classifications', { items: readJsonArg(j) }));
program
  .command('drafts')
  .description('show the drafting queue')
  .option('-l, --limit <n>', '', (v) => Number(v), 8)
  .action((o) => run('gtm_get_drafting_queue', { limit: o.limit }));
program
  .command('sequence <json>')
  .description('save a sequence (or an array of sequences): JSON, @file.json or -')
  .action(async (j) => {
    const input = readJsonArg(j);
    if (!Array.isArray(input)) return run('gtm_save_sequence', { sequence: input });
    const out = [];
    for (const s of input) {
      try {
        const r: any = await callTool('gtm_save_sequence', { sequence: s });
        out.push({ lead_id: s.lead_id, status: r.status ?? 'error', errors: r.errors, lint: (r.lint ?? []).map((i: any) => `${i.level}:${i.rule}:${i.message}`) });
      } catch (e) {
        out.push({ lead_id: s?.lead_id, status: 'error', errors: [(e as Error).message] });
      }
    }
    print(out);
  });
program
  .command('push')
  .description('push final sequences to Overloop as inert draft campaigns')
  .option('-l, --limit <n>', '', (v) => Number(v), 50)
  .option('--force-enroll', 'attempt enrollment (blocked by SafetyGuard unless SEND_MODE=live)')
  .action((o) => run('gtm_push_to_overloop', { limit: o.limit, enroll: !!o.forceEnroll }));
program.command('verify').description('verify pushed Overloop campaigns are inert').action(() => run('gtm_verify_overloop'));
program
  .command('review')
  .description('pushed campaigns awaiting human review (literal copy + Overloop links)')
  .option('-l, --limit <n>', '', (v) => Number(v), 25)
  .action((o) => run('gtm_review_queue', { limit: o.limit }));
program
  .command('approve [leadIds...]')
  .description('approve reviewed campaigns for launch (all pending if no ids)')
  .option('--revoke', 'withdraw approval instead')
  .action((ids: string[], o) => run('gtm_approve', { lead_ids: ids?.length ? ids.map(Number) : undefined, revoke: !!o.revoke }));
program
  .command('launch [leadIds...]')
  .description('SENDS: enroll + activate approved campaigns (needs SEND_MODE=live and --confirm SEND)')
  .option('--confirm <word>', 'must be SEND')
  .action((ids: string[], o) => run('gtm_launch', { lead_ids: ids?.length ? ids.map(Number) : undefined, confirm: o.confirm }));
program
  .command('replies')
  .description('reply inbox: replies waiting on a human, hot first, with drafted answers')
  .action(() => run('gtm_reply_inbox'));
program
  .command('reply-queue')
  .description('replies to triage (what the agent sees)')
  .action(() => run('gtm_get_reply_queue'));
program
  .command('reply-add')
  .description('attach a reply text: --lead <id> | --email <addr> | --reply <id>, --text <text>')
  .option('--reply <id>', '', (v) => Number(v))
  .option('--lead <id>', '', (v) => Number(v))
  .option('--email <email>')
  .option('--channel <c>', 'email|linkedin')
  .requiredOption('--text <text>')
  .action((o) => run('gtm_ingest_reply', { reply_id: o.reply, lead_id: o.lead, email: o.email, channel: o.channel, text: o.text }));
program
  .command('triage <json>')
  .description('save a reply triage (object or array): JSON, @file.json or -')
  .action(async (j) => {
    const input = readJsonArg(j);
    const list = Array.isArray(input) ? input : [input];
    const out = [];
    for (const t of list) {
      try {
        out.push(await callTool('gtm_save_reply_triage', t));
      } catch (e) {
        out.push({ reply_id: (t as any)?.reply_id, error: (e as Error).message });
      }
    }
    print(Array.isArray(input) ? out : out[0]);
  });
program
  .command('resolve <replyId>')
  .description('close a reply after a human handled it')
  .option('--meeting', 'a meeting was booked')
  .action((id, o) => run('gtm_resolve_reply', { reply_id: Number(id), outcome: o.meeting ? 'meeting_booked' : 'answered' }));
program
  .command('simulate-replies')
  .description('TEST: inject realistic replies for pushed leads')
  .option('-n, --count <n>', '', (v) => Number(v), 6)
  .action((o) => run('gtm_simulate_replies', { count: o.count }));
program.command('sync').description('sync results from Overloop').action(() => run('gtm_sync_results'));
program
  .command('simulate')
  .description('TEST: simulate outcomes for the learning loop')
  .option('--seed <n>', '', (v) => Number(v), 42)
  .action((o) => run('gtm_simulate_results', { seed: o.seed }));
program
  .command('performance')
  .description('analytics by signal / tier / persona / route / hook')
  .option('--real-only', 'exclude simulated outcomes')
  .action((o) => run('gtm_get_performance', { include_simulated: !o.realOnly }));
program
  .command('learn <json>')
  .description('save learnings JSON (@file.json or -)')
  .action((j) => run('gtm_save_learnings', readJsonArg(j) as Record<string, unknown>));
program
  .command('playbook')
  .description('print the current playbook')
  .option('--reload', 'import manual edits from data/playbook.md as a new version')
  .action(async (o) => {
    if (o.reload) {
      print(savePlaybook(fs.readFileSync(PLAYBOOK_FILE, 'utf8'), 'manual edit of data/playbook.md'));
      return;
    }
    const pb = (await callTool('gtm_get_playbook', {})) as { version: number; content: string };
    console.log(`<!-- playbook v${pb.version} -->\n${pb.content}`);
  });
program
  .command('report')
  .description('write and print the daily brief')
  .option('-d, --date <yyyy-mm-dd>')
  .action(async (o) => {
    const r = (await callTool('gtm_write_report', { date: o.date })) as { file: string; markdown: string };
    console.log(r.markdown + `\n\n(saved to ${r.file})`);
  });
program
  .command('cleanup')
  .description('delete bot-created test campaigns/prospects from Overloop')
  .option('--yes', 'actually delete (default is a dry run)')
  .action((o) => run('gtm_cleanup_overloop', { dry_run: !o.yes }));
program
  .command('wizard')
  .description('first-run setup: .env, API keys, business, database, seller profile, schedule (npm run setup)')
  .option('-y, --yes', 'non-interactive: validate .env and initialize the database')
  .action(async (o) => {
    try {
      await runWizard({ yes: !!o.yes });
    } catch (e) {
      console.error(`✖ ${(e as Error).message}`);
      process.exitCode = 1;
    }
  });
program
  .command('daily')
  .description('unattended daily run: lock → DB backup → housekeeping → agent (/gtm-daily-loop) → report')
  .option('--note <text>', 'extra instructions for this run')
  .option('--dry-run', 'do everything except start the agent')
  .action(async (o) => print(await runDaily({ note: o.note, dryRun: !!o.dryRun })));
program
  .command('schedule [action]')
  .description('install | remove | status the daily run in Task Scheduler (Windows) or cron (macOS/Linux), using GTM_SCHEDULE_* from .env')
  .action((action = 'status') => {
    try {
      print(action === 'install' ? scheduleInstall() : action === 'remove' ? scheduleRemove() : scheduleStatus());
    } catch (e) {
      console.error(`✖ ${(e as Error).message}`);
      process.exitCode = 1;
    }
  });
program
  .command('backup')
  .description('snapshot the database into GTM_BACKUP_DIR (keeps GTM_BACKUP_KEEP)')
  .action(() => print(backupDb()));
program
  .command('tool <name> [json]')
  .description('call any tool by name with JSON args (same as MCP)')
  .action((name, json) => run(name, json ? (readJsonArg(json) as Record<string, unknown>) : {}));
program.command('tools').description('list all tools').action(() => print(TOOLS.map((t) => ({ name: t.name, title: t.title, readOnly: !!t.readOnly }))));

await program.parseAsync();
