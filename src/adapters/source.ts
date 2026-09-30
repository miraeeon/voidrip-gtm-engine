export interface SourceCandidate {
  /** Numeric legacy ingestion id. The persistent Candidate model replaces this in the next data phase. */
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
  engagement_type: string | null;
  post_url: string | null;
  signals: { name: string; slug: string }[];
  payload: Record<string, unknown> | null;
  triggered_at: string | null;
  created_at: string;
}

export interface SourceMetadata {
  provider: string;
  kind: 'api' | 'file' | 'database' | 'manual';
  capabilities: readonly ('list' | 'get' | 'refresh')[];
}

export interface CandidateQuery {
  scopeId: number;
  knownIds: ReadonlySet<number>;
  maxPages: number;
}

/** Stable core port. Provider implementations return normalized candidates only. */
export interface SourceAdapter {
  listCandidates(query: CandidateQuery): Promise<SourceCandidate[]>;
  getCandidate(scopeId: number, candidateId: number): Promise<SourceCandidate | null>;
  refreshCandidate(scopeId: number, candidateId: number): Promise<SourceCandidate | null>;
  getSourceMetadata(): SourceMetadata;
}

export interface SourceBusiness {
  id: number;
  name: string;
  website: string;
  description: string | null;
  ideal_customer_profile?: unknown;
}

export interface SourceSignal {
  id: number;
  name: string;
  slug: string;
  description: string;
  active: boolean;
  default_config?: { input_schema?: unknown } & Record<string, unknown>;
}

export interface SourceSubscription {
  id: number;
  name: string;
  signal: { name: string; slug: string };
  config: Record<string, unknown>;
  active: boolean;
  last_checked_at: string | null;
}

/** Optional management surface used only by legacy provider setup tools. */
export interface ManagedSourceAdapter extends SourceAdapter {
  listSignals(): Promise<SourceSignal[]>;
  listBusinesses(): Promise<SourceBusiness[]>;
  getBusiness(id: number): Promise<SourceBusiness>;
  createBusiness(data: { website: string; name?: string; description?: string }): Promise<SourceBusiness>;
  updateIcp(scopeId: number, icp: Record<string, unknown> & { id: number }): Promise<SourceBusiness>;
  listSubscriptions(scopeId: number): Promise<SourceSubscription[]>;
  createSubscription(
    scopeId: number,
    data: { signal_slug: string; name: string; config?: Record<string, unknown> },
  ): Promise<SourceSubscription>;
  pauseSubscription(scopeId: number, id: number): Promise<unknown>;
  resumeSubscription(scopeId: number, id: number): Promise<unknown>;
}
