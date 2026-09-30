import { getConfig } from '../config.js';
import { normalizeLinkedinUrl } from '../identity/linkedin.js';
import { SendGuard, type AuditSink, type GuardContext } from '../safety/guard.js';
import { HttpClient, type FetchLike } from './http.js';

export interface OvlProspect {
  id: number;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  jobtitle: string | null;
  linkedin_profile: string | null;
  organisation_name?: string | null;
  email_status?: string | null;
  opened: boolean;
  opened_at: string | null;
  open_count: number;
  clicked: boolean;
  click_count: number;
  replied: boolean;
  replied_at: string | null;
  email_reply_count: number;
  linkedin_reply_count: number;
  bounced: boolean;
  excluded: boolean;
  last_emailed_at: string | null;
  url?: string;
  [k: string]: unknown;
}

export interface OvlCampaign {
  id: number;
  name: string;
  status: string;
  only_allow_manual_enrollment: boolean;
  automatically_send_messages: boolean;
  automatically_send_follow_ups: boolean;
  [k: string]: unknown;
}

export interface OvlStepInput {
  type: 'email' | 'delay' | 'linkedin_visit_profile' | 'linkedin_send_invitation' | 'linkedin_send_message' | 'linkedin_check_connection';
  config?: Record<string, unknown>;
  previous_step_id?: string;
  position?: number;
}

export interface OvlStep {
  id: string;
  type: string;
  position: number;
  previous_step_id: string | null;
  config: Record<string, unknown>;
}

interface ListResp<T> {
  data: T[];
  pagination: { page: number; per_page: number; total: number; total_pages: number };
}

/**
 * Overloop v2 client. Every write goes through SendGuard first — there is no
 * code path that reaches the network for a mutating request without a check.
 */
export class OverloopClient {
  readonly http: HttpClient;
  readonly guard: SendGuard;

  constructor(opts: { apiKey?: string; baseUrl?: string; fetchImpl?: FetchLike; audit?: AuditSink; guard?: SendGuard } = {}) {
    const cfg = getConfig();
    const apiKey = opts.apiKey ?? cfg.OVERLOOP_API_KEY;
    if (!apiKey) throw new Error('Overloop adapter is not configured — set OVERLOOP_API_KEY or use another ExecutionAdapter');
    this.http = new HttpClient({
      service: 'Overloop',
      baseUrl: opts.baseUrl ?? cfg.OVERLOOP_API_URL,
      headers: { Authorization: apiKey },
      perMinute: 500,
      fetchImpl: opts.fetchImpl,
    });
    this.guard = opts.guard ?? new SendGuard(cfg.SEND_MODE, opts.audit);
  }

  private write<T>(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown, ctx?: GuardContext): Promise<T> {
    this.guard.check(method, path, body, ctx);
    return this.http.request<T>(method, path, body);
  }

  // --- read ---
  me() {
    return this.http.get<{ id: number; name: string; email: string }>('/me');
  }
  account() {
    return this.http.get('/account');
  }
  listSendingAddresses() {
    return this.http.get<ListResp<{ id: number; email: string; from_name: string; working: boolean; user_id: number }>>('/sending_addresses');
  }
  listCampaigns(query: Record<string, unknown> = {}) {
    return this.http.get<ListResp<OvlCampaign>>('/campaigns', query);
  }
  async getCampaign(id: number | string, expand?: string): Promise<OvlCampaign> {
    const r = await this.http.get<any>(`/campaigns/${id}`, expand ? { expand } : undefined);
    return r.data ?? r;
  }
  getCampaignStats(id: number | string) {
    return this.http.get<{ data: Record<string, any> }>(`/campaigns/${id}/stats`);
  }
  async listSteps(campaignId: number | string): Promise<OvlStep[]> {
    return (await this.http.get<ListResp<OvlStep>>(`/campaigns/${campaignId}/steps`, { per_page: 100 })).data;
  }
  listEnrollments(campaignId: number | string) {
    return this.http.get<ListResp<Record<string, unknown>>>(`/campaigns/${campaignId}/enrollments`, { per_page: 100 });
  }
  listStepTypes() {
    return this.http.get('/campaigns/step_types');
  }
  listMergeTags() {
    return this.http.get<{ data: { tag: string; group: string; example: string }[] }>('/merge_tags');
  }
  listCustomFields(type = 'prospects') {
    return this.http.get<{ data: { identifier: string; name: string; value_type: string }[] }>('/custom_fields', { type });
  }
  async getProspect(id: number | string): Promise<OvlProspect> {
    const r = await this.http.get<any>(`/prospects/${id}`);
    return r.data ?? r;
  }
  async findProspectByEmail(email: string): Promise<OvlProspect | null> {
    const r = await this.http.get<ListResp<OvlProspect>>('/prospects', { filter: { email }, per_page: 1 });
    return r.data[0] ?? null;
  }
  async findProspectByLinkedin(url: string): Promise<OvlProspect | null> {
    const r = await this.http.get<ListResp<OvlProspect>>('/prospects', { filter: { linkedin_profile: url }, per_page: 1 });
    const hit = r.data[0];
    // Guard against the API ignoring an unknown filter and returning an arbitrary prospect.
    return hit && normalizeLinkedinUrl(hit.linkedin_profile) === normalizeLinkedinUrl(url) ? hit : null;
  }
  listConversations(query: Record<string, unknown> = {}) {
    return this.http.get<ListResp<{ id: number; name: string; prospect_ids: number[]; last_activity_at: string; created_from: string }>>(
      '/conversations',
      query,
    );
  }
  getConversation(id: number | string) {
    return this.http.get<any>(`/conversations/${id}`);
  }
  listLists(search?: string) {
    return this.http.get<ListResp<{ id: number; name: string }>>('/lists', search ? { search } : undefined);
  }

  // --- guarded writes ---
  async createProspect(attrs: Record<string, unknown>): Promise<OvlProspect> {
    const r = await this.write<any>('POST', '/prospects', attrs);
    return r.data ?? r;
  }
  async updateProspect(id: number | string, attrs: Record<string, unknown>): Promise<OvlProspect> {
    const r = await this.write<any>('PATCH', `/prospects/${id}`, attrs);
    return r.data ?? r;
  }
  deleteProspect(id: number | string) {
    return this.write('DELETE', `/prospects/${id}`);
  }
  async createList(name: string): Promise<{ id: number; name: string }> {
    const r = await this.write<any>('POST', '/lists', { name });
    return r.data ?? r;
  }
  async createCampaign(body: Record<string, unknown>, ctx?: GuardContext): Promise<OvlCampaign> {
    const r = await this.write<any>('POST', '/campaigns', body, ctx);
    return r.data ?? r;
  }
  async updateCampaign(id: number | string, body: Record<string, unknown>, ctx?: GuardContext): Promise<OvlCampaign> {
    const r = await this.write<any>('PATCH', `/campaigns/${id}`, body, ctx);
    return r.data ?? r;
  }
  deleteCampaign(id: number | string) {
    return this.write('DELETE', `/campaigns/${id}`);
  }
  async createStep(campaignId: number | string, step: OvlStepInput): Promise<OvlStep> {
    const r = await this.write<any>('POST', `/campaigns/${campaignId}/steps`, step);
    return r.data ?? r;
  }
  createEnrollment(campaignId: number | string, prospectId: number, ctx?: GuardContext) {
    return this.write('POST', `/campaigns/${campaignId}/enrollments`, { prospect_id: prospectId }, ctx);
  }
  /** Removing enrollments only ever *stops* sending, so the guard allows it in every mode. */
  async stopEnrollmentsFor(campaignId: number | string, prospectId: number): Promise<number> {
    const r = await this.listEnrollments(campaignId);
    const mine = r.data.filter((e: any) => Number(e.prospect_id ?? e.prospect?.id) === Number(prospectId));
    for (const e of mine) await this.write('DELETE', `/campaigns/${campaignId}/enrollments/${(e as any).id}`);
    return mine.length;
  }
  addToExclusionList(value: string, itemType: 'email' | 'domain' = 'email') {
    return this.write('POST', '/exclusion_list', { value, item_type: itemType });
  }
  /**
   * The public API ignores conversation filters, so scan the most recently active
   * conversations for this prospect and assign it to the campaign owner (or the API user).
   */
  async assignConversationForProspect(prospectId: number, campaignId?: number | null, pages = 3) {
    for (let page = 1; page <= pages; page++) {
      const r = await this.listConversations({ sort: '-last_activity_at', per_page: 100, page });
      const conv = r.data.find((c) => c.prospect_ids?.includes(Number(prospectId)));
      if (conv) {
        let ownerId: number | undefined;
        if (campaignId) ownerId = Number((await this.getCampaign(campaignId).catch(() => null))?.user_id ?? 0) || undefined;
        ownerId ??= (await this.me()).id;
        await this.write('POST', `/conversations/${conv.id}/assign`, { owner_id: ownerId });
        return { conversation_id: conv.id, owner_id: ownerId };
      }
      if (page >= r.pagination.total_pages) break;
    }
    return null;
  }
}

export function normLinkedin(url: string | null | undefined): string {
  return normalizeLinkedinUrl(url);
}
