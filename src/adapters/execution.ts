export type ExecutionStep =
  | { type: 'email'; delay_days: number; subject: string; body: string }
  | { type: 'linkedin_visit'; delay_days: number }
  | { type: 'linkedin_invite'; delay_days: number; note: string }
  | { type: 'linkedin_message'; delay_days: number; message: string };

export interface ExecutionProspect {
  id: number;
  email_status?: string | null;
  bounced: boolean;
  replied: boolean;
  replied_at: string | null;
  email_reply_count: number;
  linkedin_reply_count: number;
  opened: boolean;
  opened_at: string | null;
  clicked: boolean;
  clicked_at?: string | null;
  excluded: boolean;
  last_emailed_at: string | null;
}

export interface ProspectIdentity {
  email?: string | null;
  linkedinUrl?: string | null;
}

export interface ProspectDraft extends ProspectIdentity {
  firstName?: string | null;
  lastName?: string | null;
  jobTitle?: string | null;
  sourceSummary: string;
}

export interface CampaignDraft {
  name: string;
  timezone: string;
  sendingDays: string[];
  startSendingMinutes: number;
  endSendingMinutes: number;
  senderId?: number;
  steps: ExecutionStep[];
}

export interface ExecutionCampaign {
  id: number;
  name: string;
  status: string;
}

export interface DraftVerification {
  campaign: ExecutionCampaign;
  enrollments: number;
  inert: boolean;
}

export interface ExecutionAccount {
  user: { id: number; name: string; email: string };
  sendingIdentities: { id: number; email: string; working: boolean }[];
}

/** Stable core port. Every provider write remains guarded inside its implementation. */
export interface ExecutionAdapter {
  findProspect(identity: ProspectIdentity): Promise<ExecutionProspect | null>;
  createProspect(draft: ProspectDraft): Promise<ExecutionProspect>;
  getProspect(id: number): Promise<ExecutionProspect>;
  pushDraft(draft: CampaignDraft): Promise<ExecutionCampaign>;
  verifyDraft(campaignId: number): Promise<DraftVerification>;
  enroll(campaignId: number, prospectId: number, allowSend: boolean): Promise<void>;
  activate(campaignId: number, prospectId: number, allowSend: boolean): Promise<void>;
  pause(campaignId: number, prospectId: number): Promise<number>;
  exclude(email: string): Promise<void>;
  assignReplyOwner(prospectId: number, campaignId?: number | null): Promise<{ conversation_id: number; owner_id: number } | null>;
  deleteDraft(campaignId: number): Promise<void>;
  deleteProspect(prospectId: number): Promise<void>;
  getAccount(): Promise<ExecutionAccount>;
}
