// All the sound in the game: the narrator, sound effects and ambience, behind one mute switch.
// Files live in public/audio. Loudness is levelled here, so a file that arrives too loud or too quiet still sits right.
import { VOICE } from './data/voice';

interface SfxDef { file: string; db: number; maxSec?: number; fade?: number }

/** Target loudness (RMS, dB below full scale) for each effect, and how much of long files to use. */
const SFX: Record<string, SfxDef> = {
  click: { file: 'soft_ui_click.ogg', db: -31 },
  purchase: { file: 'purchase_confirmed.mp3', db: -25 },
  kaching: { file: 'kaching_cahs_register.mp3', db: -24 },
  denied: { file: 'denied.mp3', db: -27 },
  radar: { file: 'radar_scan.mp3', db: -27, maxSec: 3.6, fade: 0.8 },
  launch: { file: 'rocket_launch.mp3', db: -24, maxSec: 3.2, fade: 1.3 },
  flyby: { file: 'rocket_flyby.mp3', db: -23 },
  impact: { file: 'meteor_impact.mp3', db: -17 },
  whoosh: { file: 'meteor_whoosh.mp3', db: -27, maxSec: 4.5, fade: 1.8 },
  boom: { file: 'space_explosion.mp3', db: -21, maxSec: 3.5, fade: 1 },
  shock: { file: 'shockwave.mp3', db: -22, maxSec: 8, fade: 3 },
  beep: { file: 'countdown_beep.mp3', db: -30 },
  news: { file: 'news_alert.mp3', db: -27 },
  siren: { file: 'nuclear_warning_siren.mp3', db: -28, maxSec: 3.5, fade: 1.2 },
  nukeboom: { file: 'nuclear_explosion_distant.mp3', db: -22, maxSec: 12, fade: 5 },
  win: { file: 'win_success.mp3', db: -24 },
  ending: { file: 'ending.mp3', db: -20 },
};
const VOICE_DB = -20;

/** Ambience streams from the file (they are minutes long). Gains were set from measured loudness, well under the narrator. */
const AMB = {
  main: { file: 'main_ambience.mp3', gain: 0.05 },
  calm: { file: 'calm_start.mp3', gain: 0.15 },
  suspense: { file: 'suspense_ambient.mp3', gain: 0.11 },
  hum: { file: 'computer_hum.mp3', gain: 0.115 },
  ruined: { file: 'ruined_environment.mp3', gain: 0.42 },
} as const;
type AmbName = keyof typeof AMB;
type Scene = 'off' | 'home' | 'mission' | 'hit' | 'good';

interface SpeakOpts {
  /** cut off whatever is being said */
  interrupt?: boolean;
  /** wait for the current line to finish */
  queue?: boolean;
  /** each line plays once per round unless this is false */
  once?: boolean;
  /** show the line as a caption while it plays (default true) */
  caption?: boolean;
  delay?: number;
}

let ctx: AudioContext | null = null;
let master: GainNode;
let busVoice: GainNode;
let busSfx: GainNode;
let busAmb: GainNode;
let on = false;
let scene: Scene = 'off';
let tension = 0;
let duckScene = 1;
let duckVoice = 1;
let ambNow = 1;
let ticker = 0;
let subEl: HTMLElement | null = null;
let subTimer = 0;
const listeners = new Set<() => void>();
const buffers = new Map<string, Promise<AudioBuffer | null>>();
const rmsCache = new Map<string, number>();
const used = new Set<string>();
const queue: { id: string; o: SpeakOpts }[] = [];
let token = 0;
let cur: { src: AudioBufferSourceNode; token: number; id: string } | null = null;
/** while the tutorial runs, only the tutorial's own lines may speak */
let tutorialOnly = false;
/** watching someone else's run: no narrator, only the sounds of what happens on screen */
let replayMode = false;
const REPLAY_SFX = new Set(['launch', 'flyby', 'boom', 'impact', 'shock', 'whoosh', 'nukeboom', 'radar', 'ending', 'siren']);
const allowed = (id: string) => !tutorialOnly || id.startsWith('tour_');
let loading = false;
const amb: Partial<Record<AmbName, { el: HTMLAudioElement; node: GainNode; w: number }>> = {};

const ICON_ON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5v5h3.6L12 18.5v-13L7.6 9.5z"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.6a7.6 7.6 0 0 1 0 10.8"/></svg>';
const ICON_OFF = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5v5h3.6L12 18.5v-13L7.6 9.5z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/></svg>';

function pref(): string {
  try { return localStorage.getItem('ad.sound') ?? ''; } catch { return ''; }
}
function savePref(v: 'on' | 'off') {
  try { localStorage.setItem('ad.sound', v); } catch { /* storage may be blocked */ }
}
const emit = () => listeners.forEach((f) => f());

/** Fetch and decode every narrator line and effect, and buffer the music, so nothing is late or missing during play. */
async function preload(tick: (done: number, total: number) => void): Promise<void> {
  if (!ctx) build();
  const files = [...new Set([...Object.values(SFX).map((d) => d.file), ...Object.keys(VOICE).map((id) => `${id}.mp3`)])];
  const names = Object.keys(AMB) as AmbName[];
  const total = files.length + names.length;
  let done = 0;
  const bump = () => tick(++done, total);
  const withTimeout = (p: Promise<unknown>, ms: number) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);
  const jobs: Promise<unknown>[] = files.map((f) => withTimeout(load(f), 30000).then(bump, bump));
  for (const n of names) {
    const el = new Audio();
    el.preload = 'auto';
    el.src = `/audio/${AMB[n].file}`;
    ambPre[n] = el;
    const ready = new Promise<void>((res) => {
      el.addEventListener('canplaythrough', () => res(), { once: true });
      el.addEventListener('error', () => res(), { once: true });
    });
    el.load();
    jobs.push(withTimeout(ready, 30000).then(bump, bump));
  }
  await Promise.all(jobs);
}

function build() {
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = 0;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14; comp.ratio.value = 5; comp.attack.value = 0.004; comp.release.value = 0.25;
  master.connect(comp).connect(ctx.destination);
  busVoice = ctx.createGain(); busSfx = ctx.createGain(); busAmb = ctx.createGain();
  busVoice.connect(master); busSfx.connect(master); busAmb.connect(master);
  ticker = window.setInterval(tick, 80);
  document.addEventListener('visibilitychange', () => {
    if (!ctx) return;
    if (document.hidden) void ctx.suspend(); else if (on) void ctx.resume();
  });
}

function weights(): Partial<Record<AmbName, number>> {
  if (scene === 'home') return { calm: 1 };
  if (scene === 'mission') return { main: 1 - 0.55 * tension, hum: 1, suspense: Math.pow(Math.max(0, tension - 0.1) / 0.9, 1.3) };
  if (scene === 'hit') return { ruined: 1 };
  if (scene === 'good') return { calm: 0.8 };
  return {};
}

const ambPre: Partial<Record<AmbName, HTMLAudioElement>> = {};

function track(name: AmbName) {
  let t = amb[name];
  if (!t && ctx) {
    const el = ambPre[name] ?? new Audio(`/audio/${AMB[name].file}`);
    el.loop = true;
    el.preload = 'auto';
    const node = ctx.createGain();
    node.gain.value = 0;
    ctx.createMediaElementSource(el).connect(node).connect(busAmb);
    t = { el, node, w: 0 };
    amb[name] = t;
  }
  return t;
}

/** Every 80 ms: glide each ambience track toward where the scene wants it. */
function tick() {
  if (!ctx) return;
  const want = weights();
  ambNow += ((on ? duckScene * duckVoice : 0) - ambNow) * 0.12;
  busAmb.gain.value = ambNow;
  for (const name of Object.keys(AMB) as AmbName[]) {
    const target = on ? want[name] ?? 0 : 0;
    let t = amb[name];
    if (!t) { if (target <= 0.01) continue; t = track(name); if (!t) continue; }
    t.w += (target - t.w) * 0.05;
    t.node.gain.value = AMB[name].gain * t.w;
    if (target > 0.01 && t.el.paused) void t.el.play().catch(() => undefined);
    else if (target === 0 && t.w < 0.004 && !t.el.paused) t.el.pause();
  }
}

function load(file: string): Promise<AudioBuffer | null> {
  let p = buffers.get(file);
  if (!p) {
    p = fetch(`/audio/${file}`)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then((b) => ctx!.decodeAudioData(b))
      .catch(() => null);
    buffers.set(file, p);
  }
  return p;
}

/** Average loudness of the part of a recording that will be played, in dB below full scale. */
function rmsDb(file: string, buf: AudioBuffer, seconds: number): number {
  const key = `${file}:${seconds}`;
  const hit = rmsCache.get(key);
  if (hit !== undefined) return hit;
  const n = Math.min(buf.length, Math.floor(seconds * buf.sampleRate));
  let sum = 0, cnt = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i += 5) { sum += d[i] * d[i]; cnt++; }
  }
  const db = 20 * Math.log10(Math.sqrt(sum / Math.max(1, cnt)) + 1e-9);
  rmsCache.set(key, db);
  return db;
}

const levelFor = (db: number, target: number) => Math.max(0.02, Math.min(8, Math.pow(10, (target - db) / 20)));

// ---------------------------------------------------------------- captions

function caption(text: string, seconds: number) {
  if (!subEl) return;
  subEl.textContent = text;
  subEl.classList.add('on');
  clearTimeout(subTimer);
  subTimer = window.setTimeout(hideCaption, (seconds + 0.5) * 1000);
}
function hideCaption() {
  subEl?.classList.remove('on');
}

// ---------------------------------------------------------------- the narrator

function stopVoice() {
  token++;
  loading = false;
  queue.length = 0;
  if (cur) { try { cur.src.stop(); } catch { /* already finished */ } cur = null; }
  duckVoice = 1;
  clearTimeout(subTimer);
  hideCaption();
}

function begin(id: string, o: SpeakOpts) {
  const my = ++token;
  loading = true;
  const go = () => {
    void load(`${id}.mp3`).then((buf) => {
      if (my !== token || !ctx || !on) return;
      loading = false;
      if (!allowed(id)) { next(); return; }
      if (!buf) { next(); return; }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const g = ctx.createGain();
      g.gain.value = levelFor(rmsDb(id, buf, buf.duration), VOICE_DB);
      src.connect(g).connect(busVoice);
      cur = { src, token: my, id };
      duckVoice = 0.5;
      if (o.caption !== false) caption(VOICE[id], buf.duration);
      src.onended = () => {
        if (cur && cur.token === my) { cur = null; duckVoice = 1; next(); }
      };
      src.start();
    });
  };
  if (o.delay) window.setTimeout(go, o.delay * 1000); else go();
}

function next() {
  const n = queue.shift();
  if (n) begin(n.id, n.o);
}

function speak(id: string, o: SpeakOpts = {}): boolean {
  if (!on || !ctx || !VOICE[id] || !allowed(id) || replayMode) return false;
  if ((o.once ?? true) && used.has(id)) return false;
  if (cur || loading) {
    if (o.interrupt) stopVoice();
    else if (o.queue) {
      if (queue.length >= 3) return false;
      used.add(id);
      queue.push({ id, o });
      return true;
    } else return false;
  }
  used.add(id);
  begin(id, o);
  return true;
}

// ---------------------------------------------------------------- sound effects

function sfx(id: string, o: { vol?: number; delay?: number; maxSec?: number; fade?: number } = {}) {
  if (!on || !ctx || (replayMode && !REPLAY_SFX.has(id))) return;
  const d = SFX[id];
  if (!d) return;
  void load(d.file).then((buf) => {
    if (!buf || !ctx || !on) return;
    const max = o.maxSec ?? d.maxSec;
    const dur = max ? Math.min(buf.duration, max) : buf.duration;
    const fade = Math.min(dur * 0.8, o.fade ?? d.fade ?? 0.2);
    const when = ctx.currentTime + (o.delay ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    const level = levelFor(rmsDb(d.file, buf, dur), d.db) * (o.vol ?? 1);
    g.gain.setValueAtTime(level, when);
    if (max && dur < buf.duration + 0.01) {
      g.gain.setValueAtTime(level, Math.max(when, when + dur - fade));
      g.gain.linearRampToValueAtTime(0, when + dur);
    }
    src.connect(g).connect(busSfx);
    src.start(when, 0, dur);
  });
}

// ---------------------------------------------------------------- public face

async function enable() {
  if (!ctx) build();
  try { await ctx!.resume(); } catch { /* needs a click first */ }
  on = true;
  savePref('on');
  master.gain.setTargetAtTime(0.9, ctx!.currentTime, 0.05);
  emit();
  // get the most-used sounds ready so the first click or launch is not late
  window.setTimeout(() => {
    for (const id of ['click', 'purchase', 'launch', 'radar', 'news', 'denied', 'flyby']) void load(SFX[id].file);
    for (const id of ['brief_open', 'brief_red', 'brief_hard', 'daily_open']) void load(`${id}.mp3`);
  }, 1500);
}

function disable() {
  on = false;
  savePref('off');
  stopVoice();
  if (ctx) master.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
  emit();
}

function notice(after?: () => void) {
  if (pref() === 'off') { after?.(); return; }
  const d = document.createElement('dialog');
  d.className = 'sound-notice';
  d.innerHTML = `<div class="in">
    <div class="sn-icon">${ICON_ON}</div>
    <h2>Turn your volume up</h2>
    <p>This game has a narrator. Turn your sound on to hear Dr. Okafor, the effects and the music. Captions show what she says.</p>
    <div class="row-actions"><button type="button" class="btn primary" data-on>Start with sound</button><button type="button" class="btn" data-off>Play without sound</button></div>
  </div>`;
  d.addEventListener('cancel', (e) => e.preventDefault());
  d.addEventListener('click', async (e) => {
    const t = e.target as HTMLElement;
    if (t.hasAttribute('data-on')) {
      d.close();
      await enable();
      audio.scene(scene === 'off' ? 'home' : scene);
      if (scene === 'home') speak('home_tag', { once: false });
      after?.();
    } else if (t.hasAttribute('data-off')) {
      d.close();
      disable();
      after?.();
    }
  });
  d.addEventListener('close', () => d.remove());
  document.body.appendChild(d);
  d.showModal();
}

export const audio = {
  get enabled() { return on; },
  /** wire up the caption bar and the click sound once, at start-up */
  init(stage: HTMLElement) {
    subEl = document.createElement('div');
    subEl.className = 'vo-sub';
    subEl.setAttribute('role', 'status');
    stage.appendChild(subEl);
    document.addEventListener('pointerdown', (e) => {
      if (!on) return;
      const b = (e.target as Element | null)?.closest?.('button, [role=tab], summary, .tile');
      if (b && !(b as HTMLButtonElement).disabled && !b.hasAttribute('data-quiet')) sfx('click');
    }, true);
  },
  notice,
  preload,
  enable,
  disable,
  toggle() { if (on) disable(); else { void enable().then(() => audio.scene(scene)); } },
  onChange(fn: () => void) { listeners.add(fn); return () => listeners.delete(fn); },
  /** which music bed fits the screen */
  scene(s: Scene) { scene = s; if (s !== 'mission') tension = 0; },
  /** 0 = calm, 1 = about to hit: fades the tense music in */
  setTension(t: number) { tension += (Math.max(0, Math.min(1, t)) - tension) * 0.5; },
  /** lower the music under a cutscene */
  duck(downTo: number) { duckScene = downTo; },
  speak,
  /** the tutorial is speaking: silence every other line until it is over */
  tutorial(on: boolean) {
    tutorialOnly = on;
    if (!on) return;
    for (let i = queue.length - 1; i >= 0; i--) if (!allowed(queue[i].id)) queue.splice(i, 1);
    if (cur && !allowed(cur.id)) stopVoice();
  },
  sfx,
  replay(onOff: boolean) { replayMode = onOff; if (onOff) stopVoice(); },
  stopVoice,
  /** start of a round: every line may play again */
  newRound() { used.clear(); stopVoice(); tension = 0; duckScene = 1; },
  /** the words of a line */
  line(id: string) { return VOICE[id] ?? ''; },
  /** plays the line and returns its words to show, or `fallback` if it is not being spoken */
  say(id: string, fallback: string, o: SpeakOpts = {}): string {
    return speak(id, { caption: false, ...o }) ? VOICE[id] : fallback;
  },
  /** for checking the mix while testing */
  debug() {
    return {
      on, scene, tension: +tension.toFixed(2), ctx: ctx?.state, duck: +ambNow.toFixed(2),
      amb: Object.fromEntries(Object.entries(amb).map(([k, v]) => [k, { w: +v!.w.toFixed(3), paused: v!.el.paused, t: +v!.el.currentTime.toFixed(1), err: v!.el.error?.code ?? 0 }])),
    };
  },
  /** a speaker button that follows the mute state */
  button(): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'iconbtn snd';
    b.setAttribute('data-quiet', '');
    const paint = () => {
      b.innerHTML = on ? ICON_ON : ICON_OFF;
      b.setAttribute('aria-pressed', String(on));
      b.setAttribute('aria-label', on ? 'Sound on. Press to mute' : 'Sound off. Press to turn on');
      b.title = on ? 'Mute sound' : 'Turn sound on';
    };
    paint();
    listeners.add(paint);
    b.addEventListener('click', () => audio.toggle());
    return b;
  },
};

void ticker;
