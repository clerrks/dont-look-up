import { postAI } from '../api';
import { Game, dateAt, fmtDate, fmtMoney } from '../game';
import { oneInN } from '../sim/model';
import type { GameView } from '../view/gameView';
import { el, esc, toast } from './dom';

function nameList(o: NonNullable<Game['outcome']>) {
  return o.rows.filter((r) => r.deathsM > 0.001 || r.exposedM > 0.001).slice(0, 5);
}

function localDebrief(g: Game): string[] {
  const o = g.outcome!;
  const sc = g.sc;
  const notes = g.decisionNotes;
  const first = g.history[0];
  const p1Parts: string[] = [`${sc.name}, ${sc.diameterM} m across, was found ${sc.leadYears} years out with a ${oneInN(first?.p ?? 0)} chance of hitting Earth.`];
  if (!notes.length) p1Parts.push('You took no action and let the observations run.');
  else {
    const bits = notes.slice(0, 4).map((n) => `${n.text.toLowerCase()} in ${fmtDate(dateAt(sc, n.t))} when the chance stood at ${oneInN(n.p)}`);
    p1Parts.push(`You made ${notes.length} call${notes.length > 1 ? 's' : ''}: ${bits.join('; ')}${notes.length > 4 ? '; and more' : ''}.`);
  }
  const p2: string[] = [];
  if (o.hit) {
    p2.push(o.ocean ? `It struck the ocean. ${o.deathsM > 0 ? `Tsunamis and blast killed an estimated ${o.deathsM.toFixed(1)} million people.` : 'No large coastal population fell inside the damage zone.'}` : o.deathsM > 0 ? `It struck land, killing an estimated ${o.deathsM.toFixed(1)} million people${o.baselineDeathsM > 0 ? `, against ${o.baselineDeathsM.toFixed(1)} million had you done nothing` : ''}.` : 'It struck land, but no major city fell inside the damage zone.');
    const early = notes.find((n) => n.text.includes('launched'));
    p2.push(early ? `The push you made was not enough to clear the planet. The lesson of this round: the impact chance only became decisive late, and each year of delay costs a deflection about as much strength as a year of speed.` : 'No spacecraft was sent, and by the time the picture was certain no spacecraft could have arrived. Real planetary defense means acting while the odds still look small.');
  } else if (o.baselineHit) {
    p2.push(`The asteroid missed, passing about ${Math.round(o.missKm).toLocaleString('en-US')} km from the centre of the Earth. Left alone it would have hit.`);
    p2.push('The push you made early is what saved the planet: a tiny change in speed, applied years ahead, becomes thousands of kilometres.');
  } else {
    p2.push(`It missed by a wide margin and would have anyway. Over the round you spent ${fmtMoney(o.spentB)} of ${fmtMoney(sc.budgetB)}.`);
    p2.push('That is the price of acting under uncertainty: from the data you had, you could not have known. Cheap observations are how real teams find out whether an alarm is false.');
  }
  return [p1Parts.join(' '), p2.join(' ')];
}

export function showOutcome(game: Game, panel: HTMLElement, view: GameView, again: () => void, home: () => void) {
  const o = game.outcome!;
  const sc = game.sc;
  const topRows = nameList(o);
  const headline = o.hit
    ? o.ocean ? 'It hit the ocean.' : topRows[0] ? `Impact near ${topRows[0].city.name}.` : 'Impact.'
    : o.baselineHit ? 'You turned it away.' : 'It missed.';
  const fx = o.effects;
  const bar = (v: number, max: number) => `<div class="gauge" aria-hidden="true"><i style="width:${Math.round((v / max) * 100)}%"></i></div>`;
  const share = `Asteroid Defense: ${sc.name} (${sc.diameterM} m). ${o.hit ? 'It hit.' : o.baselineHit ? 'I deflected it.' : 'It missed.'} Score ${o.score.total} (${o.score.grade}). ad.chiefkeef.org`;

  panel.innerHTML = `
    <div class="pane outcome fade-in" id="outcome-pane" tabindex="-1">
      <h2 data-hit="${o.hit}">${esc(headline)}</h2>
      <div class="score"><span class="total num" aria-label="Score">${o.score.total}</span><span class="grade" aria-label="Grade ${o.score.grade}">${o.score.grade}</span></div>
      <dl class="breakdown">
        <div><dt>Protecting people</dt><dd>${o.score.lives} / 600</dd><div class="bar">${bar(o.score.lives, 600)}</div></div>
        <div><dt>Spending wisely (${fmtMoney(o.spentB)} of ${fmtMoney(sc.budgetB)})</dt><dd>${o.score.thrift} / 250</dd><div class="bar">${bar(o.score.thrift, 250)}</div></div>
        <div><dt>Prudent planning</dt><dd>${o.score.prudence} / 150</dd><div class="bar">${bar(o.score.prudence, 150)}</div></div>
      </dl>

      <section class="group debrief" id="debrief">
        <h3>Debrief</h3>
        ${localDebrief(game).map((p) => `<p>${esc(p)}</p>`).join('')}
        <p class="muted" id="debrief-note"><span class="spin"></span> Dr. Okafor is writing her notes...</p>
      </section>

      <section class="group">
        <h3>What the data said when you decided</h3>
        ${game.decisionNotes.length ? `<table class="table"><thead><tr><th>Decision</th><th class="n" style="text-align:right">Impact chance</th></tr></thead><tbody>${game.decisionNotes.map((n) => `<tr><td>${esc(n.text)}<div class="muted">${esc(fmtDate(dateAt(sc, n.t)))} · ${(sc.leadYears - n.t).toFixed(1)} years before impact</div></td><td class="n">${oneInN(n.p)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">You made no decisions.</p>'}
      </section>

      <section class="group">
        <h3>The impact, if it had come</h3>
        <p>${fx.energyMt >= 100 ? Math.round(fx.energyMt).toLocaleString('en-US') : fx.energyMt.toFixed(1)} megatons of energy. ${fx.airburst ? `At this size it would mostly burst in the air, with a severe blast out to ${fx.rB.toFixed(0)} km.` : `Crater about ${fx.craterKm.toFixed(1)} km wide, severe blast out to ${fx.rB.toFixed(0)} km, damaging overpressure to ${fx.rC.toFixed(0)} km.`}</p>
        ${o.hit && topRows.length ? `<table class="table"><thead><tr><th>City in the zone</th><th class="n" style="text-align:right">Estimated deaths</th></tr></thead><tbody>${topRows.map((r) => `<tr><td>${esc(r.city.name)}<div class="muted">${Math.round(r.distKm)} km from ground zero${r.evac > 0 ? ` · ${Math.round(r.evac * 100)}% evacuated` : ''}</div></td><td class="n">${r.deathsM >= 0.1 ? r.deathsM.toFixed(1) + 'M' : Math.round(r.deathsM * 1000) + 'k'}</td></tr>`).join('')}</tbody></table>` : ''}
      </section>

      ${o.hit && topRows.length ? `<section class="group"><h3>Evacuation plan</h3><p class="muted">Draft a plan for the people inside the impact zone, from the cities above.</p><div id="plan-out"></div><div><button class="btn" id="plan-btn">Draft evacuation plan</button></div></section>` : ''}

      <div class="row-actions">
        <button class="btn primary" id="again">Another asteroid</button>
        <button class="btn" id="share">Copy result</button>
        <button class="btn quiet" id="home">Home</button>
      </div>
      <p class="muted">Simplified model: orbits, deflection, blast zones and casualties are approximations for learning, not forecasts.</p>
    </div>`;
  panel.scrollTop = 0;
  (panel.querySelector('#outcome-pane') as HTMLElement).focus({ preventScroll: true });

  panel.querySelector('#again')!.addEventListener('click', again);
  panel.querySelector('#home')!.addEventListener('click', home);
  panel.querySelector('#share')!.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(share); toast('Result copied.'); } catch { toast(share, 6000); }
  });

  // AI debrief (replaces the local text when it arrives)
  void postAI('/api/debrief', { state: game.record() }).then((res) => {
    const note = panel.querySelector('#debrief-note');
    if (!note) return;
    if (res?.text) {
      const box = panel.querySelector('#debrief')!;
      box.querySelectorAll('p:not(#debrief-note)').forEach((p) => p.remove());
      const frag = res.text.split(/\n\s*\n/).filter(Boolean).map((t) => { const p = el('p'); p.textContent = t.trim(); return p; });
      frag.forEach((p) => box.insertBefore(p, note));
      note.textContent = `Written by ${res.provider === 'claude' ? 'Claude' : res.provider === 'groq' ? 'Groq AI' : 'the AI advisor'}, from your round record.`;
    } else {
      note.textContent = 'Offline debrief: the AI advisor was not reachable, so these notes were written from the round record.';
    }
  });

  const planBtn = panel.querySelector<HTMLButtonElement>('#plan-btn');
  planBtn?.addEventListener('click', async () => {
    planBtn.disabled = true;
    planBtn.innerHTML = '<span class="spin"></span> Drafting...';
    const state = {
      impactZoneRadiiKm: { destroyed: Math.round(fx.rA), severe: Math.round(fx.rB), damaging: Math.round(fx.rC) },
      ocean: o.ocean,
      cities: topRows.map((r) => ({ city: r.city.name, country: r.city.country, distanceKm: Math.round(r.distKm), populationMillions: r.city.popM, alreadyPlanned: r.evac > 0 })),
      warningYears: sc.leadYears,
    };
    const res = await postAI('/api/evac', { state });
    const out = panel.querySelector('#plan-out')!;
    const text = res?.text ?? [
      `Situation: impact ${Math.round(topRows[0].distKm)} km from ${topRows[0].city.name}; severe blast to ${Math.round(fx.rB)} km.`,
      `1. National authorities: declare the exclusion zone out to ${Math.round(fx.rC)} km, 12 months before impact.`,
      `2. Regional transport agencies: stage road and rail corridors for ${topRows.map((r) => r.city.name).join(', ')}, 9 months out.`,
      '3. Hospitals: pre-position burn and trauma capacity outside the zone, 6 months out.',
      '4. Local governments: run staged evacuation drills and open reception centres, 3 months out.',
      '5. Everyone inside the zone: be fully relocated 48 hours before impact.',
      'If the forecast changes, narrow the zone to the new corridor and release the rest.',
    ].join('\n');
    const pre = el('div', 'plan');
    pre.textContent = text;
    out.replaceChildren(pre);
    planBtn.remove();
  });
  void view;
}
