import { all, logRun, nowIso, one, run, tx } from '../db/db.js';
import { getPlaybook } from '../pipeline/playbook.js';
import { getSellerProfile } from '../pipeline/setup.js';
import { lintSequence, SequenceInput } from '../pipeline/sequence.js';
import { CandidateSequenceInput } from './contracts.js';
import { activationEligibleSignalSql, outsideCurrentYcProgramSql } from './activation-eligibility.js';

function parseJson<T>(value: string | null, fallback: T): T {
  return value ? (JSON.parse(value) as T) : fallback;
}

export function getMarketDraftingQueue(limit = 25) {
  const candidates = all<any>(
    `SELECT c.*, p.id project_id, p.name project_name, p.url project_url, p.description project_description,
            b.boundary_status, b.evidence_summary, b.confidence,
            a.id activation_score_id, a.intent_strength, a.freshness, a.priority_tier, a.route, a.angle,
            a.channel_plan_json, a.reasoning activation_reasoning
       FROM candidates c
       JOIN projects p ON p.candidate_id = c.id
       JOIN boundary_qualifications b ON b.id = (
         SELECT MAX(b2.id) FROM boundary_qualifications b2 WHERE b2.project_id = p.id
       )
       JOIN activation_scores a ON a.id = (
         SELECT MAX(a2.id) FROM activation_scores a2 WHERE a2.project_id = p.id
       )
      WHERE c.state IN ('ACTIVATION_READY','DRAFTED')
        AND a.route != 'none'
        AND ${activationEligibleSignalSql('c.id', 'p.id')}
        AND ${outsideCurrentYcProgramSql('c.id', 'p.id')}
        AND NOT EXISTS (
          SELECT 1 FROM candidate_sequences s
           WHERE s.candidate_id = c.id AND s.project_id = p.id AND s.status = 'final'
        )
      ORDER BY CASE a.priority_tier WHEN 'A' THEN 0 WHEN 'B' THEN 1 WHEN 'C' THEN 2 ELSE 3 END,
               COALESCE(a.intent_strength, 0) DESC
      LIMIT ?`,
    limit,
  ).map((item) => ({
    ...item,
    channel_plan: parseJson(item.channel_plan_json, null),
    channel_plan_json: undefined,
    source_observations: all<any>(
      `SELECT source, source_lane_id, source_record_id, retrieved_at, evidence_json
         FROM source_observations WHERE candidate_id = ? ORDER BY retrieved_at DESC`,
      item.id,
    ).map((observation) => ({ ...observation, evidence: parseJson(observation.evidence_json, []), evidence_json: undefined })),
  }));
  const playbook = getPlaybook();
  return { candidates, seller: getSellerProfile(), playbook_version: playbook.version, playbook: playbook.content };
}

export function saveCandidateSequence(raw: unknown) {
  const input = CandidateSequenceInput.parse(raw);
  const context = one<any>(
    `SELECT c.*, p.id project_id, a.id activation_score_id, a.route, a.channel_plan_json
       FROM candidates c JOIN projects p ON p.candidate_id = c.id
       JOIN activation_scores a ON a.id = (
         SELECT MAX(a2.id) FROM activation_scores a2 WHERE a2.candidate_id = c.id AND a2.project_id = p.id
       )
      WHERE c.id = ? AND p.id = ?`,
    input.candidate_id,
    input.project_id,
  );
  if (!context) throw new Error('candidate/project has no activation score');
  if (context.route === 'none') throw new Error('candidate is routed to none — do not draft');
  const plan = parseJson<any>(context.channel_plan_json, null);
  const legacyShape = SequenceInput.parse({ ...input, lead_id: input.candidate_id });
  const issues = lintSequence(
    legacyShape,
    context.route,
    { first_name: context.name?.split(/\s+/)[0] ?? null, company: context.current_org },
    getSellerProfile()?.proof_points ?? [],
    plan?.first_channel ?? null,
  );
  const errors = issues.filter((issue) => issue.level === 'error');
  const status = input.status === 'final' && errors.length ? 'draft' : input.status;
  const version = (one<{ version: number }>(
    'SELECT MAX(version) version FROM candidate_sequences WHERE candidate_id = ? AND project_id = ?',
    input.candidate_id,
    input.project_id,
  )?.version ?? 0) + 1;
  const id = tx(() => {
    run(
      `UPDATE candidate_sequences SET status = 'superseded'
        WHERE candidate_id = ? AND project_id = ? AND status != 'superseded'`,
      input.candidate_id,
      input.project_id,
    );
    const result = run(
      `INSERT INTO candidate_sequences(candidate_id, project_id, activation_score_id, version, status, route, angle,
        hook_type, steps_json, lint_json, critique, playbook_version, review_status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'pending', ?)`,
      input.candidate_id,
      input.project_id,
      context.activation_score_id,
      version,
      status,
      context.route,
      input.angle,
      input.hook_type,
      JSON.stringify(input.steps),
      JSON.stringify(issues),
      input.critique ?? null,
      getPlaybook().version,
      nowIso(),
    );
    run(
      'UPDATE candidates SET state = ?, updated_at = ? WHERE id = ?',
      status === 'final' ? 'REVIEW_READY' : 'DRAFTED',
      nowIso(),
      input.candidate_id,
    );
    return Number(result.lastInsertRowid);
  });
  const result = { sequence_id: id, candidate_id: input.candidate_id, project_id: input.project_id, version, status, lint: issues };
  logRun('candidate_sequence', result);
  return result;
}

export function saveCandidateSequences(items: unknown[]) {
  const saved = items.map((item) => saveCandidateSequence(item));
  return { saved };
}

export function getMarketReviewQueue(limit = 25) {
  return all<any>(
    `SELECT s.id sequence_id, s.candidate_id, s.project_id, s.version, s.route, s.angle, s.hook_type,
            s.steps_json, s.lint_json, s.critique, s.review_status, s.created_at,
            c.external_id, c.name, c.linkedin_url, c.email, c.current_role, c.current_org,
            p.name project_name, p.url project_url,
            b.boundary_status, b.kernel_primary, b.evidence_summary, a.priority_tier, a.intent_strength, a.freshness,
            (SELECT se.source FROM signal_events se WHERE se.candidate_id=c.id AND se.project_id=p.id ORDER BY se.created_at DESC LIMIT 1) signal_source,
            (SELECT se.url FROM signal_events se WHERE se.candidate_id=c.id AND se.project_id=p.id ORDER BY se.created_at DESC LIMIT 1) signal_url,
            (SELECT se.event_date FROM signal_events se WHERE se.candidate_id=c.id AND se.project_id=p.id ORDER BY se.created_at DESC LIMIT 1) signal_date,
            (SELECT se.evidence FROM signal_events se WHERE se.candidate_id=c.id AND se.project_id=p.id ORDER BY se.created_at DESC LIMIT 1) signal_evidence,
            (SELECT se.strength FROM signal_events se WHERE se.candidate_id=c.id AND se.project_id=p.id ORDER BY se.created_at DESC LIMIT 1) signal_strength
       FROM candidate_sequences s
       JOIN candidates c ON c.id = s.candidate_id
       JOIN projects p ON p.id = s.project_id
       JOIN boundary_qualifications b ON b.id = (
         SELECT MAX(b2.id) FROM boundary_qualifications b2 WHERE b2.project_id = p.id
       )
       JOIN activation_scores a ON a.id = s.activation_score_id
      WHERE s.status = 'final' AND s.review_status = 'pending'
        AND ${activationEligibleSignalSql('s.candidate_id', 's.project_id')}
        AND ${outsideCurrentYcProgramSql('s.candidate_id', 's.project_id')}
      ORDER BY CASE a.priority_tier WHEN 'A' THEN 0 WHEN 'B' THEN 1 ELSE 2 END,
               COALESCE(a.intent_strength, 0) DESC, s.created_at ASC
      LIMIT ?`,
    limit,
  ).map((item) => ({
    ...item,
    steps: parseJson(item.steps_json, []),
    lint: parseJson(item.lint_json, []),
    steps_json: undefined,
    lint_json: undefined,
  }));
}
