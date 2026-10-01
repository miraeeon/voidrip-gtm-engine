import fs from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { one, run } from '../src/db/db.js';
import { getPlaybook, PLAYBOOK_FILE, savePlaybook } from '../src/pipeline/playbook.js';
import { freshEnv } from './helpers.js';

describe('activation playbook seed', () => {
  beforeEach(() => freshEnv());

  it('seeds the VOIDRIP LinkedIn activation rules', () => {
    const playbook = getPlaybook();
    expect(playbook.content).toContain('VOIDRIP Activation Playbook V1');
    expect(playbook.content).toContain('PASS_OUTBOUND_V1');
    expect(playbook.content).toContain('SEND_MODE=locked');
    expect(playbook.content).not.toContain('simulated outcomes): 15 leads contacted');
  });

  it('upgrades an untouched legacy seed to the repository playbook', () => {
    run(
      'INSERT INTO playbook_versions(version, content, reason, created_at) VALUES (1, ?, ?, ?)',
      '# legacy generic playbook',
      'seed',
      new Date().toISOString(),
    );
    const playbook = getPlaybook();
    expect(playbook).toEqual({ version: 2, content: fs.readFileSync(PLAYBOOK_FILE, 'utf8') });
    expect(one<{ reason: string }>('SELECT reason FROM playbook_versions WHERE version = 2')!.reason).toBe('seed-sync');
  });

  it('does not overwrite a playbook changed by governed learning', () => {
    getPlaybook();
    const saved = savePlaybook('# governed learning', 'learn from real results');
    expect(saved.version).toBe(2);
    expect(getPlaybook()).toEqual({ version: 2, content: '# governed learning' });
  });
});
