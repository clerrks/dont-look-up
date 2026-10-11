import { postAI, submitRun } from '../api';
import { audio } from '../audio';
import { Game, dateAt, fmtDate, fmtMoney } from '../game';
import { oneInN } from '../sim/model';
import type { GameView } from '../view/gameView';
import { TargetView } from '../view/targetView';
import { bindBoard, boardHtml } from './board';
import { TILE_ICONS, el, esc, toast } from './dom';

function people(m: number) {
  return m >= 0.1 ? `${m.toFixed(1)} million` : m > 0.0005 ? `${Math.round(m * 1000)},000` : 'no one';
}

function callIcon(text: string): keyof typeof TILE_ICONS {
  if (/mpactor/.test(text)) return 'rocket';
  if (/tractor/i.test(text)) return 'tractor';
  if (/probe/i.test(text)) return 'probe';
  if (/shelter/i.test(text)) return 'shelter';
  if (/money|fund/i.test(text)) return 'coin';
  if (/nuclear/i.test(text)) return 'nuke';
  if (/radar/i.test(text)) return 'radar';
  if (/Evac/.test(text)) return 'people';
  return 'scope';
}

function localDebrief(g: Game): string {
  const o = g.outcome!;
  const acted = g.decisionNotes.some((n) => n.text.includes('launched'));
  if (o.hit) {
    return acted
      ? 'Your push was not enough to clear the planet. The certain answer came too late to add more, so the early guess was the one that counted.'
      : 'By the time the picture was certain, no spacecraft could arrive. Real defense means acting while the odds still look small.';
  }
  if (o.baselineHit) return 'You moved it off Earth. A tiny nudge years early becomes thousands of kilometres.';
  return 'It would have missed anyway. Acting under uncertainty costs money, and cheap telescopes tell you sooner.';
}

/** Present when this round was the Daily Challenge: the score goes to the leaderboard. */
export interface DailyCtx { day: string; name: string; analyze: (id: number) => Promise<void> }

export function showOutcome(game: Game, panel: HTMLElement, view: GameView, again: () => void, home: () => void, daily?: DailyCtx) {
  const o = game.outcome!;
  const sc = game.sc;
  // the music and the narrator close the round: a good ending gets the stinger, a hit gets the ruined world until the player leaves
  audio.duck(1);
  if (o.hit) {
    audio.scene('hit');
    audio.speak('end_lost', { interrupt: true, once: false, delay: 1.4 });
  } else {
    audio.scene('good');
    audio.sfx('ending', { delay: 0.8 });
    if (o.baselineHit) audio.speak('end_saved_big', { queue: true, once: false, delay: 1.2 });
    else if (o.spentB > 0.05) audio.speak('end_waste', { queue: true, once: false, delay: 1.2 });
  }
  const rows = o.rows.filter((r) => r.deathsM > 0.0005 || r.exposedM > 0.0005).slice(0, 4);
  const headline = o.hit
    ? o.ocean ? 'It hit the ocean.' : rows[0] ? `Impact near ${rows[0].city.name}.` : 'Impact, away from cities.'
    : o.baselineHit ? 'You turned it away.' : 'It missed.';
  const fx = o.effects;
  const bar = (v: number, max: number) => `<span class="gauge" aria-hidden="true"><i style="width:${Math.round((v / max) * 100)}%"></i></span>`;
  const share = daily
    ? `Don't Look Up Daily Challenge ${daily.day}: ${o.hit ? 'it hit' : o.baselineHit ? 'I turned it away' : 'it missed'}, score ${o.score.total} (${o.score.grade}). Beat me: dontlookup.cc`
    : `Don't Look Up: ${sc.name} (${sc.diameterM} m). ${o.hit ? 'It hit.' : o.baselineHit ? 'I turned it away.' : 'It missed.'} Score ${o.score.total} (${o.score.grade}). dontlookup.cc`;

  const lost = o.hit
    ? `<div class="fact"><b>${people(o.deathsM)}</b><span>lost${o.baselineHit && o.baselineDeathsM > o.deathsM ? `, instead of ${people(o.baselineDeathsM)}` : ''}</span></div>`
    : `<div class="fact"><b>${Math.round(o.missKm).toLocaleString('en-US')} km</b><span>from Earth's centre</span></div>`;

  panel.innerHTML = `
    <div class="pane outcome fade-in" id="outcome-pane" tabindex="-1">
      <h2 data-hit="${o.hit}">${esc(headline)}</h2>
      <div class="score-wrap"><span class="score-cap">Your total score</span><div class="score"><span class="total num" aria-label="Total score ${o.score.total} out of 1000">${o.score.total}</span><span class="of">out of 1000</span><span class="grade-pill" aria-label="Grade ${o.score.grade}">Grade <b>${o.score.grade}</b></span></div></div>

      <div class="target-wrap">
        <canvas class="target" role="img" aria-label="Head-on view of where the asteroid went relative to Earth's target disc"></canvas>
        <div class="legend"><span>${o.baselineHit || true ? '<i class="d red"></i>Without you' : ''}</span><span><i class="d green"></i>With you</span></div>
      </div>

      <div class="facts">
        ${lost}
        <div class="fact"><b>${fmtMoney(o.spentB)}</b><span>spent of ${fmtMoney(sc.budgetB + game.fundedB)}</span></div>
        <div class="fact"><b>${fx.energyMt >= 100 ? Math.round(fx.energyMt).toLocaleString('en-US') : fx.energyMt.toFixed(1)} Mt</b><span>blast if it hit</span></div>
      </div>

      ${o.hit ? `<div class="zone-legend" aria-label="Areas affected, as highlighted on the globe"><span><i class="z a"></i>Total destruction<b>${Math.round(fx.rA)} km</b></span><span><i class="z b"></i>Severe blast<b>${Math.round(fx.rB)} km</b></span><span><i class="z c"></i>Damage<b>${Math.round(fx.rC)} km</b></span></div>` : ''}

      <dl class="breakdown">
        <div><dt>Protecting people</dt><dd>${o.score.lives} / 600</dd>${bar(o.score.lives, 600)}</div>
        <div><dt>Spending wisely</dt><dd>${o.score.thrift} / 250</dd>${bar(o.score.thrift, 250)}</div>
        <div><dt>Planning</dt><dd>${o.score.prudence} / 150</dd>${bar(o.score.prudence, 150)}</div>
      </dl>

      ${daily ? `<section class="group daily-res" id="daily-res"><h3>Daily Challenge · ${esc(daily.day)}</h3><div class="rankline" id="rankline" aria-live="polite"></div><div id="res-board"></div></section>` : ''}

      <section class="group debrief" id="debrief">
        <h3>Dr. Okafor's note</h3>
        <p id="debrief-text">${esc(localDebrief(game))}</p>
      </section>

      <section class="group">
        <h3>Your calls</h3>
        ${game.decisionNotes.length
          ? `<ul class="orders">${game.decisionNotes.map((n) => `<li><span class="ti sm">${TILE_ICONS[callIcon(n.text)]}</span><span class="on-t">${esc(n.text)}</span><span class="on-s">${esc(fmtDate(dateAt(sc, n.t)))} · was ${oneInN(n.p)}</span></li>`).join('')}</ul>`
          : '<p class="muted">You made no calls.</p>'}
      </section>

      ${o.hit && rows.length ? `<section class="group"><h3>Hardest hit</h3><ul class="orders">${rows.map((r) => `<li><span class="ti sm">${TILE_ICONS.people}</span><span class="on-t">${esc(r.city.name)}</span><span class="on-s">${people(r.deathsM)}${r.evac > 0 ? ` · ${Math.round(r.evac * 100)}% evacuated` : ''}</span></li>`).join('')}</ul><div id="plan-out"></div><div><button class="btn" id="plan-btn">Draft evacuation plan</button></div></section>` : ''}

      <div class="row-actions">
        <button class="btn primary" id="again">Play again</button>
        <button class="btn" id="share">Copy result</button>
        <button class="btn quiet" id="home">Home</button>
      </div>
      <p class="muted">A simplified model for learning, not a forecast.</p>
    </div>`;
  panel.scrollTop = 0;
  (panel.querySelector('#outcome-pane') as HTMLElement).focus({ preventScroll: true });

  const tv = new TargetView(panel.querySelector('canvas.target')!, sc);
  const marks: { xi: number; zeta: number; kind: 'before' | 'after' }[] = [];
  marks.push({ xi: o.basePos.xi, zeta: o.basePos.zeta, kind: 'before' });
  marks.push({ xi: o.finalPos.xi, zeta: o.finalPos.zeta, kind: 'after' });
  tv.set({ now: { xi: 0, zeta: 0, sxi: 1, szeta: 1 }, marks, hideCloud: true }, true);

  panel.querySelector('#again')!.addEventListener('click', () => { tv.destroy(); again(); });
  panel.querySelector('#home')!.addEventListener('click', () => { tv.destroy(); home(); });
  panel.querySelector('#share')!.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(share); toast('Result copied.'); } catch { toast(share, 6000); }
  });

  if (daily) {
    const rankEl = panel.querySelector<HTMLElement>('#rankline')!;
    const boardEl = panel.querySelector<HTMLElement>('#res-board')!;
    bindBoard(boardEl, daily.analyze);
    const send = async () => {
      rankEl.innerHTML = '<span class="spin"></span> Saving your score';
      const res = await submitRun({
        day: daily.day, name: daily.name, score: o.score.total, grade: o.score.grade, lives: o.score.lives, thrift: o.score.thrift, prudence: o.score.prudence,
        spent: Number(o.spentB.toFixed(3)), hit: o.hit, actions: game.actions,
      });
      if (!res) {
        rankEl.innerHTML = 'Could not reach the leaderboard. <button type="button" class="btn small" id="retry">Try again</button>';
        rankEl.querySelector('#retry')!.addEventListener('click', () => void send());
        return;
      }
      if (res.improved && res.rank === 1) audio.speak('daily_rank1', { queue: true, once: false });
      else audio.speak('daily_saved', { queue: true, once: false });
      rankEl.innerHTML = res.improved
        ? `<b>#${res.rank}</b> of ${res.total} today, as ${esc(daily.name)}.`
        : `Your best today is ${res.best} (<b>#${res.rank}</b> of ${res.total}). This run did not beat it.`;
      boardEl.innerHTML = `<div class="board-head"><span>Today's top 5</span><span>${res.total} ${res.total === 1 ? 'player' : 'players'}</span></div>${boardHtml(res.board.top, daily.name)}`;
    };
    void send();
  }

  void postAI('/api/debrief', { state: game.record() }).then((res) => {
    const t = panel.querySelector('#debrief-text');
    if (t && res?.text) t.textContent = res.text.trim().replace(/\s+/g, ' ');
  });

  const planBtn = panel.querySelector<HTMLButtonElement>('#plan-btn');
  planBtn?.addEventListener('click', async () => {
    planBtn.disabled = true;
    planBtn.innerHTML = '<span class="spin"></span> Drafting';
    const state = {
      impactZoneRadiiKm: { destroyed: Math.round(fx.rA), severe: Math.round(fx.rB), damaging: Math.round(fx.rC) },
      ocean: o.ocean,
      cities: rows.map((r) => ({ city: r.city.name, country: r.city.country, distanceKm: Math.round(r.distKm), populationMillions: r.city.popM, alreadyPlanned: r.evac > 0 })),
      warningYears: sc.leadYears,
    };
    const res = await postAI('/api/evac', { state });
    const out = panel.querySelector('#plan-out')!;
    const text = res?.text ?? [
      `Zone: severe blast to ${Math.round(fx.rB)} km around ${rows[0].city.name}.`,
      `1. Government: set the exclusion zone to ${Math.round(fx.rC)} km, 12 months out.`,
      `2. Transport: stage roads and rail from ${rows.map((r) => r.city.name).join(', ')}, 9 months out.`,
      '3. Hospitals: move burn and trauma capacity outside the zone, 6 months out.',
      '4. Cities: run drills and open reception centres, 3 months out.',
      '5. Everyone in the zone: be relocated 48 hours before impact.',
    ].join('\n');
    const pre = el('div', 'plan');
    pre.textContent = text;
    out.replaceChildren(pre);
    planBtn.remove();
  });
  void view;
}
