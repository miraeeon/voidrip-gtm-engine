import { beforeEach, describe, expect, it } from 'vitest';
import { OverloopClient } from '../src/clients/overloop.js';
import { MaxSourceAdapter } from '../src/adapters/max-source.js';
import { OverloopExecutionAdapter } from '../src/adapters/overloop-execution.js';
import { SendGuard } from '../src/safety/guard.js';
import { auditSink, one, run } from '../src/db/db.js';
import { setConfigForTests } from '../src/config.js';
import { saveClassifications } from '../src/pipeline/classify.js';
import { saveSequence } from '../src/pipeline/sequence.js';
import { approvePushes, launchApproved, pushToOverloop, reviewQueue } from '../src/pipeline/push.js';
import { detectReplies, getReplyQueue, ingestReply, replyInbox, resolveReply, saveReplyTriage, simulateReplies } from '../src/pipeline/replies.js';
import { sourceLeads } from '../src/pipeline/source.js';
import { MaxClient } from '../src/clients/max.js';
import { fakeFetch, freshEnv, maxLead } from './helpers.js';

const seq = (id: number) => ({
  lead_id: id,
  angle: 'speed angle',
  hook_type: 'signal_reference' as const,
  status: 'final' as const,
  steps: [
    {
      type: 'email' as const,
      delay_days: 0,
      subject: 'your comment on agency selection',
      body: 'Hi Jane,\n\nYour comment about agency selection at Acme stuck with me: briefs get lost between teams. We help marketing leads get a vetted shortlist from one brief.\n\nWorth me sending the 1-page overview?',
    },
  ],
});

function ovlFake(prospect: Record<string, unknown> = {}) {
  let id = 500;
  const f = fakeFetch({
    'GET /prospects': () => ({ data: [], pagination: {} }),
    'POST /prospects': (b) => ({ data: { id: id++, ...b } }),
    'POST /campaigns': (b) => ({ data: { id: id++, ...b } }),
    'PATCH /campaigns/': (b) => ({ data: { id: 1, ...b } }),
    'GET /prospects/': () => ({ data: { id: 1, replied: false, excluded: false, bounced: false, email_reply_count: 0, linkedin_reply_count: 0, replied_at: null, ...prospect } }),
    'POST /enrollments': () => ({ data: { id: 9 } }),
    'GET /enrollments': () => ({ data: [{ id: 77, prospect_id: 500 }], pagination: { total: 1 } }),
    'DELETE /enrollments/77': () => ({}),
    'POST /exclusion_list': (b) => ({ data: b }),
    'GET /conversations': () => ({ data: [{ id: 3, prospect_ids: [500] }], pagination: { total_pages: 1 } }),
    'GET /me': () => ({ id: 42, name: 'Me', email: 'me@x.co' }),
    'GET /campaigns/': () => ({ data: { id: 501, user_id: 7 } }),
    'POST /assign': () => ({}),
  });
  return f;
}

async function pushOne(mode: 'locked' | 'live' = 'locked', prospect: Record<string, unknown> = {}) {
  const mf = fakeFetch({ 'GET /leads': () => ({ leads: [maxLead(1)], meta: { current_page: 1, total_pages: 1, total_count: 1, per_page: 100 } }) });
  await sourceLeads({ source: new MaxSourceAdapter(new MaxClient({ fetchImpl: mf.fn, baseUrl: 'https://max.test/api/v1', apiKey: 'k' })), businessId: 143 });
  saveClassifications([{ lead_id: 1, tier: 'A', persona: 'cmo', intent_strength: 5, route: 'email', angle: 'speed', reasoning: 'Strong fit and signal.' }]);
  saveSequence(seq(1));
  const f = ovlFake(prospect);
  const execution = new OverloopExecutionAdapter(
    new OverloopClient({ fetchImpl: f.fn, baseUrl: 'https://ovl.test/public/v2', apiKey: 'k', guard: new SendGuard(mode, auditSink) }),
  );
  await pushToOverloop({ execution });
  return { execution, calls: f.calls };
}

describe('review / approve / launch', () => {
  beforeEach(() => freshEnv());

  it('requires confirm, approval, and is blocked in locked mode', async () => {
    const { execution, calls } = await pushOne('locked');
    expect(reviewQueue()[0]!.steps.length).toBe(1);
    expect(((await launchApproved({ execution, confirm: 'SEND' })) as any).approved_candidates).toBe(0); // not approved yet
    approvePushes();
    expect((await launchApproved({ execution })).launched).toBe(0); // no confirm
    const r = await launchApproved({ execution, confirm: 'SEND' });
    expect(r.items[0]!.status).toBe('blocked');
    expect(calls.some((c) => c.url.includes('enrollments') && c.method === 'POST')).toBe(false);
  });

  it('launches in live mode with approval + confirm', async () => {
    setConfigForTests({ SEND_MODE: 'live' });
    const { execution, calls } = await pushOne('live');
    approvePushes([1]);
    const r = await launchApproved({ execution, confirm: 'SEND' });
    expect(r.launched).toBe(1);
    expect(calls.some((c) => c.url.endsWith('/enrollments') && c.method === 'POST')).toBe(true);
    expect(calls.some((c) => c.method === 'PATCH' && c.body?.status === 'on')).toBe(true);
    expect(one<any>('SELECT launched_at FROM pushes').launched_at).toBeTruthy();
  });

  it('never launches someone who replied meanwhile', async () => {
    setConfigForTests({ SEND_MODE: 'live' });
    const { execution } = await pushOne('live', { replied: true });
    approvePushes();
    expect((await launchApproved({ execution, confirm: 'SEND' })).items[0]!.status).toBe('skipped');
  });

  it('respects the daily push limit', async () => {
    setConfigForTests({ GTM_DAILY_PUSH_LIMIT: 0 });
    const mf = fakeFetch({ 'GET /leads': () => ({ leads: [maxLead(1)], meta: { current_page: 1, total_pages: 1, total_count: 1, per_page: 100 } }) });
    await sourceLeads({ source: new MaxSourceAdapter(new MaxClient({ fetchImpl: mf.fn, baseUrl: 'https://max.test/api/v1', apiKey: 'k' })), businessId: 143 });
    saveClassifications([{ lead_id: 1, tier: 'A', persona: 'cmo', intent_strength: 5, route: 'email', angle: 'speed', reasoning: 'Strong fit and signal.' }]);
    saveSequence(seq(1));
    const r = await pushToOverloop({ execution: new OverloopExecutionAdapter(new OverloopClient({ fetchImpl: ovlFake().fn, baseUrl: 'https://ovl.test/public/v2', apiKey: 'k' })) });
    expect(r.pushed).toBe(0);
    expect(r.note).toMatch(/Daily push limit/);
  });
});

describe('reply handling', () => {
  beforeEach(() => freshEnv());

  it('detects replies from Overloop counts and needs text', async () => {
    await pushOne('locked');
    const future = new Date(Date.now() + 60_000).toISOString();
    const f = ovlFake({ replied: true, replied_at: future, email_reply_count: 1 });
    const execution = new OverloopExecutionAdapter(new OverloopClient({ fetchImpl: f.fn, baseUrl: 'https://ovl.test/public/v2', apiKey: 'k' }));
    const d = await detectReplies({ execution });
    expect(d.new_replies).toBe(1);
    expect((await detectReplies({ execution })).new_replies).toBe(0); // idempotent
    expect(getReplyQueue().needs_text.length).toBe(1);
    ingestReply({ reply_id: d.opened[0]!.reply_id, text: 'Sounds good, send times.' });
    expect(getReplyQueue().to_triage.length).toBe(1);
  });

  it('triage applies safe actions: unsubscribe -> exclusion + stop; interested -> assign + positive outcome', async () => {
    const { calls } = await pushOne('locked');
    const execution = new OverloopExecutionAdapter(new OverloopClient({ fetchImpl: ovlFake().fn, baseUrl: 'https://ovl.test/public/v2', apiKey: 'k', guard: new SendGuard('locked', auditSink) }));
    const a = ingestReply({ lead_id: 1, text: 'Please remove me from your list.' });
    const t1 = await saveReplyTriage({ reply_id: a.reply_id, category: 'unsubscribe', sentiment: 'negative', summary: 'Asked to be removed', next_action: 'None' }, { execution });
    expect(t1.actions.map((x) => x.action)).toEqual(['exclusion_list', 'stop_sequence']);
    expect(t1.actions.every((x) => x.ok)).toBe(true);
    expect(t1.needs_human).toBe(false);

    const b = ingestReply({ lead_id: 1, text: 'Interested — can we talk Tuesday?' });
    const t2 = await saveReplyTriage(
      { reply_id: b.reply_id, category: 'interested', sentiment: 'positive', summary: 'Wants a call Tuesday', next_action: 'Confirm Tuesday 10:00', draft_response: 'Great — Tuesday 10:00 works?' },
      { execution },
    );
    expect(t2.actions.find((x) => x.action === 'assign_conversation')?.ok).toBe(true);
    expect(one<any>('SELECT positive, replied FROM outcomes WHERE lead_id = 1')).toMatchObject({ positive: 1, replied: 1 });
    expect(replyInbox()[0]!.category).toBe('interested');
    resolveReply({ reply_id: b.reply_id, outcome: 'meeting_booked' });
    expect(one<any>('SELECT meeting FROM outcomes WHERE lead_id = 1').meeting).toBe(1);
    void calls;
  });

  it('simulated replies skip real actions and are flagged', async () => {
    await pushOne('locked');
    const s = simulateReplies({ count: 1 });
    const f = ovlFake();
    const execution = new OverloopExecutionAdapter(new OverloopClient({ fetchImpl: f.fn, baseUrl: 'https://ovl.test/public/v2', apiKey: 'k' }));
    const t = await saveReplyTriage({ reply_id: s.created[0]!.reply_id, category: 'not_interested', sentiment: 'negative', summary: 'Not interested', next_action: 'None' }, { execution });
    expect(t.actions.every((x) => x.detail?.includes('simulated'))).toBe(true);
    expect(f.calls.length).toBe(0);
    expect(one<any>('SELECT is_simulated FROM outcomes WHERE lead_id = 1').is_simulated).toBe(1);
  });

  it('refuses triage without text', async () => {
    await pushOne('locked');
    run(`INSERT INTO replies(lead_id, channel, status, detected_at) VALUES (1, 'email', 'needs_text', 'x')`);
    await expect(saveReplyTriage({ reply_id: 1, category: 'question', sentiment: 'neutral', summary: 'x x', next_action: 'y y' })).rejects.toThrow(/no text/);
  });
});
