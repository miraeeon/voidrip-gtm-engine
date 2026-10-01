import { createDefaultHeyReachAdapter } from '../adapters/runtime.js';
import type { HeyReachAdapter } from '../adapters/heyreach-execution.js';
import { auditSink } from '../db/db.js';

/** Read-only verification of the single preconfigured VOIDRIP HeyReach campaign. */
export async function verifyHeyReachCampaign(opts: { execution?: HeyReachAdapter } = {}) {
  const inspection = await (opts.execution ?? createDefaultHeyReachAdapter(auditSink)).inspectConfiguredCampaign();
  return {
    ...inspection,
    all_inert: inspection.inert,
    launch_authorized: false,
  };
}
