import fs from 'node:fs';
import path from 'node:path';
import { getConfig, ROOT } from '../config.js';
import { nowIso, one, run } from '../db/db.js';

export const PLAYBOOK_FILE = path.join(ROOT, 'data', 'playbook.md');

interface PlaybookRow {
  version: number;
  content: string;
  reason: string;
}

function fileSeed(): string | null {
  return fs.existsSync(PLAYBOOK_FILE) ? fs.readFileSync(PLAYBOOK_FILE, 'utf8') : null;
}

function managedByRepository(reason: string): boolean {
  return reason === 'seed' || reason === 'seed-sync';
}

/** Current playbook: latest DB version, seeded from data/playbook.md on first use. */
export function getPlaybook(): { version: number; content: string } {
  const row = one<PlaybookRow>('SELECT version, content, reason FROM playbook_versions ORDER BY version DESC LIMIT 1');
  const seed = fileSeed();
  if (row && seed && managedByRepository(row.reason) && seed.trim() !== row.content.trim()) {
    const version = row.version + 1;
    run('INSERT INTO playbook_versions(version, content, reason, created_at) VALUES (?, ?, ?, ?)', version, seed, 'seed-sync', nowIso());
    return { version, content: seed };
  }
  if (row) return { version: row.version, content: row.content };
  const content = seed ?? '# Playbook\n\n(empty)\n';
  run('INSERT INTO playbook_versions(version, content, reason, created_at) VALUES (1, ?, ?, ?)', content, 'seed', nowIso());
  return { version: 1, content };
}

export function savePlaybook(content: string, reason: string): { version: number } {
  const current = getPlaybook();
  if (content.trim() === current.content.trim()) return { version: current.version };
  const version = current.version + 1;
  run('INSERT INTO playbook_versions(version, content, reason, created_at) VALUES (?, ?, ?, ?)', version, content, reason, nowIso());
  if (getConfig().GTM_DB_PATH !== ':memory:') {
    fs.mkdirSync(path.dirname(PLAYBOOK_FILE), { recursive: true });
    fs.writeFileSync(PLAYBOOK_FILE, content, 'utf8');
  }
  return { version };
}
