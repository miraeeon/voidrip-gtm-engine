import { getConfig } from '../config.js';
import { OutboundSafetyGuard, type AuditSink, type GuardContext, type OutboundAction } from '../safety/guard.js';
import { HttpClient, type FetchLike } from './http.js';

export interface HeyReachLead {
  firstName?: string | null;
  lastName?: string | null;
  location?: string | null;
  summary?: string | null;
  companyName?: string | null;
  position?: string | null;
  about?: string | null;
  emailAddress?: string | null;
  profileUrl: string;
  customUserFields?: { name: string; value: string }[];
}

export interface HeyReachCampaign {
  id: number;
  name: string;
  status: string;
  linkedInUserListId: number;
  campaignAccountIds: number[];
  progressStats?: {
    totalUsers?: number;
    totalUsersInProgress?: number;
    totalUsersPending?: number;
    totalUsersFinished?: number;
    totalUsersFailed?: number;
    totalUsersManuallyStopped?: number;
    totalUsersExcluded?: number;
  };
}

export interface HeyReachList {
  id: number;
  name: string;
  totalItemsCount?: number;
  count?: number;
  listType: string;
  campaignIds?: number[];
}

export interface HeyReachAccount {
  id: number;
  firstName?: string | null;
  lastName?: string | null;
  emailAddress?: string | null;
  isActive?: boolean;
  authIsValid?: boolean;
  activeCampaigns?: number;
  status?: string | null;
}

export interface HeyReachImportResult {
  addedLeadsCount?: number;
  updatedLeadsCount?: number;
  failedLeadsCount?: number;
  added?: number;
  updated?: number;
  failed?: number;
  [key: string]: unknown;
}

export interface Page<T> {
  totalCount: number;
  items: T[];
}

/** Official HeyReach public API client. Every write is classified before network I/O. */
export class HeyReachClient {
  readonly http: HttpClient;
  readonly guard: OutboundSafetyGuard;

  constructor(opts: {
    apiKey?: string;
    baseUrl?: string;
    perMinute?: number;
    fetchImpl?: FetchLike;
    audit?: AuditSink;
    guard?: OutboundSafetyGuard;
  } = {}) {
    const cfg = getConfig();
    const apiKey = opts.apiKey ?? cfg.HEYREACH_API_KEY;
    if (!apiKey) throw new Error('HeyReach adapter is not configured — set HEYREACH_API_KEY');
    this.http = new HttpClient({
      service: 'HeyReach',
      baseUrl: opts.baseUrl ?? cfg.HEYREACH_API_URL,
      headers: { 'X-API-KEY': apiKey },
      perMinute: opts.perMinute ?? cfg.HEYREACH_REQUESTS_PER_MINUTE,
      fetchImpl: opts.fetchImpl,
    });
    this.guard = opts.guard ?? new OutboundSafetyGuard(cfg.SEND_MODE, opts.audit);
  }

  private write<T>(action: OutboundAction, operation: string, path: string, body?: unknown, ctx: GuardContext = {}): Promise<T> {
    this.guard.check(action, {
      adapter: 'heyreach',
      operation,
      target: path,
      allowImport: ctx.allowImport,
      allowSend: ctx.allowSend,
      reason: action === 'SEND_CAPABLE' ? `${operation} can start or resume LinkedIn outreach` : undefined,
      summary: body === undefined ? undefined : JSON.stringify(body).slice(0, 400),
    });
    return this.http.request<T>('POST', path, body);
  }

  checkApiKey() {
    return this.http.get<void>('/auth/CheckApiKey');
  }

  listCampaigns(offset = 0, limit = 100, keyword?: string) {
    return this.http.post<Page<HeyReachCampaign>>('/campaign/GetAll', { offset, limit, keyword });
  }

  getCampaign(campaignId: number) {
    return this.http.get<HeyReachCampaign>(`/campaign/GetById?campaignId=${campaignId}`);
  }

  listLinkedInAccounts(offset = 0, limit = 100) {
    return this.http.post<Page<HeyReachAccount>>('/li_account/GetAll', { offset, limit });
  }

  listLeadLists(offset = 0, limit = 100, keyword?: string) {
    return this.http.post<Page<HeyReachList>>(
      '/list/GetAll',
      { offset, limit, keyword, listType: 'USER_LIST' },
    );
  }

  getLeadList(listId: number) {
    return this.http.get<HeyReachList>(`/list/GetById?listId=${listId}`);
  }

  getCampaignSequence(campaignId: number) {
    return this.http.get<Record<string, unknown>>(`/campaign/GetCampaignSequence?campaignId=${campaignId}`);
  }

  getLeadsFromList(listId: number, offset = 0, limit = 100) {
    return this.http.post<Page<Record<string, unknown>>>('/list/GetLeadsFromList', { listId, offset, limit });
  }

  addLeadsToList(listId: number, leads: HeyReachLead[], ctx: GuardContext = {}) {
    return this.write<HeyReachImportResult>(
      'IMPORT_CAPABLE',
      'add_leads_to_list',
      '/list/AddLeadsToListV2',
      { listId, leads },
      ctx,
    );
  }

  addLeadsToCampaign(campaignId: number, accountLeadPairs: { linkedInAccountId: number; lead: HeyReachLead }[], ctx: GuardContext = {}) {
    return this.write(
      'SEND_CAPABLE',
      'add_leads_to_campaign',
      '/campaign/AddLeadsToCampaignV2',
      { campaignId, accountLeadPairs, resumeFinishedCampaign: false, resumePausedCampaign: false },
      ctx,
    );
  }

  startCampaign(campaignId: number, ctx: GuardContext = {}) {
    return this.write<void>('SEND_CAPABLE', 'start_campaign', `/campaign/StartCampaign?campaignId=${campaignId}`, undefined, ctx);
  }

  pauseCampaign(campaignId: number) {
    return this.write<void>('SAFE_WRITE', 'pause_campaign', `/campaign/Pause?campaignId=${campaignId}`);
  }

  getCampaignLeads(campaignId: number, offset = 0, limit = 100) {
    return this.http.post<Page<Record<string, unknown>>>('/campaign/GetLeadsFromCampaign', { campaignId, offset, limit, timeFilter: 'Everywhere' });
  }

  getConversations(profileUrl: string, offset = 0, limit = 100) {
    return this.http.post<Page<Record<string, unknown>>>('/inbox/GetConversationsV2', {
      filters: { linkedInAccountIds: [], campaignIds: [], leadProfileUrl: profileUrl },
      offset,
      limit,
    });
  }

  getChatroom(accountId: number, conversationId: string | number) {
    return this.http.get<Record<string, unknown>>(`/inbox/GetChatroom/${accountId}/${conversationId}`);
  }

  stopLeadInCampaign(campaignId: number, profileUrl: string) {
    return this.write<Record<string, unknown>>(
      'SAFE_WRITE',
      'stop_lead_in_campaign',
      '/campaign/StopLeadInCampaign',
      { campaignId, leadUrl: profileUrl },
    );
  }

  getCampaignStats(campaignId: number, startDate: string, endDate: string) {
    return this.http.post<Record<string, unknown>>('/stats/GetOverallStatsByCampaign', {
      accountIds: [], campaignIds: [campaignId], startDate, endDate,
    });
  }

  addToBlacklist(leads: ({ profileUrl: string } | { email: string } | { fullName: string })[]) {
    return this.write<Record<string, unknown>>('SAFE_WRITE', 'add_to_blacklist', '/blacklist/AddLeads', { leads });
  }
}
