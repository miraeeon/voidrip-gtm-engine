import { getConfig } from '../config.js';
import { HeyReachClient, type HeyReachCampaign, type HeyReachLead } from '../clients/heyreach.js';

export interface HeyReachCampaignInspection {
  provider: 'heyreach';
  campaign: HeyReachCampaign;
  leadCount: number;
  inert: boolean;
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

  exclude(profileUrl: string) {
    return this.client.addToBlacklist([{ profileUrl }]);
  }
}
