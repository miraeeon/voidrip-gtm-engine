import { describe, expect, it } from 'vitest';
import { HeyReachAdapter } from '../src/adapters/heyreach-execution.js';
import { HeyReachClient } from '../src/clients/heyreach.js';
import { verifyHeyReachCampaign } from '../src/pipeline/heyreach.js';
import { OutboundSafetyGuard, SafetyError, type AuditEntry } from '../src/safety/guard.js';
import { fakeFetch, freshEnv } from './helpers.js';

describe('OutboundSafetyGuard', () => {
  it('classifies writes independently from provider paths', () => {
    const audit: AuditEntry[] = [];
    const guard = new OutboundSafetyGuard('locked', (entry) => audit.push(entry));
    expect(() => guard.check('SAFE_WRITE', {
      adapter: 'heyreach', operation: 'create_draft_campaign', target: '/campaign/Create',
    })).not.toThrow();
    expect(() => guard.check('SEND_CAPABLE', {
      adapter: 'heyreach', operation: 'start_campaign', target: '/campaign/StartCampaign',
    })).toThrow(SafetyError);
    expect(audit).toMatchObject([
      { service: 'heyreach', action: 'SAFE_WRITE', allowed: true },
      { service: 'heyreach', action: 'SEND_CAPABLE', allowed: false },
    ]);
  });
});

describe('HeyReach adapter', () => {
  it('inspects the configured existing campaign without creating or changing anything', async () => {
    freshEnv({ SEND_MODE: 'locked' });
    const fake = fakeFetch({
      'GET /campaign/GetById': () => ({
        id: 623081,
        name: 'VOIDRIP — BOFU — Invitation + M1–M5',
        status: 'DRAFT',
        linkedInUserListId: 71,
        campaignAccountIds: [11],
        progressStats: { totalUsersInProgress: 0 },
      }),
      'POST /campaign/GetLeadsFromCampaign': () => ({ totalCount: 0, items: [] }),
    });
    const client = new HeyReachClient({ apiKey: 'test-heyreach-key', baseUrl: 'https://heyreach.test/api/public', fetchImpl: fake.fn });
    const adapter = new HeyReachAdapter(client, 623081);
    const result = await verifyHeyReachCampaign({ execution: adapter });

    expect(result).toMatchObject({
      provider: 'heyreach',
      leadCount: 0,
      inert: true,
      all_inert: true,
      launch_authorized: false,
      campaign: { id: 623081, status: 'DRAFT' },
    });
    expect(fake.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      'GET /api/public/campaign/GetById',
      'POST /api/public/campaign/GetLeadsFromCampaign',
    ]);
    expect(fake.calls.some((call) => call.url.includes('/Create') || call.url.includes('/AddLeads') || call.url.includes('/StartCampaign'))).toBe(false);
  });

  it('blocks starting or adding leads to campaigns in locked mode before network I/O', async () => {
    freshEnv({ SEND_MODE: 'locked' });
    const fake = fakeFetch({});
    const client = new HeyReachClient({ apiKey: 'test-heyreach-key', baseUrl: 'https://heyreach.test/api/public', fetchImpl: fake.fn });
    expect(() => client.startCampaign(81, { allowSend: true })).toThrow(/SEND_MODE=locked/);
    expect(() => client.addLeadsToCampaign(81, [], { allowSend: true })).toThrow(/SEND_MODE=locked/);
    expect(fake.calls).toHaveLength(0);
  });

  it('still requires explicit allowSend for StartCampaign in live mode', async () => {
    freshEnv({ SEND_MODE: 'live' });
    const fake = fakeFetch({ 'POST /campaign/StartCampaign': () => null });
    const client = new HeyReachClient({ apiKey: 'test-heyreach-key', baseUrl: 'https://heyreach.test/api/public', fetchImpl: fake.fn });
    expect(() => client.startCampaign(81)).toThrow(/explicit allowSend/);
    await expect(client.startCampaign(81, { allowSend: true })).resolves.toBeNull();
    expect(fake.calls).toHaveLength(1);
  });

  it('requires an explicit existing campaign id', async () => {
    freshEnv({ SEND_MODE: 'locked' });
    const client = new HeyReachClient({ apiKey: 'test-heyreach-key', baseUrl: 'https://heyreach.test/api/public', fetchImpl: fakeFetch({}).fn });
    const adapter = new HeyReachAdapter(client, 0);
    await expect(adapter.inspectConfiguredCampaign()).rejects.toThrow(/HEYREACH_CAMPAIGN_ID/);
  });
});
