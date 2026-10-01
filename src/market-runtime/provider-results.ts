import { normalizeLinkedinUrl } from '../identity/linkedin.js';

export type MarketEventType =
  | 'CONNECTION_SENT'
  | 'CONNECTION_ACCEPTED'
  | 'MESSAGE_SENT'
  | 'REPLY_RECEIVED'
  | 'POSITIVE_REPLY'
  | 'NEGATIVE_REPLY'
  | 'PROVIDER_FAILED'
  | 'PROVIDER_FINISHED';

export interface ProviderResultEvent {
  profileUrl: string;
  type: MarketEventType;
  at: string;
  key: string;
  raw: Record<string, unknown>;
}

function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function nested(record: Record<string, unknown>, key: string): unknown {
  const lead = record.lead;
  return record[key] ?? (lead && typeof lead === 'object' ? (lead as Record<string, unknown>)[key] : undefined);
}

export function resultProfileUrl(record: Record<string, unknown>): string {
  return text(nested(record, 'profileUrl')) || text(nested(record, 'linkedinUrl')) || text(nested(record, 'linkedInUrl')) || text(nested(record, 'leadUrl'));
}

function autoTag(record: Record<string, unknown>): string {
  const raw = record.autoTag ?? record.autoTagName ?? record.leadAutoTag ?? record.intent;
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') return text((raw as Record<string, unknown>).name) || text((raw as Record<string, unknown>).value);
  return '';
}

function eventTime(record: Record<string, unknown>): string {
  return text(record.lastActionTime) || text(record.updatedAt) || text(record.lastReplyDate) || text(record.creationTime) || new Date().toISOString();
}

export function mapHeyReachLeadResult(campaignId: number, record: Record<string, unknown>): ProviderResultEvent[] {
  const profileUrl = resultProfileUrl(record);
  if (!profileUrl) return [];
  const at = eventTime(record);
  const connection = text(record.leadConnectionStatus ?? record.connectionStatus).toLowerCase();
  const status = [record.senderStatus, record.lastAction, record.status, record.state].map(text).join(' ').toLowerCase();
  const tag = autoTag(record).toLowerCase();
  const types = new Set<MarketEventType>();
  if (connection.includes('connectionsent') || connection.includes('connection_sent')) types.add('CONNECTION_SENT');
  if (connection.includes('connectionaccepted') || connection.includes('connection_accepted')) types.add('CONNECTION_ACCEPTED');
  if (status.includes('message_sent') || status.includes('message sent')) types.add('MESSAGE_SENT');
  if (status.includes('message_replied') || status.includes('replied') || Number(record.replyCount ?? 0) > 0) types.add('REPLY_RECEIVED');
  if (tag.includes('interested') || tag.includes('positive')) types.add('POSITIVE_REPLY');
  if (tag.includes('not interested') || tag.includes('negative')) types.add('NEGATIVE_REPLY');
  if (status.includes('failed')) types.add('PROVIDER_FAILED');
  if (status.includes('finished')) types.add('PROVIDER_FINISHED');
  const normalized = normalizeLinkedinUrl(profileUrl);
  const signature = [connection, status, tag].join('|');
  return [...types].map((type) => ({
    profileUrl,
    type,
    at,
    key: `heyreach:${campaignId}:${normalized}:${type}:${signature}`,
    raw: record,
  }));
}

export interface ProviderReplyCandidate {
  conversationId: string;
  accountId: number | null;
  profileUrl: string;
  receivedAt: string;
  text: string | null;
  fromLead: boolean;
}

export function mapHeyReachConversation(record: Record<string, unknown>): ProviderReplyCandidate | null {
  const profileUrl = resultProfileUrl(record) || text(record.leadProfileUrl);
  const conversationId = text(record.id ?? record.conversationId ?? record.chatroomId);
  if (!profileUrl || !conversationId) return null;
  const sender = text(record.lastMessageFrom ?? record.lastMessageSender ?? record.lastSender).toLowerCase();
  const fromLead = sender === 'lead' || sender === 'recipient' || sender.includes('prospect') || record.isLastMessageFromLead === true;
  return {
    conversationId,
    accountId: Number(record.linkedInAccountId ?? record.accountId) || null,
    profileUrl,
    receivedAt: text(record.lastMessageAt ?? record.updatedAt ?? record.lastActivityAt) || new Date().toISOString(),
    text: text(record.lastMessage ?? record.lastMessageText ?? record.message) || null,
    fromLead,
  };
}

export function latestInboundChatMessage(chatroom: Record<string, unknown>): { id: string; text: string; at: string } | null {
  const messages = Array.isArray(chatroom.messages) ? chatroom.messages : Array.isArray(chatroom.items) ? chatroom.items : [];
  const inbound = messages.filter((item) => {
    if (!item || typeof item !== 'object') return false;
    const message = item as Record<string, unknown>;
    const sender = text(message.sender ?? message.senderType ?? message.from).toLowerCase();
    return message.isFromLead === true || sender === 'lead' || sender === 'recipient' || sender.includes('prospect');
  });
  const last = inbound.at(-1) as Record<string, unknown> | undefined;
  if (!last) return null;
  const body = text(last.text ?? last.message ?? last.body);
  if (!body) return null;
  return {
    id: text(last.id ?? last.messageId) || `${text(last.createdAt ?? last.sentAt)}:${body.slice(0, 40)}`,
    text: body,
    at: text(last.createdAt ?? last.sentAt ?? last.timestamp) || new Date().toISOString(),
  };
}
