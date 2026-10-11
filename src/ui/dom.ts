export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = ''): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html) n.innerHTML = html;
  return n;
}

export function toast(msg: string, ms = 3200) {
  const t = el('div', 'toast');
  t.setAttribute('role', 'status');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

export const ICONS = {
  focus: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  minus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg>',
  globe: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c3.2 3.4 3.2 13.6 0 17M12 3.5c-3.2 3.4-3.2 13.6 0 17"/></svg>',
  cam: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 9V6a1.5 1.5 0 0 1 1.5-1.5h3M15 4.5h3A1.5 1.5 0 0 1 19.5 6v3M19.5 15v3a1.5 1.5 0 0 1-1.5 1.5h-3M9 19.5H6A1.5 1.5 0 0 1 4.5 18v-3"/><circle cx="12" cy="12" r="3.4"/></svg>',
  help: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 1 1 3.6 2.2c-.8.4-1.2 1-1.2 1.8M12 16.8v.2"/></svg>',
};

export function openDialog(html: string, extra?: { label: string; run: () => void }) {
  const d = document.createElement('dialog');
  d.innerHTML = `<div class="in">${html}<div class="row-actions"><button class="btn primary" data-close>Got it</button>${extra ? `<button class="btn" data-extra>${extra.label}</button>` : ''}</div></div>`;
  d.addEventListener('click', (e) => { if ((e.target as HTMLElement).hasAttribute('data-extra')) { d.close(); extra?.run(); } });
  d.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t === d || t.hasAttribute('data-close')) d.close();
  });
  d.addEventListener('close', () => d.remove());
  document.body.appendChild(d);
  d.showModal();
}

export const HOW_IT_WORKS = `
<h2>How it works</h2>
<p>An asteroid might hit Earth. Each line in the chart is a path it could still take. <b style="color:var(--bad)">Red lines hit Earth.</b> You do not know which one is real yet.</p>
<div class="scenes">
  <figure><svg viewBox="0 0 170 90" aria-hidden="true"><circle cx="122" cy="52" r="17" class="rock"/><circle cx="116" cy="46" r="3.5" class="crater"/><circle cx="128" cy="58" r="2.8" class="crater"/><rect x="22" y="44" width="16" height="10" rx="2" class="ship"/><path d="M14 40h8M14 58h8M38 49h26" class="ln"/><path d="M122 35c8-14 20-18 36-20" class="dash"/><path d="M153 11l6 3-6 4" class="ln"/></svg><figcaption><b>Kinetic impactor</b>Crash a spacecraft into the asteroid. A small nudge years early becomes a big miss.</figcaption></figure>
  <figure><svg viewBox="0 0 170 90" aria-hidden="true"><circle cx="70" cy="48" r="20" class="rock"/><circle cx="62" cy="42" r="4" class="crater"/><circle cx="78" cy="54" r="3" class="crater"/><rect x="122" y="40" width="16" height="10" rx="2" class="ship"/><path d="M96 38l22 3M96 48h22M96 58l22-6" class="dash"/><path d="M70 72c-8 5-20 6-34 3" class="dash"/><path d="M40 78l-6-3 5-4" class="ln"/></svg><figcaption><b>Gravity tractor</b>Park a heavy spacecraft beside it. Its gravity slowly tugs the asteroid off course.</figcaption></figure>
  <figure><svg viewBox="0 0 170 90" aria-hidden="true"><path d="M30 70l22-34 12 8-22 34z" class="ship"/><path d="M52 36l16-26M64 44l22-18" class="ln"/><circle cx="110" cy="28" r="2.6" class="dot"/><circle cx="130" cy="42" r="2.6" class="dot"/><circle cx="148" cy="30" r="2.6" class="dot"/><path d="M110 28l20 14 18-12" class="dash"/></svg><figcaption><b>Telescopes</b>Watching longer shows exactly where it is going, so you know the answer sooner.</figcaption></figure>
  <figure><svg viewBox="0 0 170 90" aria-hidden="true"><circle cx="50" cy="30" r="9" class="ship"/><path d="M34 70c0-12 7-20 16-20s16 8 16 20z" class="ship"/><circle cx="105" cy="32" r="7" class="ship"/><path d="M92 70c0-10 6-17 13-17s13 7 13 17z" class="ship"/><path d="M126 62h30M150 56l7 6-7 6" class="ln"/></svg><figcaption><b>Evacuation planning</b>If it does hit, people need time to leave. It works best about a year ahead.</figcaption></figure>
</div>
<p class="muted">The big rule: do not push it before you can tell which way. Buy telescope time first, then launch. Real NASA and JPL data; the impact itself is a what-if, and the physics is simplified.</p>
`;

const ic = (body: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
export const TILE_ICONS = {
  scope: ic('<path d="M3.5 14.5l11-5.5 2.2 4.4-11 5.5z"/><path d="M14.5 9l3.2-1.6 2.2 4.4-3.2 1.6"/><path d="M9.5 19.5l1.6-4.6M5.5 21h7"/>'),
  sat: ic('<rect x="2.5" y="9" width="5" height="6" rx="0.8"/><rect x="16.5" y="9" width="5" height="6" rx="0.8"/><rect x="8.5" y="8" width="7" height="8" rx="1.4"/><path d="M7.5 12h1M15.5 12h1M12 4.5v3.5"/>'),
  rocket: ic('<path d="M12 3c3.2 2.2 5 5.2 5 9l-2 3.5H9L7 12c0-3.8 1.8-6.8 5-9z"/><circle cx="12" cy="10" r="1.7"/><path d="M9 15.5l-2.2 3.5M15 15.5l2.2 3.5M12 17.5V21"/>'),
  tractor: ic('<rect x="2.5" y="14" width="6.5" height="5" rx="1"/><path d="M9 15l5.5-3.2M9 16.5h5.5M9 18l5 2.2"/><circle cx="17.5" cy="9" r="4"/>'),
  nuke: ic('<circle cx="12" cy="12" r="2"/><path d="M12 10V3.8a8.2 8.2 0 0 0-7.1 4.1L10.3 11M13.7 11l5.4-3.1A8.2 8.2 0 0 0 12 3.8M12 14l0 6.2a8.2 8.2 0 0 0 7.1-4.1L13.7 13M10.3 13l-5.4 3.1A8.2 8.2 0 0 0 12 20.2"/>'),
  radar: ic('<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><path d="M12 12l6-6"/><circle cx="12" cy="12" r="1"/>'),
  probe: ic('<rect x="9.5" y="9" width="5" height="6" rx="1"/><path d="M9.5 12H4.5M14.5 12h5M4.5 10v4M19.5 10v4M12 9V6M10.5 6h3"/>'),
  coin: ic('<circle cx="12" cy="12" r="8.5"/><path d="M14.7 9.4c-.6-.9-1.5-1.3-2.7-1.3-1.4 0-2.5.7-2.5 1.9 0 2.7 5 1.3 5 4 0 1.2-1.1 2-2.6 2-1.3 0-2.3-.5-2.9-1.5M12 6.4v1.7M12 16.2v1.6"/>'),
  shelter: ic('<path d="M3.5 11 12 4.5l8.5 6.5"/><path d="M6 10v9.5h12V10"/><path d="M10 19.5v-5h4v5"/>'),
  rock: ic('<path d="M5 14.5 7.5 7l5-2.5 5.5 3 2 5-3 5-6 1.5-5-3z"/><circle cx="10" cy="11" r="1.4"/><circle cx="15" cy="15" r="1.9"/>'),
  people: ic('<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.6 2.6-6 6-6s6 2.4 6 6"/><circle cx="17" cy="9" r="2.4"/><path d="M16 14c3 0 5 2 5 5.2"/>'),
};
