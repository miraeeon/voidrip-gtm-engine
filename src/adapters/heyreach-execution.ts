import { getConfig } from '../config.js';
import { HeyReachClient, type HeyReachCampaign, type HeyReachLead } from '../clients/heyreach.js';

export interface HeyReachCampaignInspection {
  provider: 'heyreach';
  campaign: HeyReachCampaign;
  leadCount: number;
  inert: boolean;
}

export interface HeyReachReadiness extends HeyReachCampaignInspection {
  leadList: { id: number; name: string; count: number } | null;
  availableAccounts: { id: number; name: string; authValid: boolean }[];
  assignedAccounts: { id: number; name: string; authValid: boolean }[];
  sequence: { nodeCount: number; requiredVariables: string[] };
  blockers: string[];
  readyForImportApproval: boolean;
  readyForLaunchApproval: boolean;
}

function inspectSequence(value: unknown) {
  const serialized = JSON.stringify(value ?? {});
  const requiredVariables = [...serialized.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1]!);
  const visit = (node: unknown): number => {
    if (!node || typeof node !== 'object') return 0;
    const current = node as Record<string, unknown>;
    return 1 + visit(current.conditionalNode) + visit(current.unconditionalNode);
  };
  return { nodeCount: visit(value), requiredVariables: [...new Set(requiredVariables)].sort() };
}

/** Read and control the already configured VOIDRIP campaign; never creates a replacement. */
export class HeyReachAdapter {
  private readonly campaignId: number;

  constructor(private readonly client = new HeyReachClient(), campaignId = getConfig().HEYREACH_CAMPAIGN_ID) {
    this.campaignId = campaignId;
  }

  private configuredCampaignId(): number {
    if (this.campaignId <= 0) throw new Error('HeyReach campaign is not configured — set HEYREACH_CAMPAIGN_ID');
    return this.campaignId;
  }

  async inspectConfiguredCampaign(): Promise<HeyReachCampaignInspection> {
    const campaignId = this.configuredCampaignId();
    const [campaign, leads] = await Promise.all([
      this.client.getCampaign(campaignId),
      this.client.getCampaignLeads(campaignId, 0, 1),
    ]);
    if (campaign.id !== campaignId) throw new Error(`HeyReach returned campaign ${campaign.id}, expected ${campaignId}`);
    const inProgress = campaign.progressStats?.totalUsersInProgress ?? 0;
    return {
      provider: 'heyreach',
      campaign,
      leadCount: leads.totalCount,
      inert: campaign.status === 'DRAFT' && inProgress === 0,
    };
  }

  async inspectReadiness(): Promise<HeyReachReadiness> {
    const inspection = await this.inspectConfiguredCampaign();
    const [leadList, accountsPage, sequence] = await Promise.all([
      this.client.getLeadList(inspection.campaign.linkedInUserListId),
      this.client.listLinkedInAccounts(0, 100),
      this.client.getCampaignSequence(inspection.campaign.id),
    ]);
    const accountsById = new Map(accountsPage.items.map((account) => [account.id, account]));
    const availableAccounts = accountsPage.items.map((account) => ({
      id: account.id,
      name: [account.firstName, account.lastName].filter(Boolean).join(' ') || `Account ${account.id}`,
      authValid: account.authIsValid === true,
    }));
    const assignedAccounts = inspection.campaign.campaignAccountIds.map((id) => {
      const account = accountsById.get(id);
      return {
        id,
        name: [account?.firstName, account?.lastName].filter(Boolean).join(' ') || `Account ${id}`,
        authValid: account?.authIsValid === true,
      };
    });
    const sequenceSummary = inspectSequence(sequence);
    const required = ['FIRST_NAME', 'specific_observation', 'specific_observation_2', 'specific_project', 'platform'];
    const blockers: string[] = [];
    if (inspection.campaign.status !== 'DRAFT') blockers.push(`campaign status is ${inspection.campaign.status}, expected DRAFT before launch`);
    if (!inspection.inert) blockers.push('campaign has leads in progress');
    if (!leadList || leadList.listType !== 'USER_LIST') blockers.push('configured campaign lead list is missing or invalid');
    if (assignedAccounts.length === 0) blockers.push('no LinkedIn sender account is assigned to the campaign');
    if (!availableAccounts.some((account) => account.authValid)) blockers.push('no LinkedIn sender with valid authentication is available in HeyReach');
    if (assignedAccounts.some((account) => !account.authValid)) blockers.push('an assigned LinkedIn sender has invalid authentication');
    for (const variable of required) {
      if (!sequenceSummary.requiredVariables.includes(variable)) blockers.push(`sequence is missing {${variable}}`);
    }
    return {
      ...inspection,
      leadList: leadList ? { id: leadList.id, name: leadList.name, count: leadList.totalItemsCount ?? leadList.count ?? 0 } : null,
      availableAccounts,
      assignedAccounts,
      sequence: sequenceSummary,
      blockers,
      readyForImportApproval:
        inspection.campaign.status === 'DRAFT' &&
        inspection.inert &&
        !!leadList &&
        leadList.listType === 'USER_LIST' &&
        required.every((variable) => sequenceSummary.requiredVariables.includes(variable)),
      readyForLaunchApproval: blockers.length === 0 && (leadList.totalItemsCount ?? leadList.count ?? 0) > 0,
    };
  }

  async stageApprovedLeads(leads: HeyReachLead[], allowImport: boolean) {
    const campaign = await this.client.getCampaign(this.configuredCampaignId());
    if (campaign.status !== 'DRAFT') {
      throw new Error(`refusing safe list staging while campaign status is ${campaign.status}; expected DRAFT`);
    }
    return this.client.addLeadsToList(campaign.linkedInUserListId, leads, { allowImport });
  }

  async listStagedLeads(offset = 0) {
    const campaign = await this.client.getCampaign(this.configuredCampaignId());
    return this.client.getLeadsFromList(campaign.linkedInUserListId, offset, 100);
  }

  async addApprovedLeads(accountLeadPairs: { linkedInAccountId: number; lead: HeyReachLead }[], allowSend: boolean): Promise<void> {
    await this.client.addLeadsToCampaign(this.configuredCampaignId(), accountLeadPairs, { allowSend });
  }

  async activate(allowSend: boolean): Promise<void> {
    await this.client.startCampaign(this.configuredCampaignId(), { allowSend });
  }

  pause() {
    return this.client.pauseCampaign(this.configuredCampaignId());
  }

  results(offset = 0) {
    return this.client.getCampaignLeads(this.configuredCampaignId(), offset, 100);
  }

  replies(profileUrl: string, offset = 0) {
    return this.client.getConversations(profileUrl, offset, 100);
  }

  chatroom(accountId: number, conversationId: string | number) {
    return this.client.getChatroom(accountId, conversationId);
  }

  stopLead(profileUrl: string) {
    return this.client.stopLeadInCampaign(this.configuredCampaignId(), profileUrl);
  }

  exclude(profileUrl: string) {
    return this.client.addToBlacklist([{ profileUrl }]);
  }
}
