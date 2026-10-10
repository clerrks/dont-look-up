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
  help: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 1 1 3.6 2.2c-.8.4-1.2 1-1.2 1.8M12 16.8v.2"/></svg>',
};

export function openDialog(html: string) {
  const d = document.createElement('dialog');
  d.innerHTML = `<div class="in">${html}<div><button class="btn primary" data-close>Got it</button></div></div>`;
  d.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t === d || t.hasAttribute('data-close')) d.close();
  });
  d.addEventListener('close', () => d.remove());
  document.body.appendChild(d);
  d.showModal();
}

export const HOW_IT_WORKS = `
<h2>How a round works</h2>
<p>An asteroid has been found that might hit Earth. You cannot be sure yet, and you cannot wait until you are. Every month, new observations shrink the glowing <b>risk corridor</b> on the globe. Every month you wait, a deflection gets weaker.</p>
<ul>
<li><b>Sharpen the orbit.</b> Telescope time makes the corridor shrink sooner.</li>
<li><b>Deflect.</b> A kinetic impactor (like NASA's DART, 2022) takes about a year to arrive and changes the asteroid's speed by a hair; a hair early becomes thousands of kilometres. A gravity tractor tows more gently for years.</li>
<li><b>Protect people.</b> Evacuation planning needs about a year of lead time to be fully effective.</li>
<li><b>Advance the clock</b> with the timeline. The outcome is decided when the date arrives.</li>
</ul>
<p><b>What is real:</b> asteroid orbits, brightness and close approaches come live from NASA's NeoWs and JPL's Small-Body Database and Close-Approach APIs. The Earth-impact scenario itself is hypothetical, and where a real asteroid is far too big to deflect, the game says so and scales its size.</p>
<p><b>What is simplified:</b> orbits are two-body Keplerian; the corridor is a Monte Carlo cloud on a simplified impact plane; deflection uses a linear along-track model; blast zones use cube-root scaling; casualties use metropolitan populations. It behaves correctly, not research-grade.</p>
`;
