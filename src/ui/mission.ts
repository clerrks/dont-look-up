import { postAI } from '../api';
import { CITIES } from '../data/cities';
import {
  Game, adviceFor, dateAt, fmtDate, fmtDateLong, fmtMoney, fmtYears,
} from '../game';
import {
  EVAC_COST_B, KINETIC, MAX_OBS_BONUS, OBS, TRACTOR, evacFraction, impactEffects, kineticPlan, oneInN, tractorPlan,
  type KineticTier,
} from '../sim/model';
import type { GameView } from '../view/gameView';
import { ICONS, HOW_IT_WORKS, el, esc, openDialog, toast } from './dom';

type Tab = 'decide' | 'advisor' | 'log';
interface Msg { role: 'user' | 'assistant'; content: string; provider?: string }

export class Mission {
  private tab: Tab = 'decide';
  private tier: KineticTier = 'standard';
  private pending: { key: string; text: string; level: 'ok' | 'warn'; run: () => void } | null = null;
  private msgs: Msg[] = [];
  private busy = false;
  private running = false;
  private runTimer = 0;
  private locked = false;
  private unsub: () => void;
  private hudEls!: { p: HTMLElement; cone: HTMLElement; left: HTMLElement; leftSub: HTMLElement };
  private tl!: { date: HTMLElement; sub: HTMLElement; range: HTMLInputElement; canvas: HTMLCanvasElement; runBtn: HTMLButtonElement; btns: HTMLButtonElement[] };
  private panes!: Record<Tab, HTMLElement>;
  private tabBtns!: Record<Tab, HTMLButtonElement>;
  private budgetEl!: HTMLElement;
  private hud: HTMLElement;
  private tlWrap: HTMLElement;
  private hudTools: HTMLElement;
  private cap!: HTMLElement;
  private dragMonths: number | null = null;
  private advisorBadge = 0;
  private modeBtns!: HTMLButtonElement[];

  constructor(
    private game: Game,
    private view: GameView,
    private stage: HTMLElement,
    private panel: HTMLElement,
    private briefing: string,
    private onFinished: () => void,
    private onExit: () => void,
  ) {
    view.clearFx();
    view.showCorridor(true);
    view.setScenario(game.sc);
    view.setMode('earth');
    this.hud = el('div', 'hud');
    this.hudTools = el('div', 'tools');
    this.tlWrap = el('div', 'timeline');
    this.buildHud();
    this.buildTimeline();
    this.buildPanel();
    this.cap = el('p', 'orbit-cap', 'Real orbit from JPL. Earth (blue) and the asteroid (amber) meet on the impact date in this what-if. Drag to look around.');
    this.cap.hidden = true;
    stage.append(this.hud, this.cap, this.tlWrap);
    this.msgs.push({
      role: 'assistant',
      content: `I'm Dr. Okafor, your chief scientist. The glowing corridor is everywhere ${game.sc.name} could still land. It will shrink as we observe, and where it ends up decides everything. Ask me anything, at any time.`,
      provider: 'local',
    });
    this.unsub = game.on(() => this.render());
    this.render(true);
    setTimeout(() => this.view.focus(this.game.corridor.centroid?.lat ?? 20, this.game.corridor.centroid?.lon ?? 0, 3.5), 300);
  }

  destroy() {
    this.unsub();
    this.stopRun();
    this.hud.remove();
    this.cap.remove();
    this.tlWrap.remove();
  }

  // ------------------------------------------------------------ build

  private buildHud() {
    this.hud.innerHTML = `
      <dl class="readouts" aria-live="polite">
        <div><dt>Impact chance</dt><dd class="r-p num">-</dd></div>
        <div><dt>Corridor radius</dt><dd class="r-cone num">-</dd></div>
        <div><dt>Time to impact</dt><dd class="r-left num">-<small></small></dd></div>
      </dl>`;
    this.hudTools.innerHTML = `
      <div class="seg" role="group" aria-label="View">
        <button type="button" data-mode="earth" aria-pressed="true">Earth</button>
        <button type="button" data-mode="orbit" aria-pressed="false">Orbit</button>
      </div>
      <button type="button" class="iconbtn" data-act="focus" aria-label="Recentre on the corridor" title="Recentre on the corridor">${ICONS.focus}</button>
      <button type="button" class="iconbtn" data-act="zin" aria-label="Zoom in" title="Zoom in">${ICONS.plus}</button>
      <button type="button" class="iconbtn" data-act="zout" aria-label="Zoom out" title="Zoom out">${ICONS.minus}</button>
      <button type="button" class="iconbtn" data-act="help" aria-label="How this works" title="How this works">${ICONS.help}</button>`;
    this.hud.append(this.hudTools);
    this.hudEls = {
      p: this.hud.querySelector('.r-p')!,
      cone: this.hud.querySelector('.r-cone')!,
      left: this.hud.querySelector('.r-left')!,
      leftSub: this.hud.querySelector('.r-left small')!,
    };
    this.modeBtns = [...this.hudTools.querySelectorAll<HTMLButtonElement>('[data-mode]')];
    this.hudTools.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      if (b.dataset.mode) {
        this.view.setMode(b.dataset.mode as 'earth' | 'orbit');
        this.modeBtns.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        if (b.dataset.mode === 'orbit' && !this.game.sc.orbit) toast('No orbit data for this object.');
        this.cap.hidden = b.dataset.mode !== 'orbit' || !this.game.sc.orbit;
      }
      if (b.dataset.act === 'focus') { const c = this.game.corridor.centroid; if (c) this.view.focus(c.lat, c.lon, 3.2); }
      if (b.dataset.act === 'zin') this.view.zoom(0.8);
      if (b.dataset.act === 'zout') this.view.zoom(1.25);
      if (b.dataset.act === 'help') openDialog(HOW_IT_WORKS);
    });
  }

  private buildTimeline() {
    const lead = this.game.sc.leadYears;
    this.tlWrap.innerHTML = `
      <div class="tl-date"><strong class="d1">-</strong><span class="d2">-</span></div>
      <div class="tl-track">
        <canvas aria-hidden="true"></canvas>
        <input type="range" min="0" max="${Math.round(lead * 12)}" step="1" value="0" aria-label="Mission clock, months since discovery. Move right to advance time." />
      </div>
      <div class="tl-actions">
        <button class="btn small" type="button" data-step="1">+1 mo</button>
        <button class="btn small" type="button" data-step="6">+6 mo</button>
        <button class="btn small" type="button" data-step="12">+1 yr</button>
        <button class="btn small primary" type="button" data-run>Run</button>
      </div>`;
    const range = this.tlWrap.querySelector('input')!;
    this.tl = {
      date: this.tlWrap.querySelector('.d1')!,
      sub: this.tlWrap.querySelector('.d2')!,
      range,
      canvas: this.tlWrap.querySelector('canvas')!,
      runBtn: this.tlWrap.querySelector('[data-run]')!,
      btns: [...this.tlWrap.querySelectorAll<HTMLButtonElement>('[data-step]')],
    };
    this.tlWrap.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b || this.locked) return;
      if (b.dataset.step) { this.stopRun(); this.step(Number(b.dataset.step) / 12); }
      if (b.hasAttribute('data-run')) this.running ? this.stopRun() : this.startRun();
    });
    range.addEventListener('input', () => {
      this.dragMonths = Number(range.value);
      this.drawTimeline();
    });
    range.addEventListener('change', () => {
      const months = Number(range.value);
      this.dragMonths = null;
      if (this.locked) return;
      const cur = Math.round(this.game.t * 12);
      this.stopRun();
      if (months > cur) this.step((months - this.game.t * 12) / 12);
      else range.value = String(cur);
    });
    new ResizeObserver(() => this.drawTimeline()).observe(this.tl.canvas);
  }

  private buildPanel() {
    this.panel.innerHTML = `
      <div class="tabs" role="tablist" aria-label="Mission panels">
        <button role="tab" id="tab-decide" aria-controls="pane-decide" aria-selected="true" data-tab="decide">Decide</button>
        <button role="tab" id="tab-advisor" aria-controls="pane-advisor" aria-selected="false" data-tab="advisor">Advisor<span class="sr"> (chief scientist)</span></button>
        <button role="tab" id="tab-log" aria-controls="pane-log" aria-selected="false" data-tab="log">Log</button>
        <span class="spacer"></span>
        <span class="budget" title="Budget remaining">Budget <b class="num"></b></span>
      </div>
      <div class="pane" id="pane-decide" role="tabpanel" aria-labelledby="tab-decide"></div>
      <div class="pane" id="pane-advisor" role="tabpanel" aria-labelledby="tab-advisor" hidden></div>
      <div class="pane" id="pane-log" role="tabpanel" aria-labelledby="tab-log" hidden></div>`;
    this.panes = {
      decide: this.panel.querySelector('#pane-decide')!,
      advisor: this.panel.querySelector('#pane-advisor')!,
      log: this.panel.querySelector('#pane-log')!,
    };
    this.tabBtns = {
      decide: this.panel.querySelector('#tab-decide')!,
      advisor: this.panel.querySelector('#tab-advisor')!,
      log: this.panel.querySelector('#tab-log')!,
    };
    this.budgetEl = this.panel.querySelector('.budget b')!;
    const tabs = this.panel.querySelector('.tabs')!;
    tabs.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-tab]');
      if (b) this.setTab(b.dataset.tab as Tab);
    });
    tabs.addEventListener('keydown', (e) => {
      const order: Tab[] = ['decide', 'advisor', 'log'];
      const i = order.indexOf(this.tab);
      if ((e as KeyboardEvent).key === 'ArrowRight') { this.setTab(order[(i + 1) % 3]); this.tabBtns[this.tab].focus(); }
      if ((e as KeyboardEvent).key === 'ArrowLeft') { this.setTab(order[(i + 2) % 3]); this.tabBtns[this.tab].focus(); }
    });
    this.panes.decide.addEventListener('click', (e) => this.onDecideClick(e));
    this.panes.advisor.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-ask]');
      if (b) this.ask(b.dataset.ask!);
    });
    this.panes.advisor.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = this.panes.advisor.querySelector<HTMLInputElement>('input[name=q]');
      if (input && input.value.trim()) { const v = input.value.trim(); input.value = ''; this.ask(v); }
    });
    this.renderAdvisor(true);
  }

  private setTab(t: Tab) {
    this.tab = t;
    for (const k of Object.keys(this.panes) as Tab[]) {
      this.panes[k].hidden = k !== t;
      this.tabBtns[k].setAttribute('aria-selected', String(k === t));
      this.tabBtns[k].tabIndex = k === t ? 0 : -1;
    }
    if (t === 'advisor') { this.advisorBadge = 0; this.updateAdvisorBadge(); this.scrollChat(); }
    this.panel.scrollTop = 0;
    this.render();
  }

  // ------------------------------------------------------------ clock

  private step(years: number) {
    if (this.locked || this.game.finished) return;
    const logLen = this.game.log.length;
    const t0 = this.game.t;
    this.game.advance(years, this.running);
    this.afterAdvance(logLen, t0);
  }

  private afterAdvance(logLen: number, t0: number) {
    const fresh = this.game.log.slice(logLen).filter((l) => l.tone !== 'info' || l.text.startsWith('Follow-up') || l.text.startsWith('Impact at'));
    if (fresh.length && !this.game.finished) {
      const l = fresh[fresh.length - 1];
      this.msgs.push({ role: 'assistant', content: `Update, ${fmtDate(dateAt(this.game.sc, this.game.t))}: ${l.text}`, provider: 'local' });
      if (this.tab !== 'advisor') { this.advisorBadge += 1; this.updateAdvisorBadge(); }
      this.renderAdvisor();
    }
    void t0;
    if (this.game.finished) this.finish();
  }

  private startRun() {
    if (this.locked) return;
    this.running = true;
    this.tl.runBtn.textContent = 'Pause';
    const tick = () => {
      if (!this.running) return;
      const logLen = this.game.log.length;
      const t0 = this.game.t;
      const stopped = this.game.advance(1 / 12, true);
      this.afterAdvance(logLen, t0);
      if (stopped || this.game.finished) { this.stopRun(); return; }
      this.runTimer = window.setTimeout(tick, 260);
    };
    tick();
  }

  private stopRun() {
    this.running = false;
    clearTimeout(this.runTimer);
    if (this.tl) this.tl.runBtn.textContent = 'Run';
  }

  private finish() {
    this.locked = true;
    this.stopRun();
    this.tl.btns.forEach((b) => (b.disabled = true));
    this.tl.runBtn.disabled = true;
    this.tl.range.disabled = true;
    const o = this.game.outcome!;
    this.view.setLabels([]);
    this.view.playOutcome({ hit: o.hit, site: o.site, effects: o.effects, missRe: o.bFinal, sc: this.game.sc }, () => {
      setTimeout(() => this.onFinished(), o.hit ? 1400 : 900);
    });
  }

  // ------------------------------------------------------------ render

  private render(force = false) {
    const g = this.game;
    const p = g.p;
    this.view.setCorridor(g.corridor);
    this.view.setTime(g.t, g.sc);
    // labels
    const labels = g.risk().filter((r) => r.p > 0.01).slice(0, 5).map((r) => ({ id: r.city.id, text: `${r.city.name} ${oneInN(r.p)}`, lat: r.city.lat, lon: r.city.lon, tone: 'risk' as const }));
    const planned = g.evacSet();
    for (const id of planned) {
      const c = CITIES.find((x) => x.id === id)!;
      if (!labels.find((l) => l.id === id)) labels.push({ id, text: `${c.name} planned`, lat: c.lat, lon: c.lon, tone: 'plan' as never });
    }
    this.view.setLabels(labels);
    // readouts
    this.hudEls.p.textContent = oneInN(p);
    this.hudEls.p.dataset.level = p > 0.3 ? 'hot' : p > 0.02 ? 'warm' : 'cool';
    const r = g.coneRadiusKm;
    this.hudEls.cone.textContent = r > 0 ? `${r >= 1000 ? Math.round(r / 100) * 100 : Math.round(r / 10) * 10}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + ' km' : 'none';
    this.hudEls.left.firstChild!.textContent = g.finished ? 'Now' : fmtYears(g.yearsLeft);
    this.hudEls.leftSub.textContent = fmtDate(dateAt(g.sc, g.sc.leadYears));
    // timeline
    this.tl.date.textContent = fmtDate(dateAt(g.sc, g.t));
    this.tl.sub.textContent = `${fmtYears(g.t)} since discovery`;
    if (this.dragMonths === null) this.tl.range.value = String(Math.round(g.t * 12));
    this.drawTimeline();
    this.budgetEl.textContent = fmtMoney(g.budgetLeft);
    if (force || this.tab === 'decide') this.renderDecide();
    if (force || this.tab === 'log') this.renderLog();
  }

  private drawTimeline() {
    const cv = this.tl.canvas;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const g = this.game, lead = g.sc.leadYears;
    const css = getComputedStyle(document.documentElement);
    const col = (n: string) => css.getPropertyValue(n).trim();
    const X = (t: number) => (t / lead) * w;
    const Y = (p: number) => h - 4 - (Math.log10(Math.max(1e-4, Math.min(1, p))) + 4) / 4 * (h - 10);
    // future shading
    const now = this.dragMonths !== null ? this.dragMonths / 12 : g.t;
    ctx.fillStyle = 'rgba(255,255,255,0.025)';
    ctx.fillRect(X(now), 0, w - X(now), h);
    // probability history (log scale: 1 in 10,000 at the floor, certain at the top)
    const hist = g.history;
    if (hist.length > 1) {
      ctx.beginPath();
      ctx.moveTo(X(hist[0].t), h);
      for (const pt of hist) ctx.lineTo(X(pt.t), Y(pt.p));
      ctx.lineTo(X(hist[hist.length - 1].t), h);
      ctx.closePath();
      ctx.fillStyle = 'rgba(255,180,70,0.22)';
      ctx.fill();
      ctx.beginPath();
      hist.forEach((pt, i) => (i ? ctx.lineTo(X(pt.t), Y(pt.p)) : ctx.moveTo(X(pt.t), Y(pt.p))));
      ctx.strokeStyle = col('--signal');
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    // decisions
    for (const d of g.decs) {
      const x = X(d.t);
      ctx.fillStyle = d.kind === 'evac' ? col('--cool') : d.kind === 'obs' ? col('--text-3') : col('--signal');
      ctx.fillRect(x - 1, 2, 2, 8);
      if (d.kind === 'kinetic' && d.interceptT !== undefined) {
        const xi = X(d.interceptT);
        ctx.fillStyle = col('--signal');
        ctx.beginPath(); ctx.moveTo(xi, 14); ctx.lineTo(xi - 4, 6); ctx.lineTo(xi + 4, 6); ctx.fill();
      }
    }
    // impact line
    ctx.fillStyle = col('--bad');
    ctx.fillRect(w - 2, 0, 2, h);
    if (this.dragMonths !== null) {
      this.tl.date.textContent = fmtDate(dateAt(g.sc, now));
      this.tl.sub.textContent = `release to advance ${fmtYears(Math.max(0, now - g.t))}`;
    }
  }

  // ------------------------------------------------------------ decide

  private renderDecide() {
    const g = this.game, sc = g.sc;
    const pane = this.panes.decide;
    const scrollTop = this.panel.scrollTop;
    const fx = impactEffects(sc);
    const obsUsed = g.obsBonusUsed();
    const need = g.neededPushRe();
    const done = g.finished;

    const obsOpt = (k: 'ground' | 'space') => {
      const o = OBS[k];
      const capped = obsUsed + o.bonusYears > MAX_OBS_BONUS + 1e-9;
      const poor = g.budgetLeft < o.costB;
      const adv = adviceFor(g, { kind: 'obs' });
      const key = `obs-${k}`;
      return `<div class="opt">
        <div><div class="name">${esc(o.label)}</div><div class="desc">Like skipping ${o.bonusYears.toFixed(1)} years of data, delivered over ${fmtYears(o.durYears)}.</div></div>
        <div class="act"><button class="btn small" data-do="${key}" ${capped || poor || done ? 'disabled' : ''}>Fund</button><span class="cost">${fmtMoney(o.costB)}</span></div>
        ${capped ? `<div class="why muted">Observation capacity used up.</div>` : ''}
        ${this.pending?.key === key ? this.confirmHtml(adv) : ''}
      </div>`;
    };

    const kp = kineticPlan(sc, this.tier, g.t);
    const kinOk = kp.feasible && g.budgetLeft >= KINETIC[this.tier].costB && !done;
    const kAdv = adviceFor(g, { kind: 'kinetic', tier: this.tier });
    const frac = kp.feasible ? Math.min(1, kp.expectedR / need) : 0;
    const tp = tractorPlan(sc, g.t);
    const tAdv = adviceFor(g, { kind: 'tractor' });
    const tfrac = tp.feasible ? Math.min(1, tp.expectedR / need) : 0;

    const flights = g.decs.filter((d) => d.kind === 'kinetic' || d.kind === 'tractor');
    const flightsHtml = flights.length
      ? `<section class="group"><h3>Orders in flight</h3><ul class="orders">${flights
          .map((d) => {
            const when = d.kind === 'kinetic' ? d.interceptT! : d.arriveT!;
            const state = g.t >= when ? (d.kind === 'kinetic' ? 'Struck' : 'Towing') : `${d.kind === 'kinetic' ? 'Arrives' : 'Reaches'} ${fmtDate(dateAt(sc, when))}`;
            return `<li><span>${esc(d.label)}</span><span>${state}</span></li>`;
          })
          .join('')}</ul></section>`
      : '';

    const risk = g.risk().filter((r) => r.p > 0.001).slice(0, 6);
    const planned = g.evacSet();
    const evacRows = risk.length
      ? risk
          .map((r) => {
            const done2 = planned.has(r.city.id);
            const dec = g.decs.find((d) => d.cityId === r.city.id);
            const ready = dec ? Math.round((evacFraction(dec.t, sc.leadYears) / 0.9) * 100) : 0;
            const key = `evac-${r.city.id}`;
            const adv = adviceFor(g, { kind: 'evac', cityId: r.city.id, p: r.p });
            return `<div class="risk"><div class="c"><b>${esc(r.city.name)}</b><span>${esc(r.city.country)} · ${r.city.popM >= 1 ? r.city.popM.toFixed(1) + 'M' : Math.round(r.city.popM * 1000) + 'k'} people</span></div>
              <div class="pp" title="Chance this city is inside a damage zone">${oneInN(r.p)}</div>
              ${done2 ? `<span class="muted">Planned · ${ready}% ready</span>` : `<button class="btn small" data-do="${key}" ${g.budgetLeft < EVAC_COST_B || done ? 'disabled' : ''}>Plan ${fmtMoney(EVAC_COST_B)}</button>`}
              ${this.pending?.key === key ? `<div style="grid-column:1/-1">${this.confirmHtml(adv, true)}</div>` : ''}
            </div>`;
          })
          .join('')
      : `<p class="muted">No city has more than a 0.1% chance of falling inside a damage zone right now.</p>`;

    pane.innerHTML = `
      <div class="brief">
        <h2>${esc(sc.name)}</h2>
        <p>${esc(this.briefing)}</p>
        <p class="facts">
          <span>Width <b>${sc.diameterM} m</b></span>
          <span>Impact speed <b>${sc.vImpact.toFixed(1)} km/s</b></span>
          <span>Energy <b>${fx.energyMt >= 100 ? Math.round(fx.energyMt).toLocaleString('en-US') : fx.energyMt.toFixed(1)} Mt</b></span>
          <span>Impact date <b>${fmtDateLong(dateAt(sc, sc.leadYears))}</b></span>
        </p>
        <p class="muted">${esc(sc.diameterNote)}.${sc.facts.length ? ' ' + esc(sc.facts.join(' ')) : ''}</p>
      </div>

      <section class="group">
        <h3>Sharpen the orbit</h3>
        ${obsOpt('ground')}${obsOpt('space')}
      </section>

      <section class="group">
        <h3>Deflect the asteroid</h3>
        <div class="tiers" role="group" aria-label="Impactor size">
          ${(Object.keys(KINETIC) as KineticTier[]).map((k) => `<button type="button" data-tier="${k}" aria-pressed="${this.tier === k}"><b>${KINETIC[k].label.replace(' impactor', '')}</b><span>${KINETIC[k].blurb.split(',')[0]} · ${fmtMoney(KINETIC[k].costB)}</span></button>`).join('')}
        </div>
        <div class="opt" style="border-top:0;padding-top:4px">
          <div><div class="name">Kinetic impactor</div>
          <div class="desc">${kp.feasible ? `Arrives ${fmtDate(dateAt(sc, kp.interceptT))}, ${fmtYears(sc.cruiseYears)} flight. Push ${kp.expectedR.toFixed(2)} of ${need.toFixed(2)} Earth radii needed.` : 'Not enough time left for a spacecraft to arrive.'}</div></div>
          <div class="act"><button class="btn small primary" data-do="kin" ${kinOk ? '' : 'disabled'}>Launch</button></div>
          <div class="gauge" style="grid-column:1/-1" data-met="${frac >= 1}" role="img" aria-label="Share of the needed push this impactor provides: ${Math.round(frac * 100)} percent"><i style="width:${Math.round(frac * 100)}%"></i></div>
          <div class="why" data-level="${kAdv.level}">${esc(kAdv.text)}</div>
          ${this.pending?.key === 'kin' ? this.confirmHtml(kAdv) : ''}
        </div>
        <div class="opt">
          <div><div class="name">Gravity tractor</div>
          <div class="desc">${tp.feasible ? `Reaches it ${fmtDate(dateAt(sc, tp.arriveT))}, tows until ${fmtDate(dateAt(sc, tp.endT))}. Push ${tp.expectedR.toFixed(2)} Earth radii.` : 'Too late: it needs years of towing.'}</div></div>
          <div class="act"><button class="btn small primary" data-do="tractor" ${tp.feasible && g.budgetLeft >= TRACTOR.costB && !done ? '' : 'disabled'}>Dispatch</button><span class="cost">${fmtMoney(TRACTOR.costB)}</span></div>
          <div class="gauge" style="grid-column:1/-1" data-met="${tfrac >= 1}" role="img" aria-label="Share of the needed push the tractor provides: ${Math.round(tfrac * 100)} percent"><i style="width:${Math.round(tfrac * 100)}%"></i></div>
          <div class="why" data-level="${tAdv.level}">${esc(tAdv.text)}</div>
          ${this.pending?.key === 'tractor' ? this.confirmHtml(tAdv) : ''}
        </div>
      </section>

      <section class="group">
        <h3>Protect people</h3>
        <p class="muted">Cities most likely to fall inside a damage zone today. Planning needs about a year of lead time to be fully effective.</p>
        <div class="risk-list">${evacRows}</div>
      </section>
      ${flightsHtml}`;
    this.panel.scrollTop = scrollTop;
  }

  private confirmHtml(adv: { level: 'ok' | 'warn'; text: string }, tight = false) {
    if (adv.level === 'ok') return `<div class="confirm"><p>${esc(adv.text)}</p><div class="row"><button class="btn small primary" data-confirm>Confirm</button><button class="btn small quiet" data-cancel>Cancel</button></div></div>`;
    return `<div class="confirm"><p><b>Dr. Okafor:</b> ${esc(adv.text)}</p><div class="row"><button class="btn small primary" data-confirm>${tight ? 'Plan anyway' : 'Proceed anyway'}</button><button class="btn small quiet" data-cancel>Cancel</button></div></div>`;
  }

  private onDecideClick(e: Event) {
    const t = e.target as HTMLElement;
    const tierBtn = t.closest<HTMLElement>('[data-tier]');
    if (tierBtn) { this.tier = tierBtn.dataset.tier as KineticTier; this.pending = null; this.renderDecide(); return; }
    if (t.closest('[data-cancel]')) { this.pending = null; this.renderDecide(); return; }
    if (t.closest('[data-confirm]')) { const p = this.pending; this.pending = null; p?.run(); this.renderDecide(); return; }
    const d = t.closest<HTMLElement>('[data-do]');
    if (!d || this.locked) return;
    const key = d.dataset.do!;
    const g = this.game;
    let run: () => void;
    let adv: { level: 'ok' | 'warn'; text: string };
    if (key === 'kin') { adv = adviceFor(g, { kind: 'kinetic', tier: this.tier }); run = () => { if (g.launchKinetic(this.tier)) toast('Impactor launched.'); }; }
    else if (key === 'tractor') { adv = adviceFor(g, { kind: 'tractor' }); run = () => { if (g.launchTractor()) toast('Gravity tractor dispatched.'); }; }
    else if (key.startsWith('obs-')) { const k = key.slice(4) as 'ground' | 'space'; adv = adviceFor(g, { kind: 'obs' }); run = () => { if (g.fundObs(k)) toast('Observation time funded.'); }; }
    else if (key.startsWith('evac-')) {
      const id = key.slice(5);
      const r = g.risk().find((x) => x.city.id === id);
      adv = adviceFor(g, { kind: 'evac', cityId: id, p: r?.p ?? 0 });
      run = () => { if (g.planEvac(id)) toast('Evacuation planning started.'); };
    } else return;
    // Cheap or sensible orders go straight through; questionable ones ask first.
    if (adv.level === 'ok' && (key.startsWith('obs-') || key.startsWith('evac-'))) { run(); return; }
    this.pending = { key, text: adv.text, level: adv.level, run };
    this.renderDecide();
  }

  // ------------------------------------------------------------ log

  private renderLog() {
    const g = this.game;
    this.panes.log.innerHTML = `
      <h2>Mission log</h2>
      <p class="muted">The ribbon under the map plots the impact chance over time on a log scale. Everything that happens lands here.</p>
      <ol class="log" reversed>${[...g.log].reverse().map((l) => `<li data-tone="${l.tone}"><time>${esc(fmtDate(dateAt(g.sc, l.t)))}</time><span class="t">${esc(l.text)}</span></li>`).join('')}</ol>`;
  }

  // ------------------------------------------------------------ advisor

  private updateAdvisorBadge() {
    const b = this.tabBtns.advisor;
    b.firstChild!.textContent = this.advisorBadge ? `Advisor (${this.advisorBadge})` : 'Advisor';
  }

  private renderAdvisor(init = false) {
    const pane = this.panes.advisor;
    if (init || !pane.querySelector('.msgs')) {
      pane.innerHTML = `
        <div class="chat">
          <div class="msgs" role="log" aria-live="polite" aria-label="Conversation with the chief scientist"></div>
          <div class="chips">
            <button type="button" data-ask="What should I do right now?">What now?</button>
            <button type="button" data-ask="Why is the corridor this wide?">Why this wide?</button>
            <button type="button" data-ask="Is it too early to launch a mission?">Too early to launch?</button>
            <button type="button" data-ask="How much push do I actually need, and why?">How much push?</button>
          </div>
          <form class="composer"><input name="q" type="text" maxlength="300" autocomplete="off" placeholder="Ask your chief scientist anything" aria-label="Ask the chief scientist" /><button class="btn primary" type="submit">Ask</button></form>
        </div>`;
    }
    const box = pane.querySelector('.msgs')!;
    const label = (p?: string) => (p === 'groq' ? 'Groq AI' : p === 'claude' ? 'Claude' : p === 'workers-ai' ? 'AI advisor' : p === 'offline' ? 'Offline advisor' : '');
    box.innerHTML = this.msgs
      .map((m) => `<div class="msg ${m.role === 'user' ? 'me' : 'adv'}">${esc(m.content)}${m.role === 'assistant' && label(m.provider) ? `<small>${label(m.provider)}</small>` : ''}</div>`)
      .join('') + (this.busy ? '<div class="msg adv typing">Dr. Okafor is checking the numbers...</div>' : '');
    this.scrollChat();
  }

  private scrollChat() {
    const box = this.panes.advisor.querySelector('.msgs');
    if (box) box.scrollTop = box.scrollHeight;
  }

  private async ask(q: string) {
    if (this.busy) return;
    this.setTab('advisor');
    this.msgs.push({ role: 'user', content: q });
    this.busy = true;
    this.renderAdvisor();
    const history = this.msgs.filter((m) => m.provider !== 'local' || m.role === 'user').slice(-7).map((m) => ({ role: m.role, content: m.content }));
    const res = await postAI('/api/advisor', { messages: history, state: this.game.snapshot() });
    this.busy = false;
    this.msgs.push({
      role: 'assistant',
      content: res?.text ?? 'I lost the line for a moment. Try again; in the meantime, the corridor and the push gauge on the Decide tab tell the story.',
      provider: res?.provider ?? 'offline',
    });
    this.renderAdvisor();
  }
}
