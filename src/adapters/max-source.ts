import { MaxClient, type MaxLead } from '../clients/max.js';
import type {
  CandidateQuery,
  ManagedSourceAdapter,
  SourceCandidate,
  SourceMetadata,
} from './source.js';

function toCandidate(lead: MaxLead): SourceCandidate {
  return {
    id: lead.id,
    external_id: lead.external_id,
    name: lead.name,
    headline: lead.headline,
    job_title: lead.job_title,
    email: lead.email,
    phone: lead.phone,
    linkedin_url: lead.linkedin_url,
    location: lead.location,
    company: lead.company,
    company_industry: lead.company_industry,
    company_size: lead.company_size,
    company_website: lead.company_website,
    company_linkedin: lead.company_linkedin,
    icp_score: lead.icp_score,
    engagement_type: lead.engagement_type,
    post_url: lead.post_url,
    signals: lead.signals,
    payload: lead.payload,
    triggered_at: lead.triggered_at,
    created_at: lead.created_at,
  };
}

export class MaxSourceAdapter implements ManagedSourceAdapter {
  constructor(private readonly client = new MaxClient()) {}

  static fromApiKey(apiKey: string): MaxSourceAdapter {
    return new MaxSourceAdapter(new MaxClient({ apiKey }));
  }

  async listCandidates(query: CandidateQuery): Promise<SourceCandidate[]> {
    const leads = await this.client.listNewLeads(
      query.scopeId,
      (id) => query.knownIds.has(id),
      query.maxPages,
    );
    return leads.map(toCandidate);
  }

  async getCandidate(scopeId: number, candidateId: number): Promise<SourceCandidate | null> {
    for (let page = 1; page <= 50; page++) {
      const result = await this.client.listLeadsPage(scopeId, page, 100);
      const hit = result.items.find((lead) => lead.id === candidateId);
      if (hit) return toCandidate(hit);
      if (page >= result.meta.total_pages || result.items.length === 0) break;
    }
    return null;
  }

  refreshCandidate(scopeId: number, candidateId: number): Promise<SourceCandidate | null> {
    return this.getCandidate(scopeId, candidateId);
  }

  getSourceMetadata(): SourceMetadata {
    return { provider: 'max', kind: 'api', capabilities: ['list', 'get', 'refresh'] };
  }

  listSignals() {
    return this.client.listSignals();
  }
  listBusinesses() {
    return this.client.listBusinesses();
  }
  getBusiness(id: number) {
    return this.client.getBusiness(id);
  }
  createBusiness(data: { website: string; name?: string; description?: string }) {
    return this.client.createBusiness(data);
  }
  updateIcp(scopeId: number, icp: Record<string, unknown> & { id: number }) {
    return this.client.updateIcp(scopeId, icp);
  }
  listSubscriptions(scopeId: number) {
    return this.client.listSubscriptions(scopeId);
  }
  createSubscription(scopeId: number, data: { signal_slug: string; name: string; config?: Record<string, unknown> }) {
    return this.client.createSubscription(scopeId, data);
  }
  pauseSubscription(scopeId: number, id: number) {
    return this.client.pauseSubscription(scopeId, id);
  }
  resumeSubscription(scopeId: number, id: number) {
    return this.client.resumeSubscription(scopeId, id);
  }
}
