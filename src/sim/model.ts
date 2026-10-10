// Planetary-defense simulation core. Pure functions, deterministic per scenario seed.
// Everything here is a *simplified* model: it behaves correctly (earlier is better,
// uncertainty shrinks with observation, direction matters) without research-grade accuracy.
import { CITIES, type City } from '../data/cities';
import { gauss, mulberry32 } from './rng';
import type { Elements } from './orbit';

export const R_EARTH_KM = 6371;
export const V_ESC = 11.186; // km/s
export const D2R = Math.PI / 180;
const SEC_PER_YEAR = 365.25 * 86400;
const MT_J = 4.184e15;
const SHAPE_P = 2.8; // how fast the uncertainty collapses as the arc grows
export const SAMPLES = 4200;

export interface Scenario {
  id: string;
  name: string;
  designation: string;
  kind: 'real' | 'whatif';
  diameterM: number;
  diameterNote: string;
  H?: number;
  vInf: number; // km/s
  vImpact: number; // km/s
  densityKgM3: number;
  massKg: number;
  leadYears: number;
  bImp: number; // effective impact radius in the b-plane, Earth radii
  willHit: boolean;
  truth0: { xi: number; zeta: number; tau: number };
  est0: { xi: number; zeta: number; tau: number };
  sigma0: { xi: number; zeta: number; tau: number };
  sigmaFloor: { xi: number; zeta: number; tau: number };
  radiant: { lat: number; lon: number; theta: number };
  beta: number; // momentum enhancement factor (unknown to the player)
  geom: number; // along-track to b-plane geometry factor
  cruiseYears: number;
  seed: number;
  orbit?: Elements;
  facts: string[];
  briefing?: string;
  difficulty: 'easy' | 'standard' | 'hard';
  startISO: string;
  budgetB: number;
}

export type KineticTier = 'light' | 'standard' | 'heavy';
export const KINETIC: Record<KineticTier, { label: string; massKg: number; costB: number; blurb: string }> = {
  light: { label: 'Light impactor', massKg: 1000, costB: 0.4, blurb: '1 tonne, DART-class' },
  standard: { label: 'Standard impactor', massKg: 3000, costB: 0.7, blurb: '3 tonnes' },
  heavy: { label: 'Heavy impactor', massKg: 8000, costB: 1.3, blurb: '8 tonnes, heavy-lift launch' },
};
export const TRACTOR = { massKg: 30000, costB: 1.4, label: 'Gravity tractor' };
export const OBS = {
  ground: { label: 'Ground survey push', costB: 0.12, bonusYears: 0.3, durYears: 0.25 },
  space: { label: 'Space telescope time', costB: 0.45, bonusYears: 0.8, durYears: 0.5 },
};
export const EVAC_COST_B = 0.04;
export const MAX_OBS_BONUS = 2.0;
export const IMPACTOR_SPEED_KMS = 6.1;

export interface Decision {
  id: string;
  kind: 'obs' | 'kinetic' | 'tractor' | 'evac';
  t: number; // game time of the order, years
  costB: number;
  label: string;
  // obs
  bonusYears?: number;
  durYears?: number;
  // kinetic
  tier?: KineticTier;
  interceptT?: number;
  // tractor
  arriveT?: number;
  endT?: number;
  // evac
  cityId?: string;
}

export interface Applied {
  id: string;
  kind: 'kinetic' | 'tractor';
  t0: number; // intercept or arrival time
  dir: [number, number]; // unit vector in the b-plane
  fullR: number; // actual displacement at impact (Earth radii) when complete
  nominalR: number; // what the team *predicts* (nominal beta)
  tractor?: { a: number; t0: number; t1: number };
  measuredAt: number;
}

const unit = (x: number, y: number): [number, number] => {
  const m = Math.hypot(x, y);
  return m < 1e-9 ? [1, 0] : [x / m, y / m];
};

export function massFromDiameter(dM: number, rho: number) {
  return (rho * Math.PI * dM ** 3) / 6;
}

export function bImpactRadius(vInf: number) {
  return Math.sqrt(1 + (V_ESC / vInf) ** 2);
}

function obsBonus(decs: Decision[], t: number): number {
  let b = 0;
  for (const d of decs) {
    if (d.kind !== 'obs') continue;
    const f = Math.max(0, Math.min(1, (t - d.t) / (d.durYears ?? 0.25)));
    b += (d.bonusYears ?? 0) * f;
  }
  return Math.min(MAX_OBS_BONUS, b);
}

/** Fraction of the original uncertainty that remains at game time t. */
export function remaining(sc: Scenario, decs: Decision[], t: number): number {
  const s = Math.min(t + obsBonus(decs, t), sc.leadYears - 0.004);
  return Math.pow(Math.max(0, 1 - s / sc.leadYears), SHAPE_P);
}

function sigmaAt(sc: Scenario, f: number) {
  const m = (k: 'xi' | 'zeta' | 'tau') => sc.sigmaFloor[k] + (sc.sigma0[k] - sc.sigmaFloor[k]) * f;
  return { xi: m('xi'), zeta: m('zeta'), tau: m('tau') };
}

function deflectionR(sc: Scenario, massKg: number, beta: number, remainingYears: number): number {
  const dv = (beta * massKg * IMPACTOR_SPEED_KMS * 1000) / sc.massKg; // m/s
  const ds = 3 * dv * remainingYears * SEC_PER_YEAR; // along-track displacement, m
  return (sc.geom * ds) / (R_EARTH_KM * 1000);
}

function tractorAccel(sc: Scenario, massKg: number) {
  const d = 0.8 * sc.diameterM; // hover a little outside the surface
  return (6.674e-11 * massKg) / (d * d);
}

function tractorDisplacementR(sc: Scenario, a: number, t0: number, t1: number, t: number): number {
  const tc = Math.min(t, t1);
  const tau = Math.max(0, tc - t0);
  const rem = sc.leadYears - tc;
  const ds = 3 * a * SEC_PER_YEAR * SEC_PER_YEAR * tau * (rem + tau / 2);
  return (sc.geom * ds) / (R_EARTH_KM * 1000);
}

export const NOMINAL_BETA = 2.0;

function errScaleVec(sc: Scenario, f: number) {
  return { xi: (sc.est0.xi - sc.truth0.xi) * f, zeta: (sc.est0.zeta - sc.truth0.zeta) * f, tau: (sc.est0.tau - sc.truth0.tau) * f };
}

function currentTruth(sc: Scenario, applied: Applied[], t: number): { xi: number; zeta: number } {
  let xi = sc.truth0.xi, zeta = sc.truth0.zeta;
  for (const a of applied) {
    const r = a.kind === 'kinetic' ? (t >= a.t0 ? a.fullR : 0) : a.tractor ? tractorDisplacementR(sc, a.tractor.a, a.tractor.t0, a.tractor.t1, t) : 0;
    xi += a.dir[0] * r;
    zeta += a.dir[1] * r;
  }
  return { xi, zeta };
}

/** The team's best estimate of the impact-plane position at game time t. */
function estimateAt(sc: Scenario, decs: Decision[], applied: Applied[], t: number) {
  const f = remaining(sc, decs, t);
  const err = errScaleVec(sc, f);
  const tr = currentTruth(sc, applied, t);
  let xi = tr.xi + err.xi, zeta = tr.zeta + err.zeta;
  let extra = 0;
  for (const a of applied) {
    if (a.kind !== 'kinetic' || t < a.t0 || t >= a.measuredAt) continue;
    // before the follow-up observations, the team only knows the nominal result
    xi += a.dir[0] * (a.nominalR - a.fullR);
    zeta += a.dir[1] * (a.nominalR - a.fullR);
    extra += 0.35 * Math.abs(a.fullR);
  }
  return { xi, zeta, tau: sc.truth0.tau + err.tau, extra };
}

export function computeApplied(sc: Scenario, decs: Decision[]): Applied[] {
  const mobile = decs
    .filter((d) => d.kind === 'kinetic' || d.kind === 'tractor')
    .map((d) => ({ d, t0: d.kind === 'kinetic' ? d.interceptT! : d.arriveT! }))
    .sort((a, b) => a.t0 - b.t0);
  const applied: Applied[] = [];
  for (const { d, t0 } of mobile) {
    // a tractor can re-point as the orbit firms up; model that by steering with the estimate 60% of the way through the tow
    const tSteer = d.kind === 'tractor' ? t0 + 0.6 * (d.endT! - t0) : t0;
    const est = estimateAt(sc, decs, applied, tSteer);
    const dir = unit(est.xi, est.zeta);
    if (d.kind === 'kinetic') {
      const m = KINETIC[d.tier!].massKg;
      applied.push({
        id: d.id, kind: 'kinetic', t0, dir,
        fullR: deflectionR(sc, m, sc.beta, sc.leadYears - t0),
        nominalR: deflectionR(sc, m, NOMINAL_BETA, sc.leadYears - t0),
        measuredAt: t0 + 0.15,
      });
    } else {
      const a = tractorAccel(sc, TRACTOR.massKg);
      applied.push({ id: d.id, kind: 'tractor', t0, dir, fullR: 0, nominalR: 0, tractor: { a, t0, t1: d.endT! }, measuredAt: t0 });
    }
  }
  return applied;
}

export interface State {
  t: number;
  remainingFrac: number;
  sigma: { xi: number; zeta: number; tau: number };
  center: { xi: number; zeta: number; tau: number };
  hitProb: number;
  applied: Applied[];
  truth: { xi: number; zeta: number };
  weightPeak: number;
}

export interface Corridor {
  lat: Float32Array;
  lon: Float32Array;
  alpha: Float32Array; // 0..1 relative density
  count: number;
  centroid: { lat: number; lon: number } | null;
  state: State;
}

const GOLDEN = 2.399963229728653;
function diskSamples(seed: number) {
  const u = new Float32Array(SAMPLES), v = new Float32Array(SAMPLES), zt = new Float32Array(SAMPLES);
  const zx = new Float32Array(SAMPLES), zz = new Float32Array(SAMPLES);
  const rng = mulberry32(seed ^ 0x9e3779b9);
  for (let i = 0; i < SAMPLES; i++) {
    const r = Math.sqrt((i + 0.5) / SAMPLES);
    const th = i * GOLDEN;
    u[i] = r * Math.cos(th);
    v[i] = r * Math.sin(th);
    zt[i] = gauss(rng);
    zx[i] = gauss(rng);
    zz[i] = gauss(rng);
  }
  return { n: SAMPLES, u, v, zt, zx, zz };
}
const diskBySeed = new Map<number, ReturnType<typeof diskSamples>>();
function disk(seed: number) {
  let d = diskBySeed.get(seed);
  if (!d) {
    d = diskSamples(seed);
    diskBySeed.set(seed, d);
  }
  return d;
}

/** Map a b-plane position (Earth radii) + arrival-time offset (hours) to a ground point. */
export function groundPoint(sc: Scenario, xi: number, zeta: number, tauH: number): { lat: number; lon: number } {
  const th = sc.radiant.theta;
  const x = (xi * Math.cos(th) - zeta * Math.sin(th)) / sc.bImp;
  const y = (xi * Math.sin(th) + zeta * Math.cos(th)) / sc.bImp;
  const rho = Math.min(1, Math.hypot(x, y));
  const c = Math.asin(rho);
  const lat0 = sc.radiant.lat * D2R;
  let lat = lat0, dlon = 0;
  if (rho > 1e-9) {
    lat = Math.asin(Math.cos(c) * Math.sin(lat0) + (y * Math.sin(c) * Math.cos(lat0)) / rho);
    dlon = Math.atan2(x * Math.sin(c), rho * Math.cos(lat0) * Math.cos(c) - y * Math.sin(lat0) * Math.sin(c));
  }
  let lon = sc.radiant.lon + dlon / D2R - 15.041 * tauH;
  lon = ((lon + 540) % 360) - 180;
  return { lat: lat / D2R, lon };
}

function erf(x: number): number {
  const s = Math.sign(x);
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
const Phi = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2));

/** P(impact) for a Gaussian posterior over the b-plane and a disk of radius b. */
export function hitProbability(mx: number, mz: number, sx: number, sz: number, b: number): number {
  const lo = Math.max(-b, mx - 6 * sx), hi = Math.min(b, mx + 6 * sx);
  if (lo >= hi) return 0;
  const N = 500;
  const h = (hi - lo) / N;
  let P = 0;
  for (let i = 0; i < N; i++) {
    const xi = lo + (i + 0.5) * h;
    const c = Math.sqrt(Math.max(0, b * b - xi * xi));
    const px = Math.exp(-0.5 * ((xi - mx) / sx) ** 2) / (sx * Math.sqrt(2 * Math.PI));
    P += px * (Phi((c - mz) / sz) - Phi((-c - mz) / sz)) * h;
  }
  return Math.max(0, Math.min(1, P));
}

export function evaluate(sc: Scenario, decs: Decision[], t: number, applied?: Applied[]): Corridor {
  const ap = applied ?? computeApplied(sc, decs);
  const f = remaining(sc, decs, t);
  const est = estimateAt(sc, decs, ap, t);
  const sg = sigmaAt(sc, f);
  const sXi = Math.hypot(sg.xi, est.extra * 0.6);
  const sZeta = Math.hypot(sg.zeta, est.extra);
  const peak = 1 / (2 * Math.PI * sXi * sZeta);
  const d = disk(sc.seed);
  const lat = new Float32Array(SAMPLES), lon = new Float32Array(SAMPLES), alpha = new Float32Array(SAMPLES);
  const P = hitProbability(est.xi, est.zeta, sXi, sZeta, sc.bImp);
  const area = (Math.PI * sc.bImp * sc.bImp) / SAMPLES;
  let n = 0, cx = 0, cy = 0, cz = 0, cw = 0;
  const push = (xi: number, zeta: number, tauH: number, a: number) => {
    const g = groundPoint(sc, xi, zeta, tauH);
    lat[n] = g.lat; lon[n] = g.lon; alpha[n] = Math.min(1, a);
    const la = g.lat * D2R, lo = g.lon * D2R;
    cx += Math.cos(la) * Math.cos(lo) * a; cy += Math.cos(la) * Math.sin(lo) * a; cz += Math.sin(la) * a; cw += a;
    n++;
  };
  if (Math.max(sXi, sZeta) < 0.6 * sc.bImp) {
    // narrow posterior: the Monte Carlo cloud itself (fixed normals scaled by the current sigma)
    for (let i = 0; i < SAMPLES; i++) {
      const xi = est.xi + d.zx[i] * sXi, zeta = est.zeta + d.zz[i] * sZeta;
      if (xi * xi + zeta * zeta >= sc.bImp * sc.bImp) continue;
      push(xi, zeta, est.tau + sg.tau * d.zt[i], 1);
    }
  } else {
    for (let i = 0; i < SAMPLES; i++) {
      const xi = d.u[i] * sc.bImp, zeta = d.v[i] * sc.bImp;
      const dx = (xi - est.xi) / sXi, dz = (zeta - est.zeta) / sZeta;
      const w = peak * Math.exp(-0.5 * (dx * dx + dz * dz));
      const a = w / peak;
      if (a < 0.015) continue;
      push(xi, zeta, est.tau + sg.tau * d.zt[i], a);
    }
  }
  void area;
  const truth = currentTruth(sc, ap, t);
  const state: State = {
    t, remainingFrac: f, sigma: sg, center: { xi: est.xi, zeta: est.zeta, tau: est.tau },
    hitProb: P, applied: ap, truth, weightPeak: peak,
  };
  const centroid = cw > 0 ? { lat: Math.atan2(cz, Math.hypot(cx, cy)) / D2R, lon: Math.atan2(cy, cx) / D2R } : null;
  return { lat, lon, alpha, count: n, centroid, state };
}

export interface Effects {
  energyMt: number;
  craterKm: number;
  airburst: boolean;
  rA: number; // km, total destruction
  rB: number; // km, severe blast
  rC: number; // km, damaging overpressure / glass
  tsunamiKm: number;
}

export function impactEffects(sc: Scenario): Effects {
  const J = 0.5 * sc.massKg * (sc.vImpact * 1000) ** 2;
  const Mt = J / MT_J;
  const Y13 = Math.cbrt(Mt);
  const airburst = sc.diameterM < 60;
  // Transient crater scaling (Collins et al. 2005, simplified): density 2500 target, 45 degree impact
  const trans = 1.161 * Math.cbrt(sc.densityKgM3 / 2500) * Math.pow(sc.diameterM, 0.78) * Math.pow(sc.vImpact * 1000, 0.44) * Math.pow(9.81, -0.22) * Math.cbrt(Math.SQRT1_2);
  const craterKm = airburst ? 0 : (trans * 1.25) / 1000;
  const rB = 4.0 * Y13;
  const rC = 11 * Y13;
  const rA = airburst ? 0.5 * rB : Math.max(craterKm * 0.9, 0.35 * rB);
  return { energyMt: Mt, craterKm, airburst, rA, rB, rC, tsunamiKm: Math.min(1800, 45 * Y13) };
}

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = lat1 * D2R, p2 = lat2 * D2R, dl = (lon2 - lon1) * D2R, dp = p2 - p1;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R_EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function evacFraction(planStart: number | undefined, leadYears: number): number {
  if (planStart === undefined) return 0;
  const lead = leadYears - planStart;
  return Math.max(0, Math.min(0.9, ((lead - 0.08) / 0.92) * 0.9));
}

export interface CityImpact {
  city: City;
  distKm: number;
  zone: 'A' | 'B' | 'C' | 'tsunami' | null;
  exposedM: number; // people in the zone before evacuation
  deathsM: number; // after evacuation
  evac: number;
}

export function cityRadiusKm(city: City): number {
  return 7 * Math.sqrt(city.popM) + 3;
}

/** Fraction of a uniform disc (radius rc) lying inside a zone disc (radius R), centres d km apart. */
function overlapFrac(R: number, rc: number, d: number): number {
  if (R <= 0) return 0;
  if (d >= R + rc) return 0;
  if (d <= R - rc) return 1;
  if (d <= rc - R) return (R * R) / (rc * rc);
  const a = Math.acos(Math.max(-1, Math.min(1, (d * d + R * R - rc * rc) / (2 * d * R))));
  const b = Math.acos(Math.max(-1, Math.min(1, (d * d + rc * rc - R * R) / (2 * d * rc))));
  const k = Math.sqrt(Math.max(0, (-d + R + rc) * (d + R - rc) * (d - R + rc) * (d + R + rc)));
  return Math.max(0, Math.min(1, (R * R * a + rc * rc * b - 0.5 * k) / (Math.PI * rc * rc)));
}

export function cityImpacts(
  sc: Scenario,
  site: { lat: number; lon: number },
  isLand: (lat: number, lon: number) => boolean,
  evacStart: Map<string, number>,
): { rows: CityImpact[]; deathsM: number; exposedM: number; ocean: boolean } {
  const fx = impactEffects(sc);
  const ocean = !isLand(site.lat, site.lon);
  const rows: CityImpact[] = [];
  let deaths = 0, exposed = 0;
  for (const city of CITIES) {
    const dist = haversineKm(site.lat, site.lon, city.lat, city.lon);
    let zone: CityImpact['zone'] = null;
    let expFrac = 0, lethal = 0;
    if (ocean) {
      if (city.coastal && dist < fx.tsunamiKm) {
        zone = 'tsunami';
        expFrac = 1;
        lethal = 0.06 * (1 - dist / fx.tsunamiKm) + 0.002;
      }
    } else {
      const rc = cityRadiusKm(city);
      const fA = overlapFrac(fx.rA, rc, dist);
      const fB = Math.max(0, overlapFrac(fx.rB, rc, dist) - fA);
      const fC = Math.max(0, overlapFrac(fx.rC, rc, dist) - fA - fB);
      expFrac = fA + fB + fC;
      lethal = fA * 1 + fB * 0.5 + fC * 0.04;
      zone = fA > 0.001 ? 'A' : fB > 0.001 ? 'B' : fC > 0.001 ? 'C' : null;
    }
    if (!zone) continue;
    const evac = evacFraction(evacStart.get(city.id), sc.leadYears);
    const exp = city.popM * expFrac;
    const dth = city.popM * lethal * (1 - evac);
    rows.push({ city, distKm: dist, zone, exposedM: exp, deathsM: dth, evac });
    deaths += dth;
    exposed += exp;
  }
  rows.sort((a, b) => b.exposedM - a.exposedM);
  return { rows, deathsM: deaths, exposedM: exposed, ocean };
}

/** Per-city chance of being inside a damage zone, given the current posterior. */
export function cityRisk(sc: Scenario, corridor: Corridor, isLand: (lat: number, lon: number) => boolean): { city: City; p: number }[] {
  const fx = impactEffects(sc);
  const d = disk(sc.seed);
  const st = corridor.state;
  const est = { xi: st.center.xi, zeta: st.center.zeta };
  const sXi = st.sigma.xi, sZeta = st.sigma.zeta;
  const area = (Math.PI * sc.bImp * sc.bImp) / SAMPLES;
  const peak = st.weightPeak;
  const out = CITIES.map((city) => ({ city, p: 0 }));
  const sites: { lat: number; lon: number; w: number; land: boolean }[] = [];
  for (let i = 0; i < SAMPLES; i += 2) {
    const xi = d.u[i] * sc.bImp, zeta = d.v[i] * sc.bImp;
    const dx = (xi - est.xi) / sXi, dz = (zeta - est.zeta) / sZeta;
    const w = peak * Math.exp(-0.5 * (dx * dx + dz * dz)) * area * 2;
    if (w < 1e-7) continue;
    const g = groundPoint(sc, xi, zeta, st.center.tau + st.sigma.tau * d.zt[i]);
    sites.push({ lat: g.lat, lon: g.lon, w, land: isLand(g.lat, g.lon) });
  }
  for (const o of out) {
    for (const s of sites) {
      const dist = haversineKm(s.lat, s.lon, o.city.lat, o.city.lon);
      const reach = s.land ? fx.rC + cityRadiusKm(o.city) : o.city.coastal ? fx.tsunamiKm : 0;
      if (dist < reach) o.p += s.w;
    }
    o.p = Math.min(1, o.p);
  }
  return out.filter((o) => o.p > 0.0005).sort((a, b) => b.p - a.p);
}

/** Schedule helpers used by the UI. */
export function kineticPlan(sc: Scenario, tier: KineticTier, now: number) {
  const interceptT = now + sc.cruiseYears;
  const remainingYears = sc.leadYears - interceptT;
  if (remainingYears <= 0.02) return { feasible: false as const, interceptT, remainingYears, expectedR: 0 };
  const m = KINETIC[tier].massKg;
  return { feasible: true as const, interceptT, remainingYears, expectedR: deflectionR(sc, m, NOMINAL_BETA, remainingYears) };
}

export function tractorPlan(sc: Scenario, now: number) {
  const arriveT = now + sc.cruiseYears + 0.5;
  const endT = sc.leadYears - 0.3;
  if (endT - arriveT < 0.3) return { feasible: false as const, arriveT, endT, expectedR: 0 };
  const a = tractorAccel(sc, TRACTOR.massKg);
  return { feasible: true as const, arriveT, endT, expectedR: tractorDisplacementR(sc, a, arriveT, endT, endT) };
}

// ---------------------------------------------------------------- scenario creation

export interface ScenarioInput {
  name: string;
  designation: string;
  kind: 'real' | 'whatif';
  diameterM: number;
  diameterNote: string;
  H?: number;
  vInf: number;
  densityKgM3?: number;
  leadYears: number;
  seed: number;
  radiantDec?: number;
  orbit?: Elements;
  facts?: string[];
  difficulty: 'easy' | 'standard' | 'hard';
  startISO?: string;
  forceHit?: boolean;
}

export function makeScenario(inp: ScenarioInput): Scenario {
  const rng = mulberry32(inp.seed);
  const rho = inp.densityKgM3 ?? 2000;
  const mass = massFromDiameter(inp.diameterM, rho);
  const vInf = Math.max(3.5, inp.vInf);
  const vImpact = Math.sqrt(vInf * vInf + V_ESC * V_ESC);
  const bImp = bImpactRadius(vInf);
  const willHit = inp.forceHit ?? rng() < 0.62;
  const th = rng() * Math.PI;
  // Initial estimate sits near the Earth centre: early orbit fits cannot tell where in the corridor the truth lies.
  const e0r = bImp * (0.15 + rng() * 0.8);
  const e0a = rng() * Math.PI * 2;
  const est0 = { xi: e0r * Math.cos(e0a), zeta: e0r * Math.sin(e0a), tau: 0 };
  const targetP = inp.difficulty === 'easy' ? 1 / 120 : inp.difficulty === 'hard' ? 1 / 600 : 1 / 300;
  const sXi0 = bImp * (0.22 + rng() * 0.16);
  // Solve sigma_zeta so the initial impact probability matches the briefing.
  let lo = 2, hi = 500;
  const probFor = (sz: number) => {
    let P = 0;
    const N = 1500;
    for (let i = 0; i < N; i++) {
      const r = Math.sqrt((i + 0.5) / N) * bImp;
      const a = i * GOLDEN;
      const dx = (r * Math.cos(a) - est0.xi) / sXi0, dz = (r * Math.sin(a) - est0.zeta) / sz;
      P += Math.exp(-0.5 * (dx * dx + dz * dz));
    }
    return (P * Math.PI * bImp * bImp) / N / (2 * Math.PI * sXi0 * sz);
  };
  for (let k = 0; k < 40; k++) {
    const mid = Math.sqrt(lo * hi);
    if (probFor(mid) > targetP) lo = mid; else hi = mid;
  }
  const sZ0 = Math.sqrt(lo * hi);
  const sTau0 = Math.min(4.5, 0.05 * sZ0 + 0.3);
  // The truth is a draw from that same posterior, conditioned on hit / miss, so the estimate is honest.
  let truth0 = { xi: 0, zeta: 0, tau: 0 };
  let found = false;
  for (let k = 0; k < 60000 && !found; k++) {
    const xi = est0.xi + gauss(rng) * sXi0, zeta = est0.zeta + gauss(rng) * sZ0;
    const r = Math.hypot(xi, zeta);
    if (willHit ? r < bImp * 0.92 : r > bImp * 1.25) { truth0 = { xi, zeta, tau: 0 }; found = true; }
  }
  if (!found) {
    const a = rng() * Math.PI * 2;
    const r = willHit ? bImp * Math.sqrt(rng()) * 0.9 : bImp * 2;
    truth0 = { xi: r * Math.cos(a), zeta: r * Math.sin(a), tau: 0 };
  }
  // A hit should usually matter: pick a populated place the corridor can reach and aim the impact there.
  const radiantLat = Math.max(-70, Math.min(70, inp.radiantDec ?? (rng() - 0.5) * 80));
  const radiantLon = (rng() - 0.5) * 360;
  const draftSc = { bImp, radiant: { lat: radiantLat, lon: radiantLon, theta: th } } as Scenario;
  truth0.tau = (rng() - 0.5) * 12;
  if (willHit && rng() < 0.85) {
    const cand: { xi: number; zeta: number; lat: number; lon: number }[] = [];
    for (let k = 0; k < 4000; k++) {
      const r = bImp * 0.9 * Math.sqrt(rng()), a = rng() * Math.PI * 2;
      const xi = r * Math.cos(a), zeta = r * Math.sin(a);
      const g = groundPoint(draftSc, xi, zeta, 0);
      cand.push({ xi, zeta, lat: g.lat, lon: g.lon });
    }
    const reach = CITIES.filter((c) => cand.some((p) => Math.abs(p.lat - c.lat) < 0.6));
    if (reach.length) {
      const total = reach.reduce((s2, c) => s2 + Math.sqrt(c.popM), 0);
      let pick = rng() * total;
      let city = reach[0];
      for (const c of reach) { pick -= Math.sqrt(c.popM); if (pick <= 0) { city = c; break; } }
      let best = cand[0];
      for (const p of cand) if (Math.abs(p.lat - city.lat) < Math.abs(best.lat - city.lat)) best = p;
      truth0.xi = best.xi; truth0.zeta = best.zeta;
      const lonTarget = city.lon + (rng() - 0.5) * 1.2;
      truth0.tau = (((best.lon - lonTarget + 540) % 360) - 180) / 15.041;
    }
  }
  est0.tau = truth0.tau + gauss(rng) * sTau0;
  const lead = inp.leadYears;
  const cruise = Math.max(0.7, Math.min(1.7, 0.7 + (lead / 12) * 1.0 + rng() * 0.25));
  return {
    id: `${inp.designation}-${inp.seed}`.replace(/\s+/g, '_'),
    name: inp.name,
    designation: inp.designation,
    kind: inp.kind,
    diameterM: inp.diameterM,
    diameterNote: inp.diameterNote,
    H: inp.H,
    vInf, vImpact,
    densityKgM3: rho,
    massKg: mass,
    leadYears: lead,
    bImp,
    willHit,
    truth0, est0,
    sigma0: { xi: sXi0, zeta: sZ0, tau: sTau0 },
    sigmaFloor: { xi: 0.012, zeta: 0.03, tau: 0.002 },
    radiant: { lat: radiantLat, lon: radiantLon, theta: th },
    beta: 1.6 + rng() * 2.2,
    geom: 0.7 + rng() * 0.5,
    cruiseYears: cruise,
    seed: inp.seed,
    orbit: inp.orbit,
    facts: inp.facts ?? [],
    difficulty: inp.difficulty,
    startISO: inp.startISO ?? new Date().toISOString().slice(0, 10),
    budgetB: inp.difficulty === 'easy' ? 4.5 : inp.difficulty === 'hard' ? 2.8 : 3.5,
  };
}

// ---------------------------------------------------------------- outcome and scoring

export interface Outcome {
  hit: boolean;
  bFinal: number;
  missKm: number;
  site: { lat: number; lon: number } | null;
  effects: Effects;
  ocean: boolean;
  rows: CityImpact[];
  deathsM: number;
  baselineDeathsM: number;
  baselineHit: boolean;
  spentB: number;
  score: { total: number; lives: number; thrift: number; prudence: number; grade: string };
  wastedEvac: string[];
}

export function resolve(
  sc: Scenario,
  decs: Decision[],
  isLand: (lat: number, lon: number) => boolean,
): Outcome {
  const applied = computeApplied(sc, decs);
  const tr = currentTruth(sc, applied, sc.leadYears);
  const bFinal = Math.hypot(tr.xi, tr.zeta);
  const hit = bFinal < sc.bImp;
  const evacStart = new Map<string, number>();
  for (const d of decs) if (d.kind === 'evac') evacStart.set(d.cityId!, d.t);
  const fx = impactEffects(sc);
  const baseHit = Math.hypot(sc.truth0.xi, sc.truth0.zeta) < sc.bImp;
  let baselineDeaths = 0;
  if (baseHit) {
    const g = groundPoint(sc, sc.truth0.xi, sc.truth0.zeta, sc.truth0.tau);
    baselineDeaths = cityImpacts(sc, g, isLand, new Map()).deathsM;
  }
  let site: Outcome['site'] = null;
  let rows: CityImpact[] = [];
  let deaths = 0, ocean = false;
  if (hit) {
    site = groundPoint(sc, tr.xi, tr.zeta, sc.truth0.tau);
    const ci = cityImpacts(sc, site, isLand, evacStart);
    rows = ci.rows; deaths = ci.deathsM; ocean = ci.ocean;
  }
  const spent = decs.reduce((s, d) => s + d.costB, 0);
  // Evacuations ordered for cities that were never in a damage zone.
  const wasted: string[] = [];
  const hitCities = new Set(rows.map((r) => r.city.id));
  for (const [id] of evacStart) if (!hitCities.has(id)) wasted.push(id);
  const nEvac = evacStart.size;

  let lives: number;
  if (baseHit) {
    const saved = baselineDeaths > 0 ? 1 - deaths / baselineDeaths : hit ? 0 : 1;
    lives = 600 * Math.max(0, Math.min(1, saved));
    if (hit) lives = Math.min(lives, 380);
  } else {
    lives = hit ? 150 * (1 - Math.min(1, deaths / 5)) : 600; // turned a harmless flyby into a hit, or not
  }
  const thrift = 250 * Math.max(0, 1 - spent / sc.budgetB);
  const prudence = nEvac === 0 ? 150 : 150 * (1 - Math.min(1, wasted.length / Math.max(1, nEvac)));
  const total = Math.round(lives + thrift + prudence);
  const grade = total >= 900 ? 'S' : total >= 780 ? 'A' : total >= 620 ? 'B' : total >= 450 ? 'C' : total >= 250 ? 'D' : 'F';
  return {
    hit, bFinal, missKm: bFinal * R_EARTH_KM, site, effects: fx, ocean, rows,
    deathsM: deaths, baselineDeathsM: baselineDeaths, baselineHit: baseHit, spentB: spent,
    score: { total, lives: Math.round(lives), thrift: Math.round(thrift), prudence: Math.round(prudence), grade },
    wastedEvac: wasted,
  };
}

export function oneInN(p: number): string {
  if (p >= 0.995) return 'certain';
  if (p >= 0.2) return `${Math.round(p * 100)}%`;
  if (p < 1e-6) return 'negligible';
  return `1 in ${Math.round(1 / p).toLocaleString('en-US')}`;
}

/** Lead time at which `nImpactors` standard impactors launched promptly just manage to deflect a typical case. */
export function suggestLead(diameterM: number, vInf: number, difficulty: 'easy' | 'standard' | 'hard', rho = 2000): number {
  const nReq = difficulty === 'easy' ? 1.4 : difficulty === 'hard' ? 3.2 : 2.2;
  const mass = massFromDiameter(diameterM, rho);
  const b = bImpactRadius(vInf);
  const need = 0.95 * b;
  for (let lead = 3; lead <= 16; lead += 0.25) {
    const cruise = Math.max(0.7, Math.min(1.7, 0.7 + lead / 12 + 0.12));
    const rem = lead * 0.9 - cruise;
    if (rem <= 0) continue;
    const dv = (2.4 * KINETIC.standard.massKg * IMPACTOR_SPEED_KMS * 1000) / mass;
    const R = (3 * dv * rem * SEC_PER_YEAR) / (R_EARTH_KM * 1000);
    if (R * nReq >= need) return lead;
  }
  return 16;
}
