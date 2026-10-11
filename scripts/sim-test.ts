import { makeScenario, evaluate, resolve, oneInN, kineticPlan, KINETIC, type Decision, type Scenario } from '../src/sim/model';
import { encounter } from '../src/sim/orbit';

const land = () => true;
const apophis = { a: 0.9224, e: 0.1914, i: 3.34, om: 203.9, w: 126.7, ma: 100 };
const enc = encounter(apophis);
console.log('apophis enc vInf', enc.vInf.toFixed(2), 'dec', enc.radiantDec.toFixed(1));

function run(seed: number, D: number, lead: number, forceHit: boolean, label: string) {
  const sc = makeScenario({ name: 'T', designation: 'T', kind: 'whatif', diameterM: D, diameterNote: '', vInf: enc.vInf, leadYears: lead, seed, difficulty: 'standard', forceHit });
  const row: string[] = [];
  for (let k = 0; k <= 10; k++) {
    const t = (lead * k) / 10;
    const c = evaluate(sc, [], Math.min(t, lead - 0.001));
    row.push(`${t.toFixed(1)}:${oneInN(c.state.hitProb)}/s${c.state.sigma.zeta.toFixed(2)}`);
  }
  console.log(label, 'D', D, 'lead', lead, 'bImp', sc.bImp.toFixed(2), 'cruise', sc.cruiseYears.toFixed(2), 'hit', sc.willHit);
  console.log('  ', row.join(' '));
  const base = resolve(sc, [], land);
  console.log('   baseline hit', base.hit, 'deaths(M)', base.deathsM.toFixed(2), 'score', base.score.total);
  for (const [name, when, n] of [['1 std @0', 0, 1], ['2 std @0', 0, 2], ['2 std @30%', 0.3, 2], ['3 heavy @0', 0, 3]] as [string, number, number][]) {
    const t = lead * when;
    const decs: Decision[] = [];
    for (let j = 0; j < n; j++) {
      const tier = name.includes('heavy') ? 'heavy' : 'standard';
      const p = kineticPlan(sc, tier as any, t);
      decs.push({ id: 'k' + j, kind: 'kinetic', t, costB: KINETIC[tier as 'heavy'].costB, label: '', tier: tier as any, interceptT: p.interceptT });
    }
    const r = resolve(sc, decs, land);
    console.log(`   ${name}: hit=${r.hit} b=${r.bFinal.toFixed(2)} deaths=${r.deathsM.toFixed(2)} score=${r.score.total}`);
  }
}
run(11, 140, 8, true, 'A');
run(12, 140, 6, true, 'B');
run(13, 60, 5, true, 'C');
run(14, 300, 10, true, 'D');
run(15, 140, 7, false, 'E(miss)');
import { suggestLead } from '../src/sim/model';
for (const D of [30, 60, 100, 140, 200, 300]) console.log('lead for', D, suggestLead(D, 6, 'easy'), suggestLead(D, 6, 'standard'), suggestLead(D, 6, 'hard'));
import { riskWithPush, certaintyTime, lastLaunchTime, computeApplied } from '../src/sim/model';
{
  const sc = makeScenario({ name: 'T', designation: 'T', kind: 'whatif', diameterM: 120, diameterNote: '', vInf: 8, leadYears: 7, seed: 21, difficulty: 'standard', forceHit: true });
  const ap = computeApplied(sc, []);
  for (const t of [0, 1, 2, 3, 4]) {
    const kp = kineticPlan(sc, 'standard', t);
    if (!kp.feasible) continue;
    const r = riskWithPush(sc, [], t, ap, kp.expectedR, kp.interceptT);
    console.log('t', t, 'push', kp.expectedR.toFixed(2), 'before', oneInN(r.before), 'after', oneInN(r.after));
  }
  console.log('sure by', certaintyTime(sc, [], 0).toFixed(2), 'last launch', lastLaunchTime(sc).toFixed(2));
}

// ---- winnability: a sensible player (telescopes first, then launch once the risk cut is large)
import { OBS, OBS as _o, riskWithPush as rwp, KINETIC as K, computeApplied as ca } from '../src/sim/model';
function play(seed: number, diff: 'easy' | 'standard' | 'hard', D: number, lead: number, telescopes: boolean) {
  const sc = makeScenario({ name: 'T', designation: 'T', kind: 'whatif', diameterM: D, diameterNote: '', vInf: 9, leadYears: lead, seed, difficulty: diff, forceHit: true });
  const decs: Decision[] = [];
  let budget = sc.budgetB, n = 0;
  if (telescopes) for (const k of ['space', 'ground', 'space'] as const) { const o = OBS[k]; if (budget >= o.costB && decs.filter((d) => d.kind === 'obs').reduce((s, d) => s + (d.bonusYears ?? 0), 0) + o.bonusYears <= 2) { decs.push({ id: 'o' + decs.length, kind: 'obs', t: 0, costB: o.costB, label: '', bonusYears: o.bonusYears, durYears: o.durYears }); budget -= o.costB; } }
  for (let t = 0; t < lead - 0.2; t += 1 / 12) {
    const kp = kineticPlan(sc, 'standard', t);
    if (!kp.feasible || budget < K.standard.costB || n >= 4) continue;
    const ap = ca(sc, decs);
    const r = rwp(sc, decs, t, ap, kp.expectedR, kp.interceptT);
    if (r.before > 0.12 && r.after < 0.6 * r.before) { decs.push({ id: 'k' + decs.length, kind: 'kinetic', t, costB: K.standard.costB, label: '', tier: 'standard', interceptT: kp.interceptT }); budget -= K.standard.costB; n++; }
  }
  const r = resolve(sc, decs, land);
  return { saved: !r.hit, impactors: n, spent: r.spentB };
}
for (const diff of ['easy', 'standard', 'hard'] as const) {
  const D = diff === 'easy' ? 90 : diff === 'standard' ? 120 : 150;
  for (const tele of [false, true]) {
    let saved = 0, tot = 40, imp = 0;
    for (let s = 1; s <= tot; s++) {
      const lead = suggestLead(D, 9, diff);
      const r = play(s * 7 + 3, diff, D, lead, tele);
      saved += r.saved ? 1 : 0; imp += r.impactors;
    }
    console.log(diff, 'D', D, 'telescopes', tele, 'saved', saved + '/' + tot, 'avg impactors', (imp / tot).toFixed(1));
  }
}

// ---- no-action outcomes with the default hit rate
for (const diff of ['easy', 'standard', 'hard'] as const) {
  let hits = 0, killed = 0, ocean = 0, deaths = 0, n = 300;
  for (let s = 1; s <= n; s++) {
    const D = diff === 'easy' ? 80 : diff === 'standard' ? 120 : 150;
    const sc = makeScenario({ name: 'T', designation: 'T', kind: 'whatif', diameterM: D, diameterNote: '', vInf: 5 + (s % 12), leadYears: suggestLead(D, 9, diff), seed: s * 13 + 5, difficulty: diff });
    // land mask stand-in: treat latitudes within the tropics/mid-latitudes over a few longitudes as land (rough 30% land)
    const isLand = (lat: number, lon: number) => ((Math.floor((lon + 180) / 40) + Math.floor((lat + 90) / 30)) % 3) === 0;
    const r = resolve(sc, [], isLand);
    if (r.hit) hits++; if (r.hit && r.deathsM > 0.05) killed++; if (r.hit && r.ocean) ocean++; deaths += r.deathsM;
  }
  console.log(diff, 'no action: hit', Math.round((hits / n) * 100) + '%', 'deadly', Math.round((killed / n) * 100) + '%', 'ocean', Math.round((ocean / n) * 100) + '%', 'avg deaths M', (deaths / n).toFixed(1));
}
