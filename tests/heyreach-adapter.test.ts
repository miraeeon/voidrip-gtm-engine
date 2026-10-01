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

  it('requires explicit import approval but allows safe lead-list staging while locked', async () => {
    freshEnv({ SEND_MODE: 'locked' });
    const fake = fakeFetch({ 'POST /list/AddLeadsToListV2': () => ({ addedLeadsCount: 1 }) });
    const client = new HeyReachClient({ apiKey: 'test-heyreach-key', baseUrl: 'https://heyreach.test/api/public', fetchImpl: fake.fn });
    const lead = { firstName: 'Ari', lastName: 'Builder', profileUrl: 'https://linkedin.com/in/ari-builder' };
    expect(() => client.addLeadsToList(71, [lead])).toThrow(/allowImport/);
    await expect(client.addLeadsToList(71, [lead], { allowImport: true })).resolves.toMatchObject({ addedLeadsCount: 1 });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ method: 'POST', body: { listId: 71, leads: [lead] } });
  });

  it('reports sequence, lead-list and sender readiness without mutating HeyReach', async () => {
    freshEnv({ SEND_MODE: 'locked' });
    const fake = fakeFetch({
      'GET /campaign/GetById': () => ({
        id: 623081, name: 'VOIDRIP', status: 'DRAFT', linkedInUserListId: 71,
        campaignAccountIds: [11], progressStats: { totalUsersInProgress: 0 },
      }),
      'POST /campaign/GetLeadsFromCampaign': () => ({ totalCount: 0, items: [] }),
      'GET /list/GetById': () => ({ id: 71, name: 'Approved prospects', listType: 'USER_LIST', totalItemsCount: 20 }),
      'POST /li_account/GetAll': () => ({ totalCount: 1, items: [{ id: 11, firstName: 'Jen', lastName: 'Veyre', isActive: true }] }),
      'GET /campaign/GetCampaignSequence': () => ({
        message: '{FIRST_NAME} {specific_project} {platform} {specific_observation} {specific_observation_2}',
      }),
    });
    const client = new HeyReachClient({ apiKey: 'test-heyreach-key', baseUrl: 'https://heyreach.test/api/public', fetchImpl: fake.fn });
    const readiness = await new HeyReachAdapter(client, 623081).inspectReadiness();
    expect(readiness).toMatchObject({
      blockers: [], readyForImportApproval: true, readyForLaunchApproval: true,
      leadList: { id: 71, count: 20 }, assignedAccounts: [{ id: 11, active: true }],
    });
    expect(fake.calls.every((call) => !call.url.includes('AddLeads') && !call.url.includes('StartCampaign'))).toBe(true);
  });

  it('surfaces an unassigned inactive sender account as a launch blocker', async () => {
    freshEnv({ SEND_MODE: 'locked' });
    const fake = fakeFetch({
      'GET /campaign/GetById': () => ({
        id: 623081, name: 'VOIDRIP', status: 'DRAFT', linkedInUserListId: 71,
        campaignAccountIds: [], progressStats: { totalUsersInProgress: 0 },
      }),
      'POST /campaign/GetLeadsFromCampaign': () => ({ totalCount: 0, items: [] }),
      'GET /list/GetById': () => ({ id: 71, name: 'Approved prospects', listType: 'USER_LIST', totalItemsCount: 0 }),
      'POST /li_account/GetAll': () => ({ totalCount: 1, items: [{ id: 11, firstName: 'Jen', lastName: 'Veyre', isActive: false }] }),
      'GET /campaign/GetCampaignSequence': () => ({
        message: '{FIRST_NAME} {specific_project} {platform} {specific_observation} {specific_observation_2}',
      }),
    });
    const client = new HeyReachClient({ apiKey: 'test-heyreach-key', baseUrl: 'https://heyreach.test/api/public', fetchImpl: fake.fn });
    const readiness = await new HeyReachAdapter(client, 623081).inspectReadiness();
    expect(readiness.readyForImportApproval).toBe(true);
    expect(readiness.readyForLaunchApproval).toBe(false);
    expect(readiness.blockers).toEqual(expect.arrayContaining([
      'no LinkedIn sender account is assigned to the campaign',
      'no active LinkedIn sender account is available in HeyReach',
    ]));
  });

  it('requires an explicit existing campaign id', async () => {
    freshEnv({ SEND_MODE: 'locked' });
    const client = new HeyReachClient({ apiKey: 'test-heyreach-key', baseUrl: 'https://heyreach.test/api/public', fetchImpl: fakeFetch({}).fn });
    const adapter = new HeyReachAdapter(client, 0);
    await expect(adapter.inspectConfiguredCampaign()).rejects.toThrow(/HEYREACH_CAMPAIGN_ID/);
  });
});
