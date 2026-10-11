import { resolve, kineticPlan, KINETIC as K, type Decision } from '../src/sim/model';
import { framePath } from '../src/view/path';
import { buildScenario } from '../src/game';
import { FALLBACK_CATALOG } from '../src/data/fallback';

const ll = (v: any) => `(${(Math.asin(v.y) * 180 / Math.PI).toFixed(0)},${(Math.atan2(v.x, v.z) * 180 / Math.PI).toFixed(0)})`;
for (const seed of [1, 2, 3, 4, 5, 6]) {
  const sc = buildScenario(FALLBACK_CATALOG[0], 'standard', { seed });
  const decs: Decision[] = [];
  for (const t of [0, 0.5]) { const p = kineticPlan(sc, 'standard', t); decs.push({ id: 'k' + t, kind: 'kinetic', t, costB: K.standard.costB, label: '', tier: 'standard', interceptT: p.interceptT } as any); }
  const r = resolve(sc, decs, () => true);
  const b = framePath(sc, r.basePos.xi, r.basePos.zeta, r.basePos.tau), f = framePath(sc, r.finalPos.xi, r.finalPos.zeta, r.finalPos.tau);
  console.log(`seed ${seed} willHit=${sc.willHit} base xi=${r.basePos.xi.toFixed(2)} z=${r.basePos.zeta.toFixed(2)} tau=${r.basePos.tau.toFixed(2)} R=${ll(b.R)} |O|=${b.O.length().toFixed(2)} | final xi=${r.finalPos.xi.toFixed(2)} z=${r.finalPos.zeta.toFixed(2)} tau=${r.finalPos.tau.toFixed(2)} R=${ll(f.R)} |O|=${f.O.length().toFixed(2)} hit=${r.hit} missKm=${Math.round(r.missKm)}`);
}
