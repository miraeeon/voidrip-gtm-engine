import { all } from '../db/db.js';

export const STRUCTURAL_NEED_SIGNAL_TYPES = [
  'EXPLICIT_STRUCTURAL_NEED',
  'RESTRUCTURING_NEED',
  'STRUCTURAL_PHASE_TRANSITION',
] as const;

export const CURRENT_YC_PROGRAM_SIGNAL_TYPES = [
  'CURRENT_YC_PROGRAM',
  'YC_2026_CURRENT_PROJECT',
] as const;

const quoted = (values: readonly string[]) => values.map((value) => `'${value}'`).join(',');

export function activationEligibleSignalSql(candidateExpression: string, projectExpression: string) {
  return `EXISTS (
    SELECT 1 FROM signal_events eligible_signal
     WHERE eligible_signal.candidate_id = ${candidateExpression}
       AND eligible_signal.project_id = ${projectExpression}
       AND eligible_signal.signal_type IN (${quoted(STRUCTURAL_NEED_SIGNAL_TYPES)})
  )`;
}

export function outsideCurrentYcProgramSql(candidateExpression: string, projectExpression: string) {
  return `NOT EXISTS (
    SELECT 1 FROM signal_events yc_signal
     WHERE yc_signal.candidate_id = ${candidateExpression}
       AND yc_signal.project_id = ${projectExpression}
       AND yc_signal.signal_type IN (${quoted(CURRENT_YC_PROGRAM_SIGNAL_TYPES)})
  )`;
}

export function getActivationEligibility(candidateId: number, projectId: number) {
  const signals = all<{ signal_type: string }>(
    'SELECT signal_type FROM signal_events WHERE candidate_id = ? AND project_id = ?',
    candidateId,
    projectId,
  );
  const types = new Set(signals.map((signal) => signal.signal_type));
  const eligibleSignalTypes = STRUCTURAL_NEED_SIGNAL_TYPES.filter((type) => types.has(type));
  const currentYcProgramSignals = CURRENT_YC_PROGRAM_SIGNAL_TYPES.filter((type) => types.has(type));
  return {
    eligible: eligibleSignalTypes.length > 0 && currentYcProgramSignals.length === 0,
    eligibleSignalTypes,
    currentYcProgramSignals,
  };
}
