import { z } from 'zod';
import { all, logRun, nowIso, one, run, today, tx } from '../db/db.js';
import { savePlaybook } from '../pipeline/playbook.js';
import { setWeight } from '../pipeline/weights.js';
import { getMarketPerformance } from './performance.js';

export const MarketLearningProposalInput = z.object({
  insights: z.array(z.object({
    finding: z.string().min(5).max(400),
    evidence: z.string().min(3).max(400),
    confidence: z.enum(['low', 'medium', 'high']),
    action: z.string().min(3).max(300),
  })).min(1).max(15),
  weight_changes: z.record(
    z.string().regex(/^(kernel|signal|tier|route|hook|intent):/),
    z.number().min(0).max(3),
  ).optional(),
  playbook_markdown: z.string().min(50).max(20_000).optional(),
});

export function saveMarketLearningProposal(raw: unknown) {
  const input = MarketLearningProposalInput.parse(raw);
  const performance = getMarketPerformance({ includeSimulated: false });
  const real = performance.data_quality.real_outcomes;
  if (real === 0) throw new Error('no real outcomes exist; the learning loop must not invent a proposal');
  if (real < 20 && input.insights.some((insight) => insight.confidence !== 'low')) {
    throw new Error('fewer than 20 real outcomes requires confidence=low for every insight');
  }
  const result = run(
    `INSERT INTO market_learning_proposals(run_date,status,real_outcome_count,insights_json,weight_changes_json,
      playbook_change,created_at) VALUES (?,'PENDING_REVIEW',?,?,?,?,?)`,
    today(), real, JSON.stringify(input.insights), JSON.stringify(input.weight_changes ?? {}),
    input.playbook_markdown ?? null, nowIso(),
  );
  const proposal = {
    proposal_id: Number(result.lastInsertRowid),
    status: 'PENDING_REVIEW',
    real_outcomes: real,
    provider_action: 'NONE',
    boundary_changed: false,
  };
  logRun('market_learning_proposal', proposal);
  return proposal;
}

export function getMarketLearningProposals(limit = 10) {
  return all<any>('SELECT * FROM market_learning_proposals ORDER BY id DESC LIMIT ?', limit).map((row) => ({
    proposal_id: row.id,
    run_date: row.run_date,
    status: row.status,
    real_outcome_count: row.real_outcome_count,
    insights: JSON.parse(row.insights_json),
    weight_changes: JSON.parse(row.weight_changes_json),
    playbook_markdown: row.playbook_change,
    created_at: row.created_at,
    reviewed_at: row.reviewed_at,
  }));
}

export function reviewMarketLearningProposal(input: { proposal_id: number; approve: boolean }) {
  const proposal = one<any>('SELECT * FROM market_learning_proposals WHERE id=?', input.proposal_id);
  if (!proposal) throw new Error(`unknown learning proposal ${input.proposal_id}`);
  if (proposal.status !== 'PENDING_REVIEW') throw new Error(`learning proposal is already ${proposal.status}`);
  const at = nowIso();
  if (!input.approve) {
    run(`UPDATE market_learning_proposals SET status='REJECTED',reviewed_at=? WHERE id=?`, at, input.proposal_id);
    return { proposal_id: input.proposal_id, status: 'REJECTED', weights_updated: 0, playbook_updated: false };
  }
  const weights = JSON.parse(proposal.weight_changes_json) as Record<string, number>;
  let playbookUpdated = false;
  tx(() => {
    for (const [key, value] of Object.entries(weights)) setWeight(key, value, `approved market learning proposal ${input.proposal_id}`);
    if (proposal.playbook_change) {
      savePlaybook(proposal.playbook_change, `approved market learning proposal ${input.proposal_id}`);
      playbookUpdated = true;
    }
    run(`UPDATE market_learning_proposals SET status='APPROVED',reviewed_at=? WHERE id=?`, at, input.proposal_id);
  });
  const result = { proposal_id: input.proposal_id, status: 'APPROVED', weights_updated: Object.keys(weights).length, playbook_updated: playbookUpdated, boundary_changed: false };
  logRun('market_learning_applied', result);
  return result;
}
