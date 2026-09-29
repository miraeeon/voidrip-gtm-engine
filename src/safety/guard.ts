/**
 * SendGuard — the hard, code-level safety layer in front of every Overloop write.
 *
 * In SEND_MODE=locked (the default) nothing the bot does can cause a message to be
 * sent to a real person. It blocks:
 *   - any enrollment endpoint (single or bulk)  -> enrolling is what starts sending
 *   - campaign status "on"                      -> activation
 *   - only_allow_manual_enrollment=false        -> auto-enroll from sourcing
 *   - automatically_send_messages / follow_ups / reenroll = true
 *   - sourcing_id / search_criteria on campaigns (auto-fills with prospects)
 *   - replying / sending on conversations
 *   - enroll_campaign steps (would move prospects into other, possibly live, campaigns)
 *
 * Even in live mode, campaign activation and enrollment still require the
 * explicit `allowSend` flag on the specific call.
 */

export type SendMode = 'locked' | 'live';

export class SafetyError extends Error {
  constructor(message: string) {
    super(`SafetyGuard blocked: ${message}`);
    this.name = 'SafetyError';
  }
}

export interface AuditEntry {
  at: string;
  service: string;
  method: string;
  path: string;
  allowed: boolean;
  reason?: string;
  summary?: string;
}

export type AuditSink = (e: AuditEntry) => void;

export interface GuardContext {
  allowSend?: boolean;
}

const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export class SendGuard {
  constructor(private readonly mode: SendMode, private readonly audit: AuditSink = () => {}) {}

  get sendMode(): SendMode {
    return this.mode;
  }

  /** Throws SafetyError if the request could send (or lead to sending) messages. */
  check(method: string, path: string, body: unknown, ctx: GuardContext = {}): void {
    const m = method.toUpperCase();
    if (!WRITE_METHODS.has(m)) return;
    const reason = this.violation(m, path, body);
    const sendCapable = reason !== null;
    const allowed = !sendCapable || (this.mode === 'live' && ctx.allowSend === true);
    this.audit({
      at: new Date().toISOString(),
      service: 'overloop',
      method: m,
      path,
      allowed,
      reason: reason ?? undefined,
      summary: summarize(body),
    });
    if (!allowed) {
      const why =
        this.mode === 'locked'
          ? `${reason} (SEND_MODE=locked)`
          : `${reason} (live mode requires explicit allowSend for this call)`;
      throw new SafetyError(why);
    }
  }

  /** Returns a description of the send-capable effect, or null if the write is inert. */
  violation(method: string, path: string, body: unknown): string | null {
    const p = path.split('?')[0]!.toLowerCase();
    if (method === 'DELETE') {
      // Deleting is never send-capable (removing an enrollment stops sending).
      return null;
    }
    if (/\/enrollments(\/|$)/.test(p)) return 'enrolling prospects into a campaign';
    if (/\/conversations\/[^/]+\/(reply|messages|send)/.test(p) || /\/messages(\/|$)/.test(p)) {
      return 'sending a conversation message';
    }
    if (/\/sourcings\/[^/]+\/start/.test(p)) return 'starting a sourcing (can auto-enroll into campaigns)';

    const b = unwrap(body);
    if (/^\/campaigns(\/[^/]+)?$/.test(p) && b && typeof b === 'object') {
      const o = b as Record<string, unknown>;
      if (o.status !== undefined && o.status !== 'off' && o.status !== 'draft') {
        return `setting campaign status to "${String(o.status)}"`;
      }
      if (o.only_allow_manual_enrollment === false) return 'enabling auto-enrollment';
      for (const k of ['automatically_send_messages', 'automatically_send_follow_ups', 'automatically_reenroll']) {
        if (o[k] === true) return `enabling ${k}`;
      }
      if (o.sourcing_id !== undefined && o.sourcing_id !== null) return 'attaching a sourcing (auto-fills campaign)';
      if (o.search_criteria !== undefined && o.search_criteria !== null) return 'attaching search criteria (auto-fills campaign)';
      if (Array.isArray(o.steps) && o.steps.some(isEnrollStep)) return 'adding an enroll_campaign step';
    }
    if (/^\/campaigns\/[^/]+\/steps(\/[^/]+)?$/.test(p) && isEnrollStep(b)) return 'adding an enroll_campaign step';
    return null;
  }
}

function isEnrollStep(s: unknown): boolean {
  return !!s && typeof s === 'object' && (s as Record<string, unknown>).type === 'enroll_campaign';
}

function unwrap(body: unknown): unknown {
  if (body && typeof body === 'object' && 'data' in (body as object)) {
    const d = (body as { data: unknown }).data;
    if (d && typeof d === 'object' && 'attributes' in (d as object)) return (d as { attributes: unknown }).attributes;
  }
  return body;
}

function summarize(body: unknown): string | undefined {
  if (body === undefined) return undefined;
  const s = JSON.stringify(body);
  return s.length > 400 ? s.slice(0, 400) + '…' : s;
}
