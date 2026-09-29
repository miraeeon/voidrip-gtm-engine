import { describe, expect, it } from 'vitest';
import { SafetyError, SendGuard, type AuditEntry } from '../src/safety/guard.js';

describe('SendGuard (locked)', () => {
  const audit: AuditEntry[] = [];
  const g = new SendGuard('locked', (e) => audit.push(e));

  it('allows reads', () => {
    expect(() => g.check('GET', '/campaigns/1/enrollments', undefined)).not.toThrow();
  });

  it('blocks single and bulk enrollment', () => {
    expect(() => g.check('POST', '/campaigns/1/enrollments', { prospect_id: 1 })).toThrow(SafetyError);
    expect(() => g.check('POST', '/campaigns/1/enrollments/bulk', { prospect_ids: [1] })).toThrow(SafetyError);
  });

  it('blocks enrollment even with allowSend in locked mode', () => {
    expect(() => g.check('POST', '/campaigns/1/enrollments', {}, { allowSend: true })).toThrow(/locked/);
  });

  it('blocks activating a campaign', () => {
    expect(() => g.check('PATCH', '/campaigns/9', { status: 'on' })).toThrow(/status/);
  });

  it('blocks auto-enroll / auto-send flags and sourcing on create', () => {
    expect(() => g.check('POST', '/campaigns', { name: 'x', only_allow_manual_enrollment: false })).toThrow();
    expect(() => g.check('POST', '/campaigns', { name: 'x', automatically_send_messages: true })).toThrow();
    expect(() => g.check('POST', '/campaigns', { name: 'x', automatically_send_follow_ups: true })).toThrow();
    expect(() => g.check('POST', '/campaigns', { name: 'x', sourcing_id: 'abc' })).toThrow();
    expect(() => g.check('POST', '/campaigns', { name: 'x', search_criteria: {} })).toThrow();
    expect(() => g.check('POST', '/campaigns', { name: 'x', steps: [{ type: 'enroll_campaign' }] })).toThrow();
  });

  it('blocks starting sourcings and sending conversation messages', () => {
    expect(() => g.check('POST', '/sourcings/abc/start', undefined)).toThrow();
    expect(() => g.check('POST', '/conversations/5/reply', { text: 'hi' })).toThrow();
  });

  it('allows inert drafts, prospects and deletes', () => {
    expect(() =>
      g.check('POST', '/campaigns', {
        name: 'x',
        status: 'off',
        only_allow_manual_enrollment: true,
        automatically_send_messages: false,
        steps: [{ type: 'email', config: { subject: 's', content: 'c' } }],
      }),
    ).not.toThrow();
    expect(() => g.check('POST', '/prospects', { email: 'a@b.co' })).not.toThrow();
    expect(() => g.check('DELETE', '/campaigns/1', undefined)).not.toThrow();
    expect(() => g.check('PATCH', '/campaigns/1', { status: 'off' })).not.toThrow();
  });

  it('audits blocked attempts', () => {
    expect(audit.some((a) => !a.allowed && a.path.includes('enrollments'))).toBe(true);
  });
});

describe('SendGuard (live)', () => {
  const g = new SendGuard('live');
  it('still requires explicit allowSend per call', () => {
    expect(() => g.check('POST', '/campaigns/1/enrollments', {})).toThrow(/allowSend/);
    expect(() => g.check('POST', '/campaigns/1/enrollments', {}, { allowSend: true })).not.toThrow();
  });
});
