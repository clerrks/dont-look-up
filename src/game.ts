import { CITIES } from './data/cities';
import {
  KINETIC, OBS, EVAC_COST_B, MAX_OBS_BONUS, TRACTOR, V_ESC,
  cityRisk, evaluate, haversineKm, impactEffects, kineticPlan, makeScenario, oneInN, resolve, suggestLead, tractorPlan,
  type Corridor, type Decision, type KineticTier, type Outcome, type Scenario,
} from './sim/model';
import { encounter } from './sim/orbit';
import { hashString } from './sim/rng';
import type { Detail } from './api';

export type Difficulty = 'easy' | 'standard' | 'hard';
export const DIFFICULTY: Record<Difficulty, { label: string; blurb: string; capM: number }> = {
  easy: { label: 'Rookie', blurb: 'Smaller rock, long warning, bigger budget.', capM: 110 },
  standard: { label: 'Director', blurb: 'The intended experience.', capM: 150 },
  hard: { label: 'Chief of last resort', blurb: 'Bigger rock, less time, thinner budget.', capM: 190 },
};

export interface LogEntry { t: number; tone: 'info' | 'good' | 'warn' | 'bad'; text: string }
export interface HistoryPoint { t: number; p: number; radiusKm: number }

export const YEAR_MS = 365.25 * 86400000;
export function dateAt(sc: Scenario, t: number): Date {
  return new Date(new Date(sc.startISO).getTime() + t * YEAR_MS);
}
export function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}
export function fmtDateLong(d: Date): string {
  return d.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
}
export function fmtYears(y: number): string {
  if (y >= 1.95) return `${y.toFixed(1)} yr`;
  const m = Math.round(y * 12);
  return m >= 12 ? `${y.toFixed(1)} yr` : `${m} mo`;
}
export function fmtMoney(b: number): string {
  return `$${b.toFixed(2)}B`;
}

export function buildScenario(d: Detail, difficulty: Difficulty, opts: { seed?: number; vInfHint?: number; forceHit?: boolean; diameterOverride?: number } = {}): Scenario {
  const seed = opts.seed ?? (crypto.getRandomValues(new Uint32Array(1))[0] || 1);
  const cap = DIFFICULTY[difficulty].capM;
  const realD = d.diameterM ?? 100;
  let D = realD;
  let note: string;
  if (opts.diameterOverride) {
    D = opts.diameterOverride;
    note = `Hypothetical size: a ${Math.round(D)} m body on the real orbit of ${d.shortName || d.name}`;
  } else if (realD <= 220 && realD >= 28) {
    note = d.diameterMeasured ? `Measured size, about ${Math.round(realD)} m` : `Estimated from brightness, about ${Math.round(realD)} m`;
  } else if (realD > 220) {
    D = cap;
    note = `Hypothetical size: scaled down from the real ${realD >= 1000 ? (realD / 1000).toFixed(1) + ' km' : Math.round(realD) + ' m'} body so a deflection is possible`;
  } else {
    D = 40;
    note = `Hypothetical size: scaled up from a roughly ${Math.round(realD)} m body so the impact matters`;
  }
  D = Math.round(D);
  let vInf = opts.vInfHint ?? 7;
  let dec: number | undefined;
  const facts: string[] = [];
  if (d.elements) {
    const enc = encounter(d.elements);
    vInf = enc.vInf;
    dec = enc.radiantDec;
    facts.push(`Orbit: a = ${d.elements.a.toFixed(2)} AU, e = ${d.elements.e.toFixed(2)}, i = ${d.elements.i.toFixed(1)} degrees (JPL Small-Body Database).`);
  } else if (opts.vInfHint) {
    facts.push('Encounter speed taken from NASA close-approach data.');
  }
  const next = d.approaches?.[0];
  if (next) facts.push(`Real next close approach: ${next.date.slice(0, 11)} at ${Math.round(next.distKm).toLocaleString('en-US')} km (JPL close-approach data). The impact scenario is hypothetical.`);
  const lead = Math.round(suggestLead(D, vInf, difficulty) * 2) / 2;
  const sc = makeScenario({
    name: d.shortName || d.name,
    designation: d.des,
    kind: realD === D ? 'real' : 'whatif',
    diameterM: D,
    diameterNote: note,
    H: d.H,
    vInf: Math.max(4.5, vInf),
    leadYears: lead,
    seed: seed ^ hashString(d.des),
    radiantDec: dec,
    orbit: d.elements ?? undefined,
    facts,
    difficulty,
    forceHit: opts.forceHit,
  });
  return sc;
}

export function templateBriefing(sc: Scenario, p: number): string {
  return `${sc.name} has been found on a path that could cross Earth's in ${sc.leadYears} years. It is about ${sc.diameterM} m across and closing at ${sc.vImpact.toFixed(1)} km/s relative to Earth, so an impact would release ${impactEffects(sc).energyMt.toLocaleString('en-US', { maximumFractionDigits: 0 })} megatons. Current odds are ${oneInN(p)}, but the orbit is barely measured: you have $${sc.budgetB.toFixed(1)}B and must decide before you are certain.`;
}

type Listener = () => void;

export class Game {
  sc: Scenario;
  decs: Decision[] = [];
  t = 0;
  budgetLeft: number;
  log: LogEntry[] = [];
  history: HistoryPoint[] = [];
  corridor!: Corridor;
  outcome: Outcome | null = null;
  finished = false;
  private lastP = 0;
  private flags = new Set<string>();
  private listeners = new Set<Listener>();
  private riskCache: { key: string; rows: { city: (typeof CITIES)[number]; p: number }[] } | null = null;
  readonly isLand: (lat: number, lon: number) => boolean;
  decisionNotes: { t: number; text: string; p: number }[] = [];

  constructor(sc: Scenario, isLand: (lat: number, lon: number) => boolean) {
    this.sc = sc;
    this.isLand = isLand;
    this.budgetLeft = sc.budgetB;
    this.refresh();
    this.lastP = this.corridor.state.hitProb;
    this.log.push({ t: 0, tone: 'info', text: `Discovery. First orbit fit gives an impact chance of ${oneInN(this.lastP)}.` });
  }

  on(fn: Listener) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit() { for (const l of this.listeners) l(); }

  get yearsLeft() { return Math.max(0, this.sc.leadYears - this.t); }
  get p() { return this.corridor.state.hitProb; }

  refresh() {
    this.corridor = evaluate(this.sc, this.decs, Math.min(this.t, this.sc.leadYears - 0.001));
    const c = this.corridor;
    // cone radius: weighted RMS angular distance of the cloud from its centroid
    let radius = 0;
    if (c.centroid && c.count) {
      let sw = 0, s2 = 0;
      for (let i = 0; i < c.count; i++) {
        const d = haversineKm(c.centroid.lat, c.centroid.lon, c.lat[i], c.lon[i]);
        s2 += d * d * c.alpha[i]; sw += c.alpha[i];
      }
      radius = Math.sqrt(s2 / Math.max(1e-9, sw));
    }
    const last = this.history[this.history.length - 1];
    const pt = { t: this.t, p: c.state.hitProb, radiusKm: radius };
    if (last && Math.abs(last.t - this.t) < 1e-6) this.history[this.history.length - 1] = pt; else this.history.push(pt);
    this.riskCache = null;
  }

  get coneRadiusKm() { return this.history[this.history.length - 1]?.radiusKm ?? 0; }

  risk() {
    const key = `${this.t.toFixed(4)}:${this.decs.length}`;
    if (this.riskCache?.key !== key) this.riskCache = { key, rows: cityRisk(this.sc, this.corridor, this.isLand) };
    return this.riskCache.rows;
  }

  /** Required push to clear the Earth, using today's best estimate. */
  neededPushRe(): number {
    const c = this.corridor.state.center;
    return Math.max(0.2, this.sc.bImp * 1.12 - Math.hypot(c.xi, c.zeta));
  }

  spent() { return this.decs.reduce((s, d) => s + d.costB, 0); }
  obsBonusUsed() { return this.decs.filter((d) => d.kind === 'obs').reduce((s, d) => s + (d.bonusYears ?? 0), 0); }
  evacSet() { return new Set(this.decs.filter((d) => d.kind === 'evac').map((d) => d.cityId!)); }

  private note(text: string) {
    this.decisionNotes.push({ t: this.t, text, p: this.p });
  }

  private pay(b: number): boolean {
    if (b > this.budgetLeft + 1e-9 || this.finished) return false;
    this.budgetLeft -= b;
    return true;
  }

  fundObs(kind: 'ground' | 'space'): boolean {
    const o = OBS[kind];
    if (this.obsBonusUsed() + o.bonusYears > MAX_OBS_BONUS + 1e-9) return false;
    if (!this.pay(o.costB)) return false;
    this.decs.push({ id: `o${this.decs.length}`, kind: 'obs', t: this.t, costB: o.costB, label: o.label, bonusYears: o.bonusYears, durYears: o.durYears });
    this.log.push({ t: this.t, tone: 'info', text: `Ordered: ${o.label.toLowerCase()} (${fmtMoney(o.costB)}). New tracking data will arrive over the next ${fmtYears(o.durYears)}.` });
    this.note(`${o.label} ordered`);
    this.refresh(); this.emit();
    return true;
  }

  launchKinetic(tier: KineticTier): boolean {
    const plan = kineticPlan(this.sc, tier, this.t);
    if (!plan.feasible) return false;
    const k = KINETIC[tier];
    if (!this.pay(k.costB)) return false;
    this.decs.push({ id: `k${this.decs.length}`, kind: 'kinetic', t: this.t, costB: k.costB, label: k.label, tier, interceptT: plan.interceptT });
    this.log.push({ t: this.t, tone: 'info', text: `Launched: ${k.label.toLowerCase()} (${fmtMoney(k.costB)}). Intercept expected ${fmtDate(dateAt(this.sc, plan.interceptT))}.` });
    this.note(`${k.label} launched (${fmtYears(plan.remainingYears)} of push before impact)`);
    this.refresh(); this.emit();
    return true;
  }

  launchTractor(): boolean {
    const plan = tractorPlan(this.sc, this.t);
    if (!plan.feasible) return false;
    if (!this.pay(TRACTOR.costB)) return false;
    this.decs.push({ id: `g${this.decs.length}`, kind: 'tractor', t: this.t, costB: TRACTOR.costB, label: TRACTOR.label, arriveT: plan.arriveT, endT: plan.endT });
    this.log.push({ t: this.t, tone: 'info', text: `Launched: gravity tractor (${fmtMoney(TRACTOR.costB)}). It reaches the asteroid ${fmtDate(dateAt(this.sc, plan.arriveT))} and tows until ${fmtDate(dateAt(this.sc, plan.endT))}.` });
    this.note('Gravity tractor launched');
    this.refresh(); this.emit();
    return true;
  }

  planEvac(cityId: string): boolean {
    if (this.evacSet().has(cityId)) return false;
    if (!this.pay(EVAC_COST_B)) return false;
    const city = CITIES.find((c) => c.id === cityId)!;
    this.decs.push({ id: `e${this.decs.length}`, kind: 'evac', t: this.t, costB: EVAC_COST_B, label: `Evacuation planning: ${city.name}`, cityId });
    this.log.push({ t: this.t, tone: 'info', text: `Evacuation planning started for ${city.name} (${fmtMoney(EVAC_COST_B)}).` });
    this.note(`Evacuation planning for ${city.name}`);
    this.refresh(); this.emit();
    return true;
  }

  /** Advance the clock. Returns true if it stopped early on news. */
  advance(years: number, stopOnNews = false): boolean {
    if (this.finished) return false;
    const target = Math.min(this.sc.leadYears, this.t + years);
    const step = 1 / 12;
    let stopped = false;
    while (this.t < target - 1e-9) {
      this.t = Math.min(target, this.t + step);
      this.refresh();
      const news = this.detectEvents();
      if (stopOnNews && news && this.t < this.sc.leadYears) { stopped = true; break; }
    }
    if (this.t >= this.sc.leadYears - 1e-9) {
      this.t = this.sc.leadYears;
      this.finish();
    }
    this.emit();
    return stopped;
  }

  advanceTo(t: number) {
    if (t > this.t) this.advance(t - this.t);
  }

  private flag(key: string): boolean {
    if (this.flags.has(key)) return false;
    this.flags.add(key);
    return true;
  }

  private detectEvents(): boolean {
    let news = false;
    const p = this.p;
    const push = (tone: LogEntry['tone'], text: string) => { this.log.push({ t: this.t, tone, text }); news = true; };
    const at = fmtDate(dateAt(this.sc, this.t));
    if (p > 0.5 && this.lastP <= 0.5 && this.flag('p50up')) push('bad', `New observations push the impact chance past 50% (${oneInN(p)}).`);
    else if (p > 0.1 && this.lastP <= 0.1 && this.flag('p10up')) push('warn', `Impact chance now ${oneInN(p)} and climbing.`);
    else if (p > 0.9 && this.lastP <= 0.9 && this.flag('p90up')) push('bad', 'Impact is now close to certain.');
    if (p < 0.001 && this.lastP >= 0.001 && this.flag('p01down')) push('good', `Good news: the corridor has slid away from Earth. Impact chance below 0.1%.`);
    else if (p < 0.01 && this.lastP >= 0.01 && this.flag('p1down')) push('good', `Impact chance falls below 1% (${oneInN(p)}).`);
    this.lastP = p;
    for (const a of this.corridor.state.applied) {
      if (a.kind === 'kinetic') {
        if (this.t >= a.t0 && this.flag('hit' + a.id)) {
          push('info', `Impact at ${at}: the spacecraft struck the asteroid. Tracking the change in its orbit now.`);
        }
        if (this.t >= a.measuredAt && this.flag('meas' + a.id)) {
          const ratio = a.fullR / Math.max(1e-6, a.nominalR);
          push(ratio >= 1 ? 'good' : 'warn', `Follow-up observations: the push was ${ratio >= 1.05 ? 'stronger' : ratio <= 0.95 ? 'weaker' : 'about as'} predicted (ejecta boosted the momentum ${(ratio * 2).toFixed(1)}x; DART measured about 3.6x). Orbit updated.`);
        }
      } else if (a.kind === 'tractor') {
        if (this.t >= a.t0 && this.flag('arr' + a.id)) push('info', 'The gravity tractor has arrived and begun towing.');
      }
    }
    const left = this.yearsLeft;
    if (left <= 1 && this.flag('lastyear')) push('warn', 'One year to impact. Spacecraft launched now would not arrive in time.');
    if (left <= 0.5 && this.flag('lasthalf')) push('warn', 'Six months to impact. Only evacuation planning can still change the outcome.');
    for (const d of this.decs) {
      if (d.kind === 'obs' && this.t >= d.t + (d.durYears ?? 0) - 1e-9 && this.flag('obs' + d.id)) push('info', `${d.label} finished: the orbit is better known.`);
    }
    void at;
    return news;
  }

  private finish() {
    this.finished = true;
    this.outcome = resolve(this.sc, this.decs, this.isLand);
    const o = this.outcome;
    this.log.push({ t: this.t, tone: o.hit ? 'bad' : 'good', text: o.hit ? 'Impact.' : `The asteroid passes Earth. Closest approach about ${Math.round(o.missKm).toLocaleString('en-US')} km from the planet's centre.` });
  }

  /** Compact, truth-free state for the advisor and briefing prompts. */
  snapshot() {
    const sc = this.sc;
    const k = kineticPlan(sc, 'standard', this.t);
    const g = tractorPlan(sc, this.t);
    const risk = this.risk().slice(0, 4).map((r) => ({ city: r.city.name, chance: Number(r.p.toFixed(3)), populationM: r.city.popM }));
    return {
      asteroid: sc.name,
      diameterM: sc.diameterM,
      impactSpeedKms: Number(sc.vImpact.toFixed(1)),
      energyMegatons: Math.round(impactEffects(sc).energyMt),
      date: fmtDateLong(dateAt(sc, this.t)),
      impactDate: fmtDateLong(dateAt(sc, sc.leadYears)),
      yearsLeft: Number(this.yearsLeft.toFixed(2)),
      hitProbability: Number(this.p.toFixed(4)),
      oneIn: oneInN(this.p),
      coneRadiusKm: Math.round(this.coneRadiusKm),
      budgetLeftB: Number(this.budgetLeft.toFixed(2)),
      budgetTotalB: sc.budgetB,
      cruiseYears: Number(sc.cruiseYears.toFixed(2)),
      pushNeededEarthRadii: Number(this.neededPushRe().toFixed(2)),
      standardImpactorPushEarthRadii: k.feasible ? Number(k.expectedR.toFixed(2)) : 0,
      standardImpactorFeasible: k.feasible,
      tractorPushEarthRadii: g.feasible ? Number(g.expectedR.toFixed(2)) : 0,
      observationBonusUsedYears: Number(this.obsBonusUsed().toFixed(2)),
      decisionsSoFar: this.decs.map((d) => `${d.label} at ${fmtDate(dateAt(sc, d.t))}`),
      topCitiesAtRisk: risk,
      escapeVelocityKms: V_ESC,
      difficulty: sc.difficulty,
    };
  }

  /** Full record for the debrief, including what the data said at each decision. */
  record() {
    const o = this.outcome!;
    return {
      asteroid: this.sc.name,
      diameterM: this.sc.diameterM,
      leadYears: this.sc.leadYears,
      startingChance: oneInN(this.history[0]?.p ?? 0),
      decisions: this.decisionNotes.map((n) => ({ when: fmtDate(dateAt(this.sc, n.t)), yearsBeforeImpact: Number((this.sc.leadYears - n.t).toFixed(1)), what: n.text, chanceAtTheTime: oneInN(n.p) })),
      spentB: Number(o.spentB.toFixed(2)),
      budgetB: this.sc.budgetB,
      hit: o.hit,
      wouldHaveHitWithoutAction: o.baselineHit,
      missKm: Math.round(o.missKm),
      deathsMillions: Number(o.deathsM.toFixed(2)),
      deathsWithoutActionMillions: Number(o.baselineDeathsM.toFixed(2)),
      oceanImpact: o.ocean,
      score: o.score.total,
      grade: o.score.grade,
      events: this.log.slice(-12).map((l) => l.text),
    };
  }

  zoneForCity(cityId: string) {
    const c = CITIES.find((x) => x.id === cityId)!;
    return c;
  }
}

/** Plain-language warning when the player is about to make a questionable choice. */
export function adviceFor(g: Game, action: { kind: 'kinetic'; tier: KineticTier } | { kind: 'tractor' } | { kind: 'evac'; cityId: string; p: number } | { kind: 'obs' }): { level: 'ok' | 'warn'; text: string } {
  const sc = g.sc;
  const left = g.yearsLeft;
  if (action.kind === 'kinetic') {
    const plan = kineticPlan(sc, action.tier, g.t);
    if (!plan.feasible) return { level: 'warn', text: `There is not enough time: the spacecraft would arrive after impact.` };
    const need = g.neededPushRe();
    const frac = plan.expectedR / need;
    if (g.p < 0.004 && left > 2) return { level: 'warn', text: `The chance is only ${oneInN(g.p)} right now. This could be a false alarm; cheap telescope time may tell you first.` };
    if (frac < 0.35) return { level: 'warn', text: `Alone this would supply about ${Math.round(frac * 100)}% of the push needed. It only helps as part of a larger plan.` };
    if (plan.remainingYears < 1.2) return { level: 'warn', text: `It arrives with only ${fmtYears(plan.remainingYears)} to impact, so the push has little time to build.` };
    if (g.budgetLeft - KINETIC[action.tier].costB < 0.3) return { level: 'warn', text: 'This leaves almost no budget for a follow-up or evacuation planning.' };
    return { level: 'ok', text: `Supplies about ${Math.min(999, Math.round(frac * 100))}% of the push needed (best estimate).` };
  }
  if (action.kind === 'tractor') {
    const plan = tractorPlan(sc, g.t);
    if (!plan.feasible) return { level: 'warn', text: 'Too late: the tractor needs years of towing to matter.' };
    const frac = plan.expectedR / g.neededPushRe();
    if (frac < 0.3) return { level: 'warn', text: `Even towing to the end it supplies about ${Math.round(frac * 100)}% of the push needed.` };
    return { level: 'ok', text: `Slow but precise. About ${Math.min(999, Math.round(frac * 100))}% of the push needed once towing is done.` };
  }
  if (action.kind === 'evac') {
    if (action.p < 0.01) return { level: 'warn', text: 'The current chance of damage here is very small. Planning is cheap, but it is better spent where the corridor points.' };
    return { level: 'ok', text: 'Planning needs about a year of lead time to be fully effective.' };
  }
  return { level: 'ok', text: 'Cheap, and it shrinks the cone sooner.' };
}
