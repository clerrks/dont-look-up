import { evaluate, resolve } from '../src/sim/model';
import { buildScenario } from '../src/game';
import { FALLBACK_CATALOG } from '../src/data/fallback';
for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
  const sc = buildScenario(FALLBACK_CATALOG[0], 'standard', { seed });
  const c = evaluate(sc, [], sc.leadYears - 0.001).state;
  const r = resolve(sc, [], () => true);
  console.log(`seed ${seed} willHit=${sc.willHit} endCenter xi=${c.center.xi.toFixed(2)} z=${c.center.zeta.toFixed(2)} tau=${c.center.tau.toFixed(2)} sig=${c.sigma.xi.toFixed(3)}/${c.sigma.zeta.toFixed(3)} | truthBase xi=${r.basePos.xi.toFixed(2)} z=${r.basePos.zeta.toFixed(2)} tau=${r.basePos.tau.toFixed(2)} hit=${r.hit}`);
}
