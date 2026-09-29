import fs from 'node:fs';
import path from 'node:path';
import { getConfig, ROOT } from '../config.js';
import { nowIso, one, run } from '../db/db.js';

export const PLAYBOOK_FILE = path.join(ROOT, 'data', 'playbook.md');

/** Current playbook: latest DB version, seeded from data/playbook.md on first use. */
export function getPlaybook(): { version: number; content: string } {
  const row = one<{ version: number; content: string }>('SELECT version, content FROM playbook_versions ORDER BY version DESC LIMIT 1');
  if (row) return row;
  const content = fs.existsSync(PLAYBOOK_FILE) ? fs.readFileSync(PLAYBOOK_FILE, 'utf8') : '# Playbook\n\n(empty)\n';
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
