import { getConfig } from '../config.js';
import { HttpClient, type FetchLike } from './http.js';

export interface MaxIcp {
  id: number;
  name?: string;
  target_job_titles: string[];
  target_locations: string[];
  target_industries: string[];
  company_types: string[];
  company_sizes: string[];
  mandatory_keywords: string[];
  excluded_companies: string[];
}

export interface MaxBusiness {
  id: number;
  name: string;
  website: string;
  description: string | null;
  ideal_customer_profile?: MaxIcp;
}

export interface MaxSignal {
  id: number;
  name: string;
  slug: string;
  description: string;
  active: boolean;
  default_config?: { input_schema?: unknown } & Record<string, unknown>;
}

export interface MaxSubscription {
  id: number;
  name: string;
  signal: { name: string; slug: string };
  config: Record<string, unknown>;
  active: boolean;
  last_checked_at: string | null;
  stats?: Record<string, unknown>;
}

export interface MaxLead {
  id: number;
  external_id: string | null;
  name: string | null;
  headline: string | null;
  job_title: string | null;
  email: string | null;
  phone: string | null;
  linkedin_url: string | null;
  location: string | null;
  company: string | null;
  company_industry: string | null;
  company_size: string | null;
  company_website: string | null;
  company_linkedin: string | null;
  icp_score: number | null;
  icp_name?: string | null;
  engagement_type: string | null;
  post_url: string | null;
  signals: { name: string; slug: string }[];
  subscription_ids: number[];
  payload: Record<string, any> | null;
  triggered_at: string | null;
  created_at: string;
}

export interface Page<T> {
  items: T[];
  meta: { current_page: number; total_pages: number; total_count: number; per_page: number };
}

export class MaxClient {
  readonly http: HttpClient;

  constructor(opts: { apiKey?: string; baseUrl?: string; fetchImpl?: FetchLike } = {}) {
    const cfg = getConfig();
    const apiKey = opts.apiKey ?? cfg.MAX_API_KEY;
    if (!apiKey) throw new Error('Max adapter is not configured — set MAX_API_KEY or use another SourceAdapter');
    this.http = new HttpClient({
      service: 'Max',
      baseUrl: opts.baseUrl ?? cfg.MAX_API_URL,
      headers: { Authorization: `Bearer ${apiKey}` },
      perMinute: 55,
      fetchImpl: opts.fetchImpl,
    });
  }

  async listSignals(): Promise<MaxSignal[]> {
    return (await this.http.get<{ signals: MaxSignal[] }>('/signals')).signals;
  }

  async listBusinesses(): Promise<MaxBusiness[]> {
    return (await this.http.get<{ businesses: MaxBusiness[] }>('/businesses')).businesses;
  }

  async getBusiness(id: number): Promise<MaxBusiness> {
    return (await this.http.get<{ business: MaxBusiness }>(`/businesses/${id}`)).business;
  }

  async createBusiness(data: { website: string; name?: string; description?: string }): Promise<MaxBusiness> {
    const r = await this.http.post<{ business: MaxBusiness }>('/businesses', data);
    return r.business;
  }

  async updateIcp(businessId: number, icp: Partial<MaxIcp> & { id: number }): Promise<MaxBusiness> {
    const r = await this.http.patch<{ business: MaxBusiness }>(`/businesses/${businessId}`, {
      ideal_customer_profile_attributes: icp,
    });
    return r.business;
  }

  async listSubscriptions(businessId: number): Promise<MaxSubscription[]> {
    const out: MaxSubscription[] = [];
    for (let page = 1; page < 50; page++) {
      const r = await this.http.get<{ subscriptions: MaxSubscription[]; meta?: Page<unknown>['meta'] }>(
        `/businesses/${businessId}/subscriptions`,
        { page, per_page: 100 },
      );
      out.push(...r.subscriptions);
      if (!r.meta || page >= r.meta.total_pages || r.subscriptions.length === 0) break;
    }
    return out;
  }

  async getSubscription(businessId: number, id: number): Promise<MaxSubscription> {
    const r = await this.http.get<any>(`/businesses/${businessId}/subscriptions/${id}`);
    return r.subscription ?? r;
  }

  async createSubscription(
    businessId: number,
    data: { signal_slug: string; name: string; config?: Record<string, unknown> },
  ): Promise<MaxSubscription> {
    const r = await this.http.post<any>(`/businesses/${businessId}/subscriptions`, data);
    return r.subscription ?? r;
  }

  async pauseSubscription(businessId: number, id: number) {
    return this.http.post(`/businesses/${businessId}/subscriptions/${id}/pause`);
  }

  async resumeSubscription(businessId: number, id: number) {
    return this.http.post(`/businesses/${businessId}/subscriptions/${id}/resume`);
  }

  async listLeadsPage(businessId: number, page = 1, perPage = 100): Promise<Page<MaxLead>> {
    const r = await this.http.get<{ leads: MaxLead[]; meta: Page<MaxLead>['meta'] }>(`/businesses/${businessId}/leads`, {
      page,
      per_page: perPage,
    });
    return { items: r.leads, meta: r.meta };
  }

  /**
   * Leads come back newest first. Walk pages until we reach leads we have already
   * seen (by id) or `maxPages` is exhausted.
   */
  async listNewLeads(businessId: number, isKnown: (id: number) => boolean, maxPages = 10): Promise<MaxLead[]> {
    const fresh: MaxLead[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const { items, meta } = await this.listLeadsPage(businessId, page, 100);
      let hitKnown = false;
      for (const lead of items) {
        if (isKnown(lead.id)) hitKnown = true;
        else fresh.push(lead);
      }
      if (hitKnown || page >= meta.total_pages || items.length === 0) break;
    }
    return fresh;
  }
}
