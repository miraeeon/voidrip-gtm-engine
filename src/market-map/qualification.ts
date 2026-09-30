import { all, logRun, nowIso, one, run, tx } from '../db/db.js';
import { applyRoutingRules } from '../pipeline/route.js';
import {
  ActivationScoreInput,
  BoundaryQualificationInput,
  ProjectResolutionInput,
} from './contracts.js';
import { getBoundaryContract } from './boundary.js';

function parsed<T>(value: string | null | undefined, fallback: T): T {
  return value ? (JSON.parse(value) as T) : fallback;
}

function observations(candidateId: number) {
  return all<any>(
    `SELECT source, source_lane_id, source_record_id, retrieved_at, project_hint, org_hint, evidence_json, raw_payload_json
       FROM source_observations WHERE candidate_id = ? ORDER BY retrieved_at DESC`,
    candidateId,
  ).map((item) => ({
    ...item,
    evidence: parsed(item.evidence_json, []),
    raw_source_data: parsed(item.raw_payload_json, {}),
    evidence_json: undefined,
    raw_payload_json: undefined,
  }));
}

export function getResolutionQueue(limit = 25) {
  return all<any>(
    `SELECT c.* FROM candidates c
     WHERE c.state IN ('RAW','PERSON_RESOLVED')
       AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.candidate_id = c.id)
     ORDER BY c.updated_at ASC LIMIT ?`,
    limit,
  ).map((candidate) => ({ ...candidate, observations: observations(candidate.id) }));
}

export function saveProjectResolution(raw: unknown) {
  const input = ProjectResolutionInput.parse(raw);
  const candidate = one<any>('SELECT * FROM candidates WHERE id = ?', input.candidate_id);
  if (!candidate) throw new Error(`candidate ${input.candidate_id} not found`);
  const at = nowIso();
  const id = tx(() => {
    const result = run(
      `INSERT INTO projects(candidate_id, name, url, description, kernel_primary, kernel_secondary, project_visibility,
        project_alignment, status, evidence_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      input.candidate_id,
      input.name ?? null,
      input.url ?? null,
      input.description ?? null,
      input.kernel_primary,
      input.kernel_secondary ?? null,
      input.project_visibility,
      input.project_alignment,
      input.status ?? null,
      JSON.stringify(input.evidence),
      at,
      at,
    );
    run(`UPDATE candidates SET state = 'QUALIFICATION_PENDING', updated_at = ? WHERE id = ?`, at, input.candidate_id);
    return Number(result.lastInsertRowid);
  });
  logRun('project_resolution', { candidate_id: input.candidate_id, project_id: id });
  return { candidate_id: input.candidate_id, project_id: id, state: 'QUALIFICATION_PENDING' };
}

export function getBoundaryQueue(limit = 25) {
  const items = all<any>(
    `SELECT c.*, p.id project_id, p.name project_name, p.url project_url, p.description project_description,
            p.kernel_primary kernel_hypothesis, p.kernel_secondary, p.project_visibility, p.project_alignment,
            p.status project_status, p.evidence_json project_evidence_json
       FROM candidates c JOIN projects p ON p.candidate_id = c.id
      WHERE c.state = 'QUALIFICATION_PENDING'
        AND NOT EXISTS (SELECT 1 FROM boundary_qualifications b WHERE b.project_id = p.id)
      ORDER BY p.updated_at ASC LIMIT ?`,
    limit,
  ).map((item) => ({
    ...item,
    project_evidence: parsed(item.project_evidence_json, []),
    project_evidence_json: undefined,
    source_observations: observations(item.id),
  }));
  return { boundary: getBoundaryContract(), items };
}

export function saveBoundaryQualifications(items: unknown[]) {
  const parsedItems = items.map((item) => BoundaryQualificationInput.parse(item));
  const saved: { candidate_id: number; project_id: number; qualification_id: number; boundary_status: string }[] = [];
  tx(() => {
    for (const input of parsedItems) {
      const project = one<any>('SELECT * FROM projects WHERE id = ? AND candidate_id = ?', input.project_id, input.candidate_id);
      if (!project) throw new Error(`project ${input.project_id} does not belong to candidate ${input.candidate_id}`);
      if (
        input.boundary_status === 'PASS_OUTBOUND_V1' &&
        (project.project_alignment === 'MISALIGNED_WITH_PROFESSIONAL_IDENTITY' || input.professional_project_visibility === 'MISALIGNED')
      ) {
        throw new Error('MISALIGNED_WITH_PROFESSIONAL_IDENTITY cannot be PASS_OUTBOUND_V1');
      }
      const result = run(
        `INSERT INTO boundary_qualifications(candidate_id, project_id, boundary_version, boundary_status, project_real,
          strategic_authority, ambition, intrinsic_complexity, professional_project_visibility, kernel_primary,
          kernel_secondary, failed_gates_json, missing_evidence_json, evidence_summary, confidence, reasoning, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        input.candidate_id,
        input.project_id,
        input.boundary_version,
        input.boundary_status,
        input.project_real,
        input.strategic_authority,
        input.ambition,
        input.intrinsic_complexity,
        input.professional_project_visibility,
        input.kernel_primary,
        input.kernel_secondary ?? null,
        JSON.stringify(input.failed_gates),
        JSON.stringify(input.missing_evidence),
        input.evidence_summary,
        input.confidence,
        input.reasoning,
        nowIso(),
      );
      run('UPDATE candidates SET state = ?, updated_at = ? WHERE id = ?', input.boundary_status, nowIso(), input.candidate_id);
      saved.push({
        candidate_id: input.candidate_id,
        project_id: input.project_id,
        qualification_id: Number(result.lastInsertRowid),
        boundary_status: input.boundary_status,
      });
    }
  });
  logRun('boundary_qualification', { saved });
  return { saved };
}

export function getPriorityQueue(limit = 25) {
  return all<any>(
    `SELECT c.*, p.id project_id, p.name project_name, p.url project_url, p.description project_description,
            b.id boundary_qualification_id, b.boundary_status, b.kernel_primary, b.kernel_secondary,
            b.evidence_summary, b.confidence, b.reasoning boundary_reasoning
       FROM candidates c
       JOIN projects p ON p.candidate_id = c.id
       JOIN boundary_qualifications b ON b.project_id = p.id
      WHERE c.state = 'PASS_OUTBOUND_V1'
        AND b.id = (SELECT MAX(b2.id) FROM boundary_qualifications b2 WHERE b2.project_id = p.id)
        AND NOT EXISTS (SELECT 1 FROM activation_scores a WHERE a.boundary_qualification_id = b.id)
      ORDER BY b.id ASC LIMIT ?`,
    limit,
  ).map((item) => ({
    ...item,
    signals: all<any>('SELECT * FROM signal_events WHERE candidate_id = ? AND project_id = ? ORDER BY created_at DESC', item.id, item.project_id),
  }));
}

export function saveActivationScores(items: unknown[]) {
  const parsedItems = items.map((item) => ActivationScoreInput.parse(item));
  const saved: { candidate_id: number; project_id: number; activation_score_id: number; route: string }[] = [];
  tx(() => {
    for (const input of parsedItems) {
      const boundary = one<any>(
        `SELECT * FROM boundary_qualifications WHERE candidate_id = ? AND project_id = ? ORDER BY id DESC LIMIT 1`,
        input.candidate_id,
        input.project_id,
      );
      if (!boundary || boundary.boundary_status !== 'PASS_OUTBOUND_V1') throw new Error('activation scoring requires PASS_OUTBOUND_V1');
      const candidate = one<any>('SELECT * FROM candidates WHERE id = ?', input.candidate_id);
      const routed = applyRoutingRules(candidate, input.route, input.priority_tier);
      const result = run(
        `INSERT INTO activation_scores(candidate_id, project_id, boundary_qualification_id, intent_strength, freshness,
          priority_tier, route, angle, channel_plan_json, reasoning, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        input.candidate_id,
        input.project_id,
        boundary.id,
        input.intent_strength,
        input.freshness,
        input.priority_tier,
        routed.route,
        input.angle,
        input.channel_plan ? JSON.stringify(input.channel_plan) : null,
        `${input.reasoning} Route guard: ${routed.reason}`,
        nowIso(),
      );
      const state = routed.route === 'none' || input.priority_tier === 'DQ' ? 'PASS_OUTBOUND_V1' : 'ACTIVATION_READY';
      run('UPDATE candidates SET state = ?, updated_at = ? WHERE id = ?', state, nowIso(), input.candidate_id);
      saved.push({ candidate_id: input.candidate_id, project_id: input.project_id, activation_score_id: Number(result.lastInsertRowid), route: routed.route });
    }
  });
  logRun('activation_score', { saved });
  return { saved };
}
