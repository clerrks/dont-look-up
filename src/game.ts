import { CITIES } from './data/cities';
import {
  KINETIC, OBS, EVAC_COST_B, MAX_OBS_BONUS, NUKE, PROBE, RADAR_WINDOW_YEARS, SHELTER_COST_B, TRACTOR, V_ESC,
  betaKnownBy, cityRisk, evaluate, haversineKm, impactEffects, kineticPlan, makeScenario, nukePlan, oneInN, probePlan, resolve, riskWithPush, suggestLead, tractorPlan,
  type Corridor, type Decision, type KineticTier, type ObsKind, type Outcome, type Scenario,
} from './sim/model';
import { encounter } from './sim/orbit';
import { hashString } from './sim/rng';
import type { Detail } from './api';

export type Difficulty = 'easy' | 'standard' | 'hard';
export type ActionLog =
  | { k: 'obs'; t: number; which: ObsKind }
  | { k: 'kin'; t: number; tier: KineticTier }
  | { k: 'tractor'; t: number }
  | { k: 'evac'; t: number; city: string }
  | { k: 'shelter'; t: number; city: string }
  | { k: 'probe'; t: number }
  | { k: 'fund'; t: number }
  | { k: 'nuke'; t: number };

/** What the government will pay when it finally believes the danger: more if the risk is real, nothing if it looks like a false alarm. */
export const FUND_MIN_RISK = 0.12;
export const FUND_MAX_ASKS = 3;
export function fundingOffer(p: number): number {
  return Math.round((0.2 + 0.5 * Math.min(1, p * 2.5)) * 20) / 20;
}

export const NUKE_WARNINGS = [
  'It does not make the asteroid go away. It breaks it into many pieces, and pieces can still hit.',
  'Nuclear weapons in space break international treaties. Expect serious political fallout.',
  'It costs a huge amount, and it eats into your score if a cheaper option was still open.',
  'If the asteroid was going to miss anyway, you have just blown up a harmless rock.',
];
export const BUDGET_B: Record<Difficulty, number> = { easy: 4.5, standard: 3.5, hard: 2.8 };
export const DIFFICULTY: Record<Difficulty, { label: string; blurb: string; capM: number }> = {
  easy: { label: 'Rookie', blurb: 'Small rock, more time', capM: 90 },
  standard: { label: 'Director', blurb: 'The real challenge', capM: 120 },
  hard: { label: 'Last resort', blurb: 'Big rock, little time', capM: 150 },
};

export interface LogEntry { t: number; tone: 'info' | 'good' | 'warn' | 'bad'; text: string; /** narrator line that goes with this event */ voice?: string }
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

export function buildScenario(d: Detail, difficulty: Difficulty, opts: { seed?: number; vInfHint?: number; forceHit?: boolean; diameterOverride?: number; budgetB?: number; daily?: string } = {}): Scenario {
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
    budgetB: opts.budgetB,
    daily: opts.daily,
  });
  return sc;
}

export function templateBriefing(sc: Scenario, p: number): string {
  return `${sc.name} may hit Earth in ${sc.leadYears} years. It is ${sc.diameterM} m wide. Odds today: ${oneInN(p)}. You have $${sc.budgetB.toFixed(1)}B.`;
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
  /** every order, in a form that can be replayed on the same asteroid */
  actions: ActionLog[] = [];
  /** extra money granted after the start */
  fundedB = 0;
  fundAsks = 0;
  lastFundT = -9;

  constructor(sc: Scenario, isLand: (lat: number, lon: number) => boolean) {
    this.sc = sc;
    this.isLand = isLand;
    this.budgetLeft = sc.budgetB;
    this.refresh();
    this.lastP = this.corridor.state.hitProb;
    this.log.push({ t: 0, tone: 'info', text: `Found. Impact chance ${oneInN(this.lastP)}.` });
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
        if (c.alpha[i] === 0) continue;
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
  evacSet() { return new Set(this.decs.filter((d) => d.kind === 'evac' && d.mode !== 'shelter').map((d) => d.cityId!)); }
  shelterSet() { return new Set(this.decs.filter((d) => d.kind === 'evac' && d.mode === 'shelter').map((d) => d.cityId!)); }
  has(kind: Decision['kind']) { return this.decs.some((d) => d.kind === kind); }
  /** a probe will have reached the asteroid by `t`, so the push of an impactor arriving then is no longer a guess */
  betaKnownAt(t: number) { return betaKnownBy(this.decs, t); }

  /** Can more money be asked for right now, and if not, why not. */
  fundingStatus(): { ok: boolean; offer: number; why: string } {
    const offer = fundingOffer(this.p);
    if (this.sc.daily) return { ok: false, offer, why: 'Not in the daily challenge' };
    if (this.finished) return { ok: false, offer, why: '' };
    if (this.fundAsks >= FUND_MAX_ASKS) return { ok: false, offer, why: 'They have given all they will' };
    if (this.p < FUND_MIN_RISK) return { ok: false, offer, why: `Needs a real risk: ${Math.round(FUND_MIN_RISK * 100)}% or more` };
    if (this.t - this.lastFundT < 1) return { ok: false, offer, why: `Asked recently, try in ${Math.max(1, Math.ceil((1 - (this.t - this.lastFundT)) * 12))} months` };
    return { ok: true, offer, why: '' };
  }

  requestFunding(): boolean {
    const st = this.fundingStatus();
    if (!st.ok) return false;
    this.fundAsks++;
    this.lastFundT = this.t;
    this.fundedB += st.offer;
    this.budgetLeft += st.offer;
    this.actions.push({ k: 'fund', t: this.t });
    this.log.push({ t: this.t, tone: 'good', text: `The government approved ${fmtMoney(st.offer)} more, now that the risk is ${oneInN(this.p)}.` });
    this.note(`Asked for more money (${fmtMoney(st.offer)} granted)`);
    this.refresh(); this.emit();
    return true;
  }

  private note(text: string) {
    this.decisionNotes.push({ t: this.t, text, p: this.p });
  }

  private pay(b: number): boolean {
    if (b > this.budgetLeft + 1e-9 || this.finished) return false;
    this.budgetLeft -= b;
    return true;
  }

  fundObs(kind: ObsKind): boolean {
    const o = OBS[kind];
    if (kind === 'radar' && this.yearsLeft > RADAR_WINDOW_YEARS) return false;
    if (this.obsBonusUsed() + o.bonusYears > MAX_OBS_BONUS + (kind === 'radar' ? 0.5 : 0) + 1e-9) return false;
    if (!this.pay(o.costB)) return false;
    this.actions.push({ k: 'obs', t: this.t, which: kind });
    this.decs.push({ id: `o${this.decs.length}`, kind: 'obs', t: this.t, costB: o.costB, label: o.label, bonusYears: o.bonusYears, durYears: o.durYears });
    this.log.push({ t: this.t, tone: 'info', text: `${o.label} funded (${fmtMoney(o.costB)}). Data arrives over ${fmtYears(o.durYears)}.` });
    this.note(`${o.label} ordered`);
    this.refresh(); this.emit();
    return true;
  }

  launchKinetic(tier: KineticTier): boolean {
    const plan = kineticPlan(this.sc, tier, this.t);
    if (!plan.feasible) return false;
    const k = KINETIC[tier];
    if (!this.pay(k.costB)) return false;
    this.actions.push({ k: 'kin', t: this.t, tier });
    this.decs.push({ id: `k${this.decs.length}`, kind: 'kinetic', t: this.t, costB: k.costB, label: k.label, tier, interceptT: plan.interceptT });
    this.log.push({ t: this.t, tone: 'info', text: `${k.label} launched (${fmtMoney(k.costB)}). Arrives ${fmtDate(dateAt(this.sc, plan.interceptT))}.` });
    this.note(`${k.label} launched (${fmtYears(plan.remainingYears)} of push before impact)`);
    this.refresh(); this.emit();
    return true;
  }

  launchNuke(): boolean {
    const plan = nukePlan(this.sc, this.t);
    if (!plan.feasible) return false;
    if (!this.pay(NUKE.costB)) return false;
    this.actions.push({ k: 'nuke', t: this.t });
    this.decs.push({ id: `n${this.decs.length}`, kind: 'nuke', t: this.t, costB: NUKE.costB, label: NUKE.label, detonateT: plan.detonateT });
    this.log.push({ t: this.t, tone: 'warn', text: `Nuclear device launched (${fmtMoney(NUKE.costB)}). Detonates ${fmtDate(dateAt(this.sc, plan.detonateT))}.` });
    this.note(`Nuclear burst launched (${fmtYears(plan.remainingYears)} before impact)`);
    this.refresh(); this.emit();
    return true;
  }

  launchTractor(): boolean {
    const plan = tractorPlan(this.sc, this.t);
    if (!plan.feasible) return false;
    if (!this.pay(TRACTOR.costB)) return false;
    this.actions.push({ k: 'tractor', t: this.t });
    this.decs.push({ id: `g${this.decs.length}`, kind: 'tractor', t: this.t, costB: TRACTOR.costB, label: TRACTOR.label, arriveT: plan.arriveT, endT: plan.endT });
    this.log.push({ t: this.t, tone: 'info', text: `Gravity tractor launched (${fmtMoney(TRACTOR.costB)}). Arrives ${fmtDate(dateAt(this.sc, plan.arriveT))}.` });
    this.note('Gravity tractor launched');
    this.refresh(); this.emit();
    return true;
  }

  launchProbe(): boolean {
    if (this.has('probe')) return false;
    const plan = probePlan(this.sc, this.t);
    if (!plan.feasible) return false;
    if (!this.pay(PROBE.costB)) return false;
    this.actions.push({ k: 'probe', t: this.t });
    this.decs.push({ id: `r${this.decs.length}`, kind: 'probe', t: this.t, costB: PROBE.costB, label: PROBE.label, arriveT: plan.arriveT, bonusYears: PROBE.bonusYears, durYears: PROBE.durYears });
    this.log.push({ t: this.t, tone: 'info', text: `Probe launched (${fmtMoney(PROBE.costB)}). Reaches the asteroid ${fmtDate(dateAt(this.sc, plan.arriveT))}.` });
    this.note('Rendezvous probe launched');
    this.refresh(); this.emit();
    return true;
  }

  planShelter(cityId: string): boolean {
    if (this.shelterSet().has(cityId)) return false;
    if (!this.pay(SHELTER_COST_B)) return false;
    const city = CITIES.find((c) => c.id === cityId)!;
    this.actions.push({ k: 'shelter', t: this.t, city: cityId });
    this.decs.push({ id: `s${this.decs.length}`, kind: 'evac', mode: 'shelter', t: this.t, costB: SHELTER_COST_B, label: `Shelters: ${city.name}`, cityId });
    this.log.push({ t: this.t, tone: 'info', text: `Shelters for ${city.name} (${fmtMoney(SHELTER_COST_B)}).` });
    this.note(`Shelters built in ${city.name}`);
    this.refresh(); this.emit();
    return true;
  }

  planEvac(cityId: string): boolean {
    if (this.evacSet().has(cityId)) return false;
    if (!this.pay(EVAC_COST_B)) return false;
    const city = CITIES.find((c) => c.id === cityId)!;
    this.actions.push({ k: 'evac', t: this.t, city: cityId });
    this.decs.push({ id: `e${this.decs.length}`, kind: 'evac', t: this.t, costB: EVAC_COST_B, label: `Evacuation planning: ${city.name}`, cityId });
    this.log.push({ t: this.t, tone: 'info', text: `Evacuation planning: ${city.name} (${fmtMoney(EVAC_COST_B)}).` });
    this.note(`Evacuation planning for ${city.name}`);
    this.refresh(); this.emit();
    return true;
  }

  /** Advance the clock. Returns true if it stopped early on news. */
  advance(years: number, stopOnNews = false, stepYears = 1 / 12): boolean {
    if (this.finished) return false;
    const target = Math.min(this.sc.leadYears, this.t + years);
    const step = stepYears;
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
    const push = (tone: LogEntry['tone'], text: string, voice?: string) => { this.log.push({ t: this.t, tone, text, voice }); news = true; };
    const at = fmtDate(dateAt(this.sc, this.t));
    if (p > 0.5 && this.lastP <= 0.5 && this.flag('p50up')) push('bad', `Impact chance passes 50%.`, 'ev_p50');
    else if (p > 0.1 && this.lastP <= 0.1 && this.flag('p10up')) push('warn', `Impact chance climbing: ${oneInN(p)}.`, 'ev_climb');
    else if (p > 0.9 && this.lastP <= 0.9 && this.flag('p90up')) push('bad', 'Impact is now almost certain.', 'ev_almost');
    if (p < 0.001 && this.lastP >= 0.001 && this.flag('p01down')) push('good', `Good news: the cloud is sliding off Earth. Chance below 0.1%.`, 'ev_good');
    else if (p < 0.01 && this.lastP >= 0.01 && this.flag('p1down')) push('good', `Impact chance down to ${oneInN(p)}.`);
    this.lastP = p;
    for (const a of this.corridor.state.applied) {
      if (a.kind === 'kinetic') {
        if (this.t >= a.t0 && this.flag('hit' + a.id)) {
          push('info', `Impactor hit the asteroid. Measuring the new orbit.`);
        }
        if (this.t >= a.measuredAt && this.flag('meas' + a.id)) {
          const ratio = a.fullR / Math.max(1e-6, a.nominalR);
          push(ratio >= 1 ? 'good' : 'warn', `Result: the push was ${ratio >= 1.05 ? 'stronger than' : ratio <= 0.95 ? 'weaker than' : 'as'} predicted. Cloud updated.`, ratio >= 1.05 ? 'strike_stronger' : ratio <= 0.95 ? 'strike_weaker' : undefined);
        }
      } else if (a.kind === 'tractor') {
        if (this.t >= a.t0 && this.flag('arr' + a.id)) push('info', 'Gravity tractor arrived. Towing.');
        if (a.destroyedAt !== undefined && this.t >= a.destroyedAt && this.flag('dead' + a.id)) push('bad', 'The impactor debris destroyed the gravity tractor. It stops pulling.', 'ev_tractor_dead');
      }
    }
    for (const d of this.decs) {
      if (d.kind === 'nuke' && this.t >= d.detonateT! && this.flag('nuke' + d.id)) push('warn', 'The nuclear device went off. The asteroid broke into pieces.', 'nuke_done');
      if (d.kind === 'probe' && this.t >= d.arriveT! && this.flag('probe' + d.id)) push('good', 'The probe is alongside. It weighed the asteroid: pushes are now predictable.', 'ev_probe_arrive');
    }
    const left = this.yearsLeft;
    if (left <= 1 && this.flag('lastyear')) push('warn', 'One year left. New spacecraft cannot arrive in time.', 'ev_last_year');
    if (left <= 0.5 && this.flag('lasthalf')) push('warn', 'Six months left. Only evacuation planning still helps.', 'ev_last_half');
    for (const d of this.decs) {
      if (d.kind === 'obs' && this.t >= d.t + (d.durYears ?? 0) - 1e-9 && this.flag('obs' + d.id)) push('info', `${d.label} done. Cloud is smaller.`);
    }
    // tips that open up as the round goes on
    if (left <= RADAR_WINDOW_YEARS && left > 0.5 && this.flag('radar-open')) push('info', 'Radar can reach it now.', 'adv_radar');
    // only when the money is running low and the danger is real, not just because the first impactor is out
    if (p >= 0.15 && this.budgetLeft < this.sc.budgetB * 0.5 && this.fundAsks === 0 && !this.sc.daily && this.flag('fund-open')) push('info', 'The risk looks real. You can ask for more money.', 'adv_funding');
    if (p > 0.25 && left > this.sc.cruiseYears + 0.4 && !this.decs.some((d) => d.kind === 'kinetic' || d.kind === 'tractor') && this.flag('launch-now')) push('warn', 'The risk is climbing. Every month you wait costs you push.', 'adv_launch_now');
    void at;
    return news;
  }

  private finish() {
    this.finished = true;
    this.outcome = resolve(this.sc, this.decs, this.isLand);
    const o = this.outcome;
    this.log.push({ t: this.t, tone: o.hit ? 'bad' : 'good', text: o.hit ? 'Impact.' : `It misses Earth by about ${Math.round(o.missKm).toLocaleString('en-US')} km.` });
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
      probeSent: this.has('probe'),
      extraMoneyGrantedB: Number(this.fundedB.toFixed(2)),
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
export function adviceFor(g: Game, action: { kind: 'kinetic'; tier: KineticTier } | { kind: 'tractor' } | { kind: 'evac'; cityId: string; p: number } | { kind: 'shelter'; cityId: string; p: number } | { kind: 'obs' } | { kind: 'nuke' } | { kind: 'probe' }): { level: 'ok' | 'warn'; text: string; voice?: string } {
  const sc = g.sc;
  const left = g.yearsLeft;
  if (action.kind === 'probe') {
    if (g.p < 0.01 && left > 2) return { level: 'warn', text: `Only ${oneInN(g.p)} so far. A probe is a lot for a probable false alarm.`, voice: 'adv_false_alarm' };
    return { level: 'ok', text: 'It weighs the rock and tracks it closely. Do it before you launch impactors.', voice: 'adv_probe' };
  }
  if (action.kind === 'shelter') {
    if (action.p < 0.01) return { level: 'warn', text: 'Very unlikely to be hit. Better spent elsewhere.' };
    return { level: 'ok', text: 'Saves up to 4 in 10 people, even at the last minute.', voice: 'adv_shelter' };
  }
  if (action.kind === 'nuke') {
    const open = left > sc.cruiseYears + 0.9;
    return { level: 'warn', text: open ? 'Not yet. A spacecraft could still do this more cheaply. This is a last resort.' : 'A last resort. It breaks the rock into pieces. It will not save you from all of them.' };
  }
  if (action.kind === 'kinetic') {
    const plan = kineticPlan(sc, action.tier, g.t, g.betaKnownAt(g.t + sc.cruiseYears));
    if (!plan.feasible) return { level: 'warn', text: `Too late: it would arrive after impact.`, voice: 'adv_late' };
    const hurt = g.decs.find((d) => d.kind === 'tractor' && d.arriveT! <= plan.interceptT && plan.interceptT < d.endT!);
    if (hurt) return { level: 'warn', text: 'Your gravity tractor will be hovering at the asteroid. The impact debris would destroy it.' };
    const need = g.neededPushRe();
    const frac = plan.expectedR / need;
    const r = riskWithPush(sc, g.decs, g.t, g.corridor.state.applied, plan.expectedR, plan.interceptT);
    if (r.before > 0 && r.after > 0.93 * r.before) return { level: 'warn', text: 'Too early to know which way to push. Sharpen the picture first.', voice: 'adv_too_early' };
    if (g.p < 0.004 && left > 2) return { level: 'warn', text: `Only ${oneInN(g.p)} so far. Could be a false alarm. Telescopes are cheaper.`, voice: 'adv_false_alarm' };
    if (frac < 0.35) return { level: 'warn', text: `Alone this is only ${Math.round(frac * 100)}% of the push needed.` };
    if (plan.remainingYears < 1.2) return { level: 'warn', text: `Arrives with only ${fmtYears(plan.remainingYears)} left. Weak push.` };
    if (g.budgetLeft - KINETIC[action.tier].costB < 0.3) return { level: 'warn', text: 'Leaves almost no budget for anything else.', voice: 'adv_budget' };
    return { level: 'ok', text: `Covers about ${Math.min(999, Math.round(frac * 100))}% of the push needed.` };
  }
  if (action.kind === 'tractor') {
    const plan = tractorPlan(sc, g.t);
    if (!plan.feasible) return { level: 'warn', text: 'Too late: towing needs years.', voice: 'adv_late' };
    const doomed = g.decs.find((d) => d.kind === 'kinetic' && d.interceptT! >= plan.arriveT && d.interceptT! < plan.endT);
    if (doomed) return { level: 'warn', text: 'An impactor is due to hit while the tractor is there. The debris would destroy it.' };
    const frac = plan.expectedR / g.neededPushRe();
    if (frac < 0.3) return { level: 'warn', text: `Even fully towed, only ${Math.round(frac * 100)}% of the push needed.` };
    return { level: 'ok', text: `Slow but precise: ${Math.min(999, Math.round(frac * 100))}% of the push needed.` };
  }
  if (action.kind === 'evac') {
    if (action.p < 0.01) return { level: 'warn', text: 'Very unlikely to be hit. Better spent elsewhere.' };
    return { level: 'ok', text: 'Works best with a year of warning.' };
  }
  return { level: 'ok', text: 'Cheap. Shrinks the cloud sooner.' };
}
