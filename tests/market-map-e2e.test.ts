import { beforeEach, describe, expect, it } from 'vitest';
import { all, one } from '../src/db/db.js';
import { parseCandidateFile } from '../src/market-map/file-import.js';
import { ingestCandidates } from '../src/market-map/ingest.js';
import {
  getBoundaryQueue,
  getPriorityQueue,
  getResolutionQueue,
  saveActivationScores,
  saveBoundaryQualifications,
  saveProjectResolution,
} from '../src/market-map/qualification.js';
import { getMarketDraftingQueue, getMarketReviewQueue, saveCandidateSequence } from '../src/market-map/drafting.js';
import { freshEnv } from './helpers.js';

const record = (sourceRecordId: string) => ({
  source_record_id: sourceRecordId,
  person_name: 'Ari Builder',
  professional_profile_url: 'https://linkedin.com/in/ari-builder/',
  email: null,
  phone: null,
  headline: 'Founder and creative director',
  current_role: 'Founder',
  current_org: 'World Studio',
  org_url: 'https://world.example',
  location: 'Paris',
  project_name_if_visible: 'World One',
  project_url_if_visible: 'https://world.example/one',
  project_description_if_visible: 'A persistent narrative world across film and interactive media.',
  evidence: ['Founder profile links directly to the project.'],
  raw_source_data: { source_record_id: sourceRecordId },
});

describe('Market Map local E2E', () => {
  beforeEach(() => freshEnv());

  it('preserves observations and moves one Person + Project through local human review', () => {
    const first = ingestCandidates({ source: 'manual-json', source_lane_id: 'M-A', records: [record('m-1')] });
    const second = ingestCandidates({ source: 'manual-csv', source_lane_id: 'M-A', records: [record('m-2')] });
    expect(first.inserted).toBe(1);
    expect(second.updated).toBe(1);
    expect(one<{ n: number }>('SELECT COUNT(*) n FROM candidates')!.n).toBe(1);
    expect(one<{ n: number }>('SELECT COUNT(*) n FROM source_observations')!.n).toBe(2);

    const candidate = getResolutionQueue()[0]!;
    expect(candidate.observations).toHaveLength(2);
    const resolution = saveProjectResolution({
      candidate_id: candidate.id,
      name: 'World One',
      url: 'https://world.example/one',
      description: 'A persistent narrative world across film and interactive media.',
      kernel_primary: 'MEDIA',
      kernel_secondary: null,
      project_visibility: 'VISIBLE',
      project_alignment: 'SELF_OWNED_PROFESSIONAL_PROJECT',
      status: 'ACTIVE',
      evidence: ['Project is linked from the professional profile.'],
    });
    const boundaryQueue = getBoundaryQueue();
    expect(boundaryQueue.boundary.version).toBe('GTM_BOUNDARY_V1');
    expect(boundaryQueue.items[0]!.project_id).toBe(resolution.project_id);

    saveBoundaryQualifications([{
      candidate_id: candidate.id,
      project_id: resolution.project_id,
      boundary_version: 'GTM_BOUNDARY_V1',
      boundary_status: 'PASS_OUTBOUND_V1',
      kernel_primary: 'MEDIA',
      kernel_secondary: null,
      project_real: 'YES',
      strategic_authority: 'INDIVIDUAL',
      ambition: 'HIGH',
      intrinsic_complexity: 'HIGH',
      professional_project_visibility: 'ALIGNED',
      failed_gates: [],
      missing_evidence: [],
      evidence_summary: 'Named active project, visible artifacts and direct founder authority.',
      confidence: 'HIGH',
      reasoning: 'All Boundary gates are supported by explicit evidence.',
    }]);
    expect(getPriorityQueue()).toHaveLength(1);

    saveActivationScores([{
      candidate_id: candidate.id,
      project_id: resolution.project_id,
      intent_strength: null,
      freshness: 'UNKNOWN',
      priority_tier: 'B',
      route: 'linkedin',
      angle: 'complex world coherence',
      channel_plan: null,
      reasoning: 'Strong fit; no current intent signal, so keep priority conservative.',
    }]);
    expect(getMarketDraftingQueue().candidates).toHaveLength(1);

    const sequence = saveCandidateSequence({
      candidate_id: candidate.id,
      project_id: resolution.project_id,
      angle: 'complex world coherence',
      hook_type: 'company_trigger',
      status: 'final',
      critique: 'Uses only visible project evidence and asks a low-friction question.',
      steps: [
        { type: 'linkedin_invite', delay_days: 0, note: 'Your work on World One caught my eye — especially the way the universe spans film and interactive media.' },
        { type: 'linkedin_message', delay_days: 1, message: 'Curious how you currently keep the world, decisions and references coherent as it expands across formats?' },
      ],
    });
    expect(sequence.status).toBe('final');
    const review = getMarketReviewQueue();
    expect(review).toHaveLength(1);
    expect(review[0]).toMatchObject({ boundary_status: 'PASS_OUTBOUND_V1', priority_tier: 'B', review_status: 'pending' });
    expect(one<{ state: string }>('SELECT state FROM candidates WHERE id = ?', candidate.id)!.state).toBe('REVIEW_READY');
  });

  it('parses CSV and JSON batches and prevents misaligned outbound PASS', () => {
    const csv = 'source_record_id,person_name,professional_profile_url,current_org,project_name_if_visible\n' +
      'v-1,"Sam, Founder",https://linkedin.com/in/sam,Acme,Project Atlas\n';
    expect(parseCandidateFile(csv, 'batch.csv')[0]).toMatchObject({ person_name: 'Sam, Founder', source_record_id: 'v-1' });
    expect(parseCandidateFile(JSON.stringify([record('j-1')]), 'batch.json')).toHaveLength(1);

    const imported = ingestCandidates({ source: 'manual', source_lane_id: 'V-A', records: [record('v-2')] });
    const project = saveProjectResolution({
      candidate_id: imported.candidate_ids[0]!,
      name: 'Invisible Side Project',
      url: null,
      description: null,
      kernel_primary: 'VENTURE',
      kernel_secondary: null,
      project_visibility: 'NOT_VISIBLE',
      project_alignment: 'MISALIGNED_WITH_PROFESSIONAL_IDENTITY',
      status: null,
      evidence: [],
    });
    expect(() => saveBoundaryQualifications([{
      candidate_id: imported.candidate_ids[0]!,
      project_id: project.project_id,
      boundary_version: 'GTM_BOUNDARY_V1',
      boundary_status: 'PASS_OUTBOUND_V1',
      kernel_primary: 'VENTURE',
      kernel_secondary: null,
      project_real: 'UNKNOWN',
      strategic_authority: 'UNKNOWN',
      ambition: 'UNKNOWN',
      intrinsic_complexity: 'UNKNOWN',
      professional_project_visibility: 'MISALIGNED',
      failed_gates: [],
      missing_evidence: ['project evidence'],
      evidence_summary: 'No professionally aligned project evidence.',
      confidence: 'LOW',
      reasoning: 'Should not pass outbound.',
    }])).toThrow(/cannot be PASS_OUTBOUND_V1/);
    expect(all('SELECT * FROM boundary_qualifications')).toHaveLength(0);
  });
});
