import { all, nowIso, run } from '../db/db.js';

/** Weights are multipliers (1 = neutral). Keys: signal:<slug>, persona:<p>, route:<r>, angle:<a>, tier:<t>. */
export function getWeights(prefix = ''): Record<string, number> {
  const rows = all<{ key: string; value: number }>('SELECT key, value FROM weights WHERE key LIKE ? ORDER BY key', `${prefix}%`);
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export function setWeight(key: string, value: number, note?: string): void {
  const v = Math.max(0, Math.min(3, value));
  run(
    'INSERT INTO weights(key, value, note, updated_at) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, note = excluded.note, updated_at = excluded.updated_at',
    key,
    v,
    note ?? null,
    nowIso(),
  );
}
