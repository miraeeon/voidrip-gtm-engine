import { all } from '../db/db.js';

export interface Bucket {
  key: string;
  contacted: number;
  opened: number;
  replied: number;
  positive: number;
  meetings: number;
  bounced: number;
  open_rate: number;
  reply_rate: number;
  positive_rate: number;
  meeting_rate: number;
  low_sample: boolean;
}

export const DIMENSIONS = ['signal', 'tier', 'persona', 'route', 'first_channel', 'hook_type', 'intent_strength', 'playbook_version'] as const;
export type Dimension = (typeof DIMENSIONS)[number];

const COL: Record<Dimension, string> = {
  signal: 'l.signal_slug',
  tier: 'c.tier',
  persona: 'c.persona',
  route: 'c.route',
  first_channel: 'c.first_channel',
  hook_type: 's.hook_type',
  intent_strength: 'c.intent_strength',
  playbook_version: 's.playbook_version',
};

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);

export function bucketize(rows: { key: string | null; sent: number; opened: number; replied: number; positive: number; meeting: number; bounced: number }[], minSample = 5): Bucket[] {
  const m = new Map<string, Bucket>();
  for (const r of rows) {
    const key = r.key === null || r.key === undefined ? 'unknown' : String(r.key);
    const b =
      m.get(key) ??
      ({ key, contacted: 0, opened: 0, replied: 0, positive: 0, meetings: 0, bounced: 0 } as Bucket);
    b.contacted += r.sent ? 1 : 0;
    b.opened += r.opened;
    b.replied += r.replied;
    b.positive += r.positive;
    b.meetings += r.meeting;
    b.bounced += r.bounced;
    m.set(key, b);
  }
  return [...m.values()]
    .map((b) => ({
      ...b,
      open_rate: pct(b.opened, b.contacted),
      reply_rate: pct(b.replied, b.contacted),
      positive_rate: pct(b.positive, b.contacted),
      meeting_rate: pct(b.meetings, b.contacted),
      low_sample: b.contacted < minSample,
    }))
    .sort((a, b) => b.reply_rate - a.reply_rate || b.contacted - a.contacted);
}

export function getPerformance(opts: { includeSimulated?: boolean; sinceDays?: number } = {}) {
  const sim = opts.includeSimulated ?? true;
  const since = new Date(Date.now() - (opts.sinceDays ?? 90) * 86_400_000).toISOString();
  const base = `FROM outcomes o
      JOIN leads l ON l.id = o.lead_id
      JOIN classifications c ON c.lead_id = l.id
      LEFT JOIN sequences s ON s.lead_id = l.id AND s.status = 'final'
     WHERE l.sourced_at >= ? ${sim ? '' : 'AND o.is_simulated = 0'}`;
  const dims: Record<string, Bucket[]> = {};
  for (const d of DIMENSIONS) {
    const rows = all<any>(`SELECT ${COL[d]} AS key, o.sent, o.opened, o.replied, o.positive, o.meeting, o.bounced ${base}`, since);
    dims[d] = bucketize(rows);
  }
  const totals = bucketize(all<any>(`SELECT 'all' AS key, o.sent, o.opened, o.replied, o.positive, o.meeting, o.bounced ${base}`, since))[0] ?? null;
  const simCount = all<{ n: number }>(`SELECT COUNT(*) n FROM outcomes WHERE is_simulated = 1`)[0]?.n ?? 0;
  const realCount = all<{ n: number }>(`SELECT COUNT(*) n FROM outcomes WHERE is_simulated = 0`)[0]?.n ?? 0;

  // Replied vs. not-replied sequences for the model to compare qualitatively.
  const examples = (replied: number) =>
    all<any>(
      `SELECT l.id lead_id, c.persona, c.tier, c.route, l.signal_slug, s.hook_type, s.angle, s.steps_json, o.positive, o.is_simulated
         FROM outcomes o JOIN leads l ON l.id = o.lead_id JOIN classifications c ON c.lead_id = l.id
         JOIN sequences s ON s.lead_id = l.id AND s.status = 'final'
        WHERE o.replied = ? ${sim ? '' : 'AND o.is_simulated = 0'} ORDER BY o.positive DESC, l.id DESC LIMIT 4`,
      replied,
    ).map((r) => {
      const steps = JSON.parse(r.steps_json);
      const first = steps.find((s: any) => s.type !== 'linkedin_visit');
      return { ...r, steps_json: undefined, first_touch: first };
    });

  return {
    data_quality: {
      real_outcomes: realCount,
      simulated_outcomes: simCount,
      warning:
        simCount > 0
          ? 'Includes SIMULATED outcomes (test mode). Treat conclusions as a dry-run of the learning loop, not real evidence.'
          : realCount < 20
            ? 'Fewer than 20 real outcomes — prefer small, reversible playbook changes.'
            : undefined,
    },
    totals,
    by: dims,
    replied_examples: examples(1),
    no_reply_examples: examples(0),
  };
}
