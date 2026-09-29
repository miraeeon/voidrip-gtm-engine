/**
 * `npm run setup` — first-run wizard. Safe to re-run: every step keeps current values on Enter.
 *   1. checks Node    2. creates .env    3. asks + validates the Max and Overloop keys
 *   4. picks/creates the Max business (Max auto-builds the ICP)    5. creates the database
 *   6. seller profile basics    7. schedule + caps    8. installs the schedule (optional)    9. doctor
 * Non-interactive: `gtm wizard --yes` validates what's in .env and initializes the database.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { ENV_FILE, reloadConfig, ROOT } from './config.js';
import { MaxClient } from './clients/max.js';
import { OverloopClient } from './clients/overloop.js';
import { getDb } from './db/db.js';
import { getPlaybook } from './pipeline/playbook.js';
import { getSellerProfile, setSellerProfile, syncSellerFromMax, writeEnvVar } from './pipeline/setup.js';
import { scheduleInstall, systemChecks } from './ops.js';

const c = { g: (s: string) => `\x1b[32m${s}\x1b[0m`, y: (s: string) => `\x1b[33m${s}\x1b[0m`, r: (s: string) => `\x1b[31m${s}\x1b[0m`, b: (s: string) => `\x1b[1m${s}\x1b[0m`, d: (s: string) => `\x1b[2m${s}\x1b[0m` };
const mask = (v?: string) => (v ? `${v.slice(0, 4)}…${v.slice(-4)}` : 'not set');

export async function runWizard(opts: { yes?: boolean } = {}) {
  const rl = opts.yes ? null : createInterface({ input: stdin, output: stdout });
  const ask = async (q: string, def = ''): Promise<string> => {
    if (!rl) return def;
    const a = (await rl.question(`${q}${def ? c.d(` [${def}]`) : ''}: `)).trim();
    return a || def;
  };
  const step = (n: number, t: string) => console.log(`\n${c.b(`${n}. ${t}`)}`);

  try {
    console.log(c.b('\n🛰️  GTM Autopilot setup') + c.d(`  (${ROOT})`));

    step(1, 'Node.js');
    const [maj, min] = process.versions.node.split('.').map(Number);
    if (maj! < 22 || (maj === 22 && min! < 13)) throw new Error(`Node ${process.versions.node} is too old — install Node 22.13+ (https://nodejs.org)`);
    console.log(c.g(`✔ Node ${process.versions.node}`));

    step(2, 'Environment file');
    if (!fs.existsSync(ENV_FILE)) {
      fs.copyFileSync(path.join(ROOT, '.env.example'), ENV_FILE);
      console.log(c.g(`✔ created ${ENV_FILE} from .env.example`));
    } else console.log(c.g(`✔ using ${ENV_FILE}`));

    step(3, 'API keys');
    let maxKey = await ask(`Max API key (app.yourmax.ai → Settings → API Keys) — current ${mask(process.env.MAX_API_KEY)}`, process.env.MAX_API_KEY || '');
    let ovlKey = await ask(`Overloop API key (Overloop → Settings → API Keys) — current ${mask(process.env.OVERLOOP_API_KEY)}`, process.env.OVERLOOP_API_KEY || '');
    if (!maxKey || !ovlKey) throw new Error('Both API keys are required. Add them to .env or re-run `npm run setup`.');
    maxKey = maxKey.trim();
    ovlKey = ovlKey.trim();
    writeEnvVar('MAX_API_KEY', maxKey, ENV_FILE);
    writeEnvVar('OVERLOOP_API_KEY', ovlKey, ENV_FILE);
    process.env.MAX_API_KEY = maxKey;
    process.env.OVERLOOP_API_KEY = ovlKey;
    reloadConfig();
    const max = new MaxClient({ apiKey: maxKey });
    const businesses = await max.listBusinesses().catch((e) => {
      throw new Error(`Max key rejected: ${(e as Error).message}`);
    });
    console.log(c.g(`✔ Max key works (${businesses.length} business${businesses.length === 1 ? '' : 'es'})`));
    const me = await new OverloopClient({ apiKey: ovlKey }).me().catch((e) => {
      throw new Error(`Overloop key rejected: ${(e as Error).message} (Overloop expects the raw key, no "Bearer")`);
    });
    console.log(c.g(`✔ Overloop key works (${me.name} <${me.email}>)`));

    step(4, 'Your company in Max');
    businesses.forEach((b) => console.log(`   ${String(b.id).padStart(5)}  ${b.name}  ${c.d(b.website ?? '')}`));
    const currentBiz = process.env.MAX_BUSINESS_ID || String(businesses[0]?.id ?? '');
    const pick = await ask('Business id to use, or your website URL to create one', currentBiz);
    let businessId: number;
    if (/^\d+$/.test(pick)) {
      businessId = Number(pick);
      if (!businesses.some((b) => b.id === businessId)) throw new Error(`Business #${businessId} is not in this Max account (see the list above).`);
    } else {
      const host = pick.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
      if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host)) {
        throw new Error('Enter a business id from the list, or your company website (e.g. acme.com). In --yes mode set MAX_BUSINESS_ID in .env first.');
      }
      const url = `https://${host}`;
      console.log(c.d('   Max is analysing your website and building your ICP…'));
      businessId = (await max.createBusiness({ website: url })).id;
    }
    writeEnvVar('MAX_BUSINESS_ID', String(businessId), ENV_FILE);
    process.env.MAX_BUSINESS_ID = String(businessId);
    reloadConfig();
    const subs = await max.listSubscriptions(businessId);
    console.log(c.g(`✔ business #${businessId} · ${subs.filter((s) => s.active).length}/${subs.length} signal subscriptions active`));
    if (!subs.some((s) => s.active)) console.log(c.y('   ⚠ no active signals yet — add some with `gtm setup` + `gtm subscribe <signal>` (needs an active Max plan)'));

    step(5, 'Database');
    const tables = (getDb().prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE type = 'table'`).get() as { n: number }).n;
    getPlaybook();
    console.log(c.g(`✔ ${reloadConfig().GTM_DB_PATH} ready (${tables} tables, playbook v${getPlaybook().version})`));

    step(6, 'Seller profile (what the agent may say about you)');
    const seller = await syncSellerFromMax({ businessId, max });
    console.log(c.d(`   ${seller.company} — ${seller.description ?? ''}`));
    const existing = getSellerProfile();
    const vp = await ask('Value proposition (one or two sentences)', existing?.value_proposition ?? '');
    const pp = await ask('Proof points, separated by ";" (the ONLY numbers the agent may use)', (existing?.proof_points ?? []).join('; '));
    const cta = await ask('Primary call to action', existing?.primary_cta ?? '15-minute walkthrough or a 1-page overview');
    setSellerProfile({
      value_proposition: vp || undefined,
      proof_points: pp ? pp.split(';').map((s) => s.trim()).filter(Boolean) : undefined,
      primary_cta: cta || undefined,
    });
    console.log(c.g('✔ seller profile saved') + (vp ? '' : c.y('  (add a value proposition later: gtm seller --set …)')));

    step(7, 'Daily schedule & volume');
    const time = await ask('Run the daily loop at (HH:MM, 24h)', process.env.GTM_SCHEDULE_TIME || '08:00');
    const days = await ask('On days (MON,TUE,…)', process.env.GTM_SCHEDULE_DAYS || 'MON,TUE,WED,THU,FRI');
    const leads = await ask('Max leads classified per day', process.env.GTM_DAILY_NEW_LEADS || '40');
    const pushes = await ask('Max new Overloop campaigns per day', process.env.GTM_DAILY_PUSH_LIMIT || '25');
    for (const [k, v] of Object.entries({ GTM_SCHEDULE_TIME: time, GTM_SCHEDULE_DAYS: days, GTM_DAILY_NEW_LEADS: leads, GTM_DAILY_PUSH_LIMIT: pushes })) {
      writeEnvVar(k, v, ENV_FILE);
      process.env[k] = v;
    }
    const cfg = reloadConfig();
    console.log(c.g(`✔ ${cfg.GTM_SCHEDULE_DAYS.join(',')} at ${cfg.GTM_SCHEDULE_TIME} · ${cfg.GTM_DAILY_NEW_LEADS} leads · ${cfg.GTM_DAILY_PUSH_LIMIT} campaigns/day · SEND_MODE=${cfg.SEND_MODE}`));

    step(8, 'Install the schedule');
    const install = (await ask('Install it now in your OS scheduler? (y/n)', opts.yes ? 'n' : 'y')).toLowerCase().startsWith('y');
    if (install) {
      const r = scheduleInstall(cfg);
      console.log(c.g(`✔ scheduled (${'next_run' in r && r.next_run ? `next run ${r.next_run}` : 'cron installed'})`));
    } else console.log(c.d('   skipped — later: npm run schedule'));

    step(9, 'Health check');
    const sys = systemChecks();
    console.log(`   node ${sys.node.ok ? c.g('ok') : c.r('too old')} · database ${sys.database.ok ? c.g('ok') : c.r('missing tables')} · agent CLI "${sys.agent_cli.cmd}" ${sys.agent_cli.ok ? c.g(sys.agent_cli.version ?? 'ok') : c.y('not found — install Claude Code (https://claude.com/claude-code) or set GTM_AGENT_CMD')}`);

    console.log(`\n${c.b('Done. Next:')}
  • Open this folder in ${c.b('Claude Code')} and type ${c.b('/gtm-daily-loop')} — or run ${c.b('npm run daily')} for an unattended run
  • Review drafts:  ${c.b('node bin/gtm.mjs review')}      Replies:  ${c.b('node bin/gtm.mjs replies')}
  • Health:        ${c.b('node bin/gtm.mjs doctor')}      Docs: docs/GETTING_STARTED.md
  • Sending stays ${c.b('locked')} until you set SEND_MODE=live and approve + launch campaigns yourself.\n`);
    return { ok: true, business_id: businessId };
  } finally {
    rl?.close();
  }
}
