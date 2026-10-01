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
import { saveSignalEvents } from '../src/market-map/signals.js';
import { syncMarketMapSnapshot } from '../src/market-map/snapshot.js';
import { getDailyBuffer } from '../src/market-map/daily-buffer.js';
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

    saveSignalEvents([{
      candidate_id: candidate.id,
      project_id: resolution.project_id,
      source_signal_id: 'signal-world-one-1',
      signal_type: 'EXPLICIT_STRUCTURAL_NEED',
      source: 'public-project-site',
      event_date: '2026-09-30',
      evidence: 'The founder explicitly says the project lacks a coherent structure across formats and asks for a structural method.',
      strength: 3,
      mentionability: 'YES',
    }]);

    saveActivationScores([{
      candidate_id: candidate.id,
      project_id: resolution.project_id,
      intent_strength: 3,
      freshness: 'RECENT',
      priority_tier: 'B',
      route: 'linkedin',
      angle: 'complex world coherence',
      channel_plan: null,
      reasoning: 'Strong fit plus a recent public project signal.',
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

  it('synchronizes a governed Market Map snapshot idempotently without provider action', () => {
    const snapshot = [{
      external_candidate_id: 'C-ARI',
      source: 'drive-market-map',
      source_lane_id: 'M-B',
      source_observation_id: 'SO-ARI-1',
      candidate: record('ignored'),
      project: {
        external_project_id: 'P-WORLD',
        name: 'World One',
        url: 'https://world.example/one',
        description: 'A persistent narrative world across film and interactive media.',
        kernel_primary: 'MEDIA' as const,
        kernel_secondary: null,
        project_visibility: 'VISIBLE' as const,
        project_alignment: 'SELF_OWNED_PROFESSIONAL_PROJECT' as const,
        status: 'ACTIVE',
        evidence: ['Project is visible from the professional identity.'],
      },
      qualification: {
        external_qualification_id: 'BQ-ARI-1',
        boundary_version: 'GTM_BOUNDARY_V1' as const,
        boundary_status: 'PASS_OUTBOUND_V1' as const,
        kernel_primary: 'MEDIA' as const,
        kernel_secondary: null,
        project_real: 'YES' as const,
        strategic_authority: 'INDIVIDUAL' as const,
        ambition: 'HIGH' as const,
        intrinsic_complexity: 'HIGH' as const,
        professional_project_visibility: 'ALIGNED' as const,
        failed_gates: [],
        missing_evidence: [],
        evidence_summary: 'Named project, visible body of work and direct strategic authority.',
        confidence: 'HIGH' as const,
        reasoning: 'Every outbound Boundary gate is supported.',
      },
      signals: [],
    }];
    expect(syncMarketMapSnapshot(snapshot).qualifications_inserted).toBe(1);
    expect(syncMarketMapSnapshot(snapshot).qualifications_inserted).toBe(0);
    expect(one<{ n: number }>('SELECT COUNT(*) n FROM candidates')!.n).toBe(1);
    expect(one<{ n: number }>('SELECT COUNT(*) n FROM projects')!.n).toBe(1);
    expect(one<{ n: number }>('SELECT COUNT(*) n FROM boundary_qualifications')!.n).toBe(1);
    expect(one<{ n: number }>('SELECT COUNT(*) n FROM source_observations')!.n).toBe(1);
    expect(getDailyBuffer(20)).toMatchObject({ target: 20, ready: 0, deficit: 20, complete: false, provider_action: 'NONE' });
  });

  it('requires an explicit unresolved structural need and excludes current YC participants', () => {
    const imported = ingestCandidates({ source: 'manual', source_lane_id: 'V-A', records: [record('guard-1')] });
    const project = saveProjectResolution({
      candidate_id: imported.candidate_ids[0]!, name: 'World One', url: 'https://world.example/one',
      description: 'Persistent cross-format world.', kernel_primary: 'MEDIA', kernel_secondary: null,
      project_visibility: 'VISIBLE', project_alignment: 'SELF_OWNED_PROFESSIONAL_PROJECT', status: 'ACTIVE', evidence: ['Visible project.'],
    });
    saveBoundaryQualifications([{
      candidate_id: imported.candidate_ids[0]!, project_id: project.project_id, boundary_version: 'GTM_BOUNDARY_V1',
      boundary_status: 'PASS_OUTBOUND_V1', kernel_primary: 'MEDIA', kernel_secondary: null, project_real: 'YES',
      strategic_authority: 'INDIVIDUAL', ambition: 'HIGH', intrinsic_complexity: 'HIGH', professional_project_visibility: 'ALIGNED',
      failed_gates: [], missing_evidence: [], evidence_summary: 'All gates evidenced.', confidence: 'HIGH', reasoning: 'All gates evidenced.',
    }]);
    const activation = {
      candidate_id: imported.candidate_ids[0]!, project_id: project.project_id, intent_strength: 5, freshness: 'CURRENT',
      priority_tier: 'A', route: 'linkedin', angle: 'world coherence', channel_plan: null, reasoning: 'Would otherwise qualify.',
    } as const;
    expect(() => saveActivationScores([activation])).toThrow(/requires explicit evidence of a current unresolved structural need/);

    saveSignalEvents([{
      candidate_id: imported.candidate_ids[0]!, project_id: project.project_id,
      source_signal_id: 'project-update', signal_type: 'PROJECT_UPDATE', source: 'project-site',
      event_date: '2026-09-30', evidence: 'The project launched a new feature.', strength: 4, mentionability: 'YES',
    }]);
    expect(() => saveActivationScores([activation])).toThrow(/requires explicit evidence of a current unresolved structural need/);

    saveSignalEvents([{
      candidate_id: imported.candidate_ids[0]!, project_id: project.project_id,
      source_signal_id: 'structural-need', signal_type: 'EXPLICIT_STRUCTURAL_NEED', source: 'founder-post',
      event_date: '2026-09-30', evidence: 'The founder explicitly says the project lacks a coherent system structure.', strength: 5, mentionability: 'YES',
    }, {
      candidate_id: imported.candidate_ids[0]!, project_id: project.project_id,
      source_signal_id: 'yc-current', signal_type: 'CURRENT_YC_PROGRAM', source: 'y-combinator',
      event_date: '2026-09-30', evidence: 'The founder is currently participating in the Y Combinator program.', strength: 5, mentionability: 'YES',
    }]);
    expect(() => saveActivationScores([activation])).toThrow(/excludes people currently in a Y Combinator program/);
  });
});
