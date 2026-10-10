// Keplerian two-body propagation from the orbital elements JPL's SBDB publishes.
export interface Elements {
  a: number; // AU
  e: number;
  i: number; // deg
  om: number; // longitude of ascending node, deg
  w: number; // argument of perihelion, deg
  ma: number; // mean anomaly at epoch, deg
  epoch?: number; // JD
}

const D2R = Math.PI / 180;
const AU_YR_TO_KMS = 4.740470446;
const OBLIQUITY = 23.4393 * D2R;

export function solveKepler(M: number, e: number): number {
  M = ((M % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  let E = e < 0.8 ? M : Math.PI;
  for (let k = 0; k < 40; k++) {
    const d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-12) break;
  }
  return E;
}

function rotate(el: Elements, x: number, y: number, z = 0): [number, number, number] {
  const i = el.i * D2R, om = el.om * D2R, w = el.w * D2R;
  const cw = Math.cos(w), sw = Math.sin(w), co = Math.cos(om), so = Math.sin(om), ci = Math.cos(i), si = Math.sin(i);
  const x1 = cw * x - sw * y;
  const y1 = sw * x + cw * y;
  const x2 = x1;
  const y2 = ci * y1 - si * z;
  const z2 = si * y1 + ci * z;
  return [co * x2 - so * y2, so * x2 + co * y2, z2];
}

export function meanMotion(a: number): number {
  return (2 * Math.PI) / Math.pow(a, 1.5); // rad / year
}

/** Heliocentric ecliptic position (AU) at mean anomaly M (rad). */
export function positionAtM(el: Elements, M: number): [number, number, number] {
  const E = solveKepler(M, el.e);
  const x = el.a * (Math.cos(E) - el.e);
  const y = el.a * Math.sqrt(1 - el.e * el.e) * Math.sin(E);
  return rotate(el, x, y);
}

export function orbitPath(el: Elements, n = 240): [number, number, number][] {
  const pts: [number, number, number][] = [];
  for (let k = 0; k <= n; k++) pts.push(positionAtM(el, (k / n) * 2 * Math.PI));
  return pts;
}

export interface Encounter {
  nuStar: number; // true anomaly of the encounter point
  Mstar: number; // mean anomaly there (rad)
  lambda: number; // heliocentric longitude of encounter (rad)
  r: number;
  vInf: number; // km/s
  radiantDec: number; // deg, declination of approach direction
  radiantRA: number; // deg
  crossesEarthOrbit: boolean;
}

/** Where the orbit meets Earth's orbit (1 AU), and the encounter geometry there. */
export function encounter(el: Elements): Encounter {
  const p = el.a * (1 - el.e * el.e);
  let cosNu = el.e > 1e-6 ? (p - 1) / el.e : 1;
  const crosses = Math.abs(cosNu) <= 1;
  cosNu = Math.max(-1, Math.min(1, cosNu));
  const nu = Math.acos(cosNu); // outbound branch; inbound would be -nu
  const E = 2 * Math.atan2(Math.sqrt(1 - el.e) * Math.sin(nu / 2), Math.sqrt(1 + el.e) * Math.cos(nu / 2));
  const Mstar = E - el.e * Math.sin(E);
  const r = p / (1 + el.e * Math.cos(nu));
  const xp = r * Math.cos(nu), yp = r * Math.sin(nu);
  const [px, py] = rotate(el, xp, yp);
  const lambda = Math.atan2(py, px);
  const mu = 4 * Math.PI * Math.PI;
  const k = Math.sqrt(mu / p);
  const [vx, vy, vz] = rotate(el, -k * Math.sin(nu), k * (el.e + Math.cos(nu)));
  const vE = 2 * Math.PI;
  const evx = -vE * Math.sin(lambda), evy = vE * Math.cos(lambda);
  const rx = vx - evx, ry = vy - evy, rz = vz;
  const mag = Math.hypot(rx, ry, rz);
  // Approach direction on the sky: the asteroid comes *from* -v_rel.
  const ux = -rx / mag, uy = -ry / mag, uz = -rz / mag;
  const ye = uy * Math.cos(OBLIQUITY) - uz * Math.sin(OBLIQUITY);
  const ze = uy * Math.sin(OBLIQUITY) + uz * Math.cos(OBLIQUITY);
  return {
    nuStar: nu,
    Mstar,
    lambda,
    r,
    vInf: mag * AU_YR_TO_KMS,
    radiantDec: Math.asin(Math.max(-1, Math.min(1, ze))) / D2R,
    radiantRA: Math.atan2(ye, ux) / D2R,
    crossesEarthOrbit: crosses,
  };
}

/** Elements phased so the asteroid reaches the encounter point at game time T0 (years). */
export interface OrbitPhase {
  Mstar: number;
  n: number;
  lambdaStar: number;
  T0: number;
}

export function phaseFor(el: Elements, T0: number): OrbitPhase {
  const enc = encounter(el);
  return { Mstar: enc.Mstar, n: meanMotion(el.a), lambdaStar: enc.lambda, T0 };
}

export function asteroidAt(el: Elements, ph: OrbitPhase, t: number) {
  return positionAtM(el, ph.Mstar + ph.n * (t - ph.T0));
}

export function earthAt(ph: OrbitPhase, t: number): [number, number, number] {
  const ang = ph.lambdaStar + 2 * Math.PI * (t - ph.T0);
  return [Math.cos(ang), Math.sin(ang), 0];
}
