// The daily challenge: the same asteroid, size, seed and (small) budget for everyone on a given UTC day.
import { FALLBACK_CATALOG } from './data/fallback';
import { buildScenario } from './game';
import { hashString } from './sim/rng';
import type { Scenario } from './sim/model';

export const DAILY_BUDGET_B = 2.4;

export function todayUTC(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function msUntilReset(now = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return next - now.getTime();
}

/** Built from the bundled catalogue, never from live data, so every player gets exactly the same round. */
export function dailyScenario(day: string): Scenario {
  const h = hashString('dlu:' + day);
  const base = FALLBACK_CATALOG[h % FALLBACK_CATALOG.length];
  const size = 120 + (h % 5) * 8;
  return buildScenario(base, 'hard', { seed: h || 1, forceHit: true, diameterOverride: size, budgetB: DAILY_BUDGET_B, daily: day });
}
