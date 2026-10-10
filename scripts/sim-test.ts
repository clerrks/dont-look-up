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
