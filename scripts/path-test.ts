import * as THREE from 'three';
import { makeScenario, groundPoint } from '../src/sim/model';
import { framePath, groundPointOf } from '../src/view/path';
import { latLonToVec3 } from '../src/view/geo';
const sc = makeScenario({ name: 'T', designation: 'T', kind: 'whatif', diameterM: 100, diameterNote: '', vInf: 9, leadYears: 6, seed: 5, difficulty: 'standard', forceHit: true });
for (const [xi, z, tau] of [[0.3, 0.5, 0], [-1.2, 0.8, 2.5], [1.5, -1.0, -3.1], [0.1, -0.2, 7]]) {
  const g = groundPoint(sc, xi, z, tau);
  const f = framePath(sc, xi, z, tau);
  const p = groundPointOf(f);
  const want = latLonToVec3(g.lat, g.lon, 1);
  console.log(f.hits, 'ground', g.lat.toFixed(2), g.lon.toFixed(2), 'err', p ? p.distanceTo(want).toFixed(5) : 'miss');
}
