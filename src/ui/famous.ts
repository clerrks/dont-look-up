import type { Detail } from '../api';
import { FAMOUS, type FamousInfo } from '../data/famous';
import { esc } from './dom';
import { spinRocks } from './rockSpinner';

export function famousFor(d: Detail): FamousInfo | null {
  for (const key of Object.keys(FAMOUS)) {
    if (d.des === key || d.shortName?.includes(key) || d.name?.includes(key)) return FAMOUS[key];
  }
  return null;
}

const ORBIT_WORDS: Record<string, string> = {
  Aten: 'Aten: mostly inside Earth’s orbit',
  Apollo: 'Apollo: crosses Earth’s orbit',
  Amor: 'Amor: skirts Earth’s orbit from outside',
  Atira: 'Atira: entirely inside Earth’s orbit',
};

function width(d: Detail) {
  const m = d.diameterM;
  if (!m) return 'Unknown';
  const v = m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
  return `${v} wide${d.diameterMeasured ? '' : ' (estimated)'}`;
}

function massOf(d: Detail) {
  if (!d.diameterM) return 'Unknown';
  const kg = (4 / 3) * Math.PI * (d.diameterM / 2) ** 3 * 2000;
  const t = kg / 1000;
  const s = t >= 1e9 ? `${(t / 1e9).toFixed(1)} billion tonnes` : `${Math.round(t / 1e6).toLocaleString('en-US')} million tonnes`;
  return `About ${s}`;
}

/** A large card about one famous rock: why it matters, how big it is, what is known about it. */
export function openFamous(d: Detail, info: FamousInfo, onDefend: () => void) {
  const live: [string, string][] = [['Width', width(d)], ['Mass', massOf(d)]];
  if (d.orbitClass) live.push(['Orbit type', ORBIT_WORDS[d.orbitClass] ?? d.orbitClass]);
  if (d.elements) live.push(['One lap of the Sun', `${Math.pow(d.elements.a, 1.5).toFixed(2)} years`]);
  const next = d.approaches?.[0];
  if (next) live.push(['Next close pass', `${next.date.slice(0, 11)}, ${Math.round(next.distKm).toLocaleString('en-US')} km`]);
  const dlg = document.createElement('dialog');
  dlg.className = 'famous';
  const row = ([k, v]: [string, string]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`;
  dlg.innerHTML = `
    <div class="in">
      <div class="fam-head">
        <canvas class="spin3d huge" data-seed="${(d.des.length * 7 + d.des.charCodeAt(0)) % 6}" aria-hidden="true"></canvas>
        <div>
          <span class="eyebrow">${d.pha ? 'Potentially hazardous' : 'Famous rock'}</span>
          <h2>${esc(d.shortName)}</h2>
          <p class="fam-tag">${esc(info.tagline)}</p>
        </div>
      </div>
      <section><h3>Why it is famous</h3><p>${esc(info.why)}</p></section>
      <section><h3>Measurements</h3><dl class="fam-grid">${live.map(row).join('')}</dl></section>
      <section><h3>Key facts</h3><dl class="fam-grid">${info.facts.map(row).join('')}</dl></section>
      <p class="muted fam-src">Orbit, size and pass dates are live from NASA JPL. Mass is a guess from the width.</p>
      <div class="row-actions"><button class="btn primary" data-defend>Defend against it</button><button class="btn" data-close>Close</button></div>
    </div>`;
  dlg.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t === dlg || t.hasAttribute('data-close')) dlg.close();
    if (t.hasAttribute('data-defend')) { dlg.close(); onDefend(); }
  });
  dlg.addEventListener('close', () => dlg.remove());
  document.body.appendChild(dlg);
  dlg.showModal();
  spinRocks(dlg);
}
