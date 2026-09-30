import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from '../config.js';
import type { AuditEntry } from '../safety/guard.js';
import { MARKET_MAP_SCHEMA } from './market-map-schema.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY,              -- Max lead id
  business_id INTEGER NOT NULL,
  external_id TEXT,
  name TEXT, first_name TEXT, last_name TEXT,
  headline TEXT, job_title TEXT,
  email TEXT, phone TEXT, linkedin_url TEXT, location TEXT,
  company TEXT, company_industry TEXT, company_size TEXT, company_website TEXT, company_linkedin TEXT,
  company_summary TEXT,
  icp_score REAL,
  engagement_type TEXT, engagement_context TEXT, signal_excerpt TEXT, post_url TEXT,
  signal_slug TEXT, signal_name TEXT,
  payload_json TEXT,
  triggered_at TEXT,
  sourced_at TEXT NOT NULL,
  run_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',  -- new|classified|drafted|final|pushed|disqualified|duplicate
  dedupe_key TEXT
);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_dedupe ON leads(dedupe_key);

CREATE TABLE IF NOT EXISTS classifications (
  lead_id INTEGER PRIMARY KEY REFERENCES leads(id),
  tier TEXT NOT NULL,                  -- A|B|C|DQ
  persona TEXT,
  intent_strength INTEGER,             -- 1..5
  route TEXT NOT NULL,                 -- email|linkedin|both|none
  model_route TEXT,                    -- what the model asked for before hard rules
  route_reason TEXT,
  angle TEXT,
  reasoning TEXT,
  playbook_version INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sequences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id),
  version INTEGER NOT NULL,
  status TEXT NOT NULL,                -- draft|final|superseded
  route TEXT NOT NULL,
  angle TEXT,
  hook_type TEXT,
  steps_json TEXT NOT NULL,
  lint_json TEXT,
  critique TEXT,
  playbook_version INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_seq_lead ON sequences(lead_id);

CREATE TABLE IF NOT EXISTS pushes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL,
  sequence_id INTEGER NOT NULL,
  ovl_prospect_id INTEGER,
  prospect_created INTEGER NOT NULL DEFAULT 0,
  ovl_campaign_id INTEGER,
  campaign_name TEXT,
  send_mode TEXT NOT NULL,
  enrolled INTEGER NOT NULL DEFAULT 0,
  pushed_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS outcomes (
  lead_id INTEGER PRIMARY KEY,
  ovl_prospect_id INTEGER,
  sent INTEGER NOT NULL DEFAULT 0,
  opened INTEGER NOT NULL DEFAULT 0,
  clicked INTEGER NOT NULL DEFAULT 0,
  replied INTEGER NOT NULL DEFAULT 0,
  email_replies INTEGER NOT NULL DEFAULT 0,
  linkedin_replies INTEGER NOT NULL DEFAULT 0,
  bounced INTEGER NOT NULL DEFAULT 0,
  positive INTEGER NOT NULL DEFAULT 0,
  meeting INTEGER NOT NULL DEFAULT 0,
  is_simulated INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS playbook_versions (
  version INTEGER PRIMARY KEY,
  content TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS learnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_date TEXT NOT NULL,
  insights_json TEXT NOT NULL,
  playbook_version INTEGER,
  based_on_simulated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS weights (
  key TEXT PRIMARY KEY,                -- signal:<slug> | persona:<p> | route:<r> | angle:<a>
  value REAL NOT NULL,
  note TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_date TEXT NOT NULL,
  stage TEXT NOT NULL,
  summary_json TEXT,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  service TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  allowed INTEGER NOT NULL,
  reason TEXT,
  summary TEXT
);

CREATE TABLE IF NOT EXISTS replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL,
  ovl_prospect_id INTEGER,
  ovl_campaign_id INTEGER,
  channel TEXT NOT NULL,               -- email|linkedin
  status TEXT NOT NULL,                -- needs_text|new|needs_human|handled|resolved
  text TEXT,
  category TEXT, sentiment TEXT, summary TEXT, next_action TEXT, draft_response TEXT,
  follow_up_on TEXT, referral_json TEXT, actions_json TEXT,
  received_at TEXT, detected_at TEXT NOT NULL, triaged_at TEXT, resolved_at TEXT,
  is_simulated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_replies_status ON replies(status);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// node:sqlite prints an ExperimentalWarning on load; it would pollute CLI/MCP output.
const origEmit = process.emitWarning;
process.emitWarning = ((w: string | Error, ...rest: any[]) => {
  const msg = typeof w === 'string' ? w : w?.message;
  if (/SQLite is an experimental feature/.test(msg ?? '')) return;
  return (origEmit as any).call(process, w, ...rest);
}) as typeof process.emitWarning;
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = import('node:sqlite').DatabaseSync;

export type Db = DatabaseSync;

let instance: DatabaseSync | undefined;

export function openDb(file = getConfig().GTM_DB_PATH): DatabaseSync {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  db.exec(MARKET_MAP_SCHEMA);
  migrate(db);
  return db;
}

/** Additive column migrations for databases created by older versions. */
const MIGRATIONS: [table: string, column: string, ddl: string][] = [
  ['leads', 'ovl_context_json', 'ALTER TABLE leads ADD COLUMN ovl_context_json TEXT'],
  ['classifications', 'first_channel', 'ALTER TABLE classifications ADD COLUMN first_channel TEXT'],
  ['classifications', 'channel_plan_json', 'ALTER TABLE classifications ADD COLUMN channel_plan_json TEXT'],
  ['pushes', 'approved_at', 'ALTER TABLE pushes ADD COLUMN approved_at TEXT'],
  ['pushes', 'launched_at', 'ALTER TABLE pushes ADD COLUMN launched_at TEXT'],
];

function migrate(db: DatabaseSync): void {
  for (const [table, column, ddl] of MIGRATIONS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) db.exec(ddl);
  }
}

export function getDb(): DatabaseSync {
  if (!instance) instance = openDb();
  return instance;
}

export function setDbForTests(db: DatabaseSync): void {
  instance = db;
}

export const nowIso = () => new Date().toISOString();
export const today = () => new Date().toISOString().slice(0, 10);

export function all<T = any>(sql: string, ...params: any[]): T[] {
  return getDb().prepare(sql).all(...params) as T[];
}
export function one<T = any>(sql: string, ...params: any[]): T | undefined {
  return getDb().prepare(sql).get(...params) as T | undefined;
}
export function run(sql: string, ...params: any[]) {
  return getDb().prepare(sql).run(...params);
}

export function tx<T>(fn: () => T): T {
  const db = getDb();
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function kvGet(key: string): string | undefined {
  return one<{ value: string }>('SELECT value FROM kv WHERE key = ?', key)?.value;
}
export function kvSet(key: string, value: string): void {
  run('INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
}

export function auditSink(e: AuditEntry): void {
  run(
    'INSERT INTO audit(at, service, method, path, allowed, reason, summary) VALUES (?,?,?,?,?,?,?)',
    e.at,
    e.service,
    e.method,
    e.path,
    e.allowed ? 1 : 0,
    e.reason ?? null,
    e.summary ?? null,
  );
}

export function logRun(stage: string, summary: unknown, runDate = today()): void {
  run('INSERT INTO runs(run_date, stage, summary_json, at) VALUES (?,?,?,?)', runDate, stage, JSON.stringify(summary), nowIso());
}
