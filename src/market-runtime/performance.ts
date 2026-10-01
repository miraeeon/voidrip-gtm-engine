import { all, one } from '../db/db.js';

export interface MarketPerformanceBucket {
  key: string;
  prospects: number;
  contacted: number;
  replied: number;
  positive: number;
  meetings: number;
  scans: number;
  sales: number;
  revenue: number;
  reply_rate: number;
  positive_rate: number;
  meeting_rate: number;
  scan_rate: number;
  sale_rate: number;
  low_sample: boolean;
}

type Row = {
  key: string | null;
  contacted: number;
  replied: number;
  positive: number;
  meeting: number;
  scan: number;
  sale: number;
  revenue: number;
};

const pct = (value: number, base: number) => base > 0 ? Math.round((value / base) * 1000) / 10 : 0;

function bucketize(rows: Row[]): MarketPerformanceBucket[] {
  const buckets = new Map<string, MarketPerformanceBucket>();
  for (const row of rows) {
    const key = row.key || 'unknown';
    const bucket = buckets.get(key) ?? {
      key, prospects: 0, contacted: 0, replied: 0, positive: 0, meetings: 0, scans: 0, sales: 0, revenue: 0,
      reply_rate: 0, positive_rate: 0, meeting_rate: 0, scan_rate: 0, sale_rate: 0, low_sample: true,
    };
    bucket.prospects++;
    bucket.contacted += row.contacted;
    bucket.replied += row.replied;
    bucket.positive += row.positive;
    bucket.meetings += row.meeting;
    bucket.scans += row.scan;
    bucket.sales += row.sale;
    bucket.revenue += row.revenue;
    buckets.set(key, bucket);
  }
  return [...buckets.values()].map((bucket) => ({
    ...bucket,
    reply_rate: pct(bucket.replied, bucket.contacted),
    positive_rate: pct(bucket.positive, bucket.contacted),
    meeting_rate: pct(bucket.meetings, bucket.contacted),
    scan_rate: pct(bucket.scans, bucket.contacted),
    sale_rate: pct(bucket.sales, bucket.contacted),
    low_sample: bucket.contacted < 20,
  })).sort((a, b) => b.sale_rate - a.sale_rate || b.positive_rate - a.positive_rate || b.contacted - a.contacted);
}

const BASE = `FROM provider_activations pa
  JOIN candidates c ON c.id=pa.candidate_id
  JOIN projects p ON p.id=pa.project_id
  JOIN candidate_sequences cs ON cs.id=pa.sequence_id
  JOIN activation_scores a ON a.id=cs.activation_score_id
  JOIN boundary_qualifications b ON b.id=a.boundary_qualification_id
  LEFT JOIN signal_events se ON se.id=(SELECT MAX(se2.id) FROM signal_events se2 WHERE se2.candidate_id=pa.candidate_id AND se2.project_id=pa.project_id)
  LEFT JOIN (
    SELECT activation_id,
      MAX(event_type IN ('CONNECTION_SENT','MESSAGE_SENT')) contacted,
      MAX(event_type='REPLY_RECEIVED') replied,
      MAX(event_type='POSITIVE_REPLY') positive,
      MAX(event_type='MEETING_BOOKED') meeting,
      MAX(event_type IN ('SCAN_STARTED','SCAN_COMPLETED')) scan,
      MAX(event_type='SALE') sale,
      SUM(CASE WHEN event_type='SALE' THEN COALESCE(value_number,0) ELSE 0 END) revenue,
      MAX(is_simulated) simulated
    FROM market_outcome_events GROUP BY activation_id
  ) outcome ON outcome.activation_id=pa.id
  WHERE pa.provider='heyreach'`;

const SELECT = `COALESCE(outcome.contacted,0) contacted,COALESCE(outcome.replied,0) replied,
  COALESCE(outcome.positive,0) positive,COALESCE(outcome.meeting,0) meeting,COALESCE(outcome.scan,0) scan,
  COALESCE(outcome.sale,0) sale,COALESCE(outcome.revenue,0) revenue`;

export function getMarketPerformance(opts: { includeSimulated?: boolean } = {}) {
  const simulationFilter = opts.includeSimulated === false ? ' AND COALESCE(outcome.simulated,0)=0' : '';
  const dimensions: Record<string, string> = {
    kernel: 'b.kernel_primary',
    signal: 'se.signal_type',
    tier: 'a.priority_tier',
    route: 'a.route',
    hook: 'cs.hook_type',
    intent: 'CAST(a.intent_strength AS TEXT)',
    playbook_version: 'CAST(cs.playbook_version AS TEXT)',
  };
  const by: Record<string, MarketPerformanceBucket[]> = {};
  for (const [dimension, expression] of Object.entries(dimensions)) {
    by[dimension] = bucketize(all<Row>(`SELECT ${expression} key,${SELECT} ${BASE}${simulationFilter}`));
  }
  const totals = bucketize(all<Row>(`SELECT 'all' key,${SELECT} ${BASE}${simulationFilter}`))[0] ?? null;
  const realOutcomes = one<{ n: number }>(`SELECT COUNT(DISTINCT activation_id) n FROM market_outcome_events WHERE is_simulated=0`)?.n ?? 0;
  const simulatedOutcomes = one<{ n: number }>(`SELECT COUNT(DISTINCT activation_id) n FROM market_outcome_events WHERE is_simulated=1`)?.n ?? 0;
  return {
    data_quality: {
      real_outcomes: realOutcomes,
      simulated_outcomes: simulatedOutcomes,
      warning: simulatedOutcomes > 0
        ? 'Includes simulated events; conclusions remain a dry run.'
        : realOutcomes < 20
          ? 'Fewer than 20 real prospect outcomes; keep changes small and proposal-only.'
          : undefined,
    },
    totals,
    by,
  };
}
