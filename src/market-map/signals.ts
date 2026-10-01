import { all, logRun, nowIso, one, run, tx } from '../db/db.js';
import { SignalEventInput } from './contracts.js';

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  return value ? (JSON.parse(value) as T) : fallback;
}

export function getSignalQueue(limit = 20) {
  return all<any>(
    `SELECT c.*, p.id project_id, p.name project_name, p.url project_url, p.description project_description,
            b.id boundary_qualification_id, b.kernel_primary, b.evidence_summary, b.confidence
       FROM candidates c
       JOIN projects p ON p.candidate_id = c.id
       JOIN boundary_qualifications b ON b.id = (
         SELECT MAX(b2.id) FROM boundary_qualifications b2 WHERE b2.project_id = p.id
       )
      WHERE b.boundary_status = 'PASS_OUTBOUND_V1'
        AND c.state NOT IN ('ACTIVATION_READY','DRAFTED','REVIEW_READY')
      ORDER BY CASE WHEN EXISTS (
        SELECT 1 FROM signal_events s WHERE s.candidate_id = c.id AND s.project_id = p.id
      ) THEN 1 ELSE 0 END, c.updated_at ASC
      LIMIT ?`,
    limit,
  ).map((item) => ({
    ...item,
    signals: all<any>(
      `SELECT source_signal_id, signal_type, source, url, event_date, evidence, strength, mentionability, created_at
         FROM signal_events WHERE candidate_id = ? AND project_id = ? ORDER BY created_at DESC`,
      item.id,
      item.project_id,
    ),
    observations: all<any>(
      `SELECT source, source_lane_id, source_record_id, retrieved_at, evidence_json, raw_payload_json
         FROM source_observations WHERE candidate_id = ? ORDER BY retrieved_at DESC`,
      item.id,
    ).map((observation) => ({
      ...observation,
      evidence: parseJson(observation.evidence_json, []),
      raw_source_data: parseJson(observation.raw_payload_json, {}),
      evidence_json: undefined,
      raw_payload_json: undefined,
    })),
  }));
}

export function saveSignalEvents(items: unknown[]) {
  const parsed = items.map((item) => SignalEventInput.parse(item));
  const saved: { candidate_id: number; project_id: number; signal_event_id: number; action: 'inserted' | 'updated' }[] = [];
  tx(() => {
    for (const input of parsed) {
      const project = one<{ id: number }>('SELECT id FROM projects WHERE id = ? AND candidate_id = ?', input.project_id, input.candidate_id);
      if (!project) throw new Error(`project ${input.project_id} does not belong to candidate ${input.candidate_id}`);
      const existing = one<{ id: number }>(
        'SELECT id FROM signal_events WHERE source = ? AND source_signal_id = ?',
        input.source,
        input.source_signal_id,
      );
      if (existing) {
        run(
          `UPDATE signal_events SET candidate_id=?, project_id=?, signal_type=?, url=?, event_date=?, evidence=?, strength=?, mentionability=? WHERE id=?`,
          input.candidate_id, input.project_id, input.signal_type, input.url ?? null, input.event_date ?? null, input.evidence,
          input.strength ?? null, input.mentionability, existing.id,
        );
        saved.push({ candidate_id: input.candidate_id, project_id: input.project_id, signal_event_id: existing.id, action: 'updated' });
      } else {
        const result = run(
          `INSERT INTO signal_events(candidate_id, project_id, source_signal_id, signal_type, source, url, event_date,
            evidence, strength, mentionability, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          input.candidate_id, input.project_id, input.source_signal_id, input.signal_type, input.source,
          input.url ?? null, input.event_date ?? null, input.evidence, input.strength ?? null, input.mentionability, nowIso(),
        );
        saved.push({ candidate_id: input.candidate_id, project_id: input.project_id, signal_event_id: Number(result.lastInsertRowid), action: 'inserted' });
      }
    }
  });
  logRun('signal_refresh', { saved });
  return { saved };
}
