import '@fontsource/instrument-serif/400.css';
import '@fontsource-variable/hanken-grotesk';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './style.css';

import { fetchObject, fetchRun, postAI, type Detail } from './api';
import { dailyScenario, todayUTC } from './daily';
import { FALLBACK_CATALOG } from './data/fallback';
import { DIFFICULTY, Game, buildScenario, templateBriefing, type ActionLog, type Difficulty } from './game';
import { evaluate, type Scenario } from './sim/model';
import { GameView } from './view/gameView';
import { renderHome } from './ui/home';
import { Mission } from './ui/mission';
import { showOutcome, type DailyCtx } from './ui/outcome';
import { toast } from './ui/dom';
import { audio } from './audio';
import { runLoader } from './ui/loader';

const stage = document.getElementById('stage')!;
const labels = document.getElementById('labels')!;
const panel = document.getElementById('panel')!;

let view: GameView;
try {
  view = new GameView(stage, labels);
} catch (err) {
  panel.innerHTML = `<div class="home"><h1>Don't Look Up</h1><p class="lede">This game draws a 3D globe and needs WebGL, which this browser or device has turned off. Try a current Chrome, Edge, Firefox or Safari with hardware acceleration enabled.</p><p class="muted">${String(err).slice(0, 160)}</p></div>`;
  throw err;
}

(window as unknown as { __view: GameView }).__view = view;

type RockOpts = { diameterOverride?: number; vInfHint?: number };
type Launch = { kind: 'rock'; d: Detail; opts: RockOpts } | { kind: 'daily'; day: string };

let difficulty: Difficulty = (localStorage.getItem('ad.difficulty') as Difficulty) || 'standard';
if (!(difficulty in DIFFICULTY)) difficulty = 'standard';
let mission: Mission | null = null;
let lastLaunch: Launch | null = null;

function store(key: string, value?: string): string {
  try {
    if (value !== undefined) localStorage.setItem(key, value);
    return localStorage.getItem(key) ?? '';
  } catch {
    return value ?? '';
  }
}
let playerName = store('ad.name');

function setScreen(s: 'home' | 'mission') {
  document.body.dataset.screen = s;
  requestAnimationFrame(() => view.resize());
}

function homeBackdrop() {
  // A real scenario drawn quietly behind the menu: the corridor part-way through its narrowing.
  const sc = buildScenario(FALLBACK_CATALOG[0], 'standard', { seed: 20290413, forceHit: true });
  view.clearFx();
  view.showCorridor(true);
  view.setScenario(sc);
  view.setMode('earth');
  const c = evaluate(sc, [], sc.leadYears * 0.52);
  view.setCorridor(c);
  view.setLabels([]);
  view.setTime(sc.leadYears * 0.52, sc);
  if (c.centroid) view.focus(c.centroid.lat, c.centroid.lon, 3.7);
}

async function showHome() {
  mission?.destroy();
  mission = null;
  audio.stopVoice();
  audio.duck(1);
  audio.scene('home');
  setScreen('home');
  homeBackdrop();
  await renderHome({
    panel,
    getDifficulty: () => difficulty,
    setDifficulty: (d) => { difficulty = d; store('ad.difficulty', d); },
    start: (d, opts) => startMission(d, opts),
    surprise: async (pool) => {
      const d = pool[Math.floor(Math.random() * pool.length)];
      const cap = DIFFICULTY[difficulty].capM;
      const size = Math.round(40 + Math.random() * (cap - 40));
      await startMission(d, { diameterOverride: size, vInfHint: d.approaches?.[0]?.vInf ?? d.approaches?.[0]?.vRel });
    },
    daily: {
      getName: () => playerName,
      setName: (n) => { playerName = n; store('ad.name', n); },
      play: (day, name) => startDaily(day, name),
      analyze: (id) => analyze(id),
    },
  });
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

interface BeginOpts {
  briefing: string;
  daily?: DailyCtx;
  replay?: { name: string; score: number; actions: ActionLog[] };
}

/** Put a scenario on screen with a fresh game. The first-time tour spends money and a year, so when it ends the round starts over. */
function begin(sc: Scenario, b: BeginOpts, game = new Game(sc, view.isLand)) {
  mission?.destroy();
  setScreen('mission');
  mission = new Mission(
    game, view, stage, panel, b.briefing,
    () => showOutcome(game, panel, view, () => void again(), () => void showHome(), b.daily),
    () => void showHome(),
    {
      replay: b.replay,
      onResetAfterTour: () => { toast('Fresh start: your money and time are back.'); begin(sc, b); },
    },
  );
  (window as unknown as { __mission: Mission }).__mission = mission;
}

async function startMission(detail: Detail, opts: RockOpts) {
  lastLaunch = { kind: 'rock', d: detail, opts };
  let d = detail;
  if (!d.elements) {
    const full = await fetchObject(d.des, d.spk);
    if (full?.elements) {
      d = { ...d, elements: full.elements, orbitClass: full.orbitClass ?? d.orbitClass, H: d.H ?? full.H, diameterM: d.diameterM ?? full.diameterM, diameterMeasured: full.diameterMeasured && d.diameterM === undefined };
      if (full.diameterMeasured && full.diameterM) d = { ...d, diameterM: full.diameterM, diameterMeasured: true };
      if (full.approaches?.length && !d.approaches.length) d = { ...d, approaches: full.approaches };
    }
  }
  const sc = buildScenario(d, difficulty, { ...opts });
  const game = new Game(sc, view.isLand);
  const facts = {
    asteroid: sc.name, widthMetres: sc.diameterM, sizeNote: sc.diameterNote, impactSpeedKms: Number(sc.vImpact.toFixed(1)),
    yearsUntilImpact: sc.leadYears, firstImpactChance: `1 in ${Math.round(1 / game.p)}`, budgetBillionUSD: sc.budgetB,
    energyMegatons: Math.round(0.5 * sc.massKg * (sc.vImpact * 1000) ** 2 / 4.184e15), realFacts: sc.facts,
  };
  const ai = await withTimeout(postAI('/api/briefing', { state: facts }), 6000);
  begin(sc, { briefing: ai?.text?.trim() || templateBriefing(sc, game.p) }, game);
}

/** Everybody gets the same rock and the same money for the day, and the score goes on the board. */
async function startDaily(day: string, name: string) {
  playerName = name;
  lastLaunch = { kind: 'daily', day };
  const sc = dailyScenario(day);
  const game = new Game(sc, view.isLand);
  begin(sc, { briefing: `Daily Challenge. ${templateBriefing(sc, game.p)}`, daily: { day, name, analyze } }, game);
}

/** Watch how someone else played the daily rock, sped up. */
async function analyze(id: number) {
  const run = await fetchRun(id);
  if (!run) { toast('Could not load that run. Try again in a moment.'); return; }
  lastLaunch = { kind: 'daily', day: run.day };
  begin(dailyScenario(run.day), { briefing: `Replay of ${run.name}'s run.`, replay: { name: run.name, score: run.score, actions: run.actions } });
}

async function again() {
  const l = lastLaunch;
  if (!l) { await showHome(); return; }
  panel.querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.disabled = true));
  if (l.kind === 'daily') { if (playerName) await startDaily(todayUTC(), playerName); else await showHome(); }
  else await startMission(l.d, l.opts);
}

audio.init(stage);
(window as unknown as { __audio: typeof audio }).__audio = audio;
window.addEventListener('error', (e) => { if (String(e.message).includes('WebGL')) toast('Graphics error: ' + e.message); });
void runLoader().then(() => showHome()).then(() => audio.notice());
