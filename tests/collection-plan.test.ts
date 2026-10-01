import { beforeEach, describe, expect, it } from 'vitest';
import { ingestCandidates } from '../src/market-map/ingest.js';
import { saveBoundaryQualifications, saveProjectResolution } from '../src/market-map/qualification.js';
import { getSignalCollectionPlan } from '../src/market-map/signal-collection.js';
import { saveSignalEvents } from '../src/market-map/signals.js';
import { getSourceLaneCollectionPlan } from '../src/market-map/source-lanes.js';
import { freshEnv } from './helpers.js';

describe('governed collection plans', () => {
  beforeEach(() => freshEnv());

  it('exposes the calibrated multi-source stack without an Apollo dependency or manual fallback', () => {
    const plan = getSourceLaneCollectionPlan({ target: 20 });
    expect(plan.lanes.map((lane) => lane.id)).toEqual(['V-A', 'H-A2', 'R-A2', 'M-B']);
    expect(plan.provider_requirements).toEqual([]);
    expect(plan.optional_expanders).toContain('Apollo saved searches');
    expect(plan.no_manual_person_discovery_fallback).toBe(true);
    expect(plan.lanes.find((lane) => lane.id === 'V-A')?.activationExclusions).toContain('current YC participation');
  });

  it('creates signal work only for a qualified named Person + Project', () => {
    const imported = ingestCandidates({
      source: 'governed-lane',
      source_lane_id: 'V-A',
      records: [{
        source_record_id: 'venture-1',
        person_name: 'Ari Builder',
        professional_profile_url: 'https://linkedin.com/in/ari-builder',
        current_org: 'World Studio',
        project_name_if_visible: 'World One',
        project_url_if_visible: 'https://world.example',
        evidence: ['Named founder and visible project.'],
        raw_source_data: {},
      }],
    });
    const candidateId = imported.candidate_ids[0]!;
    const project = saveProjectResolution({
      candidate_id: candidateId,
      name: 'World One',
      url: 'https://world.example',
      description: 'A complex product universe.',
      kernel_primary: 'VENTURE',
      kernel_secondary: null,
      project_visibility: 'VISIBLE',
      project_alignment: 'SELF_OWNED_PROFESSIONAL_PROJECT',
      status: 'ACTIVE',
      evidence: ['Project linked from professional identity.'],
    });
    saveBoundaryQualifications([{
      candidate_id: candidateId,
      project_id: project.project_id,
      boundary_version: 'GTM_BOUNDARY_V1',
      boundary_status: 'PASS_OUTBOUND_V1',
      kernel_primary: 'VENTURE',
      kernel_secondary: null,
      project_real: 'YES',
      strategic_authority: 'INDIVIDUAL',
      ambition: 'HIGH',
      intrinsic_complexity: 'HIGH',
      professional_project_visibility: 'ALIGNED',
      failed_gates: [],
      missing_evidence: [],
      evidence_summary: 'Visible named project and founder authority.',
      confidence: 'HIGH',
      reasoning: 'Every outbound gate is supported.',
    }]);

    const plan = getSignalCollectionPlan(20);
    expect(plan.discovery_of_new_people).toBe(false);
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]?.queries.every((query) => query.includes('World One'))).toBe(true);
    expect(plan.rejected_as_activation_proof).toContain('MVP or launch alone');
    expect(plan.deficit_rule).toMatch(/do not replace/i);

    saveSignalEvents([{
      candidate_id: candidateId,
      project_id: project.project_id,
      source_signal_id: 'yc-current-venture-1',
      signal_type: 'CURRENT_YC_PROGRAM',
      source: 'y-combinator',
      event_date: '2026-10-01',
      evidence: 'The founder is currently participating in the Y Combinator program.',
      strength: 5,
      mentionability: 'YES',
    }]);
    expect(getSignalCollectionPlan(20).candidates).toEqual([]);
  });
});
