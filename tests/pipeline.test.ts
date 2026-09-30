import { beforeEach, describe, expect, it } from 'vitest';
import { MaxClient } from '../src/clients/max.js';
import { OverloopClient } from '../src/clients/overloop.js';
import { MaxSourceAdapter } from '../src/adapters/max-source.js';
import { OverloopExecutionAdapter } from '../src/adapters/overloop-execution.js';
import { SendGuard } from '../src/safety/guard.js';
import { auditSink, one } from '../src/db/db.js';
import { sourceLeads } from '../src/pipeline/source.js';
import { getClassificationQueue, saveClassifications } from '../src/pipeline/classify.js';
import { getDraftingQueue, saveSequence } from '../src/pipeline/sequence.js';
import { pushToOverloop } from '../src/pipeline/push.js';
import { simulateResults } from '../src/pipeline/results.js';
import { getPerformance, bucketize } from '../src/pipeline/analytics.js';
import { saveLearnings } from '../src/pipeline/learn.js';
import { getPlaybook } from '../src/pipeline/playbook.js';
import { buildReport } from '../src/pipeline/report.js';
import { fakeFetch, freshEnv, maxLead } from './helpers.js';

function maxWith(leads: any[]) {
  const f = fakeFetch({
    'GET /leads': () => ({ leads, meta: { current_page: 1, total_pages: 1, total_count: leads.length, per_page: 100 } }),
  });
  return new MaxSourceAdapter(new MaxClient({ fetchImpl: f.fn, baseUrl: 'https://max.test/api/v1', apiKey: 'k' }));
}

function overloopFake() {
  let nextId = 100;
  const f = fakeFetch({
    'GET /prospects': () => ({ data: [], pagination: { page: 1, per_page: 1, total: 0, total_pages: 0 } }),
    'POST /prospects': (b) => ({ data: { id: nextId++, ...b } }),
    'POST /campaigns': (b) => ({ data: { id: nextId++, ...b } }),
    'POST /enrollments': () => ({ data: { id: 1 } }),
  });
  const execution = new OverloopExecutionAdapter(
    new OverloopClient({ fetchImpl: f.fn, baseUrl: 'https://ovl.test/public/v2', apiKey: 'k', guard: new SendGuard('locked', auditSink) }),
  );
  return { execution, calls: f.calls };
}

const seqFor = (id: number, route: 'email' | 'linkedin' | 'both') => ({
  lead_id: id,
  angle: 'shortlist agencies fast',
  hook_type: 'signal_reference' as const,
  status: 'final' as const,
  steps:
    route === 'linkedin'
      ? [
          { type: 'linkedin_visit' as const, delay_days: 0 },
          { type: 'linkedin_invite' as const, delay_days: 1, note: `Jane, liked your comment on agency selection at Acme. Would be glad to connect.` },
        ]
      : [
          {
            type: 'email' as const,
            delay_days: 0,
            subject: 'your comment on agency selection',
            body: `Hi Jane,\n\nYour comment about agency selection stuck with me, especially the part about briefs getting lost at Acme-sized teams. We help marketing leads get a vetted shortlist in 48h from a single brief.\n\nWorth me sending the 1-page overview?`,
          },
        ],
});

describe('end-to-end pipeline (mocked APIs)', () => {
  beforeEach(() => freshEnv());

  it('sources, dedupes, classifies, drafts, pushes inert, simulates, learns, reports', async () => {
    const leads = [maxLead(1), maxLead(2, { email: null }), maxLead(3, { email: 'jane1@acme.com' }), maxLead(4)];
    const src = await sourceLeads({ source: maxWith(leads), businessId: 143 });
    expect(src.inserted).toBe(4);
    expect(src.duplicates).toBe(1);

    // re-sourcing is idempotent
    const again = await sourceLeads({ source: maxWith(leads), businessId: 143 });
    expect(again.inserted).toBe(0);

    const q = getClassificationQueue(10);
    expect(q.leads.map((l) => l.lead_id).sort()).toEqual([1, 2, 4]);
    expect(q.leads.find((l) => l.lead_id === 2)!.channels_available).toEqual({ email: false, linkedin: true });

    const saved = saveClassifications([
      { lead_id: 1, tier: 'A', persona: 'cmo', intent_strength: 5, route: 'email', angle: 'speed', reasoning: 'Strong signal, perfect title fit.' },
      { lead_id: 2, tier: 'B', persona: 'cmo', intent_strength: 3, route: 'email', angle: 'speed', reasoning: 'No email available, fine fit.' },
      { lead_id: 4, tier: 'DQ', persona: 'student', intent_strength: 1, route: 'email', angle: 'n/a', reasoning: 'Not a buyer at all.' },
    ]);
    expect(saved.saved).toBe(3);
    expect(one<any>('SELECT route FROM classifications WHERE lead_id = 2').route).toBe('linkedin');
    expect(one<any>('SELECT status FROM leads WHERE id = 4').status).toBe('disqualified');

    expect(getDraftingQueue(10).leads.map((l) => l.lead_id).sort()).toEqual([1, 2]);

    // wrong channel for the route stays draft
    const wrong = saveSequence(seqFor(2, 'email'));
    expect(wrong.ok && wrong.status).toBe('draft');
    const r1 = saveSequence(seqFor(1, 'email'));
    const r2 = saveSequence(seqFor(2, 'linkedin'));
    expect(r1.ok && r1.status).toBe('final');
    expect(r2.ok && r2.status).toBe('final');

    const ovl = overloopFake();
    const pushed = await pushToOverloop({ execution: ovl.execution });
    expect(pushed.pushed).toBe(2);
    const campaignBodies = ovl.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/campaigns')).map((c) => c.body);
    for (const b of campaignBodies) {
      expect(b.status).toBe('off');
      expect(b.only_allow_manual_enrollment).toBe(true);
      expect(b.automatically_send_messages).toBe(false);
    }
    expect(ovl.calls.some((c) => c.url.includes('enrollments'))).toBe(false);

    const sim = simulateResults({ seed: 7 });
    expect(sim.simulated).toBe(2);
    const perf = getPerformance();
    expect(perf.data_quality.simulated_outcomes).toBe(2);
    expect(perf.by.route!.length).toBeGreaterThan(0);

    const before = getPlaybook().version;
    const learned = await saveLearnings({
      insights: [{ finding: 'Signal hooks outperform generic', evidence: 'test', confidence: 'low', action: 'keep signal-first openers' }],
      playbook_markdown: '# Playbook\n\n' + 'Lead with the signal. '.repeat(5),
      weights: { 'signal:social-mentions': 1.3 },
    });
    expect(learned.playbook_version).toBe(before + 1);
    expect(learned.based_on_simulated).toBe(true);
    expect(getClassificationQueue(1).recent_learnings.length).toBe(1);

    const md = buildReport();
    expect(md).toContain('daily brief');
    expect(md).toContain('Locked mode');
  });

  it('enroll attempt in locked mode is blocked and audited, nothing enrolled', async () => {
    await sourceLeads({ source: maxWith([maxLead(1)]), businessId: 143 });
    saveClassifications([{ lead_id: 1, tier: 'A', persona: 'cmo', intent_strength: 5, route: 'email', angle: 'speed', reasoning: 'Strong signal and fit.' }]);
    saveSequence(seqFor(1, 'email'));
    const ovl = overloopFake();
    const res = await pushToOverloop({ execution: ovl.execution, enroll: true });
    expect(res.blocked).toBe(1);
    expect(ovl.calls.some((c) => c.url.includes('enrollments'))).toBe(false);
    expect(one<any>('SELECT COUNT(*) n FROM audit WHERE allowed = 0').n).toBe(1);
    expect(one<any>('SELECT COUNT(*) n FROM pushes WHERE enrolled = 1').n).toBe(0);
  });
});

describe('analytics math', () => {
  it('computes rates and flags low samples', () => {
    const b = bucketize([
      { key: 'a', sent: 1, opened: 1, replied: 1, positive: 1, meeting: 0, bounced: 0 },
      { key: 'a', sent: 1, opened: 0, replied: 0, positive: 0, meeting: 0, bounced: 0 },
      { key: 'b', sent: 1, opened: 1, replied: 0, positive: 0, meeting: 0, bounced: 0 },
    ]);
    expect(b[0]).toMatchObject({ key: 'a', contacted: 2, reply_rate: 50, low_sample: true });
    expect(b[1]).toMatchObject({ key: 'b', reply_rate: 0 });
  });
});
