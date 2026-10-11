import { dailyScenario } from '../src/daily';
import { evaluate } from '../src/sim/model';
import { framePath } from '../src/view/path';
import { buildScenario } from '../src/game';
import { FALLBACK_CATALOG } from '../src/data/fallback';

function trace(label: string, sc: any) {
  console.log('===', label, 'lead', sc.leadYears, 'bImp', sc.bImp.toFixed(2), 'est0', JSON.stringify(sc.est0), 'truth', JSON.stringify(sc.truth ?? sc.final ?? Object.keys(sc).filter(k=>/true|final|actual/i.test(k))));
  for (let k = 0; k <= 12; k++) {
    const t = Math.min(sc.leadYears - 0.01, (sc.leadYears * k) / 12);
    const c = evaluate(sc, [], t);
    const st = c.state;
    const f = framePath(sc, st.center.xi, st.center.zeta, st.center.tau);
    const Rlat = Math.asin(f.R.y) * 180 / Math.PI, Rlon = Math.atan2(f.R.x, f.R.z) * 180 / Math.PI;
    console.log(`t=${t.toFixed(2)} center xi=${st.center.xi.toFixed(2)} z=${st.center.zeta.toFixed(2)} tau=${st.center.tau.toFixed(2)}h  sig=${st.sigma.xi.toFixed(2)}/${st.sigma.zeta.toFixed(2)}  |O|=${f.O.length().toFixed(2)} R=(${Rlat.toFixed(0)},${Rlon.toFixed(0)}) hitP=${st.hitProb.toFixed(2)}`);
  }
}
trace('daily', dailyScenario('2026-10-10'));
for (const seed of [11, 12, 13]) trace('apophis dir seed ' + seed, buildScenario(FALLBACK_CATALOG[0], 'standard', { seed, forceHit: true }));
