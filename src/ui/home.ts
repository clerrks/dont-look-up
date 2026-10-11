import { openTrailer } from './trailer';
import { fetchBoard, fetchCatalog, fetchUpcoming, fetchWeek, type Board, type Detail, type UpcomingObject, type WeekObject } from '../api';
import { DAILY_BUDGET_B, dailyScenario, msUntilReset, todayUTC } from '../daily';
import { DIFFICULTY, type Difficulty } from '../game';
import { bindBoard, boardHtml } from './board';
import { esc } from './dom';
import { audio } from '../audio';
import { openFamous, famousFor } from './famous';
import { spinRocks } from './rockSpinner';

type TabKey = 'famous' | 'week' | 'decade';

export interface HomeDeps {
  panel: HTMLElement;
  getDifficulty: () => Difficulty;
  setDifficulty: (d: Difficulty) => void;
  start: (d: Detail, opts: { diameterOverride?: number; vInfHint?: number }) => Promise<void>;
  surprise: (pool: Detail[]) => Promise<void>;
  daily: {
    getName: () => string;
    setName: (n: string) => void;
    play: (day: string, name: string) => Promise<void>;
    analyze: (id: number) => Promise<void>;
  };
}

let catalog: { objects: Detail[]; live: boolean } | null = null;
let week: Awaited<ReturnType<typeof fetchWeek>> | undefined;
let decade: Awaited<ReturnType<typeof fetchUpcoming>> | undefined;
let tab: TabKey = 'famous';
let clock = 0;

const INFO: Record<string, string> = {
  week: 'These are asteroids that are actually going to pass Earth this week, powered by live NASA NeoWs data.',
  decade: 'These are asteroids that are actually going to pass Earth in the next decade, powered by live NASA close-approach data.',
};

function parseDes(name: string): string {
  const n = name.trim();
  const num = /^(\d+)\s/.exec(n);
  if (num) return num[1];
  return n.replace(/[()]/g, '').trim();
}

/** How wide the rock is, in words a player can picture. */
function fmtWide(m?: number, est = false) {
  if (!m) return 'size unknown';
  const v = m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
  return `${v} wide${est ? ' (est.)' : ''}`;
}

function pitchNote(m?: number) {
  if (!m) return '';
  const n = m / 105;
  return n >= 1.4 ? `About ${Math.round(n)} football pitches across` : m >= 40 ? 'About half a football pitch across' : 'About as wide as a swimming pool is long';
}

function weekToDetail(w: WeekObject): Detail {
  const d = w.diameterMinM && w.diameterMaxM ? (w.diameterMinM + w.diameterMaxM) / 2 : undefined;
  return { des: parseDes(w.name), spk: w.id, name: w.name, shortName: w.name, H: w.H, diameterM: d, diameterMeasured: false, elements: null, approaches: w.missKm ? [{ date: w.date, distKm: w.missKm, vRel: w.vKms }] : [], source: 'NeoWs' };
}

function decadeToDetail(u: UpcomingObject): Detail {
  return { des: u.des, name: u.name, shortName: u.name || u.des, H: u.H, diameterM: u.diameterM, diameterMeasured: false, elements: null, approaches: [{ date: u.date, distKm: u.distKm, vRel: u.vRel, vInf: u.vInf }], source: 'JPL CAD' };
}

function untilReset(): string {
  const ms = msUntilReset();
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export async function renderHome(deps: HomeDeps) {
  const { panel } = deps;
  clearInterval(clock);
  const day0 = todayUTC();
  const dsc = dailyScenario(day0);

  panel.innerHTML = `
    <div class="home fade-in">
      <header>
        <h1><img class="logo" src="/asteroid-icon.png" alt="" width="56" height="56" />Don't Look Up</h1>
        <p class="lede">A killer asteroid is coming towards Earth. Find where it lands, and stop it.</p>
        <button type="button" class="btn trailer-btn" id="trailer"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 2.5v11l9-5.5z" fill="currentColor"/></svg>Watch the trailer</button>
        <span class="home-snd"></span>
      </header>

      <section class="daily" aria-labelledby="daily-h">
        <div class="daily-top">
          <canvas class="spin3d big" data-seed="${(dsc.seed >>> 0) % 6}" aria-hidden="true"></canvas>
          <div class="daily-info">
            <span class="eyebrow">Daily Challenge</span>
            <h3 id="daily-h">${esc(dsc.name)}</h3>
            <div class="meta">
              <span class="size" title="${esc(pitchNote(dsc.diameterM))}">${fmtWide(dsc.diameterM)}</span>
              <span>$${DAILY_BUDGET_B.toFixed(1)}B, no more</span>
              <span id="daily-clock">new rock in ${untilReset()}</span>
            </div>
          </div>
        </div>
        <p class="daily-pitch">Play the Daily Challenge for today and compete on the leaderboard.</p>
        <div class="daily-board" id="daily-board" aria-live="polite"><div class="skeleton"></div></div>
        <form class="daily-play" id="daily-form" novalidate>
          <label class="name"><span>Your name</span><input id="daily-name" type="text" maxlength="16" autocomplete="nickname" spellcheck="false" placeholder="2 to 16 letters" value="${esc(deps.daily.getName())}" /></label>
          <button class="btn primary" type="submit" id="daily-go">Play today's rock</button>
        </form>
        <p class="daily-hint" id="daily-hint" hidden>Pick a name first, so you show up on the board.</p>
      </section>

      <section class="group" aria-labelledby="diff-h">
        <h3 id="diff-h">Difficulty</h3>
        <div class="diff" role="group" aria-label="Difficulty"></div>
      </section>
      <section class="group picker" aria-labelledby="pick-h">
        <h3 id="pick-h">Choose an asteroid</h3>
        <div class="picker-tabs" role="tablist" aria-label="Asteroid sources">
          <button role="tab" data-t="famous" aria-selected="true">Famous rocks</button>
          <span class="tabwrap"><button role="tab" data-t="week" aria-selected="false">Passing this week</button><button type="button" class="info" data-info="week" aria-label="About Passing this week" aria-expanded="false">?</button></span>
          <span class="tabwrap"><button role="tab" data-t="decade" aria-selected="false">Next decade</button><button type="button" class="info" data-info="decade" aria-label="About Next decade" aria-expanded="false">?</button></span>
        </div>
        <div class="infotip" id="infotip" role="tooltip" hidden></div>
        <div class="rocks" role="tabpanel" aria-live="polite"></div>
        <div class="src"></div>
      </section>
      <div class="row-actions">
        <button class="btn primary" id="surprise">Surprise me</button>
      </div>
    </div>`;

  panel.querySelector('.home-snd')!.append(audio.button());
  panel.querySelector('#trailer')!.addEventListener('click', openTrailer);

  // ---------------------------------------------------------------- daily challenge
  const boardEl = panel.querySelector<HTMLElement>('#daily-board')!;
  const nameEl = panel.querySelector<HTMLInputElement>('#daily-name')!;
  const hintEl = panel.querySelector<HTMLElement>('#daily-hint')!;
  let day = day0;
  const paintBoard = (b: Board | null) => {
    if (!b) { boardEl.innerHTML = '<p class="muted board-empty">The leaderboard could not be reached. You can still play.</p>'; return; }
    if (b.unavailable) { boardEl.innerHTML = '<p class="muted board-empty">The leaderboard is offline here. You can still play.</p>'; return; }
    boardEl.innerHTML = `<div class="board-head"><span>Today's top 5</span><span>${b.total} ${b.total === 1 ? 'player' : 'players'}</span></div>${boardHtml(b.top, nameEl.value)}`;
  };
  bindBoard(boardEl, (id) => deps.daily.analyze(id));
  void fetchBoard().then((b) => {
    if (b?.today) day = b.today;
    paintBoard(b);
  });
  nameEl.addEventListener('input', () => { hintEl.hidden = true; nameEl.classList.remove('bad'); });
  panel.querySelector('#daily-form')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = nameEl.value.normalize('NFKC').replace(/[^\p{L}\p{N} _.\-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 16);
    if (name.length < 2) {
      hintEl.hidden = false;
      nameEl.classList.remove('bad');
      void nameEl.offsetWidth;
      nameEl.classList.add('bad');
      nameEl.focus();
      return;
    }
    deps.daily.setName(name);
    panel.querySelectorAll<HTMLButtonElement>('button').forEach((x) => (x.disabled = true));
    panel.querySelector<HTMLElement>('#daily-go')!.innerHTML = '<span class="spin"></span>';
    await deps.daily.play(day, name);
  });
  clock = window.setInterval(() => {
    const c = panel.querySelector('#daily-clock');
    if (!c) { clearInterval(clock); return; }
    c.textContent = `new rock in ${untilReset()}`;
  }, 30000);

  // ---------------------------------------------------------------- difficulty
  const diffBox = panel.querySelector('.diff')!;
  const drawDiff = () => {
    diffBox.innerHTML = (Object.keys(DIFFICULTY) as Difficulty[])
      .map((k) => `<button type="button" data-d="${k}" aria-pressed="${deps.getDifficulty() === k}"><b>${DIFFICULTY[k].label}</b><span>${DIFFICULTY[k].blurb}</span></button>`)
      .join('');
  };
  drawDiff();
  diffBox.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-d]');
    if (b) { deps.setDifficulty(b.dataset.d as Difficulty); drawDiff(); }
  });

  // ---------------------------------------------------------------- rock list
  const rocksEl = panel.querySelector<HTMLElement>('.rocks')!;
  const srcEl = panel.querySelector<HTMLElement>('.src')!;
  let rows: { detail: Detail; hint?: number }[] = [];

  const rockHtml = (i: number, title: string, size: string, sizeTip: string, meta: string[], tag = '', info = false) => `
    <div class="rock" style="--i:${i}">
      <canvas class="spin3d" data-seed="${i}" aria-hidden="true"></canvas>
      <div><h3>${esc(title)}${tag}</h3><div class="meta"><span class="size" title="${esc(sizeTip)}">${esc(size)}</span>${meta.map((m) => `<span>${esc(m)}</span>`).join('')}</div></div>
      <div class="rock-acts">${info ? `<button type="button" class="info-btn" data-fam="${i}" aria-label="More about ${esc(title)}" title="Why is it famous?">i</button>` : ''}<button class="btn go" data-go="${i}" aria-label="Defend against ${esc(title)}">Defend</button></div></div>`;

  const draw = async () => {
    rocksEl.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
    rows = [];
    if (tab === 'famous') {
      catalog ??= await fetchCatalog();
      rocksEl.innerHTML = catalog.objects
        .map((d, i) => {
          rows.push({ detail: d });
          const next = d.approaches?.[0];
          const meta = [d.orbitClass ? `${d.orbitClass} orbit` : '', next ? `passes ${Math.round(next.distKm / 1000).toLocaleString('en-US')}k km, ${next.date.slice(0, 11)}` : ''].filter(Boolean);
          return rockHtml(i, d.shortName, fmtWide(d.diameterM, !d.diameterMeasured), pitchNote(d.diameterM), meta, d.pha ? '<span class="tag hot">PHA</span>' : '', !!famousFor(d));
        })
        .join('');
      srcEl.innerHTML = `<span class="dot ${catalog.live ? 'live' : ''}"></span>${catalog.live ? 'Live NASA/JPL data' : 'Cached NASA/JPL data (live feed unavailable)'}`;
    } else if (tab === 'week') {
      if (week === undefined) week = await fetchWeek();
      if (!week?.objects.length) {
        rocksEl.innerHTML = '<p class="muted">NASA\'s asteroid feed could not be reached. Try again in a moment, or pick a famous rock.</p>';
        srcEl.textContent = '';
        return;
      }
      rocksEl.innerHTML = week.objects
        .slice(0, 10)
        .map((w, i) => {
          const d = weekToDetail(w);
          rows.push({ detail: d });
          const meta = [w.date, w.lunar !== undefined ? `${w.lunar < 10 ? w.lunar.toFixed(1) : Math.round(w.lunar)} lunar distances` : '', w.vKms ? `${w.vKms.toFixed(1)} km/s` : ''].filter(Boolean);
          return rockHtml(i, w.name, fmtWide(d.diameterM, true), pitchNote(d.diameterM), meta, w.sentry ? '<span class="tag hot">Sentry</span>' : '');
        })
        .join('');
      srcEl.innerHTML = `<span class="dot live"></span>Live ${week.degraded ? 'NASA/JPL data' : 'NASA NeoWs data'}`;
    } else {
      if (decade === undefined) decade = await fetchUpcoming();
      if (!decade?.objects.length) {
        rocksEl.innerHTML = '<p class="muted">The JPL close-approach table could not be reached right now.</p>';
        srcEl.textContent = '';
        return;
      }
      rocksEl.innerHTML = decade.objects
        .slice(0, 10)
        .map((u, i) => {
          rows.push({ detail: decadeToDetail(u) });
          const meta = [u.date.slice(0, 11), `${Math.round(u.distKm / 1000).toLocaleString('en-US')}k km`, `${u.vRel.toFixed(1)} km/s`];
          return rockHtml(i, u.name || u.des, fmtWide(u.diameterM, true), pitchNote(u.diameterM), meta);
        })
        .join('');
      srcEl.innerHTML = '<span class="dot live"></span>Live JPL close-approach data';
    }
    spinRocks(rocksEl);
  };

  panel.querySelector('.picker-tabs')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-t]');
    if (!b) return;
    tab = b.dataset.t as TabKey;
    panel.querySelectorAll('.picker-tabs button[data-t]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    void draw();
  });

  // little "?" circles: hover or focus on desktop, tap on touch
  const tipEl = panel.querySelector<HTMLElement>('#infotip')!;
  const picker = panel.querySelector<HTMLElement>('.picker')!;
  let tipFor: HTMLElement | null = null;
  const hideTip = () => { tipEl.hidden = true; tipFor?.setAttribute('aria-expanded', 'false'); tipFor?.removeAttribute('aria-describedby'); tipFor = null; };
  const showTip = (b: HTMLElement) => {
    if (tipFor && tipFor !== b) hideTip();
    tipFor = b;
    tipEl.textContent = INFO[b.dataset.info!];
    tipEl.hidden = false;
    b.setAttribute('aria-expanded', 'true');
    b.setAttribute('aria-describedby', 'infotip');
    const pr = picker.getBoundingClientRect(), br = b.getBoundingClientRect();
    const w = Math.min(280, pr.width);
    tipEl.style.width = `${w}px`;
    tipEl.style.left = `${Math.max(0, Math.min(pr.width - w, br.left - pr.left + br.width / 2 - w / 2))}px`;
    tipEl.style.top = `${br.bottom - pr.top + 8}px`;
  };
  picker.querySelectorAll<HTMLElement>('.info').forEach((b) => {
    b.addEventListener('mouseenter', () => showTip(b));
    b.addEventListener('mouseleave', () => { if (document.activeElement !== b) hideTip(); });
    b.addEventListener('focus', () => showTip(b));
    b.addEventListener('blur', hideTip);
    b.addEventListener('click', (e) => { e.stopPropagation(); if (tipFor === b && !tipEl.hidden && document.activeElement !== b) hideTip(); else showTip(b); });
  });
  document.addEventListener('click', (e) => { if (!tipEl.hidden && !(e.target as HTMLElement).closest('.info')) hideTip(); });
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTip(); });

  rocksEl.addEventListener('click', async (e) => {
    const f = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-fam]');
    if (f) {
      const r = rows[Number(f.dataset.fam)];
      const info = famousFor(r.detail);
      if (info) openFamous(r.detail, info, () => rocksEl.querySelector<HTMLButtonElement>(`[data-go="${f.dataset.fam}"]`)?.click());
      return;
    }
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-go]');
    if (!b) return;
    const r = rows[Number(b.dataset.go)];
    panel.querySelectorAll<HTMLButtonElement>('button').forEach((x) => (x.disabled = true));
    b.innerHTML = '<span class="spin"></span>';
    await deps.start(r.detail, { vInfHint: r.detail.approaches?.[0]?.vInf ?? r.detail.approaches?.[0]?.vRel });
  });
  panel.querySelector('#surprise')!.addEventListener('click', async (e) => {
    const b = e.currentTarget as HTMLButtonElement;
    panel.querySelectorAll<HTMLButtonElement>('button').forEach((x) => (x.disabled = true));
    b.innerHTML = '<span class="spin"></span> Building a scenario';
    const pool: Detail[] = [...(catalog?.objects ?? [])];
    if (week?.objects) pool.push(...week.objects.map(weekToDetail));
    if (decade?.objects) pool.push(...decade.objects.map(decadeToDetail));
    if (!pool.length) pool.push(...(await fetchCatalog()).objects);
    await deps.surprise(pool);
  });

  spinRocks(panel);
  void draw();
}
