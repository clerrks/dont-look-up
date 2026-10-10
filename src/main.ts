import '@fontsource/instrument-serif/400.css';
import '@fontsource-variable/hanken-grotesk';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './style.css';

import { fetchObject, postAI, type Detail } from './api';
import { FALLBACK_CATALOG } from './data/fallback';
import { DIFFICULTY, Game, buildScenario, templateBriefing, type Difficulty } from './game';
import { evaluate } from './sim/model';
import { GameView } from './view/gameView';
import { renderHome } from './ui/home';
import { Mission } from './ui/mission';
import { showOutcome } from './ui/outcome';
import { toast } from './ui/dom';

const stage = document.getElementById('stage')!;
const labels = document.getElementById('labels')!;
const panel = document.getElementById('panel')!;

let view: GameView;
try {
  view = new GameView(stage, labels);
} catch (err) {
  panel.innerHTML = `<div class="home"><h1>Asteroid Defense</h1><p class="lede">This game draws a 3D globe and needs WebGL, which this browser or device has turned off. Try a current Chrome, Edge, Firefox or Safari with hardware acceleration enabled.</p><p class="muted">${String(err).slice(0, 160)}</p></div>`;
  throw err;
}

(window as unknown as { __view: GameView }).__view = view;

let difficulty: Difficulty = (localStorage.getItem('ad.difficulty') as Difficulty) || 'standard';
if (!(difficulty in DIFFICULTY)) difficulty = 'standard';
let mission: Mission | null = null;
let lastDetail: { d: Detail; opts: { diameterOverride?: number; vInfHint?: number } } | null = null;

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
  setScreen('home');
  homeBackdrop();
  await renderHome({
    panel,
    getDifficulty: () => difficulty,
    setDifficulty: (d) => { difficulty = d; try { localStorage.setItem('ad.difficulty', d); } catch { /* storage may be blocked */ } },
    start: (d, opts) => startMission(d, opts),
    surprise: async (pool) => {
      const d = pool[Math.floor(Math.random() * pool.length)];
      const cap = DIFFICULTY[difficulty].capM;
      const size = Math.round(40 + Math.random() * (cap - 40));
      await startMission(d, { diameterOverride: size, vInfHint: d.approaches?.[0]?.vInf ?? d.approaches?.[0]?.vRel });
    },
  });
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

async function startMission(detail: Detail, opts: { diameterOverride?: number; vInfHint?: number }) {
  lastDetail = { d: detail, opts };
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
  const briefing = ai?.text?.trim() || templateBriefing(sc, game.p);
  mission?.destroy();
  setScreen('mission');
  mission = new Mission(
    game, view, stage, panel, briefing,
    () => {
      showOutcome(game, panel, view, () => void again(), () => void showHome());
    },
    () => void showHome(),
  );
}

async function again() {
  if (!lastDetail) return void showHome();
  const pool = FALLBACK_CATALOG;
  const d = lastDetail.d;
  void pool;
  panel.querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.disabled = true));
  await startMission(d, lastDetail.opts);
}

window.addEventListener('error', (e) => { if (String(e.message).includes('WebGL')) toast('Graphics error: ' + e.message); });
void showHome();
