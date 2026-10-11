import { audio } from '../audio';

/** The trailer, in a window over the home screen. The game's own sound is held back while it plays. */
export function openTrailer() {
  const dlg = document.createElement('dialog');
  dlg.className = 'trailer';
  dlg.setAttribute('aria-label', 'Don\u2019t Look Up trailer');
  dlg.innerHTML = `
    <div class="in">
      <video src="/trailer.mp4" poster="/trailer-poster.jpg" controls autoplay playsinline preload="auto"></video>
      <button type="button" class="btn small" data-close aria-label="Close the trailer">Close</button>
    </div>`;
  const video = dlg.querySelector('video')!;
  audio.stopVoice();
  audio.duck(0);
  dlg.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t === dlg || t.hasAttribute('data-close')) dlg.close();
  });
  dlg.addEventListener('close', () => { video.pause(); audio.duck(1); dlg.remove(); });
  document.body.appendChild(dlg);
  dlg.showModal();
  void video.play().catch(() => undefined);
}
