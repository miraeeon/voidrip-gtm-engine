import { all } from '../db/db.js';

export type OperationalKernel = 'VENTURE' | 'HARDWARE' | 'RESEARCH' | 'MEDIA';

interface SourceLaneDefinition {
  id: 'V-A' | 'H-A2' | 'R-A2' | 'M-B';
  kernel: OperationalKernel;
  role: 'PRIMARY' | 'SECONDARY';
  sources: readonly string[];
  queryFamilyNamespace: string;
  retrievalContract: string;
  requiredFields: readonly string[];
  activationExclusions: readonly string[];
}

const SOURCE_LANES: readonly SourceLaneDefinition[] = [
  {
    id: 'V-A',
    kernel: 'VENTURE',
    role: 'PRIMARY',
    sources: ['YC public company directory — Developer Tools'],
    queryFamilyNamespace: 'BF-V',
    retrievalContract: 'Collect company, founder and visible project records broadly; preserve the YC batch and current-program evidence.',
    requiredFields: ['person_name', 'professional_profile_url', 'current_org', 'project_name_if_visible', 'source_record_id'],
    activationExclusions: ['current YC participation', 'MVP or launch without a distinct unresolved structural need'],
  },
  {
    id: 'H-A2',
    kernel: 'HARDWARE',
    role: 'PRIMARY',
    sources: ['YC public company directory — Hardware'],
    queryFamilyNamespace: 'BF-H',
    retrievalContract: 'Collect founders tied to a visible physical system; preserve company, product and batch evidence.',
    requiredFields: ['person_name', 'professional_profile_url', 'current_org', 'project_name_if_visible', 'project_description_if_visible'],
    activationExclusions: ['current YC participation', 'a shipped prototype or product without a distinct unresolved structural need'],
  },
  {
    id: 'R-A2',
    kernel: 'RESEARCH',
    role: 'SECONDARY',
    sources: ['ORCID public API', 'public research-program and project pages'],
    queryFamilyNamespace: 'BF-R',
    retrievalContract: 'Collect independent researchers with recent work, a visible program and a resolvable professional identity.',
    requiredFields: ['person_name', 'professional_profile_url', 'project_name_if_visible', 'project_url_if_visible', 'evidence'],
    activationExclusions: ['publication activity alone', 'institutional profile without strategic project authority'],
  },
  {
    id: 'M-B',
    kernel: 'MEDIA',
    role: 'SECONDARY',
    sources: ['4A', 'Onassis AiR / ONX', 'IDFA', 'Biennale Immersive'],
    queryFamilyNamespace: 'BF-M',
    retrievalContract: 'Start from the selected creative structures, resolve the artist or studio and the named complex universe project.',
    requiredFields: ['person_name', 'professional_profile_url', 'project_name_if_visible', 'project_url_if_visible', 'evidence'],
    activationExclusions: ['program participation alone', 'artistic complexity without an explicit current structural need'],
  },
];

interface LaneStatsRow {
  source_lane_id: string;
  candidates: number;
  observations: number;
  pass_outbound: number;
}

function laneStats(): Map<string, LaneStatsRow> {
  const rows = all<LaneStatsRow>(
    `SELECT so.source_lane_id,
            COUNT(DISTINCT so.candidate_id) candidates,
            COUNT(DISTINCT so.id) observations,
            COUNT(DISTINCT CASE WHEN b.boundary_status = 'PASS_OUTBOUND_V1' THEN so.candidate_id END) pass_outbound
       FROM source_observations so
       LEFT JOIN projects p ON p.candidate_id = so.candidate_id
       LEFT JOIN boundary_qualifications b ON b.id = (
         SELECT MAX(b2.id) FROM boundary_qualifications b2 WHERE b2.project_id = p.id
       )
      GROUP BY so.source_lane_id`,
  );
  return new Map(rows.map((row) => [row.source_lane_id, row]));
}

export function getSourceLaneCollectionPlan(input: { kernel?: OperationalKernel; target?: number } = {}) {
  const target = input.target ?? 20;
  const selected = SOURCE_LANES.filter((lane) => !input.kernel || lane.kernel === input.kernel);
  const stats = laneStats();
  return {
    version: 'SOURCE_LANE_COLLECTION_V1',
    purpose: 'Feed the persistent FIT stock before any intent research.',
    target_unique_candidates: target,
    execution_owner: 'CODEX',
    ingestion_tool: 'gtm_ingest_candidates',
    source_adapter_contract: 'normalized CSV/JSON records; provider choice remains optional',
    required_authorities: ['Need Territories', 'Derived Prospecting Persona', 'SOURCE STACK V1'],
    provider_requirements: [],
    optional_expanders: ['Apollo saved searches', 'Clay', 'SocialCrawl'],
    no_manual_person_discovery_fallback: true,
    lanes: selected.map((lane) => ({
      ...lane,
      existing_stock: stats.get(lane.id) ?? { candidates: 0, observations: 0, pass_outbound: 0 },
      run_steps: [
        'Execute only this lane and its governed query-family namespace.',
        'Normalize every kept result to the gtm_ingest_candidates contract.',
        'Preserve source URL, retrieval date, attractor or Need Territory basis and raw evidence.',
        'Do not infer intent during sourcing; unresolved evidence remains for Codex qualification.',
      ],
    })),
    exit_condition: `At least ${target} new unique candidates for the selected Kernel are ingested or the connector deficit is reported.`,
  };
}
