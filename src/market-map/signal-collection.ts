import { getSignalQueue } from './signals.js';

function quoted(value: string): string {
  return `"${value.replaceAll('"', '')}"`;
}

function queriesFor(candidate: any): string[] {
  const person = quoted(candidate.name);
  const project = quoted(candidate.project_name);
  return [
    `${person} ${project}`,
    `${project} ("looking for" OR "seeking" OR "need help" OR "need a framework")`,
    `${project} (restructure OR rethink OR rebuild OR fragmented OR coherence)`,
    `site:linkedin.com/posts ${person} ${project}`,
    `${person} ${project} (interview OR newsletter) (challenge OR stuck OR direction)`,
    `${project} (roadmap OR architecture OR strategy) (problem OR challenge OR transition)`,
  ];
}

export function getSignalCollectionPlan(limit = 20) {
  const candidates = getSignalQueue(limit);
  return {
    version: 'SIGNAL_COLLECTION_V1',
    scope: 'QUALIFIED_PERSON_PROJECT_ONLY',
    discovery_of_new_people: false,
    purpose: 'Find attributable evidence of a current unresolved structural need after FIT qualification.',
    allowed_surfaces: ['professional posts', 'project site or changelog', 'interviews', 'public communities', 'GitHub or project repositories'],
    accepted_signal_types: ['EXPLICIT_STRUCTURAL_NEED', 'RESTRUCTURING_NEED', 'STRUCTURAL_PHASE_TRANSITION'],
    rejected_as_activation_proof: [
      'MVP or launch alone',
      'product update or feedback request alone',
      'accelerator or YC page alone',
      'program participation alone',
      'generic ambition or complexity without an unresolved need',
    ],
    evidence_rule: 'Save only a dated, attributable public observation whose wording supports the signal. Unknown evidence stays unknown.',
    candidates: candidates.map((candidate) => ({
      candidate_id: candidate.id,
      project_id: candidate.project_id,
      person_name: candidate.name,
      project_name: candidate.project_name,
      project_url: candidate.project_url,
      kernel: candidate.kernel_primary,
      queries: queriesFor(candidate),
      save_with: 'gtm_save_signal_events',
    })),
    deficit_rule: 'If no qualifying signal is found, report NO_SIGNAL_FOUND for this Person + Project; do not replace it with a newly discovered person.',
  };
}
