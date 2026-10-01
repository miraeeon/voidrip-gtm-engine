import { all, one } from '../db/db.js';
import { getConfig } from '../config.js';
import { getMarketReviewQueue } from './drafting.js';
import { activationEligibleSignalSql, outsideCurrentYcProgramSql } from './activation-eligibility.js';

export function getDailyBuffer(limit = getConfig().GTM_DAILY_SEQUENCES) {
  const ready = one<{ n: number }>(
    `SELECT COUNT(*) n FROM candidate_sequences s
      JOIN activation_scores a ON a.id = s.activation_score_id
      JOIN boundary_qualifications b ON b.id = a.boundary_qualification_id
     WHERE s.status = 'final' AND s.review_status = 'pending'
       AND b.boundary_status = 'PASS_OUTBOUND_V1'
       AND a.priority_tier IN ('A','B') AND a.intent_strength BETWEEN 2 AND 5
       AND a.freshness IN ('CURRENT','RECENT') AND a.route != 'none'
       AND ${activationEligibleSignalSql('s.candidate_id', 's.project_id')}
       AND ${outsideCurrentYcProgramSql('s.candidate_id', 's.project_id')}`,
  )?.n ?? 0;
  const stages = Object.fromEntries(
    all<{ state: string; n: number }>('SELECT state, COUNT(*) n FROM candidates GROUP BY state').map((row) => [row.state, row.n]),
  );
  const signaled = one<{ n: number }>(
    `SELECT COUNT(DISTINCT s.candidate_id) n FROM signal_events s
      JOIN boundary_qualifications b ON b.candidate_id = s.candidate_id AND b.project_id = s.project_id
     WHERE b.boundary_status = 'PASS_OUTBOUND_V1'`,
  )?.n ?? 0;
  return {
    target: limit,
    ready,
    deficit: Math.max(0, limit - ready),
    complete: ready >= limit,
    quality_floor: 'PASS_OUTBOUND_V1 + explicit current unresolved structural need + outside current YC program + Tier A/B + clean final LinkedIn sequence',
    provider_action: 'NONE',
    pipeline: { ...stages, signaled },
    items: getMarketReviewQueue(limit),
  };
}
