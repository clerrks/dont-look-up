import type { BoardRow } from '../api';
import { esc } from './dom';

/** The daily top five. Every row can be opened with Analyze to watch that run back. */
export function boardHtml(rows: BoardRow[], me: string, empty = 'No scores yet today. Be the first.'): string {
  if (!rows.length) return `<p class="muted board-empty">${esc(empty)}</p>`;
  const mine = me.trim().toLowerCase();
  return `<ol class="board">${rows
    .map(
      (r, i) => `
    <li class="${mine && r.name.toLowerCase() === mine ? 'me' : ''}" style="--i:${i}">
      <span class="rk r${i + 1}">${i + 1}</span>
      <span class="nm">${esc(r.name)}</span>
      <span class="sc num">${r.score}</span>
      <span class="gr" aria-label="Grade ${esc(r.grade)}">${esc(r.grade)}</span>
      <button type="button" class="btn small quiet" data-analyze="${r.id}" aria-label="Analyze ${esc(r.name)}'s run">Analyze</button>
    </li>`,
    )
    .join('')}</ol>`;
}

export function bindBoard(root: HTMLElement, analyze: (id: number) => Promise<void>) {
  root.addEventListener('click', async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-analyze]');
    if (!b || b.disabled) return;
    const label = b.innerHTML;
    b.disabled = true;
    b.innerHTML = '<span class="spin"></span>';
    try {
      await analyze(Number(b.dataset.analyze));
    } finally {
      if (b.isConnected) { b.disabled = false; b.innerHTML = label; }
    }
  });
}
