import { beforeEach, describe, expect, it } from 'vitest';
import { applyRoutingRules, channelsAvailable } from '../src/pipeline/route.js';
import { reconcilePlan, saveClassifications } from '../src/pipeline/classify.js';
import { lintSequence } from '../src/pipeline/sequence.js';
import { enrichFromOverloop } from '../src/pipeline/enrich.js';
import { sourceLeads } from '../src/pipeline/source.js';
import { MaxClient } from '../src/clients/max.js';
import { OverloopClient } from '../src/clients/overloop.js';
import { MaxSourceAdapter } from '../src/adapters/max-source.js';
import { OverloopExecutionAdapter } from '../src/adapters/overloop-execution.js';
import { one } from '../src/db/db.js';
import { fakeFetch, freshEnv, maxLead } from './helpers.js';

const lead = (ovl: object | null) => ({
  email: 'a@acme.com',
  linkedin_url: 'https://linkedin.com/in/a',
  ovl_context_json: ovl ? JSON.stringify(ovl) : null,
});

describe('Overloop-aware routing', () => {
  it('bounced / invalid in Overloop removes email', () => {
    expect(channelsAvailable(lead({ exists: true, bounced: true })).email).toBe(false);
    expect(channelsAvailable(lead({ exists: true, email_status: 'invalid' })).email).toBe(false);
    expect(applyRoutingRules(lead({ exists: true, bounced: true }), 'both', 'A').route).toBe('linkedin');
  });
  it('replied or excluded in Overloop -> none (human)', () => {
    expect(applyRoutingRules(lead({ exists: true, replied: true }), 'both', 'A')).toMatchObject({ route: 'none' });
    expect(applyRoutingRules(lead({ exists: true, excluded: true }), 'email', 'A')).toMatchObject({ route: 'none' });
  });
});

describe('channel plan', () => {
  const plan = {
    first_channel: 'linkedin' as const,
    email: { role: 'support' as const, content: 'short proof email after connect' },
    linkedin: { role: 'lead' as const, content: 'connect about their post, then the pitch' },
    why: 'signal happened on LinkedIn, senior',
  };
  it('is kept for both, and trimmed when the route loses a channel', () => {
    expect(reconcilePlan(plan, 'both')).toEqual(plan);
    const emailOnly = reconcilePlan(plan, 'email')!;
    expect(emailOnly.first_channel).toBe('email');
    expect(emailOnly.linkedin.role).toBe('none');
    expect(emailOnly.email.role).not.toBe('none');
    expect(reconcilePlan(plan, 'none')).toBeNull();
  });
  it('lint enforces the first channel', () => {
    const seq = {
      lead_id: 1,
      angle: 'x angle',
      hook_type: 'signal_reference' as const,
      status: 'final' as const,
      steps: [
        { type: 'linkedin_visit' as const, delay_days: 0 },
        { type: 'email' as const, delay_days: 0, subject: 'hi jane', body: 'Hi Jane, about Acme and your post on agencies. Would a short overview help your team this month, or not a priority?' },
        { type: 'linkedin_invite' as const, delay_days: 1, note: 'Hi Jane, enjoyed your post.' },
      ],
    };
    expect(lintSequence(seq, 'both', { first_name: 'Jane', company: 'Acme' }, [], 'linkedin').some((i) => i.rule === 'channel_plan' && i.level === 'error')).toBe(true);
    expect(lintSequence(seq, 'both', { first_name: 'Jane', company: 'Acme' }, [], 'email').some((i) => i.rule === 'channel_plan')).toBe(false);
  });
  it('flags unbacked numeric claims', () => {
    const seq = {
      lead_id: 1,
      angle: 'x angle',
      hook_type: 'role_pain' as const,
      status: 'draft' as const,
      steps: [{ type: 'email' as const, delay_days: 0, subject: 'acme', body: 'Hi Jane, teams like Acme see replies double with us. Want a look at how, or is it not a priority this quarter?' }],
    };
    expect(lintSequence(seq, 'email', { first_name: 'Jane', company: 'Acme' }).some((i) => i.rule === 'claim')).toBe(true);
    expect(lintSequence(seq, 'email', { first_name: 'Jane', company: 'Acme' }, ['Replies double on average']).some((i) => i.rule === 'claim')).toBe(false);
  });
  it('does not flag ordinary uses of "double" (e.g. French "sans double outil")', () => {
    const mk = (body: string) => ({
      lead_id: 1,
      angle: 'x angle',
      hook_type: 'role_pain' as const,
      status: 'draft' as const,
      steps: [{ type: 'email' as const, delay_days: 0, subject: 'acme', body }],
    });
    const flags = (b: string) => lintSequence(mk(b), 'email', { first_name: 'Jane', company: 'Acme' }).some((i) => i.rule === 'claim');
    expect(flags('Bonjour Jane, chez Acme, tout dans un seul flux, sans double outil ni double saisie. Une démo vous intéresse ?')).toBe(false);
    expect(flags('Hi Jane, teams like Acme doubled their reply rate in a month. Worth a look?')).toBe(true);
    expect(flags('Hi Jane, Acme could see replies double. Worth a look?')).toBe(true);
    expect(flags('Hi Jane, Acme could get 3x more meetings. Worth a look?')).toBe(true);
  });
});

describe('enrich + classify end to end', () => {
  beforeEach(() => freshEnv());
  it('stores Overloop history and applies it on save', async () => {
    const mf = fakeFetch({ 'GET /leads': () => ({ leads: [maxLead(1), maxLead(2)], meta: { current_page: 1, total_pages: 1, total_count: 2, per_page: 100 } }) });
    await sourceLeads({ source: new MaxSourceAdapter(new MaxClient({ fetchImpl: mf.fn, baseUrl: 'https://max.test/api/v1', apiKey: 'k' })), businessId: 143 });
    const of = fakeFetch({
      'GET /prospects': (_b, url) =>
        decodeURIComponent(url).includes('jane1@acme.com')
          ? { data: [{ id: 9, email: 'jane1@acme.com', replied: true, bounced: false, excluded: false, email_status: 'found' }], pagination: {} }
          : { data: [], pagination: {} },
    });
    const r = await enrichFromOverloop({ execution: new OverloopExecutionAdapter(new OverloopClient({ fetchImpl: of.fn, baseUrl: 'https://ovl.test/public/v2', apiKey: 'k' })) });
    expect(r.already_in_overloop).toBe(1);
    const saved = saveClassifications([
      { lead_id: 1, tier: 'A', persona: 'cmo', intent_strength: 5, route: 'both', angle: 'speed', reasoning: 'Strong signal and fit.' },
      {
        lead_id: 2,
        tier: 'A',
        persona: 'cmo',
        intent_strength: 5,
        route: 'both',
        angle: 'speed',
        reasoning: 'Strong signal and fit.',
        channel_plan: { first_channel: 'linkedin', email: { role: 'support', content: 'proof email' }, linkedin: { role: 'lead', content: 'connect on post' }, why: 'LinkedIn-born signal' },
      },
    ]);
    expect(saved.by_route).toEqual({ none: 1, both: 1 });
    expect(one<any>('SELECT first_channel FROM classifications WHERE lead_id = 2').first_channel).toBe('linkedin');
  });
});
