/**
 * Operations: the daily runner (lock → backup → housekeeping → agent → report),
 * a cross-platform scheduler (Windows Task Scheduler / cron), backups and system checks.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getConfig, ROOT, type Config } from './config.js';
import { getDb, logRun, nowIso, one } from './db/db.js';
import { writeReport } from './pipeline/report.js';

// One schedule per checkout, so several clones (e.g. one per client) never overwrite each other.
export const TASK_NAME = `VOIDRIP GTM daily loop - ${path.basename(ROOT).replace(/[^\w .-]/g, '_')}`;
const CRON_MARK = `# voidrip-gtm-engine:${ROOT}`;
const LEGACY_CRON_MARK = `# gtm-autopilot:${ROOT}`;
const MIN_NODE = [22, 13];

/** Tools an unattended run may never call — enforced on the agent command line. */
export const UNATTENDED_DENY = [
  'mcp__voidrip-gtm-engine__gtm_approve',
  'mcp__voidrip-gtm-engine__gtm_launch',
  'mcp__voidrip-gtm-engine__gtm_cleanup_overloop',
  'mcp__voidrip-gtm-engine__gtm_simulate_results',
  'mcp__voidrip-gtm-engine__gtm_simulate_replies',
  'mcp__voidrip-gtm-engine__gtm_manage_subscription',
  'mcp__voidrip-gtm-engine__gtm_update_icp',
  'mcp__voidrip-gtm-engine__gtm_init',
  'Bash',
  'PowerShell',
  'Write',
  'Edit',
];

/** Local-time stamp for file names, e.g. 20260928-0815. */
const stamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};

/**
 * Resolve a CLI for spawning. On Windows, npm installs `.cmd` shims that need a shell;
 * we then pass ONE pre-quoted command line (no args array) to avoid DEP0190 and quoting bugs.
 */
export function resolveCommand(cmd: string, args: string[]): { file: string; args: string[]; shell: boolean } {
  if (process.platform !== 'win32') return { file: cmd, args, shell: false };
  const found = spawnSync('where.exe', [cmd], { encoding: 'utf8', windowsHide: true }).stdout?.split(/\r?\n/).filter(Boolean) ?? [];
  const exe = found.find((f) => /\.exe$/i.test(f));
  if (exe) return { file: exe, args, shell: false };
  const quote = (s: string) => (/[\s"&|<>^]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return { file: [cmd, ...args].map(quote).join(' '), args: [], shell: true };
}

// ---------------------------------------------------------------- backups & housekeeping

export function backupDb(cfg: Config = getConfig()): { file: string | null; kept: number } {
  if (cfg.GTM_DB_PATH === ':memory:' || cfg.GTM_BACKUP_KEEP === 0) return { file: null, kept: 0 };
  fs.mkdirSync(cfg.GTM_BACKUP_DIR, { recursive: true });
  const file = path.join(cfg.GTM_BACKUP_DIR, `gtm-${stamp()}.db`);
  getDb().exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`); // consistent online snapshot
  const all = fs.readdirSync(cfg.GTM_BACKUP_DIR).filter((f) => /^gtm-.*\.db$/.test(f)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - cfg.GTM_BACKUP_KEEP))) fs.rmSync(path.join(cfg.GTM_BACKUP_DIR, old));
  return { file, kept: Math.min(all.length, cfg.GTM_BACKUP_KEEP) };
}

export function pruneLogs(cfg: Config = getConfig()): number {
  if (!fs.existsSync(cfg.GTM_REPORTS_DIR)) return 0;
  const cutoff = Date.now() - cfg.GTM_LOG_RETENTION_DAYS * 86_400_000;
  let n = 0;
  for (const f of fs.readdirSync(cfg.GTM_REPORTS_DIR)) {
    const p = path.join(cfg.GTM_REPORTS_DIR, f);
    if (/\.(log|md)$/.test(f) && fs.statSync(p).mtimeMs < cutoff) {
      fs.rmSync(p);
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- run lock

const lockFile = (cfg: Config) => path.join(path.dirname(cfg.GTM_DB_PATH === ':memory:' ? path.join(ROOT, 'data', 'x') : cfg.GTM_DB_PATH), '.daily.lock');

export function acquireLock(cfg: Config = getConfig()): boolean {
  const file = lockFile(cfg);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: nowIso() }), { flag: 'wx' });
    return true;
  } catch {
    const age = Date.now() - fs.statSync(file).mtimeMs;
    if (age > (cfg.GTM_RUN_TIMEOUT_MIN + 10) * 60_000) {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: nowIso(), took_over_stale: true }));
      return true;
    }
    return false;
  }
}

export function releaseLock(cfg: Config = getConfig()): void {
  fs.rmSync(lockFile(cfg), { force: true });
}

// ---------------------------------------------------------------- the daily runner

export function buildAgentInvocation(cfg: Config, note = '') {
  const prompt = [
    'Use the gtm-daily-loop skill.',
    'This is an unattended scheduled run: do not ask questions, do not approve or launch anything, and finish with the daily brief.',
    cfg.GTM_LOOP_NOTE,
    note,
  ]
    .filter(Boolean)
    .join(' ');
  const bin = path.basename(cfg.GTM_AGENT_CMD).toLowerCase();
  if (bin.startsWith('codex')) {
    // Codex runs read-only; GTM_UNATTENDED also removes sensitive MCP tools server-side.
    const modelArgs = cfg.GTM_MODEL ? ['--model', cfg.GTM_MODEL] : [];
    return { cmd: cfg.GTM_AGENT_CMD, args: ['exec', '--sandbox', 'read-only', ...modelArgs, '-'], prompt };
  }
  return {
    cmd: cfg.GTM_AGENT_CMD,
    args: [
      '-p',
      '--model',
      cfg.GTM_MODEL,
      '--allowedTools',
      'mcp__voidrip-gtm-engine__*',
      'Read',
      'Skill',
      'Agent',
      '--disallowedTools',
      ...UNATTENDED_DENY,
    ],
    prompt,
  };
}

export async function runDaily(opts: { note?: string; dryRun?: boolean } = {}) {
  const cfg = getConfig();
  if (!acquireLock(cfg)) return { status: 'skipped', reason: 'another daily run is in progress (lock held)' };
  const started = Date.now();
  fs.mkdirSync(cfg.GTM_REPORTS_DIR, { recursive: true });
  const logFile = path.join(cfg.GTM_REPORTS_DIR, `run-${stamp()}.log`);
  const log = fs.createWriteStream(logFile, { flags: 'a', encoding: 'utf8' });
  const say = (s: string) => log.write(`[${new Date().toISOString()}] ${s}\n`);
  try {
    const backup = backupDb(cfg);
    const pruned = pruneLogs(cfg);
    say(`backup: ${backup.file ?? 'disabled'} · pruned ${pruned} old logs · send_mode=${cfg.SEND_MODE}`);
    const inv = buildAgentInvocation(cfg, opts.note);
    say(`agent: ${inv.cmd} ${inv.args.join(' ')}`);
    if (opts.dryRun) {
      say('dry run: agent not started');
      return { status: 'dry_run', log: logFile, invocation: inv, backup };
    }
    const exitCode = await new Promise<number>((resolve) => {
      const rc = resolveCommand(inv.cmd, inv.args);
      const child = spawn(rc.file, rc.args, {
        cwd: ROOT,
        shell: rc.shell,
        env: { ...process.env, GTM_UNATTENDED: '1' },
        windowsHide: true,
      });
      const timer = setTimeout(() => {
        say(`timeout after ${cfg.GTM_RUN_TIMEOUT_MIN} min — stopping agent`);
        child.kill();
      }, cfg.GTM_RUN_TIMEOUT_MIN * 60_000);
      child.stdout.on('data', (d) => log.write(d));
      child.stderr.on('data', (d) => log.write(d));
      child.on('error', (e) => {
        say(`failed to start agent "${inv.cmd}": ${e.message} — is it installed and on PATH? (GTM_AGENT_CMD)`);
        clearTimeout(timer);
        resolve(127);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve(code ?? 1);
      });
      child.stdin.end(inv.prompt);
    });
    // The brief always exists, even if the agent failed half-way.
    const report = writeReport();
    const summary = { status: exitCode === 0 ? 'ok' : 'agent_failed', exit_code: exitCode, minutes: Math.round((Date.now() - started) / 6000) / 10, log: logFile, report: report.file };
    say(`finished: ${JSON.stringify(summary)}`);
    logRun('daily', summary);
    return summary;
  } finally {
    log.end();
    releaseLock(cfg);
  }
}

// ---------------------------------------------------------------- scheduler

const CRON_DOW: Record<string, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };

export function cronLine(cfg: Config): string {
  const [hh, mm] = cfg.GTM_SCHEDULE_TIME.split(':').map(Number);
  const dow = cfg.GTM_SCHEDULE_DAYS.map((d) => CRON_DOW[d]).join(',');
  const logs = path.join(cfg.GTM_REPORTS_DIR, 'cron.log');
  return `${mm} ${hh} * * ${dow} cd "${ROOT}" && "${process.execPath}" bin/gtm.mjs daily >> "${logs}" 2>&1 ${CRON_MARK}`;
}

function run(cmd: string, args: string[], input?: string) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', input, windowsHide: true });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim(), missing: !!r.error };
}

export function scheduleInstall(cfg: Config = getConfig()) {
  if (process.platform === 'win32') {
    const tr = `"${process.execPath}" "${path.join(ROOT, 'bin', 'gtm.mjs')}" daily`;
    const r = run('schtasks', ['/Create', '/F', '/SC', 'WEEKLY', '/D', cfg.GTM_SCHEDULE_DAYS.join(','), '/ST', cfg.GTM_SCHEDULE_TIME, '/TN', TASK_NAME, '/TR', tr]);
    if (!r.ok) throw new Error(`schtasks failed: ${r.out}`);
    return { platform: 'windows', task: TASK_NAME, days: cfg.GTM_SCHEDULE_DAYS, time: cfg.GTM_SCHEDULE_TIME, ...scheduleStatus() };
  }
  const current = run('crontab', ['-l']);
  if (current.missing) throw new Error('crontab not found — install cron, or schedule `node bin/gtm.mjs daily` with your own scheduler');
  const kept = (current.ok ? current.out : '')
    .split('\n')
    .filter((l) => l && !l.includes(CRON_MARK) && !l.includes(LEGACY_CRON_MARK));
  const line = cronLine(cfg);
  const w = run('crontab', ['-'], [...kept, line, ''].join('\n'));
  if (!w.ok) throw new Error(`crontab update failed: ${w.out}`);
  return { platform: process.platform, cron: line };
}

export function scheduleRemove() {
  if (process.platform === 'win32') {
    const r = run('schtasks', ['/Delete', '/TN', TASK_NAME, '/F']);
    return { removed: r.ok, detail: r.ok ? TASK_NAME : r.out };
  }
  const current = run('crontab', ['-l']);
  if (!current.ok) return { removed: false, detail: 'no crontab' };
  const lines = current.out.split('\n');
  const kept = lines.filter((l) => l && !l.includes(CRON_MARK) && !l.includes(LEGACY_CRON_MARK));
  run('crontab', ['-'], [...kept, ''].join('\n'));
  return { removed: kept.length !== lines.filter(Boolean).length };
}

export function scheduleStatus(): { installed: boolean; next_run?: string; detail?: string } {
  if (process.platform === 'win32') {
    const r = run('schtasks', ['/Query', '/TN', TASK_NAME, '/FO', 'LIST', '/V']);
    if (!r.ok) return { installed: false };
    const next = r.out.match(/Next Run Time:\s*(.+)/i)?.[1]?.trim();
    const status = r.out.match(/^Status:\s*(.+)$/im)?.[1]?.trim();
    return { installed: true, next_run: next, detail: status };
  }
  const r = run('crontab', ['-l']);
  const line = r.ok ? r.out.split('\n').find((l) => l.includes(CRON_MARK)) : undefined;
  return line ? { installed: true, detail: line } : { installed: false };
}

// ---------------------------------------------------------------- system checks

export function systemChecks() {
  const cfg = getConfig();
  const [maj, min] = process.versions.node.split('.').map(Number);
  const nodeOk = maj! > MIN_NODE[0]! || (maj === MIN_NODE[0] && min! >= MIN_NODE[1]!);
  const rc = resolveCommand(cfg.GTM_AGENT_CMD, ['--version']);
  const agent = spawnSync(rc.file, rc.args, { encoding: 'utf8', shell: rc.shell, windowsHide: true });
  const dbTables = (getDb().prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE type = 'table'`).get() as { n: number }).n;
  const backups = fs.existsSync(cfg.GTM_BACKUP_DIR) ? fs.readdirSync(cfg.GTM_BACKUP_DIR).filter((f) => f.endsWith('.db')).length : 0;
  const lastDaily = one<{ at: string; summary_json: string }>(`SELECT at, summary_json FROM runs WHERE stage = 'daily' ORDER BY id DESC LIMIT 1`);
  return {
    node: { version: process.versions.node, ok: nodeOk, required: `>=${MIN_NODE.join('.')}` },
    database: { path: cfg.GTM_DB_PATH, tables: dbTables, ok: dbTables >= 10, backups },
    agent_cli: { cmd: cfg.GTM_AGENT_CMD, ok: agent.status === 0, version: (agent.stdout ?? '').trim().split('\n')[0] || undefined },
    schedule: { enabled: cfg.GTM_SCHEDULE_ENABLED, days: cfg.GTM_SCHEDULE_DAYS, time: cfg.GTM_SCHEDULE_TIME, ...scheduleStatus() },
    caps: { new_leads: cfg.GTM_DAILY_NEW_LEADS, sequences: cfg.GTM_DAILY_SEQUENCES, pushes: cfg.GTM_DAILY_PUSH_LIMIT },
    sending_window: { days: cfg.OVERLOOP_SENDING_DAYS, from: cfg.OVERLOOP_SEND_START, to: cfg.OVERLOOP_SEND_END, timezone: cfg.OVERLOOP_TIMEZONE },
    last_daily_run: lastDaily ? { at: lastDaily.at, ...JSON.parse(lastDaily.summary_json) } : null,
  };
}
