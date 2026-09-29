import { describe, expect, it } from 'vitest';
import { applyRoutingRules } from '../src/pipeline/route.js';
import { lintSequence, type SequenceInput } from '../src/pipeline/sequence.js';
import { toOverloopSteps, textToHtml } from '../src/pipeline/push.js';
import { splitName, dedupeKey } from '../src/pipeline/source.js';

const both = { email: 'a@acme.com', linkedin_url: 'https://linkedin.com/in/a' };

describe('routing rules', () => {
  it('keeps the model choice when data allows', () => {
    expect(applyRoutingRules(both, 'both', 'A').route).toBe('both');
    expect(applyRoutingRules(both, 'email', 'B').route).toBe('email');
  });
  it('falls back to the available channel', () => {
    expect(applyRoutingRules({ email: null, linkedin_url: both.linkedin_url }, 'email', 'A').route).toBe('linkedin');
    expect(applyRoutingRules({ email: both.email, linkedin_url: null }, 'linkedin', 'A').route).toBe('email');
    expect(applyRoutingRules({ email: null, linkedin_url: both.linkedin_url }, 'both', 'A').route).toBe('linkedin');
  });
  it('treats bad email status and company pages as unavailable', () => {
    expect(applyRoutingRules({ ...both, email_status: 'invalid' }, 'email', 'A').route).toBe('linkedin');
    expect(applyRoutingRules({ email: null, linkedin_url: 'https://linkedin.com/company/x' }, 'linkedin', 'A').route).toBe('none');
  });
  it('DQ always routes to none', () => {
    expect(applyRoutingRules(both, 'both', 'DQ').route).toBe('none');
  });
});

const good: SequenceInput = {
  lead_id: 1,
  angle: 'agency shortlist in 48h',
  hook_type: 'signal_reference',
  status: 'final',
  steps: [
    {
      type: 'email',
      delay_days: 0,
      subject: 'your comment on agency briefs',
      body:
        'Hi Jane,\n\nSaw your comment on the post about agency selection: the point that briefs get lost between procurement and marketing is spot on. Acme seems to run a lot of those processes.\n\nWe help teams get a vetted agency shortlist in 48 hours from one brief. Would it be useful if I sent over how a similar agency structured theirs?',
    },
    { type: 'email', delay_days: 3, subject: 're: agency briefs', body: 'Hi Jane, one more thought: the teams who shortlist fastest write the brief once and reuse it. Happy to share a template if helpful?' },
  ],
};

describe('sequence lint', () => {
  it('passes a specific, clean sequence', () => {
    const issues = lintSequence(good, 'email', { first_name: 'Jane', company: 'Acme' });
    expect(issues.filter((i) => i.level === 'error')).toEqual([]);
  });
  it('rejects channel/route mismatch, placeholders and long invite notes', () => {
    const bad: SequenceInput = {
      ...good,
      steps: [
        { type: 'linkedin_invite', delay_days: 0, note: 'Hi [First Name], ' + 'x'.repeat(10) },
        { type: 'email', delay_days: 2, subject: 'HELLO THERE', body: 'Click here for a free guarantee, act now. '.repeat(3) },
      ],
    };
    const issues = lintSequence(bad, 'email', { first_name: 'Jane', company: 'Acme' });
    const rules = issues.filter((i) => i.level === 'error').map((i) => i.rule);
    expect(rules).toContain('route');
    expect(rules).toContain('placeholder');
    expect(rules).toContain('subject');
    expect(issues.some((i) => i.rule === 'spam')).toBe(true);
  });
  it('warns when the first touch is generic', () => {
    const generic: SequenceInput = { ...good, steps: [{ type: 'email', delay_days: 0, subject: 'quick question', body: 'Hello, we help companies grow faster with our platform. Want to chat this week about your goals?' }] };
    expect(lintSequence(generic, 'email', { first_name: 'Jane', company: 'Acme' }).some((i) => i.rule === 'personalization')).toBe(true);
  });
});

describe('overloop mapping', () => {
  it('inserts delay steps and uses message for LinkedIn', () => {
    const steps = toOverloopSteps([
      { type: 'linkedin_visit', delay_days: 0 },
      { type: 'linkedin_invite', delay_days: 1, note: 'hi' },
      { type: 'email', delay_days: 2, subject: 's', body: 'a\n\nb' },
    ]);
    expect(steps.map((s) => s.type)).toEqual(['linkedin_visit_profile', 'delay', 'linkedin_send_invitation', 'delay', 'email']);
    expect(steps[2]!.config.message).toBe('hi');
    expect(steps[4]!.config.content).toBe('<p>a</p><p>b</p>');
  });
  it('escapes html', () => {
    expect(textToHtml('a < b & c')).toBe('<p>a &lt; b &amp; c</p>');
  });
});

describe('source helpers', () => {
  it('splits names and builds dedupe keys', () => {
    expect(splitName('Jean-Luc van Damme')).toEqual({ first: 'Jean-Luc', last: 'van Damme' });
    expect(splitName('Cher')).toEqual({ first: 'Cher', last: null });
    expect(dedupeKey({ email: 'A@B.com', linkedin_url: null, name: null, company: null })).toBe('email:a@b.com');
    expect(dedupeKey({ email: null, linkedin_url: 'https://www.linkedin.com/in/x/', name: null, company: null })).toBe('li:linkedin.com/in/x');
  });
});
