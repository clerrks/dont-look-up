import { fetchCatalog, fetchUpcoming, fetchWeek, health, type Detail, type UpcomingObject, type WeekObject } from '../api';
import { DIFFICULTY, type Difficulty } from '../game';
import { HOW_IT_WORKS, esc, openDialog } from './dom';

type TabKey = 'famous' | 'week' | 'decade';

export interface HomeDeps {
  panel: HTMLElement;
  getDifficulty: () => Difficulty;
  setDifficulty: (d: Difficulty) => void;
  start: (d: Detail, opts: { diameterOverride?: number; vInfHint?: number }) => Promise<void>;
  surprise: (pool: Detail[]) => Promise<void>;
}

let catalog: { objects: Detail[]; live: boolean } | null = null;
let week: Awaited<ReturnType<typeof fetchWeek>> | undefined;
let decade: Awaited<ReturnType<typeof fetchUpcoming>> | undefined;
let tab: TabKey = 'famous';

function parseDes(name: string): string {
  const n = name.trim();
  const num = /^(\d+)\s/.exec(n);
  if (num) return num[1];
  return n.replace(/[()]/g, '').trim();
}

function fmtSize(m?: number) {
  if (!m) return 'size unknown';
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

function weekToDetail(w: WeekObject): Detail {
  const d = w.diameterMinM && w.diameterMaxM ? (w.diameterMinM + w.diameterMaxM) / 2 : undefined;
  return { des: parseDes(w.name), spk: w.id, name: w.name, shortName: w.name, H: w.H, diameterM: d, diameterMeasured: false, elements: null, approaches: w.missKm ? [{ date: w.date, distKm: w.missKm, vRel: w.vKms }] : [], source: 'NeoWs' };
}

function decadeToDetail(u: UpcomingObject): Detail {
  return { des: u.des, name: u.name, shortName: u.name || u.des, H: u.H, diameterM: u.diameterM, diameterMeasured: false, elements: null, approaches: [{ date: u.date, distKm: u.distKm, vRel: u.vRel, vInf: u.vInf }], source: 'JPL CAD' };
}

export async function renderHome(deps: HomeDeps) {
  const { panel } = deps;
  panel.innerHTML = `
    <div class="home fade-in">
      <header>
        <h1>Asteroid Defense<span class="beta">BETA</span></h1>
        <p class="lede">A rock is coming, and nobody knows where it lands. You have a budget, a clock and a chief scientist. Act before you are sure.</p>
      </header>
      <section class="group" aria-labelledby="diff-h">
        <h3 id="diff-h">Difficulty</h3>
        <div class="diff" role="group" aria-label="Difficulty"></div>
      </section>
      <section class="group" aria-labelledby="pick-h">
        <h3 id="pick-h">Choose an asteroid</h3>
        <div class="picker-tabs" role="tablist" aria-label="Asteroid sources">
          <button role="tab" data-t="famous" aria-selected="true">Famous rocks</button>
          <button role="tab" data-t="week" aria-selected="false">Passing this week</button>
          <button role="tab" data-t="decade" aria-selected="false">Next decade</button>
        </div>
        <div class="rocks" role="tabpanel" aria-live="polite"></div>
        <div class="src"></div>
      </section>
      <div class="row-actions">
        <button class="btn primary" id="surprise">Surprise me: AI what-if</button>
        <button class="btn quiet" id="how">How it works</button>
      </div>
      <p class="muted" id="status"></p>
    </div>`;

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

  const rocksEl = panel.querySelector<HTMLElement>('.rocks')!;
  const srcEl = panel.querySelector<HTMLElement>('.src')!;
  let rows: { detail: Detail; hint?: number }[] = [];

  const rockHtml = (i: number, title: string, meta: string[], body: string, tag = '') => `
    <div class="rock"><div><h3>${esc(title)}${tag}</h3><div class="meta">${meta.map((m) => `<span>${esc(m)}</span>`).join('')}</div></div>
      <button class="btn go" data-go="${i}">Defend</button><p>${esc(body)}</p></div>`;

  const draw = async () => {
    rocksEl.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
    rows = [];
    if (tab === 'famous') {
      catalog ??= await fetchCatalog();
      rocksEl.innerHTML = catalog.objects
        .map((d, i) => {
          rows.push({ detail: d });
          const next = d.approaches?.[0];
          const meta = [fmtSize(d.diameterM) + (d.diameterMeasured ? '' : ' est.'), d.orbitClass ? `${d.orbitClass} orbit` : '', next ? `passes ${Math.round(next.distKm / 1000).toLocaleString('en-US')}k km, ${next.date.slice(0, 11)}` : ''].filter(Boolean);
          return rockHtml(i, d.shortName, meta, d.blurb ?? '', d.pha ? '<span class="tag hot">PHA</span>' : '');
        })
        .join('');
      srcEl.innerHTML = `<span class="dot ${catalog.live ? 'live' : ''}"></span>${catalog.live ? 'Live from JPL Small-Body Database and Close-Approach data.' : 'JPL data unreachable right now: showing cached values.'}`;
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
          rows.push({ detail: d, hint: w.vKms ? undefined : undefined });
          const meta = [`${fmtSize(d.diameterM)} est.`, w.date, w.lunar !== undefined ? `${w.lunar < 10 ? w.lunar.toFixed(1) : Math.round(w.lunar)} lunar distances` : '', w.vKms ? `${w.vKms.toFixed(1)} km/s` : ''].filter(Boolean);
          return rockHtml(i, w.name, meta, w.hazardous ? 'Classed as potentially hazardous by NASA. Its real flyby is safe; the impact is a what-if.' : 'A real flyby this week. The impact is a what-if built from its real orbit.', w.sentry ? '<span class="tag hot">Sentry</span>' : '');
        })
        .join('');
      srcEl.innerHTML = `<span class="dot live"></span>${esc(week.source)}${week.degraded ? ': NeoWs was rate-limited, so this is JPL data for the same days.' : '.'}`;
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
          const meta = [`${fmtSize(u.diameterM)} est.`, u.date.slice(0, 11), `${Math.round(u.distKm / 1000).toLocaleString('en-US')}k km`, `${u.vRel.toFixed(1)} km/s`];
          return rockHtml(i, u.name || u.des, meta, 'One of the closest predicted approaches in the next ten years. The flyby is safe; the impact is a what-if.');
        })
        .join('');
      srcEl.innerHTML = '<span class="dot live"></span>JPL Close-Approach Data, closest predicted passes through 2036.';
    }
  };

  panel.querySelector('.picker-tabs')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-t]');
    if (!b) return;
    tab = b.dataset.t as TabKey;
    panel.querySelectorAll('.picker-tabs button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    void draw();
  });
  rocksEl.addEventListener('click', async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-go]');
    if (!b) return;
    const r = rows[Number(b.dataset.go)];
    panel.querySelectorAll<HTMLButtonElement>('button').forEach((x) => (x.disabled = true));
    b.innerHTML = '<span class="spin"></span>';
    await deps.start(r.detail, { vInfHint: r.detail.approaches?.[0]?.vInf ?? r.detail.approaches?.[0]?.vRel });
  });
  panel.querySelector('#how')!.addEventListener('click', () => openDialog(HOW_IT_WORKS));
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

  void draw();
  void health().then((h) => {
    const s = panel.querySelector('#status');
    if (!s) return;
    const ai = h?.ai === 'groq' ? 'Groq (Llama 3.3)' : h?.ai === 'claude' ? 'Claude' : h?.ai === 'workers-ai' ? 'a hosted AI model' : 'built-in scripted answers';
    s.textContent = h ? `Chief scientist: ${ai}. NASA data: ${h.nasaKey ? 'API key set' : 'shared demo key (cached at the edge)'}.` : 'Server unreachable: running on cached data and scripted advisor answers.';
  });
}
