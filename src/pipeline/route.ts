import { z } from 'zod';
import type { OverloopContext } from './enrich.js';

export const Route = z.enum(['email', 'linkedin', 'both', 'none']);
export type Route = z.infer<typeof Route>;
export const Channel = z.enum(['email', 'linkedin']);
export type Channel = z.infer<typeof Channel>;

export interface RoutableLead {
  email: string | null;
  linkedin_url: string | null;
  email_status?: string | null;
  ovl_context_json?: string | null;
}

const BAD_EMAIL_STATUS = new Set(['invalid', 'bounced', 'undeliverable', 'not_found', 'risky']);

export function overloopContext(lead: RoutableLead): OverloopContext | null {
  if (!lead.ovl_context_json) return null;
  try {
    return JSON.parse(lead.ovl_context_json) as OverloopContext;
  } catch {
    return null;
  }
}

export function channelsAvailable(lead: RoutableLead): { email: boolean; linkedin: boolean } {
  const ovl = overloopContext(lead);
  const status = (ovl?.email_status ?? lead.email_status ?? '').toLowerCase();
  const emailOk =
    !!lead.email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(lead.email) && !BAD_EMAIL_STATUS.has(status) && !ovl?.bounced;
  const liOk = !!lead.linkedin_url && /linkedin\.com\/in\//i.test(lead.linkedin_url);
  return { email: emailOk, linkedin: liOk };
}

/**
 * Hard routing rules applied on top of the model's choice. The model decides the
 * *preferred* channel mix; data availability and Overloop history decide what is
 * actually allowed.
 */
export function applyRoutingRules(lead: RoutableLead, requested: Route, tier: string): { route: Route; reason: string } {
  if (tier === 'DQ') return { route: 'none', reason: 'disqualified' };
  const ovl = overloopContext(lead);
  if (ovl?.excluded) return { route: 'none', reason: 'on the Overloop exclusion list' };
  if (ovl?.replied) return { route: 'none', reason: 'already replied in Overloop — hand to a human, do not auto-sequence' };
  const { email, linkedin } = channelsAvailable(lead);
  if (!email && !linkedin) return { route: 'none', reason: 'no usable email or LinkedIn profile' };
  if (requested === 'none') return { route: 'none', reason: 'model chose not to contact' };
  if (requested === 'both') {
    if (email && linkedin) return { route: 'both', reason: 'model: both; both channels available' };
    return email
      ? { route: 'email', reason: 'model: both; no LinkedIn profile -> email only' }
      : { route: 'linkedin', reason: 'model: both; no deliverable email -> LinkedIn only' };
  }
  if (requested === 'email' && !email) return { route: 'linkedin', reason: 'model: email; no deliverable email -> LinkedIn' };
  if (requested === 'linkedin' && !linkedin) return { route: 'email', reason: 'model: LinkedIn; no LinkedIn profile -> email' };
  return { route: requested, reason: `model: ${requested}` };
}

/** The channel that must carry the first real message, consistent with the final route. */
export function resolveFirstChannel(route: Route, preferred: Channel | undefined): Channel | null {
  if (route === 'none') return null;
  if (route === 'email' || route === 'linkedin') return route;
  return preferred ?? 'email';
}
