import { postAI } from '../api';
import { audio } from '../audio';
import { CITIES } from '../data/cities';
import {
  Game, NUKE_WARNINGS, adviceFor, dateAt, fmtDate, fmtDateLong, fmtMoney, fmtYears, type ActionLog,
} from '../game';
import {
  EVAC_COST_B, KINETIC, MAX_OBS_BONUS, NUKE, OBS, PROBE, RADAR_WINDOW_YEARS, SHELTER_COST_B, TRACTOR, nukePlan, impactEffects as _fx, certaintyTime, evacFraction, evaluate, impactEffects, kineticPlan, lastLaunchTime, obsEffect, oneInN, probePlan, riskWithPush, shelterFraction, tractorPlan,
  type Corridor, type KineticTier, type ObsKind,
} from '../sim/model';
import type { GameView, PickInfo } from '../view/gameView';
import { TargetView, type Blob } from '../view/targetView';
import type { Decision } from '../sim/model';
import { ICONS, HOW_IT_WORKS, TILE_ICONS, el, esc, openDialog, toast } from './dom';
import { Tour, type TourStep } from './tour';

type Tab = 'decide' | 'advisor' | 'log';

export interface MissionOpts {
  /** play someone else's run back on the same asteroid */
  replay?: { name: string; score: number; actions: ActionLog[] };
  /** called when the first-time tour ends after the player already spent or advanced something */
  onResetAfterTour?: () => void;
}
interface Msg { role: 'user' | 'assistant'; content: string; provider?: string; typed?: boolean }

export class Mission {
  private tab: Tab = 'decide';
  private tier: KineticTier = 'standard';
  private protectMode: 'evac' | 'shelter' = 'evac';
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
  private target!: TargetView;
  private hover: string | null = null;
  private headEl!: HTMLElement;
  private bodyEl!: HTMLElement;
  private ghostSure: number | null = null;
  private sureNow = 0;
  /** the 'answer clear' day as drawn: it glides, so the bar does not twitch while time runs */
  private sureDraw = -1;
  private animating = false;
  private animDone: (() => void) | null = null;
  private motionSm = 0;
  private tip!: HTMLElement;
  private card: HTMLElement | null = null;
  private tourAuto = false;
  private replaying = false;
  private animRaf = 0;
  private panelDirty = false;
  private lastPanelAt = 0;
  private logSeen = 0;
  private newsEl: HTMLElement | null = null;
  private newsTimer = 0;
  private tour: Tour | null = null;
  private readonly fast = new URLSearchParams(location.search).has('fast');

  constructor(
    private game: Game,
    private view: GameView,
    private stage: HTMLElement,
    private panel: HTMLElement,
    private briefing: string,
    private onFinished: () => void,
    private onExit: () => void,
    private opts: MissionOpts = {},
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
    this.tip = el('div', 'pick-tip');
    this.tip.hidden = true;
    stage.append(this.hud, this.cap, this.tlWrap, this.tip);
    this.msgs.push({
      role: 'assistant',
      content: `I'm Dr. Okafor, your chief scientist. Each line on the chart is a path ${game.sc.name} could still take. The red ones hit Earth. Ask me anything, any time.`,
      provider: 'local',
      typed: true,
    });
    this.unsub = game.on(() => { if (this.animating) this.panelDirty = true; else this.render(); });
    this.logSeen = game.log.length;
    this.view.setCinematics(!this.fast && !matchMedia('(prefers-reduced-motion: reduce)').matches);
    audio.newRound();
    audio.replay(!!opts.replay);
    audio.scene('mission');
    // a first-time player gets the tutorial's voice and nothing else
    if (!opts.replay) {
      let seen = true;
      try { seen = localStorage.getItem('ad.tour') === 'done'; } catch { /* storage blocked: the tour will show */ seen = false; }
      if (!seen && !this.fast) audio.tutorial(true); else audio.tutorial(false);
      this.briefAloud();
    }
    this.render(true);
    this.view.setCorridor(game.corridor, true);
    this.view.onHover = (i) => this.onHover(i);
    this.view.onPick = (i) => this.onPick(i);
    this.syncInteractive();
    if (opts.replay) setTimeout(() => void this.runReplay(opts.replay!), 1200);
    else this.maybeTour();
    setTimeout(() => this.view.frameShot(3.9), 300);
  }

  /** The opening lines, spoken while the chart settles. */
  private briefAloud() {
    const daily = !!this.game.sc.daily;
    audio.speak(daily ? 'daily_open' : 'brief_open', { interrupt: true, delay: 0.9 });
  }

  /** The sounds that go with buying something. */
  private bought(kind: 'launch' | 'scan' | 'plain') {
    audio.sfx('purchase');
    if (kind === 'launch') audio.sfx('launch', { delay: 0.12 });
    if (kind === 'scan') audio.sfx('radar', { delay: 0.12 });
  }

  destroy() {
    audio.replay(false);
    this.view.replayStage(false);
    audio.tutorial(false);
    audio.stopVoice();
    this.unsub();
    this.stopRun();
    this.tour?.stop();
    this.view.onHover = null; this.view.onPick = null; this.view.setInteractive(false); this.view.setMotion(0);
    this.tip.remove(); this.card?.remove();
    clearTimeout(this.newsTimer);
    this.newsEl?.remove();
    this.view.asteroidCam(false);
    this.view.setMissions([]);
    this.target?.destroy();
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
      <button type="button" class="iconbtn" data-act="rockcam" aria-pressed="false" aria-label="Asteroid cam: fly alongside the asteroid" title="Asteroid cam">${ICONS.cam}</button>
      <button type="button" class="iconbtn" data-act="focus" aria-label="Show where it could land" title="Show where it could land">${ICONS.globe}</button>
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
        this.syncInteractive();
      }
      if (b.dataset.act === 'rockcam') {
        if (this.view.getMode() !== 'earth') { this.view.setMode('earth'); this.modeBtns.forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.mode === 'earth'))); this.cap.hidden = true; }
        const on = !this.view.isFollowing();
        this.view.asteroidCam(on);
        b.setAttribute('aria-pressed', String(on));
        this.tour?.notify('rockcam');
      }
      if (b.dataset.act === 'focus') {
        if (this.view.isFollowing()) { this.view.asteroidCam(false); this.hudTools.querySelector('[data-act=rockcam]')?.setAttribute('aria-pressed', 'false'); }
        this.view.frameShot(3.6);
        this.tour?.notify('focus');
      }
      if (b.dataset.act === 'zin') this.view.zoom(0.8);
      if (b.dataset.act === 'zout') this.view.zoom(1.25);
      if (b.dataset.act === 'help') openDialog(HOW_IT_WORKS, { label: 'Replay the tour', run: () => this.startTour() });
    });
  }

  private buildTimeline() {
    const lead = this.game.sc.leadYears;
    this.tlWrap.innerHTML = `
      <div class="tl-date"><strong class="d1">-</strong><span class="d2">-</span></div>
      <div class="tl-track" title="Top bar: yellow means you can still launch. Bottom bar: striped means we are not sure yet, green means the answer is clear.">
        <canvas aria-hidden="true"></canvas>
        <input type="range" min="0" max="${Math.round(lead * 12)}" step="any" value="0" aria-label="Mission clock, months since discovery. Move right to advance time." />
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
      if (b.dataset.step) { this.step(Number(b.dataset.step) / 12); }
      if (b.hasAttribute('data-run')) { this.animating ? this.stopRun() : this.startRun(); }
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
    this.panes.decide.innerHTML = `
      <div class="head"></div>
      <div class="target-wrap">
        <canvas class="target" role="img" aria-label="Chart of possible asteroid paths from the asteroid on the left to Earth on the right. Red lines hit Earth."></canvas>
        <div class="legend" aria-hidden="true"><span><i class="d amber"></i>A path that misses</span><span><i class="d red"></i>A path that hits Earth</span></div>
      </div>
      <div class="decide-body"></div>`;
    this.headEl = this.panes.decide.querySelector('.head')!;
    this.bodyEl = this.panes.decide.querySelector('.decide-body')!;
    this.target = new TargetView(this.panes.decide.querySelector('canvas.target')!, this.game.sc);
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
    const over = (e: Event) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-preview]');
      if (t) { this.hover = t.dataset.preview!; this.applyPreview(); }
    };
    const out = (e: Event) => {
      if ((e.target as HTMLElement).closest('[data-preview]')) { this.hover = null; this.applyPreview(); }
    };
    this.panes.decide.addEventListener('pointerover', over);
    this.panes.decide.addEventListener('focusin', over);
    this.panes.decide.addEventListener('pointerout', out);
    this.panes.decide.addEventListener('focusout', out);
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
    if (t === 'advisor') { this.advisorBadge = 0; this.updateAdvisorBadge(); this.renderAdvisor(); this.scrollChat(); }
    this.panel.scrollTop = 0;
    this.render();
  }

  // ------------------------------------------------------------ clock

  // ------------------------------------------------------------ animated clock

  /** Move time forward smoothly, so the cloud, asteroid and spacecraft visibly change on the way. */
  private animateTo(years: number, opts: { speed?: number; stopOnNews?: boolean } = {}): Promise<void> {
    if (this.locked || this.game.finished || this.animating) return Promise.resolve();
    const g = this.game;
    const target = Math.min(g.sc.leadYears, g.t + years);
    const dur = Math.min(4.2, 0.7 + (target - g.t) * 1.6);
    const speed = (opts.speed ?? (target - g.t) / dur) * (this.fast ? 400 : 1);
    this.animating = true;
    this.pending = null;
    this.card?.remove(); this.card = null;
    this.syncInteractive();
    this.tl.runBtn.textContent = 'Pause';
    this.setClockLock(true);
    this.tour?.setLite(true);
    let last = performance.now();
    const frame = (now: number) => {
      if (!this.animating) return;
      const dt = Math.min(0.06, (now - last) / 1000);
      last = now;
      // a cutscene (the impactor hitting) holds the clock until it is over
      if (this.view.isBusy()) { this.view.setMotion(0); this.animRaf = requestAnimationFrame(frame); return; }
      const dy = Math.min(speed * dt, target - g.t);
      this.motionSm += (Math.min(1.5, dy / Math.max(dt, 1e-3)) - this.motionSm) * 0.18;
      this.view.setMotion(this.motionSm);
      const logLen = g.log.length;
      const stopped = dy > 0 ? g.advance(dy, !!opts.stopOnNews, dy) : false;
      this.renderLive();
      this.afterAdvance(logLen);
      if (now - this.lastPanelAt > 260 && this.panelDirty) { this.panelDirty = false; this.lastPanelAt = now; this.renderPanels(); }
      if (g.finished) { this.endAnim(); this.finish(); return; }
      if (stopped || g.t >= target - 1e-9) { this.endAnim(); return; }
      this.animRaf = requestAnimationFrame(frame);
    };
    this.animRaf = requestAnimationFrame(frame);
    return new Promise<void>((res) => { this.animDone = res; });
  }

  private endAnim() {
    cancelAnimationFrame(this.animRaf);
    this.animating = false;
    this.running = false;
    this.panelDirty = false;
    if (this.tl) this.tl.runBtn.textContent = 'Run';
    this.setClockLock(false);
    this.motionSm = 0;
    this.view.setMotion(0);
    this.render();
    this.syncInteractive();
    this.tour?.setLite(false);
    this.tour?.notify('step');
    const done = this.animDone; this.animDone = null; done?.();
  }

  private syncInteractive() {
    this.view.setInteractive(!this.animating && !this.locked && !this.tour && !this.replaying && this.view.getMode() === 'earth');
  }

  private setClockLock(on: boolean) {
    this.tl.btns.forEach((b) => (b.disabled = on));
    this.tl.range.disabled = on;
    this.tlWrap.classList.toggle('busy', on);
  }

  private step(years: number) {
    if (this.locked || this.game.finished) return;
    this.animateTo(years);
  }

  private afterAdvance(logLen: number) {
    if (this.replaying) return; // a replay is shown as a film: captions only, no pop-ups
    const fresh = this.game.log.slice(logLen);
    const notable = fresh.filter((l) => l.tone !== 'info' || l.text.startsWith('Impactor hit') || l.text.startsWith('Gravity tractor arrived'));
    const l = notable.length ? notable[notable.length - 1] : null;
    // the narrator says what happened; when she does, the words on screen are hers
    let spoken: string | null = null;
    for (const e of fresh) {
      if (!e.voice) continue;
      if (audio.speak(e.voice, { queue: true, caption: e !== l }) && e === l) spoken = audio.line(e.voice);
    }
    if (!l) return;
    this.showNews(spoken ?? l.text, l.tone);
    if (!this.game.finished) {
      this.msgs.push({ role: 'assistant', content: `Update, ${fmtDate(dateAt(this.game.sc, this.game.t))}: ${l.text}`, provider: 'local' });
      if (this.tab !== 'advisor') { this.advisorBadge += 1; this.updateAdvisorBadge(); } else this.renderAdvisor();
    }
  }

  private showNews(text: string, tone: string) {
    clearTimeout(this.newsTimer);
    this.newsEl?.remove();
    const n = el('div', 'news');
    n.dataset.tone = tone;
    n.setAttribute('role', 'status');
    n.textContent = text;
    if (tone === 'warn' || tone === 'bad') audio.sfx('news');
    this.stage.appendChild(n);
    this.newsEl = n;
    this.newsTimer = window.setTimeout(() => { n.classList.add('out'); setTimeout(() => n.remove(), 400); }, 4200);
  }

  private startRun() {
    if (this.locked) return;
    this.running = true;
    this.animateTo(this.game.yearsLeft, { speed: 0.5, stopOnNews: true });
  }

  private stopRun() {
    if (this.animating) this.endAnim();
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
    this.tour?.stop();
    // the asteroid cam is for the game, not for the ending
    this.view.asteroidCam(false, true);
    const cam = this.hudTools.querySelector<HTMLButtonElement>('[data-act=rockcam]');
    if (cam) { cam.disabled = true; cam.setAttribute('aria-pressed', 'false'); cam.title = 'Asteroid cam is off: the game is over'; }
    audio.duck(0.35);
    const o = this.game.outcome!;
    const top = o.rows.filter((r) => r.deathsM > 0.0005 || r.exposedM > 0.0005)[0];
    const lost = o.deathsM >= 0.1 ? `${o.deathsM.toFixed(1)} million lost` : o.deathsM > 0.0005 ? `${Math.round(o.deathsM * 1000)},000 lost` : 'no lives lost';
    const title = o.hit ? 'IMPACT' : o.baselineHit ? 'DEFLECTED' : 'IT MISSED';
    const subtitle = o.hit ? (o.ocean ? `It struck the ocean. ${lost}` : top ? `Near ${top.city.name}. ${lost}` : `Away from major cities. ${lost}`) : `${Math.round(o.missKm).toLocaleString('en-US')} km from the centre of Earth`;
    this.view.setLabels([]);
    this.syncInteractive();
    this.card?.remove(); this.card = null; this.tip.hidden = true;
    this.view.playOutcome({ hit: o.hit, site: o.site, effects: o.effects, missRe: o.bFinal, missKm: o.missKm, sc: this.game.sc, title, subtitle, base: o.basePos, final: o.finalPos, deflected: o.deflected, fragmented: o.fragmented, cities: o.hit ? o.rows.filter((r) => r.distKm <= o.effects.rC && (r.deathsM > 0.0005 || r.exposedM > 0.0005)).slice(0, 10).map((r) => ({ lat: r.city.lat, lon: r.city.lon, level: r.distKm <= o.effects.rA ? 0 : r.distKm <= o.effects.rB ? 1 : 2 })) : [] }, () => this.onFinished());
  }

  // ------------------------------------------------------------ render

  /** Everything that must move every frame while time runs. */
  private renderLive() {
    const g = this.game;
    this.view.setCorridor(g.corridor);
    this.view.setTime(g.t, g.sc);
    const applied = g.corridor.state.applied;
    this.view.setMissions(
      g.decs.filter((d) => d.kind === 'kinetic' || d.kind === 'tractor' || d.kind === 'nuke' || d.kind === 'probe').map((d) => {
        const arrive = d.kind === 'kinetic' ? d.interceptT! : d.kind === 'nuke' ? d.detonateT! : d.arriveT!;
        const ap = applied.find((x) => x.id === d.id);
        const doomedBy = ap?.destroyedAt !== undefined ? applied.find((k) => k.kind === 'kinetic' && Math.abs(k.t0 - ap.destroyedAt!) < 1e-9)?.id : undefined;
        const shift = d.kind === 'kinetic' && ap ? { xi: ap.dir[0] * ap.nominalR, zeta: ap.dir[1] * ap.nominalR } : undefined;
        return { id: d.id, kind: d.kind as 'kinetic' | 'tractor' | 'nuke' | 'probe', tier: d.tier, doomedBy, shift, p: Math.max(0, Math.min(1, (g.t - d.t) / Math.max(1e-6, arrive - d.t))), arrived: g.t >= arrive };
      }),
    );
    const setText = (e: HTMLElement | ChildNode, v: string) => {
      if (e.textContent !== v) {
        e.textContent = v;
        const host = (e instanceof HTMLElement ? e : e.parentElement) as HTMLElement | null;
        host?.classList.remove('tick'); void host?.offsetWidth; host?.classList.add('tick');
      }
    };
    const p = g.p;
    audio.setTension(p * 1.3 + (1 - g.yearsLeft / g.sc.leadYears) * 0.35);
    setText(this.hudEls.p, oneInN(p));
    this.hudEls.p.dataset.level = p > 0.3 ? 'hot' : p > 0.02 ? 'warm' : 'cool';
    const r = g.coneRadiusKm;
    setText(this.hudEls.cone, r > 0 ? `${r >= 1000 ? Math.round(r / 100) * 100 : Math.round(r / 10) * 10}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + ' km' : 'none');
    this.hudEls.left.firstChild!.textContent = g.finished ? 'Now' : fmtYears(g.yearsLeft);
    this.hudEls.leftSub.textContent = fmtDate(dateAt(g.sc, g.sc.leadYears));
    this.tl.date.textContent = fmtDate(dateAt(g.sc, g.t));
    this.tl.sub.textContent = `${fmtYears(g.t)} since discovery`;
    if (this.dragMonths === null) this.tl.range.value = String(g.t * 12);
    this.sureNow = certaintyTime(g.sc, g.decs, g.t);
    this.drawTimeline();
    this.budgetEl.textContent = fmtMoney(g.budgetLeft);
    this.target.set({ now: this.blobOf(g.corridor), preview: null });
  }

  /** The heavier panels, only when something discrete changed. */
  private renderPanels(force = false) {
    const g = this.game;
    const labels = g.risk().filter((r) => r.p > 0.01).slice(0, 5).map((r) => ({ id: r.city.id, text: `${r.city.name} ${oneInN(r.p)}`, lat: r.city.lat, lon: r.city.lon, tone: 'risk' as const }));
    for (const id of g.evacSet()) {
      const c = CITIES.find((x) => x.id === id)!;
      if (!labels.find((l) => l.id === id)) labels.push({ id, text: `${c.name} planned`, lat: c.lat, lon: c.lon, tone: 'plan' as never });
    }
    this.view.setLabels(labels);
    if (force || this.tab === 'decide') this.renderDecide();
    if (force || this.tab === 'log') this.renderLog();
  }

  private render(force = false) {
    this.renderLive();
    this.renderPanels(force);
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
    const X = (t: number) => Math.max(0, Math.min(w, (t / lead) * w));
    const now = this.dragMonths !== null ? this.dragMonths / 12 : g.t;
    this.sureDraw = this.sureDraw < 0 ? this.sureNow : this.sureDraw + (this.sureNow - this.sureDraw) * 0.2;
    if (Math.abs(this.sureNow - this.sureDraw) < 0.002) this.sureDraw = this.sureNow;
    const sure = this.sureDraw, last = lastLaunchTime(g.sc);
    const small = h < 44;
    const pad = 3, row = small ? 6 : 11, gap = 3;
    const laneH = Math.floor((h - pad - row - gap * 2) / 2);
    const y1 = pad, y2 = pad + laneH + gap;
    const sans = '"Hanken Grotesk Variable", sans-serif';
    const bar = (x0: number, x1: number, y: number, color: string, alpha: number) => {
      if (x1 - x0 < 1) return;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      ctx.beginPath();
      const c = ctx as CanvasRenderingContext2D & { roundRect?: (x: number, y: number, w: number, h: number, r: number) => void };
      if (c.roundRect) c.roundRect(x0, y, x1 - x0, laneH, 4); else ctx.rect(x0, y, x1 - x0, laneH);
      ctx.fill();
      ctx.globalAlpha = 1;
    };
    const label = (text: string, x0: number, x1: number, y: number, indent = 6, right = false) => {
      if (laneH < 15) return;
      ctx.font = `600 11px ${sans}`;
      const tw = ctx.measureText(text).width;
      if (x1 - x0 < tw + indent + 16) return;
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.textBaseline = 'middle';
      // text on the right side is pinned to the end of the bar, so it stays still while the boundary slides
      if (right) { ctx.textAlign = 'right'; ctx.fillText(text, x1 - 10, y + laneH / 2 + 0.5); ctx.textAlign = 'start'; }
      else ctx.fillText(text, x0 + indent, y + laneH / 2 + 0.5);
    };
    const xNow = X(now);

    // what has already happened is dim; what is still ahead is coloured and named
    bar(0, xNow, y1, '#8aa0c0', 0.14);
    bar(0, xNow, y2, '#8aa0c0', 0.14);

    // top lane: can a new spacecraft still get there in time?
    const hasLaunch = last > now;
    if (hasLaunch) {
      bar(xNow, X(last), y1, col('--signal'), 0.38);
      label('You can launch', xNow, X(last), y1, 12);
    }
    const lateFrom = hasLaunch ? X(last) : xNow;
    bar(lateFrom, w, y1, col('--bad'), 0.3);
    label('Too late to launch', lateFrom, w, y1, 6, true);

    // bottom lane: how sure are we yet?
    const sureAt = Math.min(Math.max(sure, now), lead);
    const hasFog = sureAt > now + 0.005;
    if (hasFog) {
      bar(xNow, X(sureAt), y2, '#9db4d6', 0.16);
      ctx.save();
      ctx.beginPath(); ctx.rect(xNow, y2, X(sureAt) - xNow, laneH); ctx.clip();
      ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 1;
      for (let x = xNow - laneH; x < X(sureAt); x += 6) { ctx.beginPath(); ctx.moveTo(x, y2 + laneH); ctx.lineTo(x + laneH, y2); ctx.stroke(); }
      ctx.restore();
      label('Not sure yet', xNow, X(sureAt), y2, 12);
    }
    const clearFrom = hasFog ? X(sureAt) : xNow;
    if (sureAt < lead - 0.005) {
      bar(clearFrom, w, y2, col('--good'), 0.34);
      label('Answer clear', clearFrom, w, y2, 6, true);
    }
    // what buying this would change: the answer arrives sooner
    if (this.ghostSure !== null && this.ghostSure < sureAt - 0.01) {
      const gx = X(Math.max(now, this.ghostSure));
      bar(gx, X(sureAt), y2, col('--cool'), 0.45);
      label('sooner', gx, X(sureAt), y2);
    }

    // the two flags: the last day to launch, and the day the answer is clear
    const flag = (t: number, color: string) => {
      const x = Math.round(X(t));
      ctx.fillStyle = color;
      ctx.fillRect(x - 1, y1 - 1, 2, laneH * 2 + gap + 2);
      ctx.beginPath(); ctx.moveTo(x + 1, y1 - 1); ctx.lineTo(x + 10, y1 + 3.5); ctx.lineTo(x + 1, y1 + 8); ctx.fill();
    };
    if (hasLaunch && last < lead - 0.02) flag(last, col('--signal'));
    if (sureAt > now && sureAt < lead - 0.02) flag(sureAt, '#8fe0c4');

    // your orders: a dot where each was given, a line to the day it arrives
    const ry = h - row / 2;
    for (const d of g.decs) {
      const x = X(d.t);
      const arrive = d.kind === 'kinetic' ? d.interceptT : d.kind === 'nuke' ? d.detonateT : d.kind === 'tractor' || d.kind === 'probe' ? d.arriveT : undefined;
      const color = d.kind === 'evac' ? col('--cool') : d.kind === 'obs' ? col('--text-3') : col('--signal');
      if (arrive !== undefined) {
        const xa = X(arrive);
        ctx.strokeStyle = color; ctx.globalAlpha = 0.55; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x, ry); ctx.lineTo(xa, ry); ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.moveTo(xa + 1, ry); ctx.lineTo(xa - 5, ry - 4); ctx.lineTo(xa - 5, ry + 4); ctx.fill();
      }
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(x, ry, 3, 0, 7); ctx.fill();
    }
    // impact: the end of the line
    ctx.fillStyle = col('--bad');
    ctx.fillRect(w - 3, y1 - 1, 3, laneH * 2 + gap + 2);
    if (this.dragMonths !== null) {
      this.tl.date.textContent = fmtDate(dateAt(g.sc, now));
      this.tl.sub.textContent = `release to advance ${fmtYears(Math.max(0, now - g.t))}`;
    }
  }

  // ------------------------------------------------------------ decide

  // ------------------------------------------------------------ tour

  private maybeTour() {
    let seen = false;
    try { seen = localStorage.getItem('ad.tour') === 'done'; } catch { /* storage blocked: show the tour */ }
    if (!seen && !this.fast) setTimeout(() => { this.tourAuto = true; this.startTour(); }, 1100);
  }

  startTour() {
    this.tour?.stop();
    this.stopRun();
    this.setTab('decide');
    this.tour = new Tour(this.tourSteps(), () => {
      try { localStorage.setItem('ad.tour', 'done'); } catch { /* ignore */ }
      this.tour = null;
      this.setTab('decide');
      this.syncInteractive();
      // the tutorial spent a telescope and a year: start the real round from scratch
      if (this.tourAuto && (this.game.decs.length > 0 || this.game.t > 0)) { this.tourAuto = false; this.opts.onResetAfterTour?.(); }
      this.tourAuto = false;
    });
    this.tour.start();
    this.syncInteractive();
  }

  private tourSteps(): TourStep[] {
    return [
      { title: 'Don\'t look up. Do.', text: audio.enabled ? audio.line('tour_intro') : 'An asteroid may hit Earth. This quick tour shows you where everything is.', voice: 'tour_intro', next: 'Start' },
      {
        target: '.target-wrap',
        title: 'Possible paths',
        voice: 'tour_paths',
        text: 'The asteroid is on the left, Earth on the right. Each line is a path it might still take.<ul class="sw-list"><li><i class="sw amber"></i><span><b>Amber line:</b> a path that misses Earth.</span></li><li><i class="sw red"></i><span><b>Red line:</b> a path that hits Earth. More red means more danger.</span></li></ul>',
      },
      { target: '.readouts', title: 'Your numbers', text: audio.enabled ? audio.line('tour_numbers') : 'Chance it hits, how wide the danger zone is, and how long you have.', voice: 'tour_numbers' },
      { target: 'canvas.view-canvas', title: 'The globe', text: audio.enabled ? audio.line('tour_globe') : 'Drag to turn it. The amber dots show where on Earth it could land. Try dragging now.', voice: 'tour_globe', spot: 'stage' },
      { target: '[data-act=rockcam]', title: 'Asteroid cam', text: audio.enabled ? audio.line('tour_cam') : 'Press this to fly alongside the asteroid.', voice: 'tour_cam', wait: 'rockcam', next: null },
      { target: '[data-act=rockcam]', title: 'Nice view', text: audio.enabled ? audio.line('tour_cam_back') : 'Press it again to come back to Earth.', voice: 'tour_cam_back', wait: 'rockcam', next: null },
      { target: '[data-act=focus]', title: 'Show the danger zone', text: audio.enabled ? audio.line('tour_focus') : 'This turns the globe to where the asteroid could land.', voice: 'tour_focus' },
      { target: '.timeline', title: 'Time', text: audio.enabled ? `${audio.line('tour_flag')} ${audio.line('tour_sure')}` : 'Hatched means you are not sure yet. The yellow flag is the last day a spacecraft can still help. Green is when you will know.', voice: 'tour_flag', voice2: 'tour_sure', placement: 'above' },
      { target: '[data-do=obs-space]', title: 'Try a telescope', text: audio.enabled ? `${audio.line('tour_scope')} Hover to preview, then press it to buy.` : 'Telescopes show the path sooner. Hover to preview, then press it to buy.', voice: 'tour_scope', wait: 'buy', next: null, onEnter: () => this.setTab('decide') },
      { target: '[data-step="12"]', title: 'Move time forward', text: audio.enabled ? `${audio.line('tour_time')} Press +1 yr.` : 'Press +1 yr and watch the lines narrow.', voice: 'tour_time', wait: 'step', next: null, placement: 'above' },
      { target: '.chat', title: 'Dr. Okafor, your AI Agent', text: audio.enabled ? audio.line('tour_okafor') : 'If you are ever confused on what something does, or what to do next, feel free to ask me anything here.', voice: 'tour_okafor', next: 'Done', onEnter: () => this.setTab('advisor') },
    ];
  }

  // ------------------------------------------------------------ preview

  private blobOf(c: Corridor): Blob {
    return { xi: c.state.center.xi, zeta: c.state.center.zeta, sxi: c.state.sigma.xi, szeta: c.state.sigma.zeta };
  }

  /** What would this option do? The chart morphs to show it before any money is spent. */
  private applyPreview() {
    const g = this.game;
    const key = this.hover ?? this.pending?.key ?? null;
    let preview: { sigmaScale?: number; redScale?: number } | null = null;
    const now = this.blobOf(g.corridor);
    this.ghostSure = null;
    if (key && !g.finished) {
      if (key.startsWith('obs-')) {
        const o = OBS[key.slice(4) as ObsKind];
        preview = { sigmaScale: obsEffect(g.sc, g.decs, g.t, o) };
        const extra: Decision = { id: 'pv', kind: 'obs', t: g.t, costB: 0, label: '', bonusYears: o.bonusYears, durYears: o.durYears };
        this.ghostSure = certaintyTime(g.sc, [...g.decs, extra], g.t);
      } else if (key === 'kin' || key === 'tractor') {
        const plan = key === 'kin' ? kineticPlan(g.sc, this.tier, g.t, g.betaKnownAt(g.t + g.sc.cruiseYears)) : null;
        const tp = key === 'tractor' ? tractorPlan(g.sc, g.t) : null;
        const push = plan?.feasible ? plan.expectedR : tp?.feasible ? tp.expectedR : 0;
        const when = plan?.feasible ? plan.interceptT : tp?.feasible ? tp.endT : g.t;
        if (push > 0) {
          const r = riskWithPush(g.sc, g.decs, g.t, g.corridor.state.applied, push, when);
          const k = r.before > 0 ? Math.max(0, Math.min(1, r.after / r.before)) : 1;
          preview = { redScale: k };
        }
      }
    }
    this.target.set({ now, preview });
    this.drawTimeline();
  }

  // ------------------------------------------------------------ decide

  private tile(key: string, icon: keyof typeof TILE_ICONS, title: string, desc: string, effect: string, cost: string, disabled: boolean, extra = '') {
    return `<button type="button" class="tile" data-do="${key}" data-preview="${key}" ${disabled ? 'disabled' : ''}>
      <span class="ti">${TILE_ICONS[icon]}</span>
      <span class="tt"><b>${esc(title)}</b><span class="td">${esc(desc)}</span><span class="te">${esc(effect)}</span></span>
      <span class="tc">${cost}</span>
      ${extra}
    </button>`;
  }

  private renderDecide() {
    const g = this.game, sc = g.sc;
    const scrollTop = this.panel.scrollTop;
    const fx = impactEffects(sc);
    const obsUsed = g.obsBonusUsed();
    const need = g.neededPushRe();
    const done = g.finished;
    const mt = fx.energyMt >= 100 ? Math.round(fx.energyMt).toLocaleString('en-US') : fx.energyMt.toFixed(1);

    this.headEl.innerHTML = `
      <h2>${esc(sc.name)}</h2>
      <p class="stats"><span><b>${sc.diameterM + ' m'}</b> wide</span><span><b>${sc.vImpact.toFixed(1)} km/s</b></span><span><b>${mt} Mt</b> blast</span><span>hits <b>${fmtDate(dateAt(sc, sc.leadYears))}</b></span></p>
      <details class="brief-more"><summary>About this asteroid</summary><p>${esc(this.briefing)}</p><p class="muted">${esc(sc.diameterNote)}.${sc.facts.length ? ' ' + esc(sc.facts.join(' ')) : ''}</p></details>
`;

    const obsTile = (k: ObsKind, icon: keyof typeof TILE_ICONS, title: string) => {
      const o = OBS[k];
      const capped = obsUsed + o.bonusYears > MAX_OBS_BONUS + (k === 'radar' ? 0.5 : 0) + 1e-9;
      const poor = g.budgetLeft < o.costB;
      const tooFar = k === 'radar' && g.yearsLeft > RADAR_WINDOW_YEARS;
      const scale = obsEffect(sc, g.decs, g.t, o);
      void scale;
      const extra: Decision = { id: 'pv', kind: 'obs', t: g.t, costB: 0, label: '', bonusYears: o.bonusYears, durYears: o.durYears };
      const months = Math.round((this.sureNow - certaintyTime(sc, [...g.decs, extra], g.t)) * 12);
      const eff = tooFar ? `Opens ${fmtYears(RADAR_WINDOW_YEARS)} before impact` : capped ? 'Capacity used up' : months > 0 ? `Know the answer ${months} months sooner` : 'Little gain now';
      const desc = k === 'ground' ? 'Watch it from Earth to learn its path.' : k === 'space' ? 'Watch from space: sharper and faster.' : 'Bounce radar off it once it is close: very sharp.';
      return this.tile(`obs-${k}`, icon, title, desc, eff, fmtMoney(o.costB), capped || poor || done || tooFar);
    };

    const kp = kineticPlan(sc, this.tier, g.t, g.betaKnownAt(g.t + sc.cruiseYears));
    const riskTxt = (push: number, when: number) => {
      const r = riskWithPush(sc, g.decs, g.t, g.corridor.state.applied, push, when);
      return `Risk ${oneInN(r.before)} to ${oneInN(r.after)}`;
    };
    const kRisk = kp.feasible ? riskTxt(kp.expectedR, kp.interceptT) : '';
    const kinOk = kp.feasible && g.budgetLeft >= KINETIC[this.tier].costB && !done;
    const frac = kp.feasible ? Math.min(1, kp.expectedR / need) : 0;
    const tp = tractorPlan(sc, g.t);
    const tfrac = tp.feasible ? Math.min(1, tp.expectedR / need) : 0;
    const tRisk = tp.feasible ? riskTxt(tp.expectedR, tp.endT) : '';
    const gauge = (f: number, label: string) => `<span class="gauge" data-met="${f >= 0.999}" role="img" aria-label="${label}: ${Math.round(f * 100)} percent of the push needed"><i style="width:${Math.round(f * 100)}%"></i></span>`;

    const orders = g.decs.length
      ? `<section class="group"><h3>On the way</h3><ul class="orders">${g.decs
          .map((d) => {
            let frac2 = 1, label = 'Done', icon: keyof typeof TILE_ICONS = 'scope';
            if (d.kind === 'obs') { frac2 = Math.min(1, (g.t - d.t) / (d.durYears ?? 0.25)); label = frac2 >= 1 ? 'Data in' : 'Data arriving'; icon = 'scope'; }
            else if (d.kind === 'kinetic') { const span = d.interceptT! - d.t; frac2 = Math.min(1, (g.t - d.t) / span); label = frac2 >= 1 ? 'Struck' : `Arrives ${fmtDate(dateAt(sc, d.interceptT!))}`; icon = 'rocket'; }
            else if (d.kind === 'tractor') { const span = d.endT! - d.t; frac2 = Math.min(1, (g.t - d.t) / span); label = g.t >= d.arriveT! ? 'Towing' : `Arrives ${fmtDate(dateAt(sc, d.arriveT!))}`; icon = 'tractor'; }
            else if (d.kind === 'probe') { const span = d.arriveT! - d.t; frac2 = Math.min(1, (g.t - d.t) / span); label = frac2 >= 1 ? 'Alongside' : `Arrives ${fmtDate(dateAt(sc, d.arriveT!))}`; icon = 'probe'; }
            else if (d.kind === 'nuke') { const span = d.detonateT! - d.t; frac2 = Math.min(1, (g.t - d.t) / span); label = frac2 >= 1 ? 'Detonated' : `Detonates ${fmtDate(dateAt(sc, d.detonateT!))}`; icon = 'nuke'; }
            else if (d.mode === 'shelter') { frac2 = shelterFraction(d.t, sc.leadYears) / 0.4; label = `${Math.round(frac2 * 100)}% ready`; icon = 'shelter'; }
            else { frac2 = evacFraction(d.t, sc.leadYears) / 0.9; label = `${Math.round(frac2 * 100)}% ready`; icon = 'people'; }
            return `<li><span class="ti sm">${TILE_ICONS[icon]}</span><span class="on-t">${esc(d.label.replace('Evacuation planning: ', ''))}</span><span class="on-s">${esc(label)}</span><span class="gauge" aria-hidden="true"><i style="width:${Math.round(frac2 * 100)}%"></i></span></li>`;
          })
          .join('')}</ul></section>`
      : '';

    const risk = g.risk().filter((r) => r.p > 0.001).slice(0, 5);
    const shelterMode = this.protectMode === 'shelter';
    const planned = shelterMode ? g.shelterSet() : g.evacSet();
    const costP = shelterMode ? SHELTER_COST_B : EVAC_COST_B;
    const evacRows = risk.length
      ? risk
          .map((r) => {
            const isPlanned = planned.has(r.city.id);
            const key = `${shelterMode ? 'shelter' : 'evac'}-${r.city.id}`;
            const adv = adviceFor(g, shelterMode ? { kind: 'shelter', cityId: r.city.id, p: r.p } : { kind: 'evac', cityId: r.city.id, p: r.p });
            return `<div class="risk"><div class="c"><b>${esc(r.city.name)}</b><span>${r.city.popM >= 1 ? r.city.popM.toFixed(1) + 'M' : Math.round(r.city.popM * 1000) + 'k'} people</span></div>
              <div class="bar" role="img" aria-label="Chance of damage: ${oneInN(r.p)}"><i style="width:${Math.max(4, Math.round(Math.sqrt(r.p) * 100))}%"></i></div>
              <div class="pp">${oneInN(r.p)}</div>
              ${isPlanned ? `<span class="chip ok">${shelterMode ? 'Built' : 'Planned'}</span>` : `<button class="btn small" data-do="${key}" ${g.budgetLeft < costP || done ? 'disabled' : ''}>${shelterMode ? 'Build' : 'Plan'} ${fmtMoney(costP)}</button>`}
              ${this.pending?.key === key ? `<div style="grid-column:1/-1">${this.confirmHtml(adv, true)}</div>` : ''}
            </div>`;
          })
          .join('')
      : `<p class="muted">No city is at real risk right now.</p>`;

    const pp = probePlan(sc, g.t);
    const probeSent = g.has('probe');
    const probeEff = probeSent ? 'Already sent' : !pp.feasible ? 'Too late to arrive' : `Reaches it in ${fmtYears(sc.cruiseYears * PROBE.cruiseFactor)}. Makes pushes predictable`;
    const fs = g.fundingStatus();
    const fundTile = this.tile('fund', 'coin', 'Ask for more money', 'Governments pay more once the danger looks real.', fs.ok ? `They would grant about ${fmtMoney(fs.offer)} now` : fs.why || 'Not available', 'Free', !fs.ok || done);

    this.bodyEl.innerHTML = `
      <section class="group">
        <h3>Money</h3>
        <div class="tiles">
          ${fundTile}
        </div>
      </section>

      <section class="group">
        <h3>See more</h3>
        <div class="tiles">
          ${obsTile('ground', 'scope', 'Ground telescopes')}
          ${this.pending?.key === 'obs-ground' ? this.confirmHtml(adviceFor(g, { kind: 'obs' })) : ''}
          ${obsTile('space', 'sat', 'Space telescope')}
          ${this.pending?.key === 'obs-space' ? this.confirmHtml(adviceFor(g, { kind: 'obs' })) : ''}
          ${obsTile('radar', 'radar', 'Radar imaging')}
          ${this.pending?.key === 'obs-radar' ? this.confirmHtml(adviceFor(g, { kind: 'obs' })) : ''}
          ${this.tile('probe', 'probe', 'Rendezvous probe', 'Fly a small craft alongside to weigh and track it.', probeEff, fmtMoney(PROBE.costB), probeSent || !pp.feasible || g.budgetLeft < PROBE.costB || done)}
          ${this.pending?.key === 'probe' ? this.confirmHtml(adviceFor(g, { kind: 'probe' })) : ''}
        </div>
      </section>

      <section class="group">
        <h3>Push it off course</h3>
        <div class="tiers" role="group" aria-label="Impactor size">
          ${(Object.keys(KINETIC) as KineticTier[]).map((k) => `<button type="button" data-tier="${k}" aria-pressed="${this.tier === k}"><b>${KINETIC[k].label.replace(' impactor', '')}</b><span>${fmtMoney(KINETIC[k].costB)}</span></button>`).join('')}
        </div>
        <div class="tiles">
          ${this.tile('kin', 'rocket', 'Kinetic impactor', 'Crash a spacecraft into it to nudge it.', kp.feasible ? `Takes ${fmtYears(sc.cruiseYears)}. ${kRisk}` : 'Too late to arrive', fmtMoney(KINETIC[this.tier].costB), !kinOk, kp.feasible ? gauge(frac, 'Impactor') : '')}
          ${this.pending?.key === 'kin' ? this.confirmHtml(adviceFor(g, { kind: 'kinetic', tier: this.tier })) : ''}
          ${this.tile('tractor', 'tractor', 'Gravity tractor', 'Park beside it; gravity slowly pulls it off course.', tp.feasible ? `Slow tow. ${tRisk}` : 'Too late: needs years', fmtMoney(TRACTOR.costB), !(tp.feasible && g.budgetLeft >= TRACTOR.costB && !done), tp.feasible ? gauge(tfrac, 'Tractor') : '')}
          ${this.pending?.key === 'tractor' ? this.confirmHtml(adviceFor(g, { kind: 'tractor' })) : ''}
        </div>
      </section>

      ${this.lastResortHtml()}
      <section class="group">
        <h3>Protect people</h3>
        <div class="tiers two" role="group" aria-label="How to protect people">
          <button type="button" data-protect="evac" aria-pressed="${!shelterMode}"><b>Evacuate</b><span>Best with a year or more. ${fmtMoney(EVAC_COST_B)} a city</span></button>
          <button type="button" data-protect="shelter" aria-pressed="${shelterMode}"><b>Build shelters</b><span>Works late, saves up to 4 in 10. ${fmtMoney(SHELTER_COST_B)} a city</span></button>
        </div>
        <div class="risk-list">${evacRows}</div>
      </section>
      ${orders}`;
    this.panel.scrollTop = scrollTop;
    this.applyPreview();
  }

  private confirmHtml(adv: { level: 'ok' | 'warn'; text: string }, tight = false) {
    return `<div class="confirm" data-level="${adv.level}"><p>${adv.level === 'warn' ? '<b>Dr. Okafor:</b> ' : ''}${esc(adv.text)}</p><div class="row"><button class="btn small primary" data-confirm>${adv.level === 'warn' ? (tight ? 'Plan anyway' : 'Do it anyway') : 'Confirm'}</button><button class="btn small quiet" data-cancel>Cancel</button></div></div>`;
  }

  private onDecideClick(e: Event) {
    const t = e.target as HTMLElement;
    const protectBtn = t.closest<HTMLElement>('[data-protect]');
    if (protectBtn) {
      this.protectMode = protectBtn.dataset.protect as 'evac' | 'shelter';
      this.pending = null;
      if (this.protectMode === 'shelter') audio.speak('adv_shelter');
      this.renderDecide();
      return;
    }
    const tierBtn = t.closest<HTMLElement>('[data-tier]');
    if (tierBtn) { this.tier = tierBtn.dataset.tier as KineticTier; this.pending = null; this.renderDecide(); return; }
    if (t.closest('[data-cancel]')) { this.pending = null; this.renderDecide(); return; }
    if (t.closest('[data-confirm]')) { const p = this.pending; this.pending = null; p?.run(); this.renderDecide(); return; }
    const d = t.closest<HTMLElement>('[data-do]');
    if (!d || this.locked || this.replaying) return;
    const key = d.dataset.do!;
    const g = this.game;
    if (key === 'nuke') { this.openNukeDialog(); return; }
    let run: () => void;
    let adv: { level: 'ok' | 'warn'; text: string; voice?: string };
    if (key === 'kin') { adv = adviceFor(g, { kind: 'kinetic', tier: this.tier }); run = () => { if (g.launchKinetic(this.tier)) { toast(audio.say('ev_launch', 'Impactor launched. Watch it fly out to the asteroid.')); this.bought('launch'); this.renderLive(); this.tour?.notify('buy'); } }; }
    else if (key === 'tractor') { adv = adviceFor(g, { kind: 'tractor' }); run = () => { if (g.launchTractor()) { toast(audio.say('ev_launch', 'Gravity tractor launched.')); this.bought('launch'); this.renderLive(); this.tour?.notify('buy'); } }; }
    else if (key.startsWith('obs-')) { const k = key.slice(4) as ObsKind; adv = adviceFor(g, { kind: 'obs' }); run = () => { if (g.fundObs(k)) { this.view.pulse(); toast(k === 'radar' ? 'Radar pointed at it. The picture will sharpen fast.' : audio.say('ev_telescope', 'Telescope time bought. The picture will sharpen.')); this.bought('scan'); this.tour?.notify('buy'); } }; }
    else if (key === 'probe') { adv = adviceFor(g, { kind: 'probe' }); run = () => { if (g.launchProbe()) { toast(audio.say('ev_launch', 'Probe launched. Watch it fly out to the asteroid.')); this.bought('launch'); this.renderLive(); } }; }
    else if (key === 'fund') {
      adv = { level: 'ok', text: '' };
      run = () => { const off = g.fundingStatus().offer; if (g.requestFunding()) { toast(audio.say('ev_funding_ok', `Approved: ${fmtMoney(off)} more to spend.`)); audio.sfx('kaching'); this.renderLive(); } };
    }
    else if (key.startsWith('shelter-')) {
      const id = key.slice(8);
      const r = g.risk().find((x) => x.city.id === id);
      adv = adviceFor(g, { kind: 'shelter', cityId: id, p: r?.p ?? 0 });
      run = () => { if (g.planShelter(id)) { const c = CITIES.find((x) => x.id === id); if (c) this.view.ping(c.lat, c.lon); toast('Shelters going up.'); this.bought('plain'); } };
    }
    else if (key.startsWith('evac-')) {
      const id = key.slice(5);
      const r = g.risk().find((x) => x.city.id === id);
      adv = adviceFor(g, { kind: 'evac', cityId: id, p: r?.p ?? 0 });
      run = () => { if (g.planEvac(id)) { const c = CITIES.find((x) => x.id === id); if (c) this.view.ping(c.lat, c.lon); toast('Evacuation planning started.'); this.bought('plain'); } };
    } else return;
    // Questionable orders get a warning sound and, where there is one, the narrator's words.
    if (adv.level === 'warn') audio.sfx('denied');
    if (adv.voice) adv.text = audio.say(adv.voice, adv.text, { once: false, caption: false, interrupt: true });
    // Cheap or sensible orders go straight through; questionable ones ask first.
    if (adv.level === 'ok' && (key.startsWith('obs-') || key.startsWith('evac-') || key.startsWith('shelter-') || key === 'fund')) { run(); return; }
    this.pending = { key, text: adv.text, level: adv.level, run };
    this.renderDecide();
  }

  // ------------------------------------------------------------ log

  private renderLog() {
    const g = this.game;
    this.panes.log.innerHTML = `
      <h2>Mission log</h2>
      <p class="muted">The bar under the map shows when you can still launch and when the answer becomes clear. Everything that happens lands here.</p>
      <ol class="log" reversed>${[...g.log].reverse().map((l) => `<li data-tone="${l.tone}"><time>${esc(fmtDate(dateAt(g.sc, l.t)))}</time><span class="t">${esc(l.text)}</span></li>`).join('')}</ol>`;
  }

  // ------------------------------------------------------------ the last resort

  private lastResortHtml(): string {
    const g = this.game;
    const plan = nukePlan(g.sc, g.t);
    const afford = g.budgetLeft >= NUKE.costB;
    const ok = plan.feasible && afford && !g.finished;
    const open = g.yearsLeft > g.sc.cruiseYears + 0.9;
    const eff = !plan.feasible ? 'Too late even for this' : !afford ? `Needs ${fmtMoney(NUKE.costB)}` : open ? 'Do not: cheaper options are still open' : `Breaks it up. Lands ${fmtYears(plan.remainingYears)} before impact`;
    return `<section class="group danger-zone">
      <h3>Last resort</h3>
      <div class="tiles">
        <button type="button" class="tile danger" data-do="nuke" ${ok ? '' : 'disabled'}>
          <span class="ti">${TILE_ICONS.nuke}</span>
          <span class="tt"><b>Nuclear burst</b><span class="td">Break the asteroid into pieces. Risky, costly, and not a fix.</span><span class="te">${esc(eff)}</span></span>
          <span class="tc">${fmtMoney(NUKE.costB)}</span>
        </button>
      </div>
    </section>`;
  }

  private openNukeDialog() {
    const g = this.game;
    const plan = nukePlan(g.sc, g.t);
    if (!plan.feasible || g.budgetLeft < NUKE.costB) return;
    const open = g.yearsLeft > g.sc.cruiseYears + 0.9;
    const d = document.createElement('dialog');
    d.className = 'nuke';
    d.innerHTML = `<div class="in">
      <div class="nuke-head"><span class="ti">${TILE_ICONS.nuke}</span><div><h2>Last resort: nuclear burst</h2><span class="muted">Read this first.</span></div></div>
      ${open ? '<div class="nuke-alert"><b>Stop.</b> A spacecraft could still do this job for far less. Using this now will cost you points.</div>' : ''}
      <div class="nuke-expl"><b>Dr. Okafor, AI Agent</b><p class="ex">Checking the numbers...</p></div>
      <ul class="nuke-warn">${NUKE_WARNINGS.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>
      <p class="nuke-facts"><span><b>${fmtMoney(NUKE.costB)}</b> cost</span><span>Detonates <b>${esc(fmtDate(dateAt(g.sc, plan.detonateT)))}</b></span><span><b>${fmtYears(plan.remainingYears)}</b> before impact</span></p>
      <label class="ack"><input type="checkbox" /> I understand this is a last resort.</label>
      <div class="row-actions"><button type="button" class="btn" data-cancel-nuke>Cancel</button><button type="button" class="btn danger" data-go disabled>Detonate anyway</button></div>
    </div>`;
    document.body.appendChild(d);
    audio.sfx('siren');
    audio.speak('nuke_warn', { interrupt: true, once: false });
    if (open) audio.speak('nuke_open', { queue: true, once: false });
    d.addEventListener('close', () => d.remove());
    d.addEventListener('click', (e) => { if (e.target === d || (e.target as HTMLElement).hasAttribute('data-cancel-nuke')) d.close(); });
    const box = d.querySelector<HTMLInputElement>('input[type=checkbox]')!;
    const go = d.querySelector<HTMLButtonElement>('[data-go]')!;
    box.addEventListener('change', () => (go.disabled = !box.checked));
    go.addEventListener('click', () => { d.close(); if (g.launchNuke()) { toast(audio.say('nuke_launched', 'Nuclear device launched. There is no taking it back.', { interrupt: true, once: false })); this.bought('launch'); this.renderLive(); this.renderDecide(); } });
    d.showModal();
    const ex = d.querySelector('.ex')!;
    const fallback = open
      ? 'This is a bad idea right now. It shatters the asteroid rather than removing it, and you still have time for a spacecraft that nudges it cleanly. Save this for when nothing else can arrive.'
      : 'It is a last resort. It will not remove the threat: it turns one big rock into many smaller ones, some of which may still hit, and it carries heavy political cost. Only use it when no spacecraft can arrive in time.';
    void postAI('/api/advisor', { messages: [{ role: 'user', content: 'In three short plain sentences, explain why a nuclear burst against this asteroid is a bad idea unless it is a last resort, and what it would really do.' }], state: g.snapshot() }).then((res) => {
      const text = (res?.text ?? fallback).trim().replace(/\s+/g, ' ');
      let i = 0;
      const words = text.split(' ');
      const id = window.setInterval(() => { i++; ex.textContent = words.slice(0, i).join(' '); if (i >= words.length) clearInterval(id); }, 30);
    });
  }

  // ------------------------------------------------------------ hover and click on the asteroid and spacecraft

  private decisionName(id: string): { title: string; type: string; what: string } | null {
    const g = this.game;
    const d = g.decs.find((x) => x.id === id);
    if (!d) return null;
    const same = g.decs.filter((x) => x.kind === d.kind);
    const n = same.indexOf(d) + 1;
    if (d.kind === 'kinetic') return { title: `Impactor ${n} (${KINETIC[d.tier!].label.replace(' impactor', '')})`, type: 'Kinetic impactor', what: 'A spacecraft that crashes into the asteroid at high speed to nudge it. A tiny nudge years early becomes a big miss.' };
    if (d.kind === 'tractor') return { title: `Gravity tractor ${n}`, type: 'Gravity tractor', what: 'A heavy spacecraft that hovers beside the asteroid. Its gravity slowly tugs the asteroid off course. Gentle and precise, but slow.' };
    if (d.kind === 'probe') return { title: `Rendezvous probe`, type: 'Rendezvous probe', what: 'A small spacecraft that flies alongside the asteroid, weighs it and tracks it closely. After it arrives, the team knows exactly how hard an impactor will push, and the orbit is sharper.' };
    if (d.kind === 'nuke') return { title: `Nuclear device ${n}`, type: 'Nuclear burst', what: 'A nuclear device detonated beside the asteroid to break it into pieces. A last resort: pieces can still hit.' };
    return null;
  }

  private onHover(i: PickInfo | null) {
    if (!i || this.card) { this.tip.hidden = true; return; }
    const g = this.game;
    let text: string;
    if (i.id === 'asteroid') text = `${g.sc.name}: the asteroid`;
    else {
      const nm = this.decisionName(i.id);
      if (!nm) { this.tip.hidden = true; return; }
      text = nm.title;
    }
    const r = this.stage.getBoundingClientRect();
    this.tip.textContent = text;
    this.tip.hidden = false;
    this.tip.style.transform = `translate(${Math.min(r.width - 190, i.x - r.left + 16)}px, ${Math.max(8, i.y - r.top - 38)}px)`;
  }

  private onPick(i: PickInfo) {
    this.tip.hidden = true;
    this.showCard(i.id);
  }

  private showCard(id: string) {
    const g = this.game, sc = g.sc;
    this.card?.remove();
    const rows: [string, string][] = [];
    let title: string, type: string, what: string, icon: keyof typeof TILE_ICONS;
    if (id === 'asteroid') {
      const fx = impactEffects(sc);
      title = sc.name; type = 'The asteroid'; icon = 'rock';
      what = `${sc.diameterNote}.`;
      rows.push(['Designation', sc.designation], ['Width', `${sc.diameterM} m`], ['Mass', `${(sc.massKg / 1e9).toLocaleString('en-US', { maximumFractionDigits: 1 })} million tonnes`], ['Speed at impact', `${sc.vImpact.toFixed(1)} km/s`], ['Blast if it hit', `${fx.energyMt >= 100 ? Math.round(fx.energyMt).toLocaleString('en-US') : fx.energyMt.toFixed(1)} megatons`], ['Would arrive', fmtDateLong(dateAt(sc, sc.leadYears))], ['Chance it hits now', oneInN(g.p)]);
      if (sc.orbit) rows.push(['Orbit', `${sc.orbit.a.toFixed(2)} AU wide, tilted ${sc.orbit.i.toFixed(0)} degrees`]);
    } else {
      const nm = this.decisionName(id);
      const d = g.decs.find((x) => x.id === id);
      if (!nm || !d) return;
      title = nm.title; type = nm.type; what = nm.what;
      icon = d.kind === 'tractor' ? 'tractor' : d.kind === 'nuke' ? 'nuke' : d.kind === 'probe' ? 'probe' : 'rocket';
      rows.push(['Cost', fmtMoney(d.costB)], ['Launched', fmtDateLong(dateAt(sc, d.t))]);
      const ap = g.corridor.state.applied.find((a) => a.id === id);
      if (d.kind === 'kinetic') {
        const done = g.t >= d.interceptT!;
        rows.push([done ? 'Struck' : 'Arrives', fmtDateLong(dateAt(sc, d.interceptT!))], ['Weight', `${(KINETIC[d.tier!].massKg / 1000).toFixed(0)} tonnes`], ['Status', done ? 'Hit the asteroid' : `In flight, ${Math.round(Math.min(1, (g.t - d.t) / (d.interceptT! - d.t)) * 100)}% of the way`]);
        if (ap) rows.push(['Push it gives', `about ${(ap.nominalR / sc.bImp * 100).toFixed(0)}% of the way past Earth (predicted)`]);
      } else if (d.kind === 'tractor') {
        const dead = ap?.destroyedAt !== undefined && g.t >= ap.destroyedAt;
        rows.push(['Arrives', fmtDateLong(dateAt(sc, d.arriveT!))], ['Tows until', fmtDateLong(dateAt(sc, ap?.destroyedAt ?? d.endT!))], ['Status', dead ? 'Destroyed by impact debris' : g.t < d.arriveT! ? 'In flight' : g.t < d.endT! ? 'Towing now' : 'Finished towing']);
      } else if (d.kind === 'probe') {
        const done = g.t >= d.arriveT!;
        rows.push([done ? 'Arrived' : 'Arrives', fmtDateLong(dateAt(sc, d.arriveT!))], ['Status', done ? 'Alongside, tracking it' : 'In flight'], ['What it gives', 'Predictable pushes and a sharper orbit']);
      } else {
        const done = g.t >= d.detonateT!;
        rows.push([done ? 'Detonated' : 'Detonates', fmtDateLong(dateAt(sc, d.detonateT!))], ['Status', done ? 'The asteroid broke into pieces' : 'In flight']);
      }
    }
    const c = el('div', 'pickcard');
    c.setAttribute('role', 'dialog');
    c.setAttribute('aria-label', title);
    c.innerHTML = `<button type="button" class="x" aria-label="Close">${ICONS.minus.replace('M5 12h14', 'M6 6l12 12M18 6L6 18')}</button>
      <div class="pc-head"><span class="ti">${TILE_ICONS[icon]}</span><div><h3>${esc(title)}</h3><span class="pc-sub">${esc(type)}</span></div></div>
      <p class="pc-what">${esc(what)}</p>
      <dl class="pc-rows">${rows.map(([a, b]) => `<div><dt>${esc(a)}</dt><dd>${esc(b)}</dd></div>`).join('')}</dl>`;
    this.stage.appendChild(c);
    this.card = c;
    const close = () => { c.classList.add('out'); setTimeout(() => c.remove(), 220); if (this.card === c) this.card = null; };
    c.querySelector('.x')!.addEventListener('click', close);
    const esc2 = (e: KeyboardEvent) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc2); } };
    document.addEventListener('keydown', esc2);
  }

  // ------------------------------------------------------------ replay of another player's run

  private async runReplay(r: NonNullable<MissionOpts['replay']>) {
    this.replaying = true;
    this.syncInteractive();
    this.tour?.stop();
    const g = this.game;
    const names: Record<string, string> = {};
    const label = (a: ActionLog) =>
      a.k === 'obs' ? (a.which === 'space' ? 'Bought space telescope time' : a.which === 'radar' ? 'Used radar imaging' : 'Bought ground telescope time') : a.k === 'kin' ? `Launched a ${KINETIC[a.tier].label.toLowerCase()}` : a.k === 'tractor' ? 'Dispatched a gravity tractor' : a.k === 'nuke' ? 'Detonated a nuclear device' : a.k === 'probe' ? 'Sent a rendezvous probe' : a.k === 'fund' ? 'Asked for more money' : a.k === 'shelter' ? `Built shelters in ${CITIES.find((c) => c.id === a.city)?.name ?? a.city}` : `Planned evacuation of ${CITIES.find((c) => c.id === a.city)?.name ?? a.city}`;
    void names;
    this.panel.innerHTML = `<div class="pane replay-pane">
      <h2>Replay</h2>
      <p class="muted">${esc(r.name)} · score ${r.score}. Sit back: this is a film of what they did, sped up.</p>
      <ol class="events">${r.actions.map((a, i) => `<li data-i="${i}"><span class="when">${esc(fmtDate(dateAt(g.sc, a.t)))}</span><span class="what">${esc(label(a))}</span></li>`).join('') || '<li class="none">They took no actions at all.</li>'}</ol>
      <div class="row-actions"><button class="btn" id="replay-exit">Back to home</button></div>
    </div>`;
    this.panel.querySelector('#replay-exit')!.addEventListener('click', () => this.onExit());
    this.panel.scrollTop = 0;
    this.view.replayStage(true);
    this.view.replayCaption(`${r.name}'s run. Score ${r.score}.`, 3600);
    await new Promise((res) => setTimeout(res, this.fast ? 10 : 2600));
    const mark = (i: number) => { const li = this.panel.querySelector(`li[data-i="${i}"]`); li?.classList.add('done'); li?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); };
    const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
    const speed = this.fast ? 400 : 1.35;
    for (let i = 0; i < r.actions.length; i++) {
      const a = r.actions[i];
      if (g.t < a.t) await this.animateRaw(a.t - g.t, speed);
      if (g.finished) break;
      if (a.k === 'obs') { if (g.fundObs(a.which)) this.view.pulse(); }
      else if (a.k === 'kin') g.launchKinetic(a.tier);
      else if (a.k === 'tractor') g.launchTractor();
      else if (a.k === 'nuke') g.launchNuke();
      else if (a.k === 'probe') g.launchProbe();
      else if (a.k === 'fund') g.requestFunding();
      else if (a.k === 'shelter') { if (g.planShelter(a.city)) { const c = CITIES.find((x) => x.id === a.city); if (c) this.view.ping(c.lat, c.lon); } }
      else if (a.k === 'evac') { if (g.planEvac(a.city)) { const c = CITIES.find((x) => x.id === a.city); if (c) this.view.ping(c.lat, c.lon); } }
      this.view.replayCaption(`${fmtDate(dateAt(g.sc, a.t))}: ${label(a)}`);
      mark(i);
      this.renderLive();
      await sleep(this.fast ? 10 : 2200);
    }
    if (!g.finished) await this.animateRaw(g.yearsLeft, speed);
  }

  /** animateTo, but usable while the player's controls are locked for a replay */
  private animateRaw(years: number, speed: number): Promise<void> {
    return this.animateTo(years, { speed });
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
          <div class="chat-head"><span class="avatar" aria-hidden="true">DO</span><div><b>Dr. Okafor</b><span>Chief scientist · AI Agent</span></div></div>
          <div class="msgs" role="log" aria-live="polite" aria-label="Conversation with the chief scientist"></div>
          <div class="chips">
            <button type="button" data-ask="What should I do right now?">What now?</button>
            <button type="button" data-ask="Why are there so many lines?">Why so many lines?</button>
            <button type="button" data-ask="Is it too early to launch a mission?">Too early to launch?</button>
            <button type="button" data-ask="How much push do I actually need, and why?">How much push?</button>
          </div>
          <form class="composer"><input name="q" type="text" maxlength="300" autocomplete="off" placeholder="Ask your chief scientist anything" aria-label="Ask the chief scientist" /><button class="btn primary" type="submit">Ask</button></form>
        </div>`;
      this.chatShown = 0;
    }
    const box = pane.querySelector('.msgs')!;
    // add only what is new, so earlier messages are never redrawn
    while (this.chatShown < this.msgs.length) {
      const m = this.msgs[this.chatShown++];
      this.appendMsg(box, m);
    }
    const typing = box.querySelector('.typing');
    if (this.busy && !typing) {
      const t = el('div', 'msg adv typing', '<i></i><i></i><i></i>');
      t.setAttribute('aria-label', 'Dr. Okafor is typing');
      box.appendChild(t);
    } else if (!this.busy && typing) typing.remove();
    this.scrollChat();
  }

  private chatShown = 0;
  private typers = new Set<number>();

  private appendMsg(box: Element, m: Msg) {
    const d = el('div', `msg ${m.role === 'user' ? 'me' : 'adv'} enter`);
    const body = el('span', 'body');
    d.appendChild(body);
    const label = m.role === 'assistant' ? (m.provider === 'groq' || m.provider === 'claude' || m.provider === 'workers-ai' ? 'AI Agent' : m.provider === 'offline' ? 'Offline advisor' : '') : '';
    const addLabel = () => { if (label) { const s = el('small', 'lab', label); d.appendChild(s); requestAnimationFrame(() => s.classList.add('on')); } };
    const typed = m.role === 'assistant' && (m.provider === 'groq' || m.provider === 'claude' || m.provider === 'workers-ai' || m.typed);
    box.appendChild(d);
    if (typed && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      // the reply writes itself, word by word
      const words = m.content.split(/(\s+)/);
      const per = Math.max(14, Math.min(60, 1500 / Math.max(1, words.length)));
      let i = 0;
      const id = window.setInterval(() => {
        i++;
        body.textContent = words.slice(0, i).join('');
        this.scrollChat();
        if (i >= words.length) { clearInterval(id); this.typers.delete(id); addLabel(); }
      }, per);
      this.typers.add(id);
    } else {
      body.textContent = m.content;
      addLabel();
    }
  }

  private scrollChat() {
    const box = this.panes.advisor.querySelector('.msgs');
    if (box) box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
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
