import { ApiError } from '../clients/http.js';
import { OverloopClient, type OvlProspect } from '../clients/overloop.js';
import type {
  CampaignDraft,
  ExecutionAccount,
  ExecutionAdapter,
  ExecutionCampaign,
  ExecutionProspect,
  ExecutionStep,
  ProspectDraft,
  ProspectIdentity,
} from './execution.js';

const DAY_NAMES: Record<string, string> = {
  MON: 'monday', TUE: 'tuesday', WED: 'wednesday', THU: 'thursday',
  FRI: 'friday', SAT: 'saturday', SUN: 'sunday',
};

export function textToHtml(body: string): string {
  const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return body
    .trim()
    .split(/\n\s*\n/)
    .map((paragraph) => `<p>${esc(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

export function toOverloopSteps(steps: ExecutionStep[]): { type: string; config: Record<string, unknown> }[] {
  const out: { type: string; config: Record<string, unknown> }[] = [];
  for (const step of steps) {
    if (step.delay_days > 0) out.push({ type: 'delay', config: { days_delay: step.delay_days } });
    if (step.type === 'email') {
      out.push({ type: 'email', config: { generate_with_ai: false, subject: step.subject, content: textToHtml(step.body) } });
    } else if (step.type === 'linkedin_visit') {
      out.push({ type: 'linkedin_visit_profile', config: {} });
    } else if (step.type === 'linkedin_invite') {
      out.push({ type: 'linkedin_send_invitation', config: { generate_with_ai: false, message: step.note } });
    } else {
      out.push({ type: 'linkedin_send_message', config: { generate_with_ai: false, message: step.message } });
    }
  }
  return out;
}

const INERT_CAMPAIGN = {
  status: 'off',
  only_allow_manual_enrollment: true,
  automatically_send_messages: false,
  automatically_send_follow_ups: false,
  automatically_reenroll: false,
} as const;

function toProspect(prospect: OvlProspect): ExecutionProspect {
  return {
    id: prospect.id,
    email_status: prospect.email_status ?? null,
    bounced: !!prospect.bounced,
    replied: !!prospect.replied,
    replied_at: prospect.replied_at ?? null,
    email_reply_count: prospect.email_reply_count ?? 0,
    linkedin_reply_count: prospect.linkedin_reply_count ?? 0,
    opened: !!prospect.opened,
    opened_at: prospect.opened_at ?? null,
    clicked: !!prospect.clicked,
    clicked_at: typeof prospect.clicked_at === 'string' ? prospect.clicked_at : null,
    excluded: !!prospect.excluded,
    last_emailed_at: prospect.last_emailed_at ?? null,
  };
}

export class OverloopExecutionAdapter implements ExecutionAdapter {
  constructor(private readonly client = new OverloopClient()) {}

  static fromApiKey(apiKey: string): OverloopExecutionAdapter {
    return new OverloopExecutionAdapter(new OverloopClient({ apiKey }));
  }

  async findProspect(identity: ProspectIdentity): Promise<ExecutionProspect | null> {
    let prospect = identity.email ? await this.client.findProspectByEmail(identity.email) : null;
    if (!prospect && identity.linkedinUrl) prospect = await this.client.findProspectByLinkedin(identity.linkedinUrl);
    return prospect ? toProspect(prospect) : null;
  }

  async createProspect(draft: ProspectDraft): Promise<ExecutionProspect> {
    const attrs: Record<string, unknown> = {
      first_name: draft.firstName ?? undefined,
      last_name: draft.lastName ?? undefined,
      jobtitle: draft.jobTitle ?? undefined,
      linkedin_profile: draft.linkedinUrl ?? undefined,
      description: `Sourced by GTM engine from ${draft.sourceSummary}.`,
    };
    if (draft.email) attrs.email = draft.email;
    return toProspect(await this.client.createProspect(attrs));
  }

  async getProspect(id: number): Promise<ExecutionProspect> {
    return toProspect(await this.client.getProspect(id));
  }

  async pushDraft(draft: CampaignDraft): Promise<ExecutionCampaign> {
    const body: Record<string, unknown> = {
      name: draft.name,
      timezone: draft.timezone,
      sending_days: draft.sendingDays.map((day) => DAY_NAMES[day] ?? day.toLowerCase()),
      start_sending_minutes: draft.startSendingMinutes,
      end_sending_minutes: draft.endSendingMinutes,
      ...INERT_CAMPAIGN,
      steps: toOverloopSteps(draft.steps),
    };
    if (draft.senderId) body.sender_id = draft.senderId;
    try {
      return await this.client.createCampaign(body);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 422)) throw error;
      const { automatically_send_messages, automatically_send_follow_ups, automatically_reenroll, ...minimal } = body;
      void automatically_send_messages, automatically_send_follow_ups, automatically_reenroll;
      return this.client.createCampaign(minimal);
    }
  }

  async verifyDraft(campaignId: number) {
    const campaign = await this.client.getCampaign(campaignId);
    const response = await this.client.listEnrollments(campaignId);
    const enrollments = response.pagination?.total ?? response.data.length;
    return {
      campaign: { id: campaign.id, name: campaign.name, status: campaign.status },
      enrollments,
      inert: (campaign.status === 'off' || campaign.status === 'draft') && enrollments === 0,
    };
  }

  async enroll(campaignId: number, prospectId: number, allowSend: boolean): Promise<void> {
    await this.client.createEnrollment(campaignId, prospectId, { allowSend });
  }

  async activate(campaignId: number, prospectId: number, allowSend: boolean): Promise<void> {
    await this.client.createEnrollment(campaignId, prospectId, { allowSend });
    await this.client.updateCampaign(campaignId, { status: 'on' }, { allowSend });
  }

  pause(campaignId: number, prospectId: number) {
    return this.client.stopEnrollmentsFor(campaignId, prospectId);
  }

  async exclude(email: string): Promise<void> {
    await this.client.addToExclusionList(email, 'email');
  }

  assignReplyOwner(prospectId: number, campaignId?: number | null) {
    return this.client.assignConversationForProspect(prospectId, campaignId);
  }

  async deleteDraft(campaignId: number): Promise<void> {
    await this.client.deleteCampaign(campaignId).catch((error) => {
      if (!(error instanceof ApiError && error.status === 404)) throw error;
    });
  }

  async deleteProspect(prospectId: number): Promise<void> {
    await this.client.deleteProspect(prospectId).catch((error) => {
      if (!(error instanceof ApiError && error.status === 404)) throw error;
    });
  }

  async getAccount(): Promise<ExecutionAccount> {
    const [user, senders] = await Promise.all([this.client.me(), this.client.listSendingAddresses()]);
    return {
      user,
      sendingIdentities: senders.data.map((sender) => ({ id: sender.id, email: sender.email, working: sender.working })),
    };
  }
}
