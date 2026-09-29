import { z } from 'zod';
import { all, logRun, nowIso, one, run, today } from '../db/db.js';
import { getPlaybook, savePlaybook } from './playbook.js';
import { ensureSubscription, pauseSubscription } from './source.js';
import { setWeight } from './weights.js';

export const LearningInput = z.object({
  insights: z
    .array(
      z.object({
        finding: z.string().min(5).max(400),
        evidence: z.string().max(400).describe('numbers from gtm_get_performance backing this'),
        confidence: z.enum(['low', 'medium', 'high']),
        action: z.string().max(300).describe('what changes because of it'),
      }),
    )
    .min(1)
    .max(15),
  playbook_markdown: z.string().min(50).max(20_000).optional().describe('full updated playbook (omit to keep current)'),
  weights: z
    .record(z.string().regex(/^(signal|persona|route|angle|tier|hook):/), z.number().min(0).max(3))
    .optional()
    .describe('multipliers, 1 = neutral; e.g. {"signal:fundraising": 1.4, "persona:cmo": 0.8}'),
  subscription_changes: z
    .array(
      z.object({
        action: z.enum(['create', 'pause']),
        signal_slug: z.string().optional(),
        subscription_id: z.number().int().optional(),
        name: z.string().optional(),
        config: z.record(z.string(), z.unknown()).optional(),
        why: z.string().max(300),
      }),
    )
    .max(5)
    .optional(),
  apply_subscription_changes: z.boolean().default(false).describe('true = actually create/pause Max subscriptions (lead searching only)'),
});
export type LearningInput = z.infer<typeof LearningInput>;

export async function saveLearnings(raw: unknown) {
  const input = LearningInput.parse(raw);
  const simulated = (one<{ n: number }>('SELECT COUNT(*) n FROM outcomes WHERE is_simulated = 1')?.n ?? 0) > 0;
  let playbookVersion = getPlaybook().version;
  if (input.playbook_markdown) {
    playbookVersion = savePlaybook(input.playbook_markdown, `learn ${today()}${simulated ? ' (simulated data)' : ''}`).version;
  }
  for (const [k, v] of Object.entries(input.weights ?? {})) setWeight(k, v, `learn ${today()}`);

  const subResults: unknown[] = [];
  for (const ch of input.subscription_changes ?? []) {
    if (!input.apply_subscription_changes) {
      subResults.push({ ...ch, applied: false, note: 'suggestion only (apply_subscription_changes=false)' });
      continue;
    }
    try {
      if (ch.action === 'create' && ch.signal_slug) {
        subResults.push({ ...ch, applied: true, result: await ensureSubscription({ signal_slug: ch.signal_slug, name: ch.name ?? ch.signal_slug, config: ch.config }) });
      } else if (ch.action === 'pause' && ch.subscription_id) {
        subResults.push({ ...ch, applied: true, result: await pauseSubscription(ch.subscription_id) });
      } else subResults.push({ ...ch, applied: false, note: 'missing signal_slug / subscription_id' });
    } catch (e) {
      subResults.push({ ...ch, applied: false, error: (e as Error).message });
    }
  }

  run(
    'INSERT INTO learnings(run_date, insights_json, playbook_version, based_on_simulated, created_at) VALUES (?,?,?,?,?)',
    today(),
    JSON.stringify({ insights: input.insights, weights: input.weights ?? {}, subscription_changes: subResults }),
    playbookVersion,
    simulated ? 1 : 0,
    nowIso(),
  );
  const summary = {
    insights: input.insights.length,
    playbook_version: playbookVersion,
    weights_updated: Object.keys(input.weights ?? {}).length,
    subscription_changes: subResults,
    based_on_simulated: simulated,
  };
  logRun('learn', summary);
  return summary;
}

export function latestLearnings(limit = 3) {
  return all<any>('SELECT * FROM learnings ORDER BY id DESC LIMIT ?', limit).map((r) => ({
    run_date: r.run_date,
    playbook_version: r.playbook_version,
    based_on_simulated: !!r.based_on_simulated,
    ...JSON.parse(r.insights_json),
  }));
}
