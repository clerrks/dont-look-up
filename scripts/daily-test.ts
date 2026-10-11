import { dailyScenario, DAILY_BUDGET_B } from '../src/daily';
import { resolve, kineticPlan, riskWithPush, computeApplied, OBS, KINETIC as K, type Decision } from '../src/sim/model';

const land = () => true;
const a = dailyScenario('2026-10-10'), b = dailyScenario('2026-10-10');
console.log('deterministic', JSON.stringify([a.name, a.diameterM, a.leadYears, a.seed, a.budgetB, a.bImp]) === JSON.stringify([b.name, b.diameterM, b.leadYears, b.seed, b.budgetB, b.bImp]), a.name, a.diameterM, 'm lead', a.leadYears, 'budget', a.budgetB, 'daily', a.daily, DAILY_BUDGET_B);

function play(day: string, telescopes: boolean) {
  const sc = dailyScenario(day);
  const decs: Decision[] = [];
  let budget = sc.budgetB, n = 0;
  if (telescopes) for (const k of ['space', 'ground'] as const) { const o = OBS[k]; if (budget >= o.costB) { decs.push({ id: 'o' + decs.length, kind: 'obs', t: 0, costB: o.costB, label: '', bonusYears: o.bonusYears, durYears: o.durYears }); budget -= o.costB; } }
  for (let t = 0; t < sc.leadYears - 0.2; t += 1 / 12) {
    const kp = kineticPlan(sc, 'standard', t);
    if (!kp.feasible || budget < K.standard.costB || n >= 4) continue;
    const ap = computeApplied(sc, decs);
    const r = riskWithPush(sc, decs, t, ap, kp.expectedR, kp.interceptT);
    if (r.before > 0.12 && r.after < 0.6 * r.before) { decs.push({ id: 'k' + decs.length, kind: 'kinetic', t, costB: K.standard.costB, label: '', tier: 'standard', interceptT: kp.interceptT }); budget -= K.standard.costB; n++; }
  }
  const r = resolve(sc, decs, land);
  return { saved: !r.hit, n, score: r.score.total };
}
for (const tele of [false, true]) {
  let saved = 0, sum = 0; const tot = 60;
  for (let i = 0; i < tot; i++) {
    const day = new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10);
    const r = play(day, tele); saved += r.saved ? 1 : 0; sum += r.score;
  }
  console.log('telescopes', tele, 'saved', saved + '/' + tot, 'avg score', Math.round(sum / tot));
}
let none = 0; for (let i = 0; i < 60; i++) { const day = new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10); const sc = dailyScenario(day); none += resolve(sc, [], land).hit ? 1 : 0; }
console.log('no action hits', none + '/60');
