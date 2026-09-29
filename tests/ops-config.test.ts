import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { getConfig, parseConfig, setConfigForTests, toMinutes } from '../src/config.js';
import { acquireLock, backupDb, buildAgentInvocation, cronLine, releaseLock, UNATTENDED_DENY } from '../src/ops.js';
import { getClassificationQueue, saveClassifications } from '../src/pipeline/classify.js';
import { getDraftingQueue } from '../src/pipeline/sequence.js';
import { pushToOverloop } from '../src/pipeline/push.js';
import { saveSequence } from '../src/pipeline/sequence.js';
import { sourceLeads } from '../src/pipeline/source.js';
import { MaxClient } from '../src/clients/max.js';
import { OverloopClient } from '../src/clients/overloop.js';
import { fakeFetch, freshEnv, maxLead } from './helpers.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gtm-'));

describe('config', () => {
  it('parses schedule days/times, booleans and empty values as defaults', () => {
    const env = {
      MAX_API_KEY: 'k'.repeat(20),
      OVERLOOP_API_KEY: 'o'.repeat(20),
      MAX_BUSINESS_ID: '',
      GTM_SCHEDULE_DAYS: 'mon, wed,Friday',
      GTM_SCHEDULE_TIME: '07:30',
      GTM_ENRICH_FROM_OVERLOOP: 'no',
      OVERLOOP_SEND_START: '08:15',
    };
    const c = parseConfig(env);
    expect(c.GTM_SCHEDULE_DAYS).toEqual(['MON', 'WED', 'FRI']);
    expect(c.GTM_ENRICH_FROM_OVERLOOP).toBe(false);
    expect(c.MAX_BUSINESS_ID).toBe(0);
    expect(c.SEND_MODE).toBe('locked');
    expect(toMinutes(c.OVERLOOP_SEND_START)).toBe(495);
    expect(() => parseConfig({ ...env, GTM_SCHEDULE_TIME: '25:00' })).toThrow(/HH:MM/);
    expect(() => parseConfig({ ...env, MAX_API_KEY: '' })).toThrow(/MAX_API_KEY missing/);
  });
});

describe('ops', () => {
  beforeEach(() => freshEnv());

  it('builds a cron line from the schedule', () => {
    setConfigForTests({ GTM_SCHEDULE_TIME: '07:05', GTM_SCHEDULE_DAYS: ['MON', 'FRI', 'SUN'] });
    const line = cronLine(getConfig());
    expect(line.startsWith('5 7 * * 1,5,0 ')).toBe(true);
    expect(line).toContain('bin/gtm.mjs daily');
    expect(line).toContain('# gtm-autopilot:');
  });

  it('agent invocation never allows approve/launch on unattended runs', () => {
    const inv = buildAgentInvocation(getConfig(), 'extra');
    for (const t of ['mcp__gtm-autopilot__gtm_approve', 'mcp__gtm-autopilot__gtm_launch']) {
      expect(UNATTENDED_DENY).toContain(t);
      expect(inv.args).toContain(t);
    }
    expect(inv.prompt).toMatch(/^\/gtm-daily-loop .*unattended.*extra$/);
    setConfigForTests({ GTM_AGENT_CMD: 'codex' });
    expect(buildAgentInvocation(getConfig()).args[0]).toBe('exec');
  });

  it('lock is exclusive and released', () => {
    const dir = tmp();
    setConfigForTests({ GTM_DB_PATH: path.join(dir, 'gtm.db') });
    expect(acquireLock()).toBe(true);
    expect(acquireLock()).toBe(false);
    releaseLock();
    expect(acquireLock()).toBe(true);
    releaseLock();
  });

  it('backs up the database and keeps only N snapshots', async () => {
    const dir = tmp();
    setConfigForTests({ GTM_DB_PATH: path.join(dir, 'gtm.db'), GTM_BACKUP_DIR: path.join(dir, 'b'), GTM_BACKUP_KEEP: 2 });
    for (let i = 0; i < 3; i++) {
      fs.mkdirSync(path.join(dir, 'b'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'b', `gtm-2020010${i}-0000.db`), 'old');
    }
    const r = backupDb();
    expect(fs.existsSync(r.file!)).toBe(true);
    expect(fs.readdirSync(path.join(dir, 'b')).length).toBe(2);
  });
});

describe('daily caps + sending window', () => {
  beforeEach(() => freshEnv({ GTM_DAILY_NEW_LEADS: 2, GTM_DAILY_SEQUENCES: 1, OVERLOOP_SENDING_DAYS: ['TUE', 'THU'], OVERLOOP_SEND_START: '10:00', OVERLOOP_SEND_END: '16:30' }));

  it('caps classification + drafting per day and applies the sending window', async () => {
    const leads = [maxLead(1), maxLead(2), maxLead(3), maxLead(4)];
    const mf = fakeFetch({ 'GET /leads': () => ({ leads, meta: { current_page: 1, total_pages: 1, total_count: 4, per_page: 100 } }) });
    await sourceLeads({ max: new MaxClient({ fetchImpl: mf.fn, baseUrl: 'https://max.test/api/v1', apiKey: 'k' }), businessId: 143 });
    expect(getClassificationQueue(10).leads.length).toBe(2);
    saveClassifications([1, 2].map((id) => ({ lead_id: id, tier: 'A' as const, persona: 'cmo', intent_strength: 5, route: 'email' as const, angle: 'speed', reasoning: 'Strong signal and fit.' })));
    const q = getClassificationQueue(10);
    expect(q.leads.length).toBe(0);
    expect(q.daily_cap.reached).toBe(true);

    expect(getDraftingQueue(10).leads.length).toBe(1);
    saveSequence({
      lead_id: 1,
      angle: 'speed angle',
      hook_type: 'signal_reference',
      status: 'final',
      steps: [{ type: 'email', delay_days: 0, subject: 'your comment', body: 'Hi Jane, your comment about agency selection at Acme stuck with me. We help teams shortlist faster. Worth a 1-pager?' }],
    });
    expect(getDraftingQueue(10).daily_cap.reached).toBe(true);

    const of = fakeFetch({ 'GET /prospects': () => ({ data: [], pagination: {} }), 'POST /prospects': () => ({ data: { id: 9 } }), 'POST /campaigns': (b) => ({ data: { id: 10, ...b } }) });
    await pushToOverloop({ client: new OverloopClient({ fetchImpl: of.fn, baseUrl: 'https://ovl.test/public/v2', apiKey: 'k' }) });
    const body = of.calls.find((c) => c.url.endsWith('/campaigns'))!.body;
    expect(body.sending_days).toEqual(['tuesday', 'thursday']);
    expect(body.start_sending_minutes).toBe(600);
    expect(body.end_sending_minutes).toBe(990);
  });
});
