import { candidateDedupeKey, ingestCandidates } from './ingest.js';
import { MarketMapSnapshotRecord } from './contracts.js';
import { nowIso, one, run, tx, logRun } from '../db/db.js';
import { saveBoundaryQualifications } from './qualification.js';
import { saveSignalEvents } from './signals.js';

export function syncMarketMapSnapshot(rawRecords: unknown[]) {
  const records = rawRecords.map((record) => MarketMapSnapshotRecord.parse(record));
  const groups = new Map<string, typeof records>();
  for (const record of records) {
    const key = `${record.source}\u0000${record.source_lane_id}`;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  for (const group of groups.values()) {
    ingestCandidates({
      source: group[0]!.source,
      source_lane_id: group[0]!.source_lane_id,
      records: group.map((record) => ({
        ...record.candidate,
        source_record_id: record.source_observation_id,
        raw_source_data: {
          ...record.candidate.raw_source_data,
          external_candidate_id: record.external_candidate_id,
          external_project_id: record.project.external_project_id,
          external_qualification_id: record.qualification.external_qualification_id,
        },
      })),
    });
  }

  let projectsInserted = 0;
  let projectsUpdated = 0;
  let qualificationsInserted = 0;
  let qualificationsUpdated = 0;
  const signalInputs: unknown[] = [];
  for (const record of records) {
    const candidate = one<{ id: number; state: string }>(
      'SELECT id, state FROM candidates WHERE dedupe_key = ?',
      candidateDedupeKey({ ...record.candidate, source_record_id: record.source_observation_id }),
    );
    if (!candidate) throw new Error(`candidate ${record.external_candidate_id} was not ingested`);
    run('UPDATE candidates SET external_id = ?, updated_at = ? WHERE id = ?', record.external_candidate_id, nowIso(), candidate.id);

    const existingProject = one<{ id: number }>('SELECT id FROM projects WHERE external_id = ?', record.project.external_project_id);
    const projectId = tx(() => {
      const values = [
        record.project.name ?? null, record.project.url ?? null, record.project.description ?? null,
        record.project.kernel_primary, record.project.kernel_secondary ?? null, record.project.project_visibility,
        record.project.project_alignment, record.project.status ?? null, JSON.stringify(record.project.evidence), nowIso(),
      ];
      if (existingProject) {
        run(
          `UPDATE projects SET name=?, url=?, description=?, kernel_primary=?, kernel_secondary=?, project_visibility=?,
            project_alignment=?, status=?, evidence_json=?, updated_at=? WHERE id=?`,
          ...values, existingProject.id,
        );
        projectsUpdated++;
        return existingProject.id;
      }
      const result = run(
        `INSERT INTO projects(external_id, candidate_id, name, url, description, kernel_primary, kernel_secondary,
          project_visibility, project_alignment, status, evidence_json, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        record.project.external_project_id, candidate.id, ...values.slice(0, 9), nowIso(), values[9],
      );
      projectsInserted++;
      return Number(result.lastInsertRowid);
    });

    const existingQualification = one<{ id: number; boundary_status: string }>(
      'SELECT id, boundary_status FROM boundary_qualifications WHERE source_qualification_id = ?',
      record.qualification.external_qualification_id,
    );
    if (existingQualification) {
      const q = record.qualification;
      if (
        q.boundary_status === 'PASS_OUTBOUND_V1' &&
        (record.project.project_alignment === 'MISALIGNED_WITH_PROFESSIONAL_IDENTITY' || q.professional_project_visibility === 'MISALIGNED')
      ) throw new Error('MISALIGNED_WITH_PROFESSIONAL_IDENTITY cannot be PASS_OUTBOUND_V1');
      run(
        `UPDATE boundary_qualifications SET candidate_id=?, project_id=?, boundary_version=?, boundary_status=?,
          project_real=?, strategic_authority=?, ambition=?, intrinsic_complexity=?, professional_project_visibility=?,
          kernel_primary=?, kernel_secondary=?, failed_gates_json=?, missing_evidence_json=?, evidence_summary=?,
          confidence=?, reasoning=? WHERE id=?`,
        candidate.id, projectId, q.boundary_version, q.boundary_status, q.project_real, q.strategic_authority,
        q.ambition, q.intrinsic_complexity, q.professional_project_visibility, q.kernel_primary, q.kernel_secondary ?? null,
        JSON.stringify(q.failed_gates), JSON.stringify(q.missing_evidence), q.evidence_summary, q.confidence, q.reasoning,
        existingQualification.id,
      );
      if (existingQualification.boundary_status !== q.boundary_status) {
        run('UPDATE candidates SET state = ?, updated_at = ? WHERE id = ?', q.boundary_status, nowIso(), candidate.id);
      }
      qualificationsUpdated++;
    } else {
      const saved = saveBoundaryQualifications([{ ...record.qualification, candidate_id: candidate.id, project_id: projectId }]);
      run(
        'UPDATE boundary_qualifications SET source_qualification_id = ? WHERE id = ?',
        record.qualification.external_qualification_id,
        saved.saved[0]!.qualification_id,
      );
      qualificationsInserted++;
    }
    for (const signal of record.signals) {
      signalInputs.push({
        ...signal,
        candidate_id: candidate.id,
        project_id: projectId,
        source_signal_id: signal.external_signal_id,
      });
    }
  }
  const signals = signalInputs.length ? saveSignalEvents(signalInputs) : { saved: [] };
  const result = {
    records: records.length,
    candidates: records.length,
    projects_inserted: projectsInserted,
    projects_updated: projectsUpdated,
    qualifications_inserted: qualificationsInserted,
    qualifications_updated: qualificationsUpdated,
    signals_synced: signals.saved.length,
  };
  logRun('market_map_snapshot_sync', result);
  return result;
}
