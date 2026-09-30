import { normalizeLinkedinUrl } from '../identity/linkedin.js';
import { getDb, logRun, nowIso, one, tx } from '../db/db.js';
import { CandidateImportRecord } from './contracts.js';

export function candidateDedupeKey(record: CandidateImportRecord): string {
  if (record.professional_profile_url) return `li:${normalizeLinkedinUrl(record.professional_profile_url)}`;
  if (record.email) return `email:${record.email.toLowerCase()}`;
  return `name:${record.person_name.toLowerCase()}|org:${(record.current_org ?? '').toLowerCase()}`;
}

export function ingestCandidates(input: {
  source: string;
  source_lane_id: string;
  records: CandidateImportRecord[];
}) {
  const records = input.records.map((record) => CandidateImportRecord.parse(record));
  const db = getDb();
  const insertCandidate = db.prepare(`INSERT INTO candidates(
    name, linkedin_url, email, phone, headline, current_role, current_org, org_url, location, dedupe_key, state, created_at, updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?, 'RAW', ?, ?)`);
  const updateCandidate = db.prepare(`UPDATE candidates SET
    name = ?, linkedin_url = COALESCE(?, linkedin_url), email = COALESCE(?, email), phone = COALESCE(?, phone),
    headline = COALESCE(?, headline), current_role = COALESCE(?, current_role), current_org = COALESCE(?, current_org),
    org_url = COALESCE(?, org_url), location = COALESCE(?, location), updated_at = ? WHERE id = ?`);
  const insertObservation = db.prepare(`INSERT OR IGNORE INTO source_observations(
    candidate_id, source, source_lane_id, source_record_id, retrieved_at, raw_payload_json, project_hint, org_hint, evidence_json
  ) VALUES (?,?,?,?,?,?,?,?,?)`);

  let inserted = 0;
  let updated = 0;
  let duplicateObservations = 0;
  const candidateIds: number[] = [];
  tx(() => {
    for (const record of records) {
      const key = candidateDedupeKey(record);
      const existing = one<{ id: number }>('SELECT id FROM candidates WHERE dedupe_key = ?', key);
      const at = nowIso();
      let candidateId: number;
      if (existing) {
        candidateId = existing.id;
        updateCandidate.run(
          record.person_name,
          record.professional_profile_url ?? null,
          record.email ?? null,
          record.phone ?? null,
          record.headline ?? null,
          record.current_role ?? null,
          record.current_org ?? null,
          record.org_url ?? null,
          record.location ?? null,
          at,
          candidateId,
        );
        updated++;
      } else {
        candidateId = Number(
          insertCandidate.run(
            record.person_name,
            record.professional_profile_url ?? null,
            record.email ?? null,
            record.phone ?? null,
            record.headline ?? null,
            record.current_role ?? null,
            record.current_org ?? null,
            record.org_url ?? null,
            record.location ?? null,
            key,
            at,
            at,
          ).lastInsertRowid,
        );
        inserted++;
      }
      const observation = insertObservation.run(
        candidateId,
        input.source,
        input.source_lane_id,
        record.source_record_id,
        record.retrieved_at ?? at,
        JSON.stringify(record.raw_source_data),
        record.project_name_if_visible ?? null,
        record.current_org ?? null,
        JSON.stringify(record.evidence),
      );
      if (Number(observation.changes) === 0) duplicateObservations++;
      candidateIds.push(candidateId);
    }
  });
  const result = {
    fetched: records.length,
    inserted,
    updated,
    duplicate_observations: duplicateObservations,
    candidate_ids: [...new Set(candidateIds)],
    source: input.source,
    source_lane_id: input.source_lane_id,
  };
  logRun('market_map_ingest', result);
  return result;
}
