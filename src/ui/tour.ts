// A short guided tour: dims everything except one control, says what it does, and for the key
// controls waits for the player to actually press them. Everything glides: the spotlight, the
// dimmed edges and the card are eased every frame, so nothing flashes or snaps between steps.
import { audio } from '../audio';

export interface TourStep {
  /** narrator line spoken when the step starts */
  voice?: string;
  /** a second line spoken right after the first */
  voice2?: string;
  target?: string;
  title: string;
  /** may contain simple markup (lists, colour swatches) */
  text: string;
  /** label of the Next button; null = no button, wait for the player to press the control */
  next?: string | null;
  /** the action that moves the tour on (reported through Tour.notify) */
  wait?: 'rockcam' | 'focus' | 'buy' | 'step';
  placement?: 'above' | 'below';
  spot?: 'stage';
  /** run when the step starts (for example to switch tab) */
  onEnter?: () => void;
}

interface Box { x: number; y: number; w: number; h: number }

export class Tour {
  private root!: HTMLElement;
  private blockers: HTMLElement[] = [];
  private ring!: HTMLElement;
  private card!: HTMLElement;
  private body!: HTMLElement;
  private i = -1;
  private raf = 0;
  private active = false;
  private pendingAdvance = 0;
  private swapTimer = 0;
  private hole: Box = { x: 0, y: 0, w: 0, h: 0 };
  private cardPos = { x: 0, y: 0 };
  private snap = true;
  private lastFrame = 0;
  private key = (e: KeyboardEvent) => {
    if (!this.active) return;
    if (e.key === 'Escape') { e.preventDefault(); this.finish(); }
    if ((e.key === 'Enter' || e.key === 'ArrowRight') && this.card.querySelector('[data-tour-next]')) { e.preventDefault(); this.next(); }
  };

  constructor(private steps: TourStep[], private onDone: () => void) {}

  start() {
    this.active = true;
    this.root = document.createElement('div');
    this.root.className = 'tour';
    this.root.innerHTML = '<div class="tour-dim"></div><div class="tour-dim"></div><div class="tour-dim"></div><div class="tour-dim"></div><div class="tour-ring"></div><div class="tour-card" role="dialog" aria-live="polite" aria-label="Tutorial"><div class="tour-body"></div></div>';
    document.body.appendChild(this.root);
    this.blockers = [...this.root.querySelectorAll<HTMLElement>('.tour-dim')];
    this.ring = this.root.querySelector('.tour-ring')!;
    this.card = this.root.querySelector('.tour-card')!;
    this.body = this.root.querySelector('.tour-body')!;
    document.addEventListener('keydown', this.key, true);
    audio.tutorial(true);
    this.go(0, true);
    this.lastFrame = performance.now();
    const loop = (now: number) => {
      if (!this.active) return;
      this.layout(Math.min(0.05, (now - this.lastFrame) / 1000));
      this.lastFrame = now;
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    audio.tutorial(false);
    cancelAnimationFrame(this.raf);
    clearTimeout(this.pendingAdvance);
    clearTimeout(this.swapTimer);
    document.removeEventListener('keydown', this.key, true);
    this.root.classList.add('out');
    const r = this.root;
    setTimeout(() => r.remove(), 320);
  }

  /** Hide the overlay while the game is animating so nothing is covered. */
  setLite(on: boolean) {
    if (this.active) this.root.classList.toggle('lite', on);
  }

  /** The game tells the tour what the player just did. */
  notify(kind: 'rockcam' | 'focus' | 'buy' | 'step') {
    const s = this.steps[this.i];
    if (!this.active || !s || s.wait !== kind) return;
    clearTimeout(this.pendingAdvance);
    // a short reaction as the player does what the step asked
    if (kind === 'buy') audio.speak('tour_bought', { interrupt: true, once: false, caption: false });
    if (kind === 'step') audio.speak('tour_stepped', { interrupt: true, once: false, caption: false });
    if (kind === 'buy') {
      // the dark shade lifts for a few seconds so the telescope's effect on the chart and the globe can be seen
      this.root.classList.add('lite');
      this.pendingAdvance = window.setTimeout(() => { this.root.classList.remove('lite'); this.next(); }, 3600);
      return;
    }
    this.pendingAdvance = window.setTimeout(() => this.next(), kind === 'step' ? 700 : 650);
  }

  private finish() {
    this.stop();
    this.onDone();
  }

  private next() {
    clearTimeout(this.pendingAdvance);
    if (this.i >= this.steps.length - 1) { this.finish(); return; }
    this.go(this.i + 1);
  }

  private findTarget(s: TourStep): HTMLElement | null {
    if (!s.target) return null;
    const e = document.querySelector<HTMLElement>(s.target);
    if (!e) return null;
    const r = e.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    return e;
  }

  private go(i: number, first = false) {
    // skip steps whose control is not on screen (for example disabled purchases)
    while (i < this.steps.length) {
      const s = this.steps[i];
      s.onEnter?.();
      if (!s.target) break;
      const t = this.findTarget(s);
      if (t && !(t as HTMLButtonElement).disabled) break;
      i++;
    }
    if (i >= this.steps.length) { this.finish(); return; }
    this.i = i;
    const s = this.steps[i];
    const t = this.findTarget(s);
    if (t) this.bringIntoView(t);
    if (s.voice) audio.speak(s.voice, { interrupt: true, once: false, caption: false });
    if (s.voice2) audio.speak(s.voice2, { queue: true, once: false, caption: false });
    const last = i === this.steps.length - 1;
    const label = s.next === undefined ? (last ? 'Done' : 'Next') : s.next;
    const dots = this.steps.map((_, k) => `<i${k === i ? ' class="on"' : ''}></i>`).join('');
    const html = `
      <div class="tour-dots" aria-hidden="true">${dots}</div>
      <h3>${s.title}</h3>
      <p>${s.text}</p>
      <div class="tour-row">
        <button type="button" class="btn small quiet" data-tour-skip>${last ? '' : 'Skip tour'}</button>
        ${label === null ? '<span class="tour-wait">Press the highlighted button</span>' : `<button type="button" class="btn small primary" data-tour-next>${label}</button>`}
      </div>`;
    const apply = () => {
      this.body.innerHTML = html;
      this.body.querySelector('[data-tour-skip]')?.addEventListener('click', () => this.finish());
      this.body.querySelector('[data-tour-next]')?.addEventListener('click', () => this.next());
      (this.body.querySelector('[data-tour-next]') as HTMLElement | null)?.focus({ preventScroll: true });
      this.body.classList.remove('swap');
    };
    clearTimeout(this.swapTimer);
    if (first) { apply(); this.card.classList.add('in'); }
    else {
      // the old text fades, the card glides to its new place, the new text fades in
      this.body.classList.add('swap');
      this.swapTimer = window.setTimeout(apply, 170);
    }
    this.root.classList.toggle('free', label === null);
  }

  /** Scroll the right container: the side panel on desktop, the page on phones. Never the whole app. */
  private bringIntoView(t: HTMLElement) {
    const r = t.getBoundingClientRect();
    if (r.top > 70 && r.bottom < window.innerHeight - 20) return;
    const panel = t.closest<HTMLElement>('#panel');
    if (!panel) return;
    if (window.matchMedia('(max-width: 880px)').matches) {
      window.scrollTo({ top: window.scrollY + r.top - window.innerHeight * 0.55, behavior: 'smooth' });
    } else {
      const pr = panel.getBoundingClientRect();
      panel.scrollTo({ top: panel.scrollTop + (r.top - pr.top) - pr.height * 0.35, behavior: 'smooth' });
    }
  }

  private layout(dt: number) {
    const s = this.steps[this.i];
    if (!s) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    const t = this.findTarget(s);
    let want: Box = { x: vw / 2, y: vh / 2, w: 0, h: 0 };
    if (t) {
      const r = t.getBoundingClientRect();
      const pad = s.spot === 'stage' ? 0 : 8;
      want = { x: Math.max(0, r.left - pad), y: Math.max(0, r.top - pad), w: Math.min(vw, r.width + pad * 2), h: Math.min(vh, r.height + pad * 2) };
    }
    // exponential easing toward the wanted box: smooth between steps, and exact while the target is still scrolling
    const k = this.snap ? 1 : 1 - Math.exp(-dt * 11);
    const c = this.hole;
    c.x += (want.x - c.x) * k; c.y += (want.y - c.y) * k; c.w += (want.w - c.w) * k; c.h += (want.h - c.h) * k;
    const [top, bottom, left, right] = this.blockers;
    const set = (e: HTMLElement, x: number, y: number, w: number, h: number) => { e.style.transform = `translate(${x}px, ${y}px)`; e.style.width = `${Math.max(0, w)}px`; e.style.height = `${Math.max(0, h)}px`; };
    set(top, 0, 0, vw, c.y);
    set(bottom, 0, c.y + c.h, vw, vh - c.y - c.h);
    set(left, 0, c.y, c.x, c.h);
    set(right, c.x + c.w, c.y, vw - c.x - c.w, c.h);
    this.ring.style.opacity = t && s.spot !== 'stage' ? '1' : '0';
    this.ring.style.transform = `translate(${c.x}px, ${c.y}px)`;
    this.ring.style.width = `${c.w}px`;
    this.ring.style.height = `${c.h}px`;

    const cw = Math.min(350, vw - 24);
    this.card.style.width = `${cw}px`;
    const ch = this.card.offsetHeight || 190;
    let cx = want.x + want.w / 2 - cw / 2;
    let cy: number;
    if (!t) { cx = vw / 2 - cw / 2; cy = vh / 2 - ch / 2; }
    else if (s.spot === 'stage') { cy = want.y + want.h - ch - 96; cx = want.x + want.w / 2 - cw / 2; }
    else {
      const below = want.y + want.h + 14, above = want.y - ch - 14;
      const prefer = s.placement ?? 'below';
      if (prefer === 'above') cy = above >= 8 ? above : below;
      else cy = below + ch <= vh - 8 ? below : above >= 8 ? above : Math.max(8, vh - ch - 12);
    }
    cx = Math.max(12, Math.min(vw - cw - 12, cx));
    cy = Math.max(8, Math.min(vh - ch - 8, cy));
    const ck = this.snap ? 1 : 1 - Math.exp(-dt * 9);
    this.cardPos.x += (cx - this.cardPos.x) * ck; this.cardPos.y += (cy - this.cardPos.y) * ck;
    this.card.style.transform = `translate(${this.cardPos.x}px, ${this.cardPos.y}px)`;
    this.snap = false;
  }
}
